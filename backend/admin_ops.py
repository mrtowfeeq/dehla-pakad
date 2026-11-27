"""Admin role permissions and safe operational lobby projections."""

from datetime import datetime, timezone


ROLES = ("admin", "moderator", "support", "member")
DEFAULT_ROLE = "member"
ROLE_RANK = {role: len(ROLES) - index for index, role in enumerate(ROLES)}
ROLE_PERMISSIONS = {
    "admin": frozenset({
        "admin:overview:read", "admin:lobbies:read", "admin:spectate",
        "admin:players:read", "admin:roles:manage", "admin:audit:read",
        "admin:system-health:read",
        "player:read", "player:moderate", "player:ban", "player:notes:write",
    }),
    "moderator": frozenset({"admin:overview:read", "admin:lobbies:read", "admin:spectate",
                             "player:read", "player:moderate", "player:notes:write"}),
    "support": frozenset({"admin:overview:read", "admin:lobbies:read", "player:read"}),
    "member": frozenset(),
}


def effective_admin_role(role):
    return role if role in ROLE_PERMISSIONS else DEFAULT_ROLE


def has_admin_permission(role, permission):
    return permission in ROLE_PERMISSIONS[effective_admin_role(role)]


def admin_audit_activity_visible(role):
    return has_admin_permission(role, "admin:audit:read")


def is_bootstrap_admin(verified_emails, configured_emails):
    """Match only verified Clerk email addresses against the explicit allowlist."""
    allowlist = {email.strip().casefold() for email in configured_emails.split(",") if email.strip()}
    return any(isinstance(email, str) and email.strip().casefold() in allowlist
               for email in verified_emails)


def role_change_denial(actor_id, target_id, actor_role, current_role, new_role, admin_count):
    """Return a stable denial reason for role changes, or None when permitted."""
    if target_id == actor_id:
        return "Administrators cannot change their own role"
    if new_role not in ROLES:
        return "Invalid role"
    if ROLE_RANK.get(new_role, -1) > ROLE_RANK.get(effective_admin_role(actor_role), -1):
        return "Not allowed"
    if effective_admin_role(current_role) == "admin" and new_role != "admin" and admin_count <= 1:
        return "Keep at least one admin"
    return None


def _public_player(player, seat, user=None, online=False):
    user = user or {}
    return {
        "seat": seat,
        "team": seat % 2,
        "username": player.get("username") or user.get("username"),
        "display_name": player.get("display_name") or user.get("display_name") or user.get("username") or player.get("username"),
        "avatar_color": player.get("avatar_color") or user.get("avatar_color"),
        "avatar_icon": player.get("avatar_icon") or user.get("avatar_icon"),
        "is_bot": bool(player.get("is_bot")),
        "online": bool(player.get("is_bot") or online),
    }


def _duration_seconds(started_at, ended_at=None, now=None):
    def parse(value):
        if not isinstance(value, str):
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
        except ValueError:
            return None

    start = parse(started_at)
    end = parse(ended_at) or now or datetime.now(timezone.utc)
    return max(0, int((end - start).total_seconds())) if start else 0


def admin_lobby_projection(room, game, users_by_id, online_by_user, spectator_count, *, now=None):
    """Return lobby operations data without Mongo/Clerk identifiers or hidden card state."""
    game = game or {}
    state = game.get("state") if isinstance(game.get("state"), dict) else {}
    game_players = {
        player.get("user_id"): player for player in game.get("players", ())
        if isinstance(player, dict) and player.get("user_id")
    }
    bot_users = room.get("bots") if isinstance(room.get("bots"), dict) else {}
    players = []
    for seat, uid in enumerate(room.get("seats", ())[:4]):
        if not uid:
            continue
        player = game_players.get(uid) or bot_users.get(uid) or {}
        user = users_by_id.get(uid, {})
        players.append(_public_player(player, seat, user, online_by_user.get(uid, False)))

    host = users_by_id.get(room.get("host_id"), {})
    host_bot = bot_users.get(room.get("host_id"), {})
    status = {"lobby": "waiting", "playing": "playing", "active": "playing", "finished": "completed", "cancelled": "cancelled"}.get(
        game.get("status") or room.get("status"), "waiting"
    )
    turn = state.get("turn")
    current_player = next((p["display_name"] or p["username"] for p in players if p["seat"] == turn), None)
    started_at = game.get("created_at")
    ended_at = game.get("finished_at")
    now = now or datetime.now(timezone.utc)
    duration = (game.get("result_summary") or {}).get("duration_seconds")
    if not isinstance(duration, int) or duration < 0:
        duration = _duration_seconds(started_at, ended_at, now)
    state_summary = None
    if game:
        state_summary = {
            "phase": state.get("phase"),
            "round": state.get("round_no"),
            "current_player": current_player,
            "scores": list(state.get("scores", ()))[:2] if isinstance(state.get("scores"), (list, tuple)) else [],
            "tricks_won": list(state.get("tricks_won", ()))[:2] if isinstance(state.get("tricks_won"), (list, tuple)) else [],
        }

    return {
        # Private room codes are bearer join credentials; staff monitoring must not
        # disclose them to roles that only have read access to lobby operations.
        "code": room.get("code") if room.get("is_public") else None,
        "room_type": "public" if room.get("is_public") else "private",
        "owner": host.get("display_name") or host.get("username") or host_bot.get("username") or "Unknown",
        "players": players,
        "occupied_seats": len(players),
        "seat_limit": 4,
        "status": status,
        "created_at": room.get("created_at"),
        "match_started_at": started_at,
        "match_duration_seconds": duration,
        "spectator_count": max(0, int(spectator_count)),
        "disconnected_players": any(not p["online"] and not p["is_bot"] for p in players),
        "current_state": state_summary,
        "settings": {
            "target": room.get("target"),
            "turn_duration": room.get("turn_duration"),
            "dealer_seat": room.get("dealer_seat"),
            "spectators_enabled": bool(room.get("spectators_enabled")),
        },
        "game_id": game.get("id") if game.get("status") == "active" else None,
        "watch_allowed": bool(game.get("status") == "active"),
    }
