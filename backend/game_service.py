import asyncio
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal

from fastapi import WebSocket

from engine import Match, GameError, legal_cards, team_of
import bots
from progression import ensure_streak_history, match_profile_update
try:
    from backend.medals import match_is_eligible, match_medal_summary, private_view, round_breakdown
except ModuleNotFoundError:
    from medals import match_is_eligible, match_medal_summary, private_view, round_breakdown
try:
    from backend.env_scope import scoped_query
except ModuleNotFoundError:
    from env_scope import scoped_query
try:
    from backend.spectator import SpectatorAccessError, public_game_card, require_spectator_access, spectator_projection
except ModuleNotFoundError:
    from spectator import SpectatorAccessError, public_game_card, require_spectator_access, spectator_projection

log = logging.getLogger("dehla")
# Pause between rounds: ~1.5 s for the last-trick animation plus 10 s of visible round results.
NEXT_ROUND_DELAY = 11.5
TURN_DURATIONS = (15, 20, 30, 45, 60)
TurnDuration = Literal[15, 20, 30, 45, 60]
DEFAULT_TURN_DURATION = 30
PUBLIC_TURN_DURATION = 30
TURN_GRACE_SECONDS = 5
# Timer outcomes that already changed the game, so a racing player or bot action must not also apply.
TIMEOUT_ACTIONS = ("auto_play", "auto_decision", "forfeit", "error")
EMOJIS = {"👏", "😂", "🔥", "😮", "😢", "🙏", "👍", "😎"}


def validate_turn_duration(value):
    if isinstance(value, bool) or value not in TURN_DURATIONS:
        raise ValueError("Turn duration must be 15, 20, 30, 45, or 60 seconds")
    return value


def utc_iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def deadline_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def match_result_summary(game):
    """Build result totals only from the authoritative engine snapshot."""
    state = game.get("state") or {}
    rounds = state.get("rounds") or []
    tricks_won = [0, 0]
    for result in rounds:
        totals = result.get("tricks_won") or []
        for team in (0, 1):
            if len(totals) > team and isinstance(totals[team], int):
                tricks_won[team] += totals[team]
    # A forfeit can end a round before it is appended to state.rounds.
    if (state.get("round_no") or 0) > len(rounds):
        current = state.get("tricks_won") or []
        for team in (0, 1):
            if len(current) > team and isinstance(current[team], int):
                tricks_won[team] += current[team]

    started_at = game.get("created_at")
    finished_at = game.get("finished_at") or game.get("updated_at")
    duration_seconds = None
    try:
        start = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
        finish = datetime.fromisoformat(str(finished_at).replace("Z", "+00:00"))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if finish.tzinfo is None:
            finish = finish.replace(tzinfo=timezone.utc)
        duration_seconds = max(0, int((finish - start).total_seconds()))
    except (TypeError, ValueError):
        pass

    return {
        "scores": list(state.get("scores") or [0, 0]),
        "target": state.get("target"),
        "winner_team": state.get("winner_team"),
        "tricks_won": tricks_won,
        "total_tricks": sum(tricks_won),
        "rounds_played": state.get("round_no") or len(rounds),
        "final_trump": state.get("trump"),
        "last_trick": state.get("last_trick"),
        "final_result": state.get("result"),
        "forfeited_by": state.get("forfeited_by"),
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": duration_seconds,
    }


class Hub:
    """Tracks every open WebSocket per user; a user is online while any socket is open."""

    def __init__(self):
        self.sockets: dict[str, set[WebSocket]] = defaultdict(set)
        self.msg_times: dict[str, list[float]] = defaultdict(list)

    def online(self, uid):
        return bool(self.sockets.get(uid))

    def add(self, uid, ws):
        first = not self.online(uid)
        self.sockets[uid].add(ws)
        return first

    def remove(self, uid, ws):
        self.sockets[uid].discard(ws)
        if not self.sockets[uid]:
            self.sockets.pop(uid, None)
            return True
        return False

    def allow(self, uid, limit=12, window=2.0):
        t = time.monotonic()
        recent = [x for x in self.msg_times[uid] if t - x < window]
        recent.append(t)
        self.msg_times[uid] = recent
        return len(recent) <= limit

    async def send(self, uid, msg):
        for ws in list(self.sockets.get(uid, ())):
            try:
                await ws.send_json(msg)
            except Exception:
                self.sockets.get(uid, set()).discard(ws)

    async def send_many(self, uids, msg):
        await asyncio.gather(*(self.send(u, msg) for u in set(uids) if u))


class SpectatorHub:
    """Ephemeral spectator sockets, separate from player seats and presence."""

    def __init__(self, max_per_game=100):
        self.members: dict[str, dict[str, WebSocket]] = defaultdict(dict)
        self.admin_members: set[tuple[str, str]] = set()
        self.max_per_game = max(1, int(max_per_game))

    def count(self, game_id):
        return len(self.members.get(game_id, {}))

    def add(self, game_id, uid, ws, *, admin=False):
        members = self.members[game_id]
        if uid not in members and len(members) >= self.max_per_game:
            return False
        members[uid] = ws
        key = (game_id, uid)
        if admin:
            self.admin_members.add(key)
        else:
            self.admin_members.discard(key)
        return True

    def is_admin(self, game_id, uid):
        return (game_id, uid) in self.admin_members

    def admin_users(self, game_id):
        return [uid for gid, uid in self.admin_members if gid == game_id]

    def remove(self, game_id, uid, ws):
        members = self.members.get(game_id)
        if not members or members.get(uid) is not ws:
            return False
        members.pop(uid, None)
        self.admin_members.discard((game_id, uid))
        if not members:
            self.members.pop(game_id, None)
        return True

    def remove_socket(self, ws):
        changed = []
        for game_id, members in list(self.members.items()):
            for uid, current in list(members.items()):
                if current is ws and self.remove(game_id, uid, ws):
                    changed.append(game_id)
        return changed

    def clear(self, game_id):
        self.members.pop(game_id, None)
        self.admin_members = {key for key in self.admin_members if key[0] != game_id}

    async def broadcast(self, game_id, message):
        changed = False
        for uid, ws in list(self.members.get(game_id, {}).items()):
            try:
                await ws.send_json(message)
            except Exception:
                changed = self.remove(game_id, uid, ws) or changed
        return changed

    async def revoke(self, game_id):
        members = self.members.pop(game_id, {})
        self.admin_members = {key for key in self.admin_members if key[0] != game_id}
        for ws in set(members.values()):
            try:
                await ws.send_json({"type": "spectator_access_revoked", "game_id": game_id})
            except Exception:
                pass
        return len(members)

    async def revoke_invited(self, game_id):
        removed = []
        admin_users = set(self.admin_users(game_id))
        for uid, ws in list(self.members.get(game_id, {}).items()):
            if uid in admin_users:
                continue
            if self.remove(game_id, uid, ws):
                removed.append(ws)
        for ws in set(removed):
            try:
                await ws.send_json({"type": "spectator_access_revoked", "game_id": game_id})
            except Exception:
                pass
        return len(removed)

    async def revoke_admin_user(self, uid):
        removed = []
        for game_id, member_uid in list(self.admin_members):
            if member_uid != uid:
                continue
            members = self.members.get(game_id, {})
            ws = members.get(uid)
            self.admin_members.discard((game_id, uid))
            if ws is None:
                continue
            members.pop(uid, None)
            if not members:
                self.members.pop(game_id, None)
            try:
                await ws.send_json({"type": "spectator_access_revoked", "game_id": game_id})
            except Exception:
                pass
            removed.append(game_id)
        return removed


class GameService:
    """Owns live matches in memory; every change is persisted so games survive restarts."""

    def __init__(self, db, hub: Hub, *, spectator_hub=None, clock=time.time, schedule_turn_timers=True, sleep=asyncio.sleep, env=None):
        self.db, self.hub = db, hub
        self.env = env
        self.spectators = spectator_hub or SpectatorHub()
        self.clock = clock
        self.schedule_turn_timers = schedule_turn_timers
        self.sleep = sleep
        self.games: dict[str, dict] = {}
        self.locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.profile_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.timers: dict[str, asyncio.Task] = {}
        self.turn_timers: dict[str, asyncio.Task] = {}
        self.turn_timer_tokens: dict[str, tuple] = {}
        self.bot_tasks: dict[str, asyncio.Task] = {}
        self.on_game_end = None
        # Coin wallet (wallet.Wallet) for stake tables; None leaves stakes untouched (tests, tools).
        self.wallet = None
        # Individual medals (medals.Medals); None skips awarding (tests, tools). The per-round breakdown is
        # still stored with the game either way.
        self.medals = None

    def _scope(self, query):
        return scoped_query(query, self.env)

    async def load_active(self):
        async for doc in self.db.games.find(self._scope({"status": "active"}), {"_id": 0}):
            if doc.get("state", {}).get("phase") == "match_over":
                async with self.locks[doc["id"]]:
                    await self._persist_completed_game(doc)
                continue
            self.games[doc["id"]] = doc
            changed = self._ensure_turn_deadline(doc)
            if changed:
                await self.db.games.update_one(self._scope({"id": doc["id"]}), {"$set": {
                    "turn_duration": doc["turn_duration"], "turn_id": doc.get("turn_id"),
                    "turn_deadline": doc.get("turn_deadline"), "turn_phase": doc.get("turn_phase"),
                    "turn_grace_deadline": doc.get("turn_grace_deadline"),
                }})
            self._schedule_turn_timeout(doc)
            # Recovery: finish any medal award that was stored but not applied before a restart (no repeats).
            if self.medals is not None and await self.medals.award_all(doc):
                await self._save_medal_rounds(doc)
            if doc["state"]["phase"] == "round_over":
                if deadline_timestamp(doc.get("next_round_at")) is None:
                    # Games saved before the deadline existed get a fresh pause once.
                    doc["next_round_at"] = utc_iso(self.clock() + NEXT_ROUND_DELAY)
                    await self.db.games.update_one(self._scope({"id": doc["id"]}),
                                                   {"$set": {"next_round_at": doc["next_round_at"]}})
                self._schedule_next(doc["id"])  # resumes only the remaining time
            self.kick_bots(doc["id"])

        # Recover a result row if the process stopped after persisting the terminal game state.
        async for doc in self.db.games.find(self._scope({"status": "finished"}), {"_id": 0}):
            if not await self.db.matches.find_one(self._scope({"game_id": doc["id"]}), {"_id": 1}):
                async with self.locks[doc["id"]]:
                    await self._finish_match(doc)
        log.info("restored %d active games", len(self.games))

    async def create(self, room, stake=None):
        """stake: {"tier", "name", "entry", "payout", "ref"} when every player's entry was already taken."""
        players = []
        room_bots = room.get("bots") or {}
        for seat, uid in enumerate(room["seats"]):
            u = room_bots.get(uid) or await self.db.users.find_one(self._scope({"user_id": uid}), {"_id": 0, "username": 1, "display_name": 1, "avatar_color": 1, "avatar_icon": 1})
            players.append({"user_id": uid, "seat": seat, "team": team_of(seat), "username": u["username"], "display_name": u.get("display_name") or u["username"],
                            "avatar_color": u.get("avatar_color"), "avatar_icon": u.get("avatar_icon"), "is_bot": uid in room_bots})
        match = Match.new(dealer=room["dealer_seat"], target=room["target"])
        turn_duration = PUBLIC_TURN_DURATION if room.get("is_public") else room.get("turn_duration", DEFAULT_TURN_DURATION)
        if turn_duration not in TURN_DURATIONS:
            turn_duration = DEFAULT_TURN_DURATION
        is_public = room.get("is_public", False)
        game = {"id": str(uuid.uuid4()), "env": self.env or room.get("env"), "room_code": room["code"], "is_public": is_public,
                "host_id": room.get("host_id"),
                "spectators_enabled": bool(is_public or room.get("spectators_enabled")),
                "players": players, "has_bots": bool(room_bots), "state": match.s, "status": "active",
                "turn_duration": turn_duration, "turn_phase": "normal", "turn_grace_deadline": None,
                "created_at": now_iso(), "updated_at": now_iso()}
        if stake:
            game["stake"] = dict(stake)
        self._assign_turn_deadline(game)
        await self.db.games.insert_one(dict(game))
        game.pop("_id", None)
        self.games[game["id"]] = game
        self._schedule_turn_timeout(game)
        await self._log(game["id"], "game_started", None, {"dealer": room["dealer_seat"], "target": room["target"]})
        return game

    def seat_of(self, game, uid):
        for p in game["players"]:
            if p["user_id"] == uid:
                return p["seat"]
        return None

    async def get(self, gid):
        game = self.games.get(gid)
        if game is None:
            game = await self.db.games.find_one(self._scope({"id": gid}), {"_id": 0})
            if game and game.get("status") == "active":
                self.games[gid] = game
        if game and game.get("status") == "active":
            changed = self._ensure_turn_deadline(game)
            if changed:
                await self.db.games.update_one(self._scope({"id": gid}), {"$set": {
                    "turn_duration": game["turn_duration"], "turn_id": game.get("turn_id"),
                    "turn_deadline": game.get("turn_deadline"), "turn_phase": game.get("turn_phase"),
                    "turn_grace_deadline": game.get("turn_grace_deadline"),
                }})
            self._schedule_turn_timeout(game)
        if game and game.get("state", {}).get("phase") == "match_over":
            async with self.locks[gid]:
                game = self.games.get(gid) or game
                if game.get("status") != "finished":
                    await self._persist_completed_game(game)
                elif not await self.db.matches.find_one(self._scope({"game_id": gid}), {"_id": 1}):
                    await self._finish_match(game)
        return game

    def view_for(self, game, uid):
        seat = self.seat_of(game, uid)
        players = [{**p, "online": p.get("is_bot") or self.hub.online(p["user_id"])} for p in game["players"]]
        result_summary = game.get("result_summary")
        if game.get("status") == "finished" and not result_summary:
            result_summary = match_result_summary(game)
        return {"type": "game_state", "game_id": game["id"], "room_code": game["room_code"], "status": game["status"],
                "is_public": game.get("is_public", False), "has_bots": game.get("has_bots", False),
                "spectators_enabled": bool(game.get("is_public") or game.get("spectators_enabled")),
                "can_manage_spectators": bool(not game.get("is_public") and game.get("host_id") == uid),
                "created_at": game.get("created_at"), "finished_at": game.get("finished_at"),
                "result_summary": result_summary, "turn_duration": game.get("turn_duration", DEFAULT_TURN_DURATION),
                "turn_deadline": game.get("turn_deadline"), "turn_phase": game.get("turn_phase", "normal"),
                "turn_grace_deadline": game.get("turn_grace_deadline"), "server_time": utc_iso(self.clock()),
                "turn_seat": self._turn_seat(game) if game.get("status") == "active" else None,
                "next_round_at": self._next_round_at(game),
                "stake": game.get("stake"),
                "medals_eligible": match_is_eligible(game), "round_medals": private_view(self._round_medals(game), uid),
                "match_medals": private_view(self._match_medals(game), uid),
                "players": players, "state": Match(game["state"]).view(seat)}

    @staticmethod
    def _match_medals(game):
        """Every round's medal changes once the match is over (match-over screen), or None."""
        if (game.get("state") or {}).get("phase") != "match_over" or not match_is_eligible(game):
            return None
        return match_medal_summary(game)

    @staticmethod
    def _round_medals(game):
        """The server-computed medal breakdown of the round on show (round results), or None. Only public
        facts are in it: which seat won how many tricks and how many tens those tricks held."""
        s = game.get("state") or {}
        if s.get("phase") not in ("round_over", "match_over") or not s.get("result"):
            return None
        return next((r for r in game.get("medal_rounds") or [] if r.get("round") == s.get("round_no")), None)

    async def broadcast(self, game):
        await asyncio.gather(*(self.hub.send(p["user_id"], self.view_for(game, p["user_id"])) for p in game["players"]))
        await self.broadcast_spectators(game)

    def spectator_view(self, game):
        online = {p["user_id"]: bool(p.get("is_bot") or self.hub.online(p["user_id"])) for p in game.get("players", ())}
        view = spectator_projection(game, self.spectators.count(game["id"]), utc_iso(self.clock()), online)
        view["turn_seat"] = self._turn_seat(game) if game.get("status") == "active" else None
        view["next_round_at"] = self._next_round_at(game)
        return view

    @staticmethod
    def _next_round_at(game):
        state = game.get("state") or {}
        if game.get("status") != "active" or state.get("phase") != "round_over":
            return None
        return game.get("next_round_at")

    async def audit_admin(self, admin_id, action, *, target_type=None, target_id=None, success=True,
                          reason=None, previous_value=None, new_value=None):
        """Persist a minimal, secret-free record of an administrative operation."""
        record = {
            "env": self.env,
            "admin_id": admin_id,
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "timestamp": utc_iso(self.clock()),
            "success": bool(success),
        }
        if reason:
            record["reason"] = str(reason)[:300]
        if previous_value is not None:
            record["previous_value"] = previous_value
        if new_value is not None:
            record["new_value"] = new_value
        await self.db.admin_audit_logs.insert_one(record)

    async def broadcast_spectators(self, game):
        for _ in range(2):
            removed = await self.spectators.broadcast(game["id"], self.spectator_view(game))
            if not removed:
                break
        if game.get("status") != "active":
            # Deliver the terminal snapshot, then stop counting/retaining live watchers.
            # Persistent recovery grants remain until their TTL so a refresh can still
            # retrieve the final public result.
            for uid in self.spectators.admin_users(game["id"]):
                try:
                    await self.audit_admin(uid, "spectator_session_ended", target_type="game",
                                           target_id=game["id"], reason="match ended")
                except Exception:
                    log.exception("failed to write terminal spectator audit event")
            self.spectators.clear(game["id"])

    async def spectator_snapshot(self, uid, game_id, invite_token=None):
        game = await self.get(game_id)
        await require_spectator_access(self.db, game, uid, invite_token, env=self.env,
                                       now=datetime.fromtimestamp(self.clock(), timezone.utc),
                                       allow_previous_session=True)
        return self.spectator_view(game)

    async def admin_spectator_snapshot(self, uid, game_id):
        game = await self.get(game_id)
        if not game or game.get("status") != "active" or self.seat_of(game, uid) is not None:
            raise SpectatorAccessError("Match unavailable or spectator access denied")
        if not game.get("is_public"):
            await self.audit_admin(uid, "private_room_spectator_view", target_type="game", target_id=game_id)
        return self.spectator_view(game)

    async def join_spectator(self, uid, game_id, ws, invite_token=None):
        game = await self.get(game_id)
        access_hash = await require_spectator_access(
            self.db, game, uid, invite_token, env=self.env, now=datetime.fromtimestamp(self.clock(), timezone.utc),
            allow_previous_session=True,
        )
        if not self.spectators.add(game_id, uid, ws):
            raise SpectatorAccessError("This match has reached its spectator limit")
        if game.get("status") == "active":
            expires_at = datetime.fromtimestamp(self.clock() + 60 * 60, timezone.utc)
            try:
                await self.db.spectator_sessions.update_one(
                    self._scope({"game_id": game_id, "user_id": uid}),
                    {"$set": {"env": self.env, "game_id": game_id, "user_id": uid, "invite_hash": access_hash,
                               "expires_at": expires_at}},
                    upsert=True,
                )
            except Exception:
                self.spectators.remove(game_id, uid, ws)
                raise
        await self.broadcast_spectators(game)
        return True

    async def join_admin_spectator(self, uid, game_id, ws):
        game = await self.get(game_id)
        if not game or game.get("status") != "active" or self.seat_of(game, uid) is not None:
            raise SpectatorAccessError("Match unavailable or spectator access denied")
        was_admin = self.spectators.is_admin(game_id, uid)
        if not self.spectators.add(game_id, uid, ws, admin=True):
            raise SpectatorAccessError("This match has reached its spectator limit")
        if not was_admin:
            try:
                await self.audit_admin(uid, "spectator_session_started", target_type="game", target_id=game_id)
            except Exception:
                self.spectators.remove(game_id, uid, ws)
                raise
        await self.broadcast_spectators(game)
        return True

    async def leave_spectator(self, uid, game_id, ws):
        was_admin = self.spectators.is_admin(game_id, uid)
        changed = self.spectators.remove(game_id, uid, ws)
        game = self.games.get(game_id)
        if changed and game:
            if not was_admin:
                await self.db.spectator_sessions.delete_one(self._scope({"game_id": game_id, "user_id": uid}))
            else:
                await self.audit_admin(uid, "spectator_session_ended", target_type="game", target_id=game_id)
            await self.broadcast_spectators(game)
        return changed

    async def disconnect_spectator(self, ws, uid=None):
        ended_admin = [
            (game_id, member_uid) for game_id, members in list(self.spectators.members.items())
            for member_uid, current in list(members.items())
            if current is ws and (uid is None or member_uid == uid) and self.spectators.is_admin(game_id, member_uid)
        ]
        changed_games = self.spectators.remove_socket(ws)
        for game_id, member_uid in ended_admin:
            try:
                await self.audit_admin(member_uid, "spectator_session_ended", target_type="game", target_id=game_id)
            except Exception:
                log.exception("failed to write disconnected spectator audit event")
        for game_id in changed_games:
            game = self.games.get(game_id)
            if game:
                await self.broadcast_spectators(game)
        return changed_games

    async def revoke_spectators(self, game_id):
        for uid in self.spectators.admin_users(game_id):
            try:
                await self.audit_admin(uid, "spectator_session_ended", target_type="game",
                                       target_id=game_id, reason="spectator access revoked")
            except Exception:
                log.exception("failed to write revoked spectator audit event")
        count = await self.spectators.revoke(game_id)
        await self.db.spectator_sessions.delete_many(self._scope({"game_id": game_id}))
        return count

    async def revoke_invited_spectators(self, game_id):
        """Revoke guest invite grants while leaving separately-authorized ops views intact."""
        count = await self.spectators.revoke_invited(game_id)
        await self.db.spectator_sessions.delete_many(self._scope({"game_id": game_id}))
        game = self.games.get(game_id)
        if game:
            await self.broadcast_spectators(game)
        return count

    async def revoke_admin_spectators(self, uid):
        """Stop privileged live views as soon as a staff role loses spectate access."""
        game_ids = await self.spectators.revoke_admin_user(uid)
        for game_id in game_ids:
            try:
                await self.audit_admin(uid, "spectator_session_ended", target_type="game",
                                       target_id=game_id, reason="spectator permission revoked")
            except Exception:
                log.warning("failed to record revoked admin spectator session")
            game = self.games.get(game_id)
            if game:
                await self.broadcast_spectators(game)
        return len(game_ids)

    async def handle(self, uid, msg):
        gid = msg.get("game_id")
        game = self.games.get(gid)
        if not game or self.seat_of(game, uid) is None:
            return {"type": "error", "message": "Game not found"}
        seat = self.seat_of(game, uid)
        action = msg.get("action")
        timeout_outcome = None
        action_error = None
        exit_requested = False
        async with self.locks[gid]:
            if game["status"] != "active":
                return {"type": "error", "message": "Match has already ended"}
            if self._ensure_turn_deadline(game):
                await self._persist_turn_timing(game)
                self._schedule_turn_timeout(game)
            timeout_outcome = await self._advance_turn_timer_locked(game)
            if timeout_outcome in TIMEOUT_ACTIONS:
                pass
            elif action == "exit":
                exit_requested = True
            else:
                m = Match(game["state"])
                rounds_before = len(m.s["rounds"])
                try:
                    if action == "select_trump":
                        m.select_trump(seat, str(msg.get("suit", "")))
                    elif action == "play":
                        m.play(seat, str(msg.get("card", "")))
                    elif action == "koth":
                        m.koth_decide(seat, bool(msg.get("declare")))
                    elif action == "grand_slam":
                        m.grand_slam_decide(seat, bool(msg.get("declare")))
                    elif action == "forfeit":
                        m.forfeit(seat)
                    else:
                        raise GameError("Unknown action")
                except GameError as e:
                    action_error = str(e)
                else:
                    public = {k: msg.get(k) for k in ("suit", "card", "declare") if k in msg}
                    await self._log(gid, action, seat, public)
                    await self._after_change(game, rounds_before)
        if timeout_outcome in TIMEOUT_ACTIONS:
            await self.broadcast(game)
            if game.get("status") == "active":
                self.kick_bots(gid)
            if timeout_outcome == "auto_play":
                return {"type": "error", "message": "Turn expired. An automatic legal card was played."}
            if timeout_outcome == "auto_decision":
                return {"type": "error", "message": "Turn expired. The default choice was made automatically."}
            if timeout_outcome == "forfeit":
                return {"type": "error", "message": "Turn expired during a decision. The match was forfeited."}
            return {"type": "error", "message": "Turn expired, but the game engine could not recover the turn."}
        if action_error:
            if timeout_outcome == "grace":
                await self.broadcast(game)
            return {"type": "error", "message": action_error}
        if exit_requested:
            return await self.cancel(gid, uid)
        await self.broadcast(game)
        self.kick_bots(gid)
        return None

    @staticmethod
    def _valid_seat(seat):
        return seat if isinstance(seat, int) and not isinstance(seat, bool) and seat in range(4) else None

    def _decision_seat(self, game, team, preferred):
        """The seat that owns a team decision's timer: a human who can actually answer the prompt.

        Either teammate may decide; the trick winner is preferred, but a bot seat is skipped when its
        partner is human because bots only decide for all-bot teams.
        """
        if team not in (0, 1) or isinstance(team, bool):
            return None
        seats = [team, team + 2]
        if preferred in seats:
            seats.sort(key=lambda s: s != preferred)
        bot_seats = {p.get("seat") for p in game.get("players", ()) if p.get("is_bot")}
        return next((s for s in seats if s not in bot_seats), seats[0])

    def _turn_seat(self, game):
        state = game.get("state") or {}
        phase = state.get("phase")
        if phase not in ("trump_select", "playing", "koth_decision", "gs_decision"):
            return None
        if phase == "trump_select":
            return self._valid_seat(state.get("trump_selector"))
        if phase == "koth_decision":
            return self._decision_seat(game, state.get("koth_decision"), self._valid_seat(state.get("turn")))
        if phase == "gs_decision":
            return self._decision_seat(game, state.get("gs_eligible"), self._valid_seat(state.get("turn")))
        return self._valid_seat(state.get("turn"))

    def _turn_key(self, game):
        seat = self._turn_seat(game)
        if seat is None:
            return None
        state = game["state"]
        return f"{state.get('seq', 0)}:{state.get('phase')}:{seat}"

    def _assign_turn_deadline(self, game):
        key = self._turn_key(game) if game.get("status") == "active" else None
        if key is None:
            game["turn_id"] = None
            game["turn_deadline"] = None
            game["turn_phase"] = None
            game["turn_grace_deadline"] = None
            return
        duration = game.get("turn_duration", DEFAULT_TURN_DURATION)
        if duration not in TURN_DURATIONS:
            duration = DEFAULT_TURN_DURATION
        game["turn_duration"] = duration
        game["turn_id"] = key
        game["turn_deadline"] = utc_iso(self.clock() + duration)
        game["turn_phase"] = "normal"
        game["turn_grace_deadline"] = None

    def _ensure_turn_deadline(self, game):
        previous_duration = game.get("turn_duration")
        previous_turn_id = game.get("turn_id")
        previous_timing = (game.get("turn_deadline"), game.get("turn_phase"), game.get("turn_grace_deadline"))
        fallback_duration = PUBLIC_TURN_DURATION if game.get("is_public") else DEFAULT_TURN_DURATION
        duration = game.get("turn_duration", fallback_duration)
        if duration not in TURN_DURATIONS:
            duration = fallback_duration
        game["turn_duration"] = duration
        key = self._turn_key(game) if game.get("status") == "active" else None
        if key is None:
            game["turn_id"] = None
            game["turn_deadline"] = None
            game["turn_phase"] = None
            game["turn_grace_deadline"] = None
            return (previous_duration != duration or previous_turn_id is not None
                    or any(value is not None for value in previous_timing))
        deadline = deadline_timestamp(game.get("turn_deadline"))
        if game.get("turn_id") != key or deadline is None:
            self._assign_turn_deadline(game)
            return True
        if game.get("turn_phase") not in ("normal", "grace"):
            game["turn_phase"] = "normal"
            game["turn_grace_deadline"] = None
        if game.get("turn_phase") == "grace":
            if deadline_timestamp(game.get("turn_grace_deadline")) is None:
                # Recover the original five-second window from the durable normal deadline.
                game["turn_grace_deadline"] = utc_iso(deadline + TURN_GRACE_SECONDS)
        else:
            game["turn_grace_deadline"] = None
        return (previous_duration != duration or previous_turn_id != game.get("turn_id")
                or previous_timing != (game.get("turn_deadline"), game.get("turn_phase"), game.get("turn_grace_deadline")))

    def _timer_deadline_value(self, game):
        if game.get("turn_phase") == "grace":
            return game.get("turn_grace_deadline")
        return game.get("turn_deadline")

    def _timer_token(self, game):
        return (game.get("turn_id"), game.get("turn_phase"), self._timer_deadline_value(game))

    def _deadline_expired(self, game):
        deadline = deadline_timestamp(self._timer_deadline_value(game))
        return deadline is not None and self.clock() >= deadline

    async def _persist_turn_timing(self, game):
        await self.db.games.update_one(self._scope({"id": game["id"]}), {"$set": {
            "turn_duration": game.get("turn_duration", DEFAULT_TURN_DURATION),
            "turn_id": game.get("turn_id"), "turn_deadline": game.get("turn_deadline"),
            "turn_phase": game.get("turn_phase"), "turn_grace_deadline": game.get("turn_grace_deadline"),
        }})

    def _schedule_turn_timeout(self, game):
        gid = game["id"]
        deadline = deadline_timestamp(self._timer_deadline_value(game))
        token = self._timer_token(game)
        previous = self.turn_timers.get(gid)
        if (previous and not previous.done() and self.turn_timer_tokens.get(gid) == token
                and self.schedule_turn_timers and token[0] and deadline is not None):
            return
        previous = self.turn_timers.pop(gid, None)
        self.turn_timer_tokens.pop(gid, None)
        if previous and not previous.done() and previous is not asyncio.current_task():
            previous.cancel()
        if not self.schedule_turn_timers or not game.get("turn_id"):
            return
        if deadline is None:
            return
        self.turn_timer_tokens[gid] = token
        self.turn_timers[gid] = asyncio.create_task(self._wait_for_turn_deadline(gid, token, deadline))

    def _cancel_turn_timeout(self, gid):
        task = self.turn_timers.pop(gid, None)
        self.turn_timer_tokens.pop(gid, None)
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()

    async def _wait_for_turn_deadline(self, gid, token, deadline):
        try:
            while True:
                remaining = deadline - self.clock()
                if remaining <= 0:
                    break
                await self.sleep(remaining)
            await self._timeout_turn(gid, token)
        except asyncio.CancelledError:
            return

    async def _timeout_turn(self, gid, token):
        async with self.locks[gid]:
            game = self.games.get(gid)
            if not game:
                return None
            timed_out = await self._timeout_turn_locked(game, token)
        if timed_out:
            await self.broadcast(game)
            if game.get("status") == "active":
                self.kick_bots(gid)
        return timed_out

    async def _advance_turn_timer_locked(self, game):
        """Process every elapsed phase while holding the per-game lock."""
        while game.get("status") == "active" and self._deadline_expired(game):
            outcome = await self._timeout_turn_locked(game, self._timer_token(game))
            if outcome != "grace" or not self._deadline_expired(game):
                return outcome
        return None

    async def _timeout_turn_locked(self, game, expected_token):
        if (game.get("status") != "active" or not expected_token
                or self._timer_token(game) != expected_token or not self._deadline_expired(game)):
            return None
        if game.get("turn_phase") == "normal":
            normal_deadline = deadline_timestamp(game.get("turn_deadline"))
            if normal_deadline is None:
                return None
            game["turn_phase"] = "grace"
            game["turn_grace_deadline"] = utc_iso(normal_deadline + TURN_GRACE_SECONDS)
            await self._persist_turn_timing(game)
            seat = self._turn_seat(game)
            await self._log(game["id"], "turn_grace_started", seat,
                            {"turn_id": game.get("turn_id"), "grace_deadline": game["turn_grace_deadline"]})
            self._schedule_turn_timeout(game)
            return "grace"

        seat = self._turn_seat(game)
        if seat is None:
            return None
        match = Match(game["state"])
        rounds_before = len(match.s["rounds"])
        expired_phase = match.s.get("phase")
        if expired_phase == "playing":
            try:
                candidates = legal_cards(match.s["hands"][seat], match.s["trick"])
                if not candidates:
                    raise GameError("No legal card is available for the timed-out turn")
                card = candidates[0]
                match.play(seat, card)
            except (GameError, IndexError, KeyError, TypeError) as error:
                # Do not invent a card or bypass Match.play; use the engine's existing recovery.
                await self._log(game["id"], "timeout_auto_play_failed", seat,
                                {"phase": expired_phase, "reason": str(error)[:160]})
                match = Match(game["state"])
                rounds_before = len(match.s["rounds"])
                try:
                    match.forfeit(seat)
                except GameError:
                    return "error"
                await self._log(game["id"], "timeout_forfeit", seat,
                                {"phase": expired_phase, "reason": "automatic_card_unavailable"})
                await self._after_change(game, rounds_before)
                return "forfeit"
            await self._log(game["id"], "turn_auto_play", seat,
                            {"card": card, "turn_id": game.get("turn_id")})
            await self._after_change(game, rounds_before)
            return "auto_play"

        # Approved rule: an expired selection or declaration takes the default choice instead of
        # forfeiting the match. Trump: the selector's strongest suit among their first five cards.
        # Koth and Grand Slam: decline.
        try:
            if expired_phase == "trump_select":
                data = {"suit": bots.choose_trump(match.s["hands"][seat])}
                match.select_trump(seat, data["suit"])
            elif expired_phase == "koth_decision":
                data = {"declare": False}
                match.koth_decide(seat, False)
            elif expired_phase == "gs_decision":
                data = {"declare": False}
                match.grand_slam_decide(seat, False)
            else:
                raise GameError("No default action for this phase")
        except (GameError, IndexError, KeyError, TypeError, ValueError) as error:
            await self._log(game["id"], "timeout_default_failed", seat,
                            {"phase": expired_phase, "reason": str(error)[:160]})
            match = Match(game["state"])
            rounds_before = len(match.s["rounds"])
            try:
                match.forfeit(seat)
            except GameError:
                return "error"
            await self._log(game["id"], "timeout_forfeit", seat, {"phase": expired_phase})
            await self._after_change(game, rounds_before)
            return "forfeit"
        await self._log(game["id"], "turn_auto_decision", seat,
                        {"phase": expired_phase, **data, "turn_id": game.get("turn_id")})
        await self._after_change(game, rounds_before)
        return "auto_decision"

    async def cancel(self, gid, uid):
        """Authoritative, idempotent match-wide cancellation (Exit Match)."""
        async with self.locks[gid]:
            game = self.games.get(gid)
            if not game or game["status"] != "active":
                return None  # already cancelled/finished: the single broadcast was already sent
            seat = self.seat_of(game, uid)
            Match(game["state"]).cancel(seat)
            game["status"] = "cancelled"
            game["updated_at"] = now_iso()
            self.games.pop(gid, None)
            for tasks in (self.timers, self.bot_tasks):
                t = tasks.pop(gid, None)
                if t and not t.done() and t is not asyncio.current_task():
                    t.cancel()
            await self.db.games.update_one(self._scope({"id": gid}), {"$set": {"state": game["state"], "status": "cancelled",
                                                                  "cancelled_by": uid, "updated_at": game["updated_at"],
                                                                  "turn_id": None, "turn_deadline": None,
                                                                  "turn_phase": None, "turn_grace_deadline": None}})
            game["turn_id"] = None
            game["turn_deadline"] = None
            game["turn_phase"] = None
            game["turn_grace_deadline"] = None
            self._cancel_turn_timeout(gid)
            await self.db.rooms.update_one(self._scope({"code": game["room_code"]}), {"$set": {"status": "cancelled"}})
            await self._log(gid, "exit_match", seat, {})
            # Stake table: the player who exited loses their entry; everyone else gets theirs back.
            stake = game.get("stake")
            if stake and self.wallet is not None:
                others = [p["user_id"] for p in game["players"] if p["user_id"] != uid and not p.get("is_bot")]
                await self.wallet.refund(others, stake["tier"], stake["ref"])
        if self.on_game_end:
            await self.on_game_end(gid, game["room_code"])
        name = next(p["username"] for p in game["players"] if p["user_id"] == uid)
        await self.broadcast_spectators(game)
        self.spectators.clear(gid)
        await self.hub.send_many([p["user_id"] for p in game["players"]], {
            "type": "match_cancelled", "game_id": gid, "room_code": game["room_code"], "by": name,
            "message": "The match has ended because a player exited."})
        return None

    # ---------- bots ----------
    def _bot_turn(self, game):
        s = game["state"]
        bot_seats = {p["seat"] for p in game["players"] if p.get("is_bot")}
        if not bot_seats:
            return None
        team_is_bots = lambda t: {t, t + 2} <= bot_seats
        if s["phase"] == "trump_select" and s["trump_selector"] in bot_seats:
            return "select_trump", s["trump_selector"]
        if s["phase"] == "playing" and s["turn"] in bot_seats:
            return "play", s["turn"]
        if s["phase"] == "koth_decision" and team_is_bots(s["koth_decision"]):
            return "koth", s["koth_decision"]
        if s["phase"] == "gs_decision" and team_is_bots(s["gs_eligible"]):
            return "grand_slam", s["gs_eligible"]
        return None

    def kick_bots(self, gid):
        t = self.bot_tasks.get(gid)
        if t and not t.done():
            return
        self.bot_tasks[gid] = asyncio.create_task(self._run_bots(gid))

    async def _run_bots(self, gid):
        while True:
            game = self.games.get(gid)
            if not game or not self._bot_turn(game):
                return
            s = game["state"]
            # Pace bots to the table: let clients finish dealing / trick-collection animations first.
            if s["phase"] == "trump_select":
                delay = 4.5
            elif s["phase"] == "playing" and not s["tricks"] and not s["trick"]:
                delay = 3.6
            elif s["phase"] == "playing" and not s["trick"] and s["tricks"]:
                delay = 1.9
            else:
                delay = 0.9
            await self.sleep(delay)
            timeout_outcome = None
            async with self.locks[gid]:
                game = self.games.get(gid)
                turn = game and game["status"] == "active" and self._bot_turn(game)
                if not turn:
                    return
                if self._ensure_turn_deadline(game):
                    await self._persist_turn_timing(game)
                    self._schedule_turn_timeout(game)
                timeout_outcome = await self._advance_turn_timer_locked(game)
                if timeout_outcome not in TIMEOUT_ACTIONS:
                    # A bot may still act during grace; the same lock decides the race with auto-play.
                    turn = self._bot_turn(game)
                    if not turn:
                        return
                    action, seat = turn
                    m = Match(game["state"])
                    rounds_before = len(m.s["rounds"])
                    data = {}
                    try:
                        if action == "select_trump":
                            data["suit"] = bots.choose_trump(m.s["hands"][seat])
                            m.select_trump(seat, data["suit"])
                        elif action == "play":
                            data["card"] = bots.choose_card(m.s, seat)
                            m.play(seat, data["card"])
                        elif action == "koth":
                            data["declare"] = bots.decide_koth(m.s, seat)
                            m.koth_decide(seat, data["declare"])
                        else:
                            data["declare"] = bots.decide_grand_slam(m.s, seat)
                            m.grand_slam_decide(seat, data["declare"])
                    except GameError as e:
                        log.error("bot action failed in %s: %s", gid, e)
                        return
                    await self._log(gid, action, seat, {**data, "bot": True})
                    await self._after_change(game, rounds_before)
            await self.broadcast(game)
            if timeout_outcome == "error":
                return

    async def _after_change(self, game, rounds_before):
        s = game["state"]
        for r in ([] if game.get("has_bots") else s["rounds"][rounds_before:]):
            winners = [p["user_id"] for p in game["players"] if p["team"] == r["winner_team"]]
            await self.db.users.update_many(self._scope({"user_id": {"$in": winners}}),
                                            {"$inc": {f"stats.{r['type']}_wins": 1, "stats.rounds_won": 1}})
        # Medals: the breakdown of a just-completed round comes from that round's own tricks (still in the
        # state until the next round is dealt) and is saved together with the state before it is awarded.
        recorded = {r.get("round") for r in game.get("medal_rounds") or []}
        for r in s["rounds"][rounds_before:]:
            breakdown = round_breakdown(game, r, s.get("tricks"))
            if breakdown and breakdown["round"] not in recorded:
                game.setdefault("medal_rounds", []).append(breakdown)
        game["updated_at"] = now_iso()
        if s["phase"] == "match_over":
            await self._persist_completed_game(game)
        else:
            self._assign_turn_deadline(game)
            new_round_result = s["phase"] == "round_over" and len(s["rounds"]) > rounds_before
            if new_round_result:
                # One authoritative deadline shared by every client, reconnects and restarts.
                game["next_round_at"] = utc_iso(self.clock() + NEXT_ROUND_DELAY)
            elif s["phase"] != "round_over":
                game["next_round_at"] = None
            if new_round_result:
                self._schedule_next(game["id"])
            await self.db.games.update_one(self._scope({"id": game["id"]}), {"$set": {
                "state": s, "status": game["status"], "updated_at": game["updated_at"],
                "turn_duration": game["turn_duration"], "turn_id": game.get("turn_id"),
                "turn_deadline": game.get("turn_deadline"), "turn_phase": game.get("turn_phase"),
                "turn_grace_deadline": game.get("turn_grace_deadline"),
                "next_round_at": game.get("next_round_at"), "medal_rounds": game.get("medal_rounds") or [],
            }})
            if self.medals is not None and await self.medals.award_all(game):
                await self._save_medal_rounds(game)
            self._schedule_turn_timeout(game)

    async def _persist_completed_game(self, game):
        game["status"] = "finished"
        game["finished_at"] = game.get("finished_at") or now_iso()
        game["updated_at"] = game["finished_at"]
        game["result_summary"] = match_result_summary(game)
        await self._finish_match(game)

    async def _finish_match(self, game):
        s = game["state"]
        game["status"] = "finished"
        game["turn_id"] = None
        game["turn_deadline"] = None
        game["turn_phase"] = None
        game["turn_grace_deadline"] = None
        self._cancel_turn_timeout(game["id"])
        game["finished_at"] = game.get("finished_at") or game.get("updated_at") or now_iso()
        game["updated_at"] = game["finished_at"]
        summary = game.get("result_summary") or match_result_summary(game)
        game["result_summary"] = summary
        wt = s["winner_team"]
        # Medals are applied on every pass (each round at most once) and before the history row, so the
        # row and the saved game carry the actual changes; a restart still applies anything missing.
        if self.medals is not None:
            await self.medals.award_all(game)
        # Keep the authoritative terminal snapshot durable before the history upsert.
        # This also repairs older finished documents encountered during startup/reconnect.
        await self.db.games.update_one(self._scope({"id": game["id"]}), {"$set": {
            "state": s, "status": "finished", "updated_at": game["updated_at"],
            "finished_at": game["finished_at"], "result_summary": summary, "medal_rounds": game.get("medal_rounds") or [],
            "turn_id": None, "turn_deadline": None, "turn_phase": None, "turn_grace_deadline": None,
        }})
        match = {
            "id": str(uuid.uuid4()), "env": self.env or game.get("env"), "game_id": game["id"], "room_code": game["room_code"], "is_public": game.get("is_public", False), "has_bots": game.get("has_bots", False),
            "players": game["players"], "player_ids": [p["user_id"] for p in game["players"]],
            "scores": summary["scores"], "target": summary["target"], "winner_team": wt, "rounds": s["rounds"], "forfeited_by": s.get("forfeited_by"),
            "tricks_won": summary["tricks_won"], "total_tricks": summary["total_tricks"], "rounds_played": summary["rounds_played"],
            "final_trump": summary["final_trump"], "last_trick": summary["last_trick"], "result_summary": summary,
            "started_at": summary["started_at"], "finished_at": summary["finished_at"], "duration_seconds": summary["duration_seconds"],
        }
        if game.get("stake"):
            match["stake"] = game["stake"]
        match["medals"] = match_medal_summary(game)
        inserted = await self.db.matches.update_one(self._scope({"game_id": game["id"]}), {"$setOnInsert": match}, upsert=True)
        # Pay the stake on every pass, not only the first: if the process stopped after the history row was
        # written, the startup recovery still pays. The wallet applies each payout at most once.
        await self._settle_stake(game, wt)
        if inserted.upserted_id is not None:
            for p in ([] if game.get("has_bots") else game["players"]):
                uid = p["user_id"]
                async with self.profile_locks[uid]:
                    user = await self.db.users.find_one(self._scope({"user_id": uid}), {"_id": 0, "stats": 1, "progression": 1, "achievement_unlocks": 1})
                    if not user:
                        continue
                    user = await ensure_streak_history(self.db, uid, user, exclude_game_id=game["id"], env=self.env)
                    update = match_profile_update(
                        user,
                        game_id=game["id"],
                        team=p["team"],
                        winner_team=wt,
                        tricks_won=summary["tricks_won"],
                        duration_seconds=summary["duration_seconds"],
                        finished_at=summary["finished_at"],
                    )
                    increments = {f"stats.{key}": value for key, value in update["stats_increment"].items() if value}
                    await self.db.users.update_one(self._scope({"user_id": uid}), {"$inc": increments, "$set": {
                        "progression": update["progression"],
                        "achievement_unlocks": update["achievement_unlocks"],
                    }})
                    if update["level_after"] > update["level_before"]:
                        await self.hub.send(uid, {"type": "level_up", "level": update["level_after"]})
        await self.db.rooms.update_one(self._scope({"code": game["room_code"]}), {"$set": {"status": "finished"}})
        if self.on_game_end:
            await self.on_game_end(game["id"], game["room_code"])
        self.games.pop(game["id"], None)
        timer = self.timers.pop(game["id"], None)
        if timer and not timer.done() and timer is not asyncio.current_task():
            timer.cancel()

    async def _save_medal_rounds(self, game):
        await self.db.games.update_one(self._scope({"id": game["id"]}), {"$set": {"medal_rounds": game.get("medal_rounds") or []}})

    async def _settle_stake(self, game, winner_team):
        """Stake table finished: the winning partners share the pot (after the table fee). A finished match
        without a winner (not produced by the current rules) gives every entry back."""
        stake = game.get("stake")
        if not stake or self.wallet is None:
            return
        humans = [p for p in game["players"] if not p.get("is_bot")]
        if winner_team in (0, 1):
            winners = [p["user_id"] for p in humans if p["team"] == winner_team]
            await self.wallet.pay_winners(winners, stake["tier"], stake["ref"])
        else:
            await self.wallet.refund([p["user_id"] for p in humans], stake["tier"], stake["ref"])

    def _schedule_next(self, gid):
        old = self.timers.get(gid)
        if old and not old.done():
            return
        self.timers[gid] = asyncio.create_task(self._next_round_later(gid))

    async def _next_round_later(self, gid):
        game = self.games.get(gid)
        if not game:
            return
        token = game.get("next_round_at")
        deadline = deadline_timestamp(token)
        delay = NEXT_ROUND_DELAY if deadline is None else max(0.0, deadline - self.clock())
        await asyncio.sleep(delay)
        game = self.games.get(gid)
        if not game:
            return
        async with self.locks[gid]:
            m = Match(game["state"])
            # Only the timer for this exact result may start the next round (no duplicate rounds).
            if m.s["phase"] != "round_over" or game.get("next_round_at") != token:
                return
            m.next_round()
            await self._after_change(game, len(m.s["rounds"]))
        await self.broadcast(game)
        self.kick_bots(gid)

    async def _log(self, gid, kind, seat, data):
        await self.db.game_events.insert_one({"env": self.env, "game_id": gid, "type": kind, "seat": seat, "data": data, "ts": now_iso()})

    def active_game_for(self, uid):
        for g in self.games.values():
            if any(p["user_id"] == uid for p in g["players"]):
                return g
        return None
