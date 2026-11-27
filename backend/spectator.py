"""Spectator access checks and explicit public-state projections."""

import hashlib
import hmac
from datetime import datetime, timezone


class SpectatorAccessError(Exception):
    """Raised when an authenticated user cannot watch a game."""


def spectator_invite_hash(token):
    if not isinstance(token, str) or not 32 <= len(token) <= 160:
        raise SpectatorAccessError("Spectator access denied")
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def require_spectator_access(db, game, user_id, invite_token=None, *, now=None, allow_previous_session=False, env=None):
    """Validate active-game eligibility and private-room access on every join/recovery."""
    if not game or game.get("status") not in (("active", "finished", "cancelled") if allow_previous_session else ("active",)):
        raise SpectatorAccessError("Spectator access denied")
    if any(player.get("user_id") == user_id for player in game.get("players", ())):
        raise SpectatorAccessError("Players cannot spectate their own active match")
    now = now or datetime.now(timezone.utc)
    environment = env if env is not None else game.get("env")
    env_filter = {"env": environment} if environment is not None else {}
    prior_session = None
    if allow_previous_session:
        prior_session = await db.spectator_sessions.find_one(
            {"game_id": game.get("id"), "user_id": user_id, "expires_at": {"$gt": now}, **env_filter},
            {"_id": 0, "invite_hash": 1},
        )
    if game.get("status") != "active" and not prior_session:
        raise SpectatorAccessError("Spectator access denied")
    if game.get("is_public"):
        return None if not prior_session else prior_session.get("invite_hash")

    code = game.get("room_code")
    room = await db.rooms.find_one(
        {"code": code, **env_filter},
        {"_id": 0, "code": 1, "is_public": 1, "status": 1, "spectators_enabled": 1,
         "spectator_invite_hash": 1},
    )
    if (not room or room.get("is_public") or room.get("status") not in ("playing", "finished", "cancelled")
            or not room.get("spectators_enabled")):
        raise SpectatorAccessError("Spectator access denied")
    if prior_session:
        if not isinstance(room.get("spectator_invite_hash"), str) or not hmac.compare_digest(
                room["spectator_invite_hash"], str(prior_session.get("invite_hash") or "")):
            raise SpectatorAccessError("Spectator access denied")
        return prior_session.get("invite_hash")
    try:
        supplied_hash = spectator_invite_hash(invite_token)
    except SpectatorAccessError:
        raise SpectatorAccessError("Spectator access denied") from None
    stored_hash = room.get("spectator_invite_hash")
    if not isinstance(stored_hash, str) or not hmac.compare_digest(stored_hash, supplied_hash):
        raise SpectatorAccessError("Spectator access denied")
    return stored_hash


_SUITS = {"S", "H", "D", "C"}
_RANKS = {"A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"}


def _seat(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 4 else None


def _card(value):
    if not isinstance(value, str) or len(value) < 2:
        return None
    rank, suit = value[:-1], value[-1]
    return value if rank in _RANKS and suit in _SUITS else None


def _public_trick(cards):
    if not isinstance(cards, list):
        return []
    result = []
    for pair in cards:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        seat, card = _seat(pair[0]), _card(pair[1])
        if seat is not None and card is not None:
            result.append([seat, card])
    return result


def _public_trick_result(value):
    if not isinstance(value, dict):
        return None
    cards = _public_trick(value.get("cards"))
    winner = _seat(value.get("winner"))
    return {"cards": cards, "winner": winner} if cards and winner is not None else None


def _public_captured_tens(value):
    """Captured ten cards per team; only well-formed tens, each at most once."""
    if not isinstance(value, list) or len(value) != 2:
        return None
    seen, teams = set(), []
    for team in value:
        cards = []
        for card in team if isinstance(team, list) else []:
            if _card(card) and card[:-1] == "10" and card not in seen:
                seen.add(card)
                cards.append(card)
        teams.append(cards)
    return teams


def _with_captured_tens(row, value):
    captured = _public_captured_tens(value.get("captured_tens"))
    if captured is not None:
        row["captured_tens"] = captured
    return row


def _public_result(value):
    if not isinstance(value, dict):
        return None
    allowed = ("winner_team", "type", "points", "reason", "dealer", "next_dealer", "tricks_won", "tens", "is_draw")
    result = _with_captured_tens({key: value[key] for key in allowed if key in value}, value)
    if result.get("winner_team") not in (0, 1):
        result.pop("winner_team", None)
    return result or None


def _public_rounds(value):
    if not isinstance(value, list):
        return []
    allowed = ("round", "winner_team", "type", "points", "reason", "dealer", "next_dealer", "tricks_won", "tens")
    return [_with_captured_tens({key: row[key] for key in allowed if key in row}, row)
            for row in value if isinstance(row, dict)]


def _public_summary(value):
    if not isinstance(value, dict):
        return None
    allowed = ("scores", "target", "winner_team", "tricks_won", "total_tricks", "rounds_played",
               "final_trump", "last_trick", "final_result", "forfeited_by", "duration_seconds",
               "started_at", "finished_at", "is_draw")
    summary = {key: value[key] for key in allowed if key in value}
    summary["last_trick"] = _public_trick_result(summary.get("last_trick"))
    summary["final_result"] = _public_result(summary.get("final_result"))
    forfeited_by = _seat(summary.get("forfeited_by"))
    if forfeited_by is not None:
        summary["forfeited_by"] = forfeited_by
    else:
        summary.pop("forfeited_by", None)
    return summary


def public_game_card(game, spectator_count=0):
    """Small safe discovery response. Never returns room codes or user identifiers."""
    state = game.get("state") or {}
    players = []
    for player in game.get("players", ()):
        seat = _seat(player.get("seat"))
        if seat is None:
            continue
        players.append({key: player.get(key) for key in (
            "username", "display_name", "avatar_color", "avatar_icon", "is_bot", "online"
        ) if player.get(key) is not None} | {"seat": seat, "team": seat % 2})
    turn = _seat(state.get("turn"))
    return {
        "game_id": game.get("id"),
        "status": game.get("status"),
        "started_at": game.get("created_at"),
        "round_no": state.get("round_no"),
        "phase": state.get("phase"),
        "turn": turn,
        "active_player": next((p.get("display_name") or p.get("username") for p in players if p["seat"] == turn), None),
        "scores": list(state.get("scores", ()))[:2],
        "target": state.get("target"),
        "tricks_won": list(state.get("tricks_won", ()))[:2],
        "spectator_count": max(0, int(spectator_count)),
        "players": players,
    }


def spectator_projection(game, spectator_count, server_time, online_by_user=None):
    """Build a strict whitelist projection for spectator REST and WebSocket responses."""
    online_by_user = online_by_user or {}
    state = game.get("state") or {}
    trick = _public_trick(state.get("trick"))
    last_trick = _public_trick_result(state.get("last_trick"))
    tricks = []
    for completed in state.get("tricks", ()):
        public = _public_trick_result(completed)
        if public:
            tricks.append(public)
    players = []
    for player in game.get("players", ()):
        seat = _seat(player.get("seat"))
        if seat is None:
            continue
        players.append({
            "seat": seat,
            "team": seat % 2,
            "username": player.get("username"),
            "display_name": player.get("display_name") or player.get("username"),
            "avatar_color": player.get("avatar_color"),
            "avatar_icon": player.get("avatar_icon"),
            "is_bot": bool(player.get("is_bot")),
            "online": bool(player.get("is_bot") or online_by_user.get(player.get("user_id"), False)),
        })
    safe_state = {
        "phase": state.get("phase"),
        "round_no": state.get("round_no"),
        "dealer": _seat(state.get("dealer")),
        "trump": state.get("trump") if state.get("trump") in _SUITS else None,
        "trump_selector": _seat(state.get("trump_selector")),
        "turn": _seat(state.get("turn")),
        "trick": trick,
        "last_trick": last_trick,
        "tricks": tricks,
        "tricks_played": len(tricks),
        "tricks_won": list(state.get("tricks_won", ()))[:2],
        "scores": list(state.get("scores", ()))[:2],
        "target": state.get("target"),
        "tens": [[card for card in team if _card(card)] for team in state.get("tens", ())[:2] if isinstance(team, list)],
        "tens_count": [len(team) for team in state.get("tens", ())[:2] if isinstance(team, list)],
        "koth": state.get("koth") if state.get("koth") in (0, 1) else None,
        "koth_decision": state.get("koth_decision") if state.get("koth_decision") in (0, 1) else None,
        "gs_eligible": state.get("gs_eligible") if state.get("gs_eligible") in (0, 1) else None,
        "gs_declared": state.get("gs_declared") if state.get("gs_declared") in (0, 1) else None,
        "result": _public_result(state.get("result")),
        "rounds": _public_rounds(state.get("rounds")),
        "winner_team": state.get("winner_team") if state.get("winner_team") in (0, 1) else None,
        "cancelled_by": _seat(state.get("cancelled_by")),
        "forfeited_by": _seat(state.get("forfeited_by")),
        "current_suit": trick[0][1][-1] if trick else None,
        "seq": state.get("seq") if isinstance(state.get("seq"), int) else None,
    }
    return {
        "type": "spectator_state",
        "game_id": game.get("id"),
        "status": game.get("status"),
        "is_public": bool(game.get("is_public")),
        "created_at": game.get("created_at"),
        "finished_at": game.get("finished_at"),
        "result_summary": _public_summary(game.get("result_summary")),
        "turn_duration": game.get("turn_duration"),
        "turn_deadline": game.get("turn_deadline"),
        "turn_phase": game.get("turn_phase"),
        "turn_grace_deadline": game.get("turn_grace_deadline"),
        "server_time": server_time,
        "spectator_count": max(0, int(spectator_count)),
        "players": players,
        "state": safe_state,
    }
