import asyncio
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import WebSocket

from engine import Match, GameError, team_of
import bots

log = logging.getLogger("dehla")
NEXT_ROUND_DELAY = 7
EMOJIS = {"👏", "😂", "🔥", "😮", "😢", "🙏", "👍", "😎"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


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


class GameService:
    """Owns live matches in memory; every change is persisted so games survive restarts."""

    def __init__(self, db, hub: Hub):
        self.db, self.hub = db, hub
        self.games: dict[str, dict] = {}
        self.locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.timers: dict[str, asyncio.Task] = {}
        self.bot_tasks: dict[str, asyncio.Task] = {}

    async def load_active(self):
        async for doc in self.db.games.find({"status": "active"}, {"_id": 0}):
            self.games[doc["id"]] = doc
            if doc["state"]["phase"] == "round_over":
                self._schedule_next(doc["id"])
            self.kick_bots(doc["id"])
        log.info("restored %d active games", len(self.games))

    async def create(self, room):
        players = []
        room_bots = room.get("bots") or {}
        for seat, uid in enumerate(room["seats"]):
            u = room_bots.get(uid) or await self.db.users.find_one({"user_id": uid}, {"_id": 0, "username": 1, "avatar_color": 1, "avatar_icon": 1})
            players.append({"user_id": uid, "seat": seat, "team": team_of(seat), "username": u["username"],
                            "avatar_color": u.get("avatar_color"), "avatar_icon": u.get("avatar_icon"), "is_bot": uid in room_bots})
        match = Match.new(dealer=room["dealer_seat"], target=room["target"])
        game = {"id": str(uuid.uuid4()), "room_code": room["code"], "is_public": room.get("is_public", False),
                "players": players, "has_bots": bool(room_bots), "state": match.s, "status": "active", "created_at": now_iso(), "updated_at": now_iso()}
        await self.db.games.insert_one(dict(game))
        game.pop("_id", None)
        self.games[game["id"]] = game
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
            game = await self.db.games.find_one({"id": gid}, {"_id": 0})
        return game

    def view_for(self, game, uid):
        seat = self.seat_of(game, uid)
        players = [{**p, "online": p.get("is_bot") or self.hub.online(p["user_id"])} for p in game["players"]]
        return {"type": "game_state", "game_id": game["id"], "room_code": game["room_code"], "status": game["status"],
                "players": players, "state": Match(game["state"]).view(seat)}

    async def broadcast(self, game):
        await asyncio.gather(*(self.hub.send(p["user_id"], self.view_for(game, p["user_id"])) for p in game["players"]))

    async def handle(self, uid, msg):
        gid = msg.get("game_id")
        game = self.games.get(gid)
        if not game or self.seat_of(game, uid) is None:
            return {"type": "error", "message": "Game not found"}
        seat = self.seat_of(game, uid)
        action = msg.get("action")
        if action == "exit":
            return await self.cancel(gid, uid)
        async with self.locks[gid]:
            if game["status"] != "active":
                return {"type": "error", "message": "Match has already ended"}
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
                return {"type": "error", "message": str(e)}
            public = {k: msg.get(k) for k in ("suit", "card", "declare") if k in msg}
            await self._log(gid, action, seat, public)
            await self._after_change(game, rounds_before)
        await self.broadcast(game)
        self.kick_bots(gid)
        return None

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
            await self.db.games.update_one({"id": gid}, {"$set": {"state": game["state"], "status": "cancelled",
                                                                  "cancelled_by": uid, "updated_at": game["updated_at"]}})
            await self.db.rooms.update_one({"code": game["room_code"]}, {"$set": {"status": "cancelled"}})
            await self._log(gid, "exit_match", seat, {})
        name = next(p["username"] for p in game["players"] if p["user_id"] == uid)
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
            await asyncio.sleep(delay)
            async with self.locks[gid]:
                game = self.games.get(gid)
                turn = game and game["status"] == "active" and self._bot_turn(game)
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

    async def _after_change(self, game, rounds_before):
        s = game["state"]
        for r in ([] if game.get("has_bots") else s["rounds"][rounds_before:]):
            winners = [p["user_id"] for p in game["players"] if p["team"] == r["winner_team"]]
            await self.db.users.update_many({"user_id": {"$in": winners}},
                                            {"$inc": {f"stats.{r['type']}_wins": 1, "stats.rounds_won": 1}})
        if s["phase"] == "match_over":
            await self._finish_match(game)
        elif s["phase"] == "round_over" and len(s["rounds"]) > rounds_before:
            self._schedule_next(game["id"])
        game["updated_at"] = now_iso()
        await self.db.games.update_one({"id": game["id"]}, {"$set": {"state": s, "status": game["status"], "updated_at": game["updated_at"]}})

    async def _finish_match(self, game):
        s = game["state"]
        game["status"] = "finished"
        wt = s["winner_team"]
        for p in ([] if game.get("has_bots") else game["players"]):
            won = p["team"] == wt
            await self.db.users.update_one({"user_id": p["user_id"]},
                                           {"$inc": {"stats.games_played": 1, "stats.wins" if won else "stats.losses": 1}})
        await self.db.matches.insert_one({
            "id": str(uuid.uuid4()), "game_id": game["id"], "room_code": game["room_code"], "is_public": game["is_public"], "has_bots": game.get("has_bots", False),
            "players": game["players"], "player_ids": [p["user_id"] for p in game["players"]],
            "scores": s["scores"], "target": s["target"], "winner_team": wt, "rounds": s["rounds"], "forfeited_by": s.get("forfeited_by"),
            "started_at": game["created_at"], "finished_at": now_iso()})
        await self.db.rooms.update_one({"code": game["room_code"]}, {"$set": {"status": "finished"}})
        self.games.pop(game["id"], None)
        timer = self.timers.pop(game["id"], None)
        if timer and not timer.done() and timer is not asyncio.current_task():
            timer.cancel()

    def _schedule_next(self, gid):
        old = self.timers.get(gid)
        if old and not old.done():
            return
        self.timers[gid] = asyncio.create_task(self._next_round_later(gid))

    async def _next_round_later(self, gid):
        await asyncio.sleep(NEXT_ROUND_DELAY)
        game = self.games.get(gid)
        if not game:
            return
        async with self.locks[gid]:
            m = Match(game["state"])
            if m.s["phase"] != "round_over":
                return
            m.next_round()
            await self._after_change(game, len(m.s["rounds"]))
        await self.broadcast(game)
        self.kick_bots(gid)

    async def _log(self, gid, kind, seat, data):
        await self.db.game_events.insert_one({"game_id": gid, "type": kind, "seat": seat, "data": data, "ts": now_iso()})

    def active_game_for(self, uid):
        for g in self.games.values():
            if any(p["user_id"] == uid for p in g["players"]):
                return g
        return None
