import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from admin_ops import (admin_audit_activity_visible, admin_lobby_projection, has_admin_permission,
                       role_change_denial)  # noqa: E402


def test_admin_permissions_are_server_role_based_and_narrower_for_support_roles():
    assert has_admin_permission("admin", "admin:roles:manage")
    assert has_admin_permission("moderator", "admin:spectate")
    assert has_admin_permission("support", "admin:lobbies:read")
    assert not has_admin_permission("support", "admin:spectate")
    assert not has_admin_permission("member", "admin:lobbies:read")
    assert not has_admin_permission("unknown", "admin:overview:read")
    assert admin_audit_activity_visible("admin")
    assert not admin_audit_activity_visible("moderator")
    assert not admin_audit_activity_visible("support")


def test_player_management_permissions_follow_least_privilege_staff_roles():
    assert all(has_admin_permission("admin", permission) for permission in (
        "player:read", "player:moderate", "player:ban", "player:notes:write",
    ))
    assert has_admin_permission("moderator", "player:read")
    assert has_admin_permission("moderator", "player:moderate")
    assert has_admin_permission("moderator", "player:notes:write")
    assert not has_admin_permission("moderator", "player:ban")
    assert has_admin_permission("support", "player:read")
    assert not has_admin_permission("support", "player:moderate")
    assert not has_admin_permission("support", "player:ban")
    assert not has_admin_permission("support", "player:notes:write")
    assert not has_admin_permission("member", "player:read")


def test_role_change_policy_blocks_self_modification_and_last_admin_removal():
    assert role_change_denial("admin-1", "admin-1", "admin", "admin", "support", 2) == (
        "Administrators cannot change their own role"
    )
    assert role_change_denial("admin-1", "admin-2", "admin", "admin", "member", 1) == "Keep at least one admin"
    assert role_change_denial("admin-1", "player-1", "admin", "member", "unknown", 2) == "Invalid role"
    assert role_change_denial("admin-1", "player-1", "admin", "member", "support", 1) is None


def test_admin_lobby_projection_exposes_operational_summary_without_sensitive_state_or_ids():
    now = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)
    room = {
        "code": "ABCD23", "is_public": False, "host_id": "clerk-host", "status": "playing",
        "created_at": "2026-11-25T11:00:00Z", "seats": ["clerk-host", "clerk-two", None, None],
        "target": 7, "turn_duration": 30, "dealer_seat": 0, "spectators_enabled": True,
    }
    game = {
        "id": "game-opaque-id", "status": "active", "created_at": "2026-11-25T11:30:00Z",
        "players": [
            {"user_id": "clerk-host", "seat": 0, "username": "host", "display_name": "Host", "is_bot": False},
            {"user_id": "clerk-two", "seat": 1, "username": "player2", "display_name": "Player Two", "is_bot": False},
        ],
        "state": {
            "phase": "playing", "round_no": 3, "turn": 1, "scores": [2, 1], "tricks_won": [4, 2],
            "hands": [["AS"], ["KH"]], "deck": ["hidden"], "events": [{"private": True}],
        },
    }
    users = {
        "clerk-host": {"username": "host", "display_name": "Host"},
        "clerk-two": {"username": "player2", "display_name": "Player Two"},
    }

    view = admin_lobby_projection(room, game, users, {"clerk-host": True, "clerk-two": False}, 2, now=now)

    assert view["room_type"] == "private"
    assert view["owner"] == "Host"
    assert view["occupied_seats"] == 2
    assert view["status"] == "playing"
    assert view["disconnected_players"] is True
    assert view["spectator_count"] == 2
    assert view["match_duration_seconds"] == 1800
    assert view["current_state"] == {
        "phase": "playing", "round": 3, "current_player": "Player Two", "scores": [2, 1], "tricks_won": [4, 2],
    }
    forbidden = {"user_id", "host_id", "hands", "hand", "deck", "events", "room_id", "_id"}

    def keys(value):
        if isinstance(value, dict):
            return set(value) | set().union(*(keys(child) for child in value.values()))
        if isinstance(value, list):
            return set().union(*(keys(child) for child in value)) if value else set()
        return set()

    assert not keys(view) & forbidden
    assert view["game_id"] == "game-opaque-id"
    assert view["code"] is None
    assert view["watch_allowed"] is True
