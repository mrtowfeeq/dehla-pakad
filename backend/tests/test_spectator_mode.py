import asyncio
import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import Match  # noqa: E402
from game_service import GameService, Hub, SpectatorHub  # noqa: E402
from spectator import (  # noqa: E402
    SpectatorAccessError,
    public_game_card,
    require_spectator_access,
    spectator_invite_hash,
    spectator_projection,
)


class MemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(document) for document in documents]

    @staticmethod
    def matches(document, query):
        for key, expected in query.items():
            actual = document
            for part in key.split("."):
                actual = actual.get(part) if isinstance(actual, dict) else None
            if isinstance(expected, dict) and "$gt" in expected:
                if not actual or actual <= expected["$gt"]:
                    return False
            elif actual != expected:
                return False
        return True

    async def find_one(self, query, projection=None):
        return copy.deepcopy(next((doc for doc in self.documents if self.matches(doc, query)), None))

    async def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def update_one(self, query, update, upsert=False):
        document = next((doc for doc in self.documents if self.matches(doc, query)), None)
        if document is None and upsert:
            document = copy.deepcopy(update.get("$set", {}))
            self.documents.append(document)
        if document:
            document.update(copy.deepcopy(update.get("$set", {})))
        return SimpleNamespace(matched_count=1 if document else 0)

    async def delete_one(self, query):
        old = len(self.documents)
        self.documents = [doc for doc in self.documents if not self.matches(doc, query)]
        return SimpleNamespace(deleted_count=old - len(self.documents))

    async def delete_many(self, query):
        return await self.delete_one(query)


class MemoryDatabase:
    def __init__(self, room=None):
        self.games = MemoryCollection()
        self.matches = MemoryCollection()
        self.rooms = MemoryCollection([room] if room else [])
        self.game_events = MemoryCollection()
        self.spectator_sessions = MemoryCollection()
        self.admin_audit_logs = MemoryCollection()
        self.users = MemoryCollection()


class Socket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(copy.deepcopy(message))


def make_game(*, public=True, status="active"):
    match = Match.new(dealer=0, target=7)
    match.select_trump(match.s["trump_selector"], "H")
    match.s["trick"] = [[0, "AS"], [1, "KH"]]
    match.s["turn"] = 2
    match.s["last_trick"] = {"cards": [[0, "10S"], [1, "9S"], [2, "AS"], [3, "KS"]], "winner": 2}
    match.s["tricks"] = [{"cards": match.s["last_trick"]["cards"], "winner": 2, "tens": ["10S"]}]
    match.s["tricks_won"] = [1, 0]
    match.s["scores"] = [3, 2]
    match.s["tens"] = [["10S"], []]
    players = [{
        "user_id": f"user-{seat}", "seat": seat, "team": seat % 2,
        "username": f"player{seat}", "display_name": f"Player {seat}",
        "avatar_color": "#38bdf8", "avatar_icon": "spade", "is_bot": False,
    } for seat in range(4)]
    return {
        "id": "public-game-1", "room_code": "SECRET", "is_public": public,
        "host_id": "user-0", "spectators_enabled": True,
        "players": players, "state": match.s, "status": status,
        "deck": ["hidden deck order"], "created_at": "2026-11-25T10:00:00Z",
        "turn_duration": 30, "turn_id": "private-turn-id", "turn_deadline": "2026-11-25T10:00:30Z",
        "turn_phase": "normal", "turn_grace_deadline": None,
    }


def run(coro):
    return asyncio.run(coro)


def test_spectator_projection_is_a_whitelist_without_hidden_hands_or_internal_ids():
    game = make_game()
    game["state"]["events"].append({"seq": 999, "type": "deal", "cards": game["state"]["hands"][0]})
    game["private_field"] = "must not escape"
    view = spectator_projection(game, 3, "2026-11-25T10:00:00Z", {f"user-{s}": True for s in range(4)})

    assert view["type"] == "spectator_state"
    assert view["spectator_count"] == 3
    assert view["state"]["trick"] == [[0, "AS"], [1, "KH"]]
    assert view["state"]["current_suit"] == "S"
    assert view["state"]["tricks"] == [{"cards": [[0, "10S"], [1, "9S"], [2, "AS"], [3, "KS"]], "winner": 2}]
    assert view["players"][0]["username"] == "player0"
    assert "user_id" not in view["players"][0]

    forbidden = {"hand", "hands", "deck", "events", "legal", "partner_hand", "deal_stage", "user_id", "host_id", "room_code", "private_field"}
    def keys(value):
        if isinstance(value, dict):
            return set(value) | set().union(*(keys(child) for child in value.values()))
        if isinstance(value, list):
            return set().union(*(keys(child) for child in value)) if value else set()
        return set()
    assert not (keys(view) & forbidden)


def test_public_discovery_card_contains_only_safe_match_summary():
    game = make_game()
    card = public_game_card(game, 2)
    assert card["game_id"] == "public-game-1"
    assert card["scores"] == [3, 2]
    assert card["active_player"] == "Player 2"
    assert card["spectator_count"] == 2
    assert "room_code" not in card and "state" not in card and "user_id" not in str(card)


def test_public_access_requires_active_game_and_rejects_its_own_players():
    game = make_game()
    db = MemoryDatabase()
    assert run(require_spectator_access(db, game, "watcher")) is None
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, game, "user-2"))
    finished = make_game(status="finished")
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, finished, "watcher"))


def test_private_room_requires_invitation_token_and_rechecks_revocation():
    invite = "a-secure-spectator-invite-token-with-enough-entropy"
    db = MemoryDatabase({
        "code": "SECRET", "is_public": False, "status": "playing", "spectators_enabled": True,
        "spectator_invite_hash": spectator_invite_hash(invite),
    })
    game = make_game(public=False)
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, game, "watcher"))
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, game, "watcher", "wrong-room-code-is-not-an-invite-token"))
    assert run(require_spectator_access(db, game, "watcher", invite)) == spectator_invite_hash(invite)
    db.rooms.documents[0]["spectators_enabled"] = False
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, game, "watcher", invite))


def test_spectator_reconnect_reads_only_same_environment_session_and_room():
    now = datetime.now(timezone.utc)
    game = make_game(public=False, status="finished")
    game.update(env="preview", room_code="SECRET")
    valid_hash = spectator_invite_hash("preview-only-reconnect-invite-token")
    other_hash = spectator_invite_hash("live-only-reconnect-invite-token")
    db = MemoryDatabase()
    db.spectator_sessions.documents = [
        {"env": "live", "game_id": game["id"], "user_id": "watcher", "invite_hash": other_hash,
         "expires_at": now + timedelta(minutes=5)},
        {"env": "preview", "game_id": game["id"], "user_id": "watcher", "invite_hash": valid_hash,
         "expires_at": now + timedelta(minutes=5)},
    ]
    db.rooms.documents = [
        {"env": "live", "code": "SECRET", "is_public": False, "status": "finished",
         "spectators_enabled": True, "spectator_invite_hash": other_hash},
        {"env": "preview", "code": "SECRET", "is_public": False, "status": "finished",
         "spectators_enabled": True, "spectator_invite_hash": valid_hash},
    ]

    assert run(require_spectator_access(db, game, "watcher", now=now,
                                        allow_previous_session=True, env="preview")) == valid_hash


def test_private_spectator_can_reconnect_to_active_game_from_persisted_session():
    async def run_case():
        invite = "secure-private-spectator-invitation-token-value"
        invite_hash = spectator_invite_hash(invite)
        db = MemoryDatabase({"code": "SECRET", "is_public": False, "status": "playing",
                             "spectators_enabled": True, "spectator_invite_hash": invite_hash})
        game = make_game(public=False)
        service = GameService(db, Hub(), schedule_turn_timers=False)
        service.games[game["id"]] = game
        original_socket, refreshed_socket = Socket(), Socket()

        await service.join_spectator("watcher", game["id"], original_socket, invite)
        # A full page refresh has already removed the invite fragment. The persistent,
        # unexpired grant allows this authenticated user to rejoin the same active game.
        await service.join_spectator("watcher", game["id"], refreshed_socket)

        assert service.spectators.count(game["id"]) == 1
        assert refreshed_socket.messages[-1]["type"] == "spectator_state"
        assert db.spectator_sessions.documents[0]["invite_hash"] == invite_hash

    run(run_case())


def test_previous_spectator_can_recover_final_state_but_new_users_cannot_join_finished_game():
    now = datetime(2026, 11, 25, 10, 0, tzinfo=timezone.utc)
    game = make_game(status="finished")
    db = MemoryDatabase()
    db.spectator_sessions.documents.append({
        "game_id": game["id"], "user_id": "watcher", "invite_hash": None,
        "expires_at": now + timedelta(minutes=5),
    })
    assert run(require_spectator_access(db, game, "watcher", now=now, allow_previous_session=True)) is None
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, game, "new-watcher", now=now, allow_previous_session=True))
    expired = now - timedelta(seconds=1)
    db.spectator_sessions.documents[0]["expires_at"] = expired
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, game, "watcher", now=now, allow_previous_session=True))


def test_private_invite_session_recovers_only_while_the_host_access_is_still_valid():
    invite_hash = spectator_invite_hash("secure-private-spectator-invitation-token-value")
    now = datetime(2026, 11, 25, 10, 0, tzinfo=timezone.utc)
    db = MemoryDatabase({"code": "SECRET", "is_public": False, "status": "finished",
                         "spectators_enabled": True, "spectator_invite_hash": invite_hash})
    db.spectator_sessions.documents.append({"game_id": "public-game-1", "user_id": "watcher",
                                            "invite_hash": invite_hash, "expires_at": now + timedelta(minutes=5)})
    game = make_game(public=False, status="finished")

    assert run(require_spectator_access(db, game, "watcher", now=now, allow_previous_session=True)) == invite_hash
    db.rooms.documents[0]["spectator_invite_hash"] = spectator_invite_hash("a-replacement-invitation-token-value")
    with pytest.raises(SpectatorAccessError):
        run(require_spectator_access(db, game, "watcher", now=now, allow_previous_session=True))


def test_spectator_hub_counts_unique_users_and_cleans_only_current_connections():
    hub = SpectatorHub(max_per_game=2)
    first, duplicate, second, third = Socket(), Socket(), Socket(), Socket()
    assert hub.add("game", "watcher-1", first)
    assert hub.add("game", "watcher-1", duplicate)
    assert hub.count("game") == 1
    assert hub.add("game", "watcher-2", second)
    assert not hub.add("game", "watcher-3", third)
    assert not hub.remove("game", "watcher-1", first)
    assert hub.count("game") == 2
    assert hub.remove_socket(duplicate) == ["game"]
    assert hub.count("game") == 1


def test_websocket_broadcasts_safe_spectator_updates_separately_from_player_snapshots():
    async def run_case():
        game = make_game()
        db = MemoryDatabase()
        player_hub = Hub()
        spectator_hub = SpectatorHub()
        service = GameService(db, player_hub, spectator_hub=spectator_hub, schedule_turn_timers=False)
        service.games[game["id"]] = game
        watcher = Socket()
        rest_snapshot = await service.spectator_snapshot("watcher", game["id"])
        assert rest_snapshot["type"] == "spectator_state"
        assert "hands" not in str(rest_snapshot) and "deck" not in str(rest_snapshot)
        await service.join_spectator("watcher", game["id"], watcher)
        await service.broadcast(game)
        assert watcher.messages
        assert all(message["type"] == "spectator_state" for message in watcher.messages)
        assert not any("hands" in message or "deck" in message for message in watcher.messages)
        assert spectator_hub.count(game["id"]) == 1
        game["status"] = "finished"
        game["state"]["phase"] = "match_over"
        game["state"]["winner_team"] = 0
        await service.broadcast(game)
        assert watcher.messages[-1]["status"] == "finished"
        assert watcher.messages[-1]["state"]["winner_team"] == 0
        assert spectator_hub.count(game["id"]) == 0
        assert db.spectator_sessions.documents
        db.matches.documents.append({"game_id": game["id"]})
        recovered = await service.spectator_snapshot("watcher", game["id"])
        assert recovered["status"] == "finished"
        assert "hands" not in recovered["state"] and "deck" not in recovered["state"]

    run(run_case())


def test_duplicate_reconnects_do_not_inflate_count_and_explicit_leave_removes_grant():
    async def run_case():
        game = make_game()
        db = MemoryDatabase()
        service = GameService(db, Hub(), schedule_turn_timers=False)
        service.games[game["id"]] = game
        old, current = Socket(), Socket()
        await service.join_spectator("watcher", game["id"], old)
        await service.join_spectator("watcher", game["id"], current)
        assert service.spectators.count(game["id"]) == 1
        assert len(db.spectator_sessions.documents) == 1
        assert await service.leave_spectator("watcher", game["id"], old) is False
        assert service.spectators.count(game["id"]) == 1
        assert await service.leave_spectator("watcher", game["id"], current) is True
        assert service.spectators.count(game["id"]) == 0
        assert db.spectator_sessions.documents == []

    run(run_case())


def test_spectator_cannot_submit_game_actions_or_change_authoritative_state():
    async def run_case():
        game = make_game()
        db = MemoryDatabase()
        service = GameService(db, Hub(), schedule_turn_timers=False)
        service.games[game["id"]] = game
        before = copy.deepcopy(game["state"])
        reply = await service.handle("watcher", {"game_id": game["id"], "action": "play", "card": "AS"})
        assert reply == {"type": "error", "message": "Game not found"}
        assert game["state"] == before

    run(run_case())


def test_admin_spectator_uses_safe_projection_and_audits_private_view_and_session_lifecycle():
    async def run_case():
        game = make_game(public=False)
        db = MemoryDatabase({"code": "SECRET", "is_public": False, "status": "playing",
                             "spectators_enabled": False})
        spectator_hub = SpectatorHub()
        service = GameService(db, Hub(), spectator_hub=spectator_hub, schedule_turn_timers=False)
        service.games[game["id"]] = game

        view = await service.admin_spectator_snapshot("admin-user", game["id"])
        assert view["type"] == "spectator_state"
        assert "hands" not in str(view) and "deck" not in str(view)
        assert db.admin_audit_logs.documents[-1]["action"] == "private_room_spectator_view"
        with pytest.raises(SpectatorAccessError):
            await service.admin_spectator_snapshot("user-0", game["id"])

        watcher = Socket()
        await service.join_admin_spectator("admin-user", game["id"], watcher)
        assert spectator_hub.count(game["id"]) == 1
        assert watcher.messages[-1]["type"] == "spectator_state"
        assert "hands" not in str(watcher.messages[-1]) and "deck" not in str(watcher.messages[-1])
        assert spectator_hub.is_admin(game["id"], "admin-user")
        assert not db.spectator_sessions.documents
        assert db.admin_audit_logs.documents[-1]["action"] == "spectator_session_started"

        before = copy.deepcopy(game["state"])
        reply = await service.handle("admin-user", {"game_id": game["id"], "action": "play", "card": "AS"})
        assert reply == {"type": "error", "message": "Game not found"}
        assert game["state"] == before

        await service.disconnect_spectator(watcher, "admin-user")
        assert spectator_hub.count(game["id"]) == 0
        assert db.admin_audit_logs.documents[-1]["action"] == "spectator_session_ended"

    run(run_case())


def test_role_demotion_revokes_an_already_open_admin_spectator_feed():
    async def run_case():
        game = make_game(public=False)
        db = MemoryDatabase({"code": "SECRET", "is_public": False, "status": "playing"})
        spectator_hub = SpectatorHub()
        service = GameService(db, Hub(), spectator_hub=spectator_hub, schedule_turn_timers=False)
        service.games[game["id"]] = game
        watcher = Socket()

        await service.join_admin_spectator("admin-user", game["id"], watcher)
        assert spectator_hub.is_admin(game["id"], "admin-user")
        assert await service.revoke_admin_spectators("admin-user") == 1
        assert spectator_hub.count(game["id"]) == 0
        assert not spectator_hub.is_admin(game["id"], "admin-user")
        assert watcher.messages[-1] == {"type": "spectator_access_revoked", "game_id": game["id"]}
        assert db.admin_audit_logs.documents[-1]["reason"] == "spectator permission revoked"

        message_count = len(watcher.messages)
        await service.broadcast_spectators(game)
        assert len(watcher.messages) == message_count

    run(run_case())


def test_rotating_private_invite_revokes_live_watchers_and_reconnect_grants():
    async def run_case():
        invite = "secure-private-spectator-invitation-token-value"
        replacement = "replacement-private-spectator-invitation-token"
        game = make_game(public=False)
        db = MemoryDatabase({"code": "SECRET", "is_public": False, "status": "playing",
                             "spectators_enabled": True, "spectator_invite_hash": spectator_invite_hash(invite)})
        service = GameService(db, Hub(), schedule_turn_timers=False)
        service.games[game["id"]] = game
        watcher = Socket()
        admin_watcher = Socket()
        await service.join_spectator("watcher", game["id"], watcher, invite)
        await service.join_admin_spectator("admin-user", game["id"], admin_watcher)
        assert db.spectator_sessions.documents

        db.rooms.documents[0]["spectator_invite_hash"] = spectator_invite_hash(replacement)
        await service.revoke_invited_spectators(game["id"])
        assert watcher.messages[-1] == {"type": "spectator_access_revoked", "game_id": game["id"]}
        assert service.spectators.count(game["id"]) == 1
        assert service.spectators.is_admin(game["id"], "admin-user")
        assert db.spectator_sessions.documents == []
        with pytest.raises(SpectatorAccessError):
            await service.spectator_snapshot("watcher", game["id"], invite)

    run(run_case())


def test_match_cancellation_broadcasts_safe_final_state_then_clears_live_membership():
    async def run_case():
        game = make_game()
        db = MemoryDatabase()
        spectator_hub = SpectatorHub()
        service = GameService(db, Hub(), spectator_hub=spectator_hub, schedule_turn_timers=False)
        service.games[game["id"]] = game
        watcher = Socket()
        await service.join_spectator("watcher", game["id"], watcher)

        await service.cancel(game["id"], "user-0")

        assert watcher.messages[-1]["status"] == "cancelled"
        assert watcher.messages[-1]["state"]["phase"] == "cancelled"
        assert "hands" not in watcher.messages[-1]["state"]
        assert spectator_hub.count(game["id"]) == 0

    run(run_case())
