import asyncio
import copy
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice import VoiceService, configured_participant_limit, pair_connection_id  # noqa: E402


class MemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(row) for row in documents]

    @staticmethod
    def matches(document, query):
        for key, expected in query.items():
            actual = document
            for part in key.split("."):
                actual = actual.get(part) if isinstance(actual, dict) else None
            if isinstance(expected, dict) and "$gt" in expected:
                if actual is None or actual <= expected["$gt"]:
                    return False
            elif actual != expected:
                return False
        return True

    async def find_one(self, query, projection=None):
        return copy.deepcopy(next((row for row in self.documents if self.matches(row, query)), None))


class MemoryDb:
    def __init__(self, rooms=(), games=(), sessions=()):
        self.rooms = MemoryCollection(rooms)
        self.games = MemoryCollection(games)
        self.spectator_sessions = MemoryCollection(sessions)


class FakeSpectators:
    def __init__(self):
        self.members = {}
        self.admin_members = set()

    def is_admin(self, game_id, uid):
        return (game_id, uid) in self.admin_members


class FakeGames:
    def __init__(self, games=()):
        self.docs = {game["id"]: copy.deepcopy(game) for game in games}
        self.spectators = FakeSpectators()

    async def get(self, game_id):
        return self.docs.get(game_id)

    @staticmethod
    def seat_of(game, uid):
        return next((player.get("seat") for player in game.get("players", ())
                     if player.get("user_id") == uid), None)


class Socket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(copy.deepcopy(message))

    def latest(self, kind):
        return next(message for message in reversed(self.messages) if message.get("type") == kind)


def build_service(*, env="preview", participant_limit=6, private=False, clock=None):
    now = datetime.now(timezone.utc)
    room = {
        "env": env, "code": "ROOM1", "is_public": not private, "status": "playing",
        "game_id": "game-1", "seats": ["p1", "p2", "p3", "p4"],
        "spectators_enabled": True,
    }
    game = {
        "env": env, "id": "game-1", "room_code": "ROOM1", "is_public": not private,
        "status": "active", "spectators_enabled": True,
        "players": [{"user_id": f"p{seat + 1}", "seat": seat} for seat in range(4)],
    }
    users = {f"p{i}": {"username": f"player{i}", "display_name": f"Player {i}",
                       "avatar_color": "#10aa55", "avatar_icon": "heart", "role": "member"}
             for i in range(1, 5)}
    rooms = [room]
    games = [game]
    sessions = []
    if private:
        room["spectator_invite_hash"] = "persisted-hash"
        sessions.append({"env": env, "game_id": "game-1", "user_id": "watcher",
                         "invite_hash": "persisted-hash", "expires_at": now + timedelta(minutes=5)})
        users["watcher"] = {"username": "watcher", "display_name": "Watcher", "role": "member"}

    db = MemoryDb(rooms, games, sessions)
    service_games = FakeGames(games)
    current = [0.0]
    if clock:
        current = clock

    async def load_user(uid):
        user = users.get(uid)
        return copy.deepcopy(user) if user and not user.get("restricted") else None

    service = VoiceService(
        db, service_games, env=env, load_user=load_user,
        has_spectate_permission=lambda role: role in {"admin", "moderator"},
        participant_limit=participant_limit, clock=lambda: current[0],
        wall_clock=lambda: now.timestamp(), stun_urls=["stun:voice.test:3478"],
        turn_urls=["turn:voice.test:3478"], turn_shared_secret="server-only-test-secret",
    )
    return service, service_games, db, users, current


def run(coro):
    return asyncio.run(coro)


def test_participant_limit_is_bounded_and_clamped(monkeypatch):
    monkeypatch.delenv("VOICE_MAX_PARTICIPANTS", raising=False)
    assert configured_participant_limit(None) == 6
    assert configured_participant_limit("20") == 8
    assert configured_participant_limit("1") == 2
    assert configured_participant_limit("bad") == 6


def test_seated_players_join_same_room_and_presence_contains_no_game_state():
    async def scenario():
        service, _, _, _, _ = build_service()
        first, second = Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p2", second, {"type": "voice_join", "game_id": "game-1"})

        joined = first.latest("voice_joined")
        presence = first.latest("voice_presence")
        assert len(service.sessions["preview:ROOM1"]["members"]) == 2
        assert presence["participants"][0]["role"] == "player"
        assert joined["ice_servers"][0]["urls"] == ["stun:voice.test:3478"]
        turn = joined["ice_servers"][1]
        assert turn["urls"] == ["turn:voice.test:3478"]
        assert "server-only-test-secret" not in str(joined)
        assert "user_id" not in str(joined) and "game_state" not in str(joined)
        assert first.latest("voice_peer_joined")["participant"]["display_name"] == "Player 2"
        assert presence["participants"]

    run(scenario())


def test_seated_players_can_join_a_lobby_before_a_game_starts():
    async def scenario():
        service, _, db, _, _ = build_service()
        db.rooms.documents[0]["status"] = "lobby"
        db.rooms.documents[0].pop("game_id")
        first, second = Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "room_code": "ROOM1"})
        await service.handle("p2", second, {"type": "voice_join", "room_code": "ROOM1"})
        assert first.latest("voice_joined")["session_id"] == second.latest("voice_joined")["session_id"]
        assert len(service.sessions["preview:ROOM1"]["members"]) == 2

    run(scenario())


def test_unseated_user_and_cross_environment_room_cannot_join():
    async def scenario():
        service, games, db, users, _ = build_service()
        users["outside"] = {"username": "outside", "role": "member"}
        outsider = Socket()
        await service.handle("outside", outsider, {"type": "voice_join", "game_id": "game-1"})
        assert outsider.latest("voice_error")["message"] == "You are not allowed to join voice for this room"

        other_env = Socket()
        await service.handle("p1", other_env, {"type": "voice_join", "room_code": "ROOM1"})
        assert other_env.latest("voice_error")

        # The same room code in another environment cannot satisfy the scoped lookup.
        db.rooms.documents.append({"env": "live", "code": "ROOM1", "status": "lobby",
                                  "seats": ["p1"], "is_public": False})
        live_game = {"env": "live", "id": "game-live", "room_code": "ROOM1", "status": "active"}
        db.games.documents.append(live_game)
        games.docs["game-live"] = live_game
        await service.handle("p1", other_env, {"type": "voice_join", "game_id": "game-live"})
        assert other_env.latest("voice_error")
        assert not service.sessions

    run(scenario())


def test_private_spectator_requires_existing_authorized_spectator_session():
    async def scenario():
        service, games, _, _, _ = build_service(private=True)
        ws = Socket()
        # Knowing the game ID is insufficient; spectator_join must have succeeded first.
        await service.handle("watcher", ws, {"type": "voice_join", "game_id": "game-1"})
        assert ws.latest("voice_error")
        games.spectators.members["game-1"] = {"watcher": ws}
        await service.handle("watcher", ws, {"type": "voice_join", "game_id": "game-1"})
        assert ws.latest("voice_joined")["type"] == "voice_joined"
        assert ws.latest("voice_presence")["participants"][0]["role"] == "spectator"

    run(scenario())


def test_private_spectator_invite_revocation_removes_voice_membership():
    async def scenario():
        service, games, db, _, _ = build_service(private=True)
        ws = Socket()
        games.spectators.members["game-1"] = {"watcher": ws}
        await service.handle("watcher", ws, {"type": "voice_join", "game_id": "game-1"})
        db.rooms.documents[0]["spectators_enabled"] = False
        await service.handle("watcher", ws, {"type": "voice_speaking_changed",
                                               "session_id": ws.latest("voice_joined")["session_id"],
                                               "speaking": True})
        assert ws.latest("voice_left")["message"] == "Voice access is no longer available"
        assert not service.sessions

    run(scenario())


def test_signaling_only_reaches_same_session_recipient_and_requires_deterministic_negotiation():
    async def scenario():
        service, _, _, _, _ = build_service()
        left, right, other = Socket(), Socket(), Socket()
        await service.handle("p1", left, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p2", right, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p3", other, {"type": "voice_join", "game_id": "game-1"})
        left_join = left.latest("voice_joined")
        right_join = right.latest("voice_joined")
        left_peer = left_join["self_peer_id"]
        right_peer = right_join["self_peer_id"]
        lower, lower_uid, higher_ws, higher_id = ((left_peer, "p1", right, right_peer)
            if left_peer < right_peer else (right_peer, "p2", left, left_peer))
        higher_uid = "p1" if left_peer > right_peer else "p2"
        higher_sender = left if higher_uid == "p1" else right
        session_id = left_join["session_id"]
        before = len(higher_ws.messages)
        await service.handle(lower_uid, left if lower_uid == "p1" else right, {
            "type": "voice_offer", "session_id": session_id, "to_peer_id": higher_id,
            "connection_id": pair_connection_id(lower, higher_id),
            "description": {"type": "offer", "sdp": "v=0\r\n"},
        })
        assert len(higher_ws.messages) == before + 1
        forwarded = higher_ws.messages[-1]
        assert forwarded["from_peer_id"] == lower
        assert "user_id" not in str(forwarded) and "deck" not in str(forwarded)

        before = len(higher_ws.messages)
        await service.handle(higher_uid, higher_sender, {
            "type": "voice_offer", "session_id": session_id, "to_peer_id": lower,
            "connection_id": pair_connection_id(higher_id, lower),
            "description": {"type": "offer", "sdp": "v=0"},
        })
        assert len(higher_ws.messages) == before + 1  # The rejection is returned only to its sender.
        assert higher_ws.latest("voice_error")

        # A missing/foreign recipient is never forwarded to the unrelated participant.
        recipient_count = len(other.messages)
        await service.handle("p1", left, {
            "type": "voice_ice_candidate", "session_id": session_id, "to_peer_id": "not-a-peer",
            "connection_id": "nope", "candidate": {"candidate": "candidate:1"},
        })
        assert len(other.messages) == recipient_count

    run(scenario())


def test_cross_room_signaling_is_rejected_and_never_reaches_other_voice_session():
    async def scenario():
        service, games, db, users, _ = build_service()
        room = {"env": "preview", "code": "ROOM2", "is_public": True, "status": "playing",
                "game_id": "game-2", "seats": ["p5", "p6", "p7", "p8"]}
        game = {"env": "preview", "id": "game-2", "room_code": "ROOM2", "is_public": True,
                "status": "active", "players": [{"user_id": f"p{i}", "seat": i - 5} for i in range(5, 9)]}
        db.rooms.documents.append(room)
        db.games.documents.append(game)
        games.docs["game-2"] = game
        users.update({f"p{i}": {"username": f"player{i}", "role": "member"} for i in range(5, 9)})
        first, foreign = Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p5", foreign, {"type": "voice_join", "game_id": "game-2"})
        foreign_peer_id = foreign.latest("voice_joined")["self_peer_id"]
        session_id = first.latest("voice_joined")["session_id"]
        await service.handle("p1", first, {
            "type": "voice_ice_candidate", "session_id": session_id,
            "to_peer_id": foreign_peer_id, "connection_id": pair_connection_id(
                first.latest("voice_joined")["self_peer_id"], foreign_peer_id),
            "candidate": {"candidate": "candidate:foreign"},
        })
        assert first.latest("voice_error")["message"] == "Voice recipient is not connected"
        assert not any(message["type"] == "voice_ice_candidate" for message in foreign.messages)

    run(scenario())


def test_signaling_payload_and_stale_session_are_rejected():
    async def scenario():
        service, _, _, _, _ = build_service()
        first, second = Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p2", second, {"type": "voice_join", "game_id": "game-1"})
        session_id = first.latest("voice_joined")["session_id"]
        peer_id = first.latest("voice_presence")["participants"][1]["peer_id"]
        await service.handle("p1", first, {
            "type": "voice_offer", "session_id": session_id, "to_peer_id": peer_id,
            "connection_id": pair_connection_id(first.latest("voice_joined")["self_peer_id"], peer_id),
            "description": {"type": "offer", "sdp": "x" * 13000},
        })
        assert first.latest("voice_error")["message"] == "Invalid or expired voice signal"
        await service.handle("p1", first, {"type": "voice_leave", "session_id": "stale-session"})
        assert first.latest("voice_error")["message"] == "Invalid or expired voice session"
        assert len(service.sessions["preview:ROOM1"]["members"]) == 2

    run(scenario())


def test_signaling_diagnostics_correlate_messages_and_explain_rejections(caplog):
    async def scenario():
        service, _, _, _, _ = build_service()
        first, second = Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p2", second, {"type": "voice_join", "game_id": "game-1"})
        first_join = first.latest("voice_joined")
        second_join = second.latest("voice_joined")
        if first_join["self_peer_id"] < second_join["self_peer_id"]:
            sender, target = first, second
            sender_id, target_id = first_join["self_peer_id"], second_join["self_peer_id"]
            sender_uid = "p1"
        else:
            sender, target = second, first
            sender_id, target_id = second_join["self_peer_id"], first_join["self_peer_id"]
            sender_uid = "p2"
        session_id = first_join["session_id"]
        signal = {
            "type": "voice_offer", "session_id": session_id, "to_peer_id": target_id,
            "connection_id": pair_connection_id(sender_id, target_id),
            "description": {"type": "offer", "sdp": "v=0\r\n"},
            "signal_id": "trace-valid-1", "created_at_ms": 1_780_000_000_000,
        }
        await service.handle(sender_uid, sender, signal)
        forwarded = target.latest("voice_offer")
        assert forwarded["signal_id"] == "trace-valid-1"
        assert forwarded["created_at_ms"] == signal["created_at_ms"]

        end_marker = {
            "type": "voice_ice_candidate", "session_id": session_id, "to_peer_id": target_id,
            "connection_id": pair_connection_id(sender_id, target_id),
            "candidate": {"candidate": "", "sdpMid": "0", "sdpMLineIndex": 0,
                          "usernameFragment": "generation-one"},
            "signal_id": "trace-eoc-1", "created_at_ms": 1_780_000_000_001,
        }
        await service.handle(sender_uid, sender, end_marker)
        forwarded_marker = target.latest("voice_ice_candidate")
        assert forwarded_marker["candidate"]["candidate"] == ""
        assert forwarded_marker["signal_id"] == "trace-eoc-1"

        mdns_candidate = {**end_marker, "signal_id": "trace-mdns-1",
                          "candidate": {"candidate": "candidate:2 1 udp 2122260223 aaabbb.local 5000 typ host"}}
        await service.handle(sender_uid, sender, mdns_candidate)
        assert target.latest("voice_ice_candidate")["candidate"] == mdns_candidate["candidate"]

        stale = {**signal, "session_id": "stale-session", "signal_id": "trace-stale-1"}
        await service.handle(sender_uid, sender, stale)
        error = sender.latest("voice_error")
        assert error["message"] == "Invalid or expired voice signal"
        assert error["signal_id"] == "trace-stale-1"

        too_large = {**signal, "signal_id": "trace-large-1",
                     "description": {"type": "offer", "sdp": "x" * (12 * 1024 + 1)}}
        await service.handle(sender_uid, sender, too_large)
        assert sender.latest("voice_error")["signal_id"] == "trace-large-1"

    caplog.set_level(logging.INFO, logger="voice")
    run(scenario())
    records = [json.loads(record.getMessage().removeprefix("voice_signal "))
               for record in caplog.records if record.getMessage().startswith("voice_signal ")]
    accepted = next(record for record in records if record["signal_id"] == "trace-valid-1")
    assert accepted["outcome"] == "accepted"
    assert accepted["sender_membership_valid"] is True
    assert accepted["recipient_membership_valid"] is True
    assert accepted["expires_at_ms"] is None
    assert accepted["sender_identity_ref"]
    assert accepted["recipient_identity_ref"]
    assert accepted["sender_identity_ref"] != accepted["recipient_identity_ref"]
    delivered = next(record for record in records if record["signal_id"] == "trace-valid-1" and
                     record["outcome"] == "delivered_to_recipient_socket")
    assert delivered["sender_id"] == accepted["sender_id"]
    assert delivered["recipient_id"] == accepted["recipient_id"]
    end_marker_record = next(record for record in records if record["signal_id"] == "trace-eoc-1")
    assert end_marker_record["outcome"] == "accepted"
    assert end_marker_record["candidate_type"] == "end_of_candidates"
    mdns_record = next(record for record in records if record["signal_id"] == "trace-mdns-1")
    assert mdns_record["candidate_type"] == "host"
    rejected = next(record for record in records if record["signal_id"] == "trace-stale-1")
    assert rejected["outcome"] == "rejected"
    assert rejected["rejection_reason"] == "session_id_mismatch"
    assert rejected["active_session_id"] != rejected["session_id"]
    assert rejected["recipient_membership_valid"] is None
    oversized = next(record for record in records if record["signal_id"] == "trace-large-1")
    assert oversized["rejection_reason"] == "sdp_too_large"
    assert "v=0" not in caplog.text
    assert "x" * 100 not in caplog.text
    assert "server-only-test-secret" not in caplog.text


def test_same_identity_reconnect_replaces_its_voice_socket_without_duplicate_members(caplog):
    async def scenario():
        service, _, _, _, _ = build_service()
        old_socket, other_socket, new_socket = Socket(), Socket(), Socket()
        await service.handle("p1", old_socket, {"type": "voice_join", "game_id": "game-1"})
        old_peer_id = old_socket.latest("voice_joined")["self_peer_id"]
        session_id = old_socket.latest("voice_joined")["session_id"]
        await service.handle("p2", other_socket, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p1", new_socket, {"type": "voice_join", "game_id": "game-1"})

        new_peer_id = new_socket.latest("voice_joined")["self_peer_id"]
        session = service.sessions["preview:ROOM1"]
        assert set(session["members"]) == {"p1", "p2"}
        assert session["session_id"] == session_id
        assert session["members"]["p1"]["peer_id"] == new_peer_id
        assert new_peer_id != old_peer_id
        assert old_socket.latest("voice_left")["message"] == "Voice moved to another connection"
        assert any(item.get("type") == "voice_peer_left" and item.get("peer_id") == old_peer_id
                   for item in other_socket.messages)
        assert any(item.get("type") == "voice_peer_joined" and
                   item.get("participant", {}).get("peer_id") == new_peer_id
                   for item in other_socket.messages)

    caplog.set_level(logging.INFO, logger="voice")
    run(scenario())
    records = [json.loads(record.getMessage().removeprefix("voice_member_lifecycle "))
               for record in caplog.records
               if record.getMessage().startswith("voice_member_lifecycle ")]
    first_join = next(record for record in records if record["event"] == "joined")
    p1_records = [record for record in records if record["identity_ref"] == first_join["identity_ref"]]
    old_join = next(record for record in p1_records if record["event"] == "joined")
    replacement_leave = next(record for record in p1_records if record["event"] == "left")
    new_join = [record for record in p1_records if record["event"] == "joined"][1]
    assert old_join["identity_ref"] == replacement_leave["identity_ref"] == new_join["identity_ref"]
    assert old_join["connection_ref"] == replacement_leave["connection_ref"]
    assert new_join["connection_ref"] != old_join["connection_ref"]
    assert replacement_leave["reason"] == "same_identity_reconnected_on_new_websocket"
    assert old_join["peer_id"] == replacement_leave["peer_id"]
    assert new_join["peer_id"] != old_join["peer_id"]


def test_signaling_and_disconnect_cleanup_are_serialized_per_voice_room():
    async def scenario():
        service, _, _, _, _ = build_service()
        first, second = Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p2", second, {"type": "voice_join", "game_id": "game-1"})
        session_id = first.latest("voice_joined")["session_id"]
        peer_ids = {
            "p1": first.latest("voice_joined")["self_peer_id"],
            "p2": second.latest("voice_joined")["self_peer_id"],
        }
        sockets = {"p1": first, "p2": second}
        sender_uid = "p1" if peer_ids["p1"] < peer_ids["p2"] else "p2"
        target_uid = "p2" if sender_uid == "p1" else "p1"
        sender, target = sockets[sender_uid], sockets[target_uid]
        sender_peer_id, target_peer_id = peer_ids[sender_uid], peer_ids[target_uid]
        original_authorize = service._authorize_existing
        target_authorization_started = asyncio.Event()
        allow_target_authorization = asyncio.Event()

        async def delayed_target_authorization(room_key, uid, member):
            if uid == target_uid:
                target_authorization_started.set()
                await allow_target_authorization.wait()
            return await original_authorize(room_key, uid, member)

        service._authorize_existing = delayed_target_authorization
        signal_task = asyncio.create_task(service.handle(sender_uid, sender, {
            "type": "voice_offer", "session_id": session_id, "to_peer_id": target_peer_id,
            "connection_id": pair_connection_id(sender_peer_id, target_peer_id),
            "description": {"type": "offer", "sdp": "valid-offer"},
        }))
        await target_authorization_started.wait()
        leave_task = asyncio.create_task(service.leave_socket(target))
        await asyncio.sleep(0)
        assert target_uid in service.sessions["preview:ROOM1"]["members"]

        allow_target_authorization.set()
        await asyncio.gather(signal_task, leave_task)
        assert any(message["type"] == "voice_offer" for message in target.messages)
        assert target_uid not in service.sessions["preview:ROOM1"]["members"]

        await service.handle(sender_uid, sender, {
            "type": "voice_offer", "session_id": session_id, "to_peer_id": target_peer_id,
            "connection_id": pair_connection_id(sender_peer_id, target_peer_id),
            "description": {"type": "offer", "sdp": "stale-offer"},
        })
        assert not any(message.get("description", {}).get("sdp") == "stale-offer"
                       for message in target.messages)

    run(scenario())


def test_participant_cap_duplicate_join_and_cleanup_are_idempotent():
    async def scenario():
        service, _, _, _, _ = build_service(participant_limit=2)
        first, replacement, second, third = Socket(), Socket(), Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        assert len(service.sessions["preview:ROOM1"]["members"]) == 1
        await service.handle("p1", replacement, {"type": "voice_join", "game_id": "game-1"})
        assert replacement.latest("voice_joined")
        await service.handle("p2", second, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p3", third, {"type": "voice_join", "game_id": "game-1"})
        assert third.latest("voice_error")["message"] == "This voice channel is full"
        assert len(service.sessions["preview:ROOM1"]["members"]) == 2
        assert await service.leave_socket(replacement)
        assert not await service.leave_socket(replacement)
        await service.close_game("game-1", "ROOM1")
        assert not service.sessions
        assert second.latest("voice_left")["message"] == "Voice ended because the match ended"

    run(scenario())


def test_account_restriction_disconnect_and_stale_heartbeat_cleanup():
    async def scenario():
        service, _, _, users, clock = build_service()
        first, second = Socket(), Socket()
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p2", second, {"type": "voice_join", "game_id": "game-1"})
        users["p1"]["restricted"] = True
        await service.handle("p1", first, {"type": "voice_mute_changed",
                                               "session_id": first.latest("voice_joined")["session_id"],
                                               "muted": True})
        assert first.latest("voice_left")
        assert "p1" not in service.sessions["preview:ROOM1"]["members"]
        users["p1"]["restricted"] = False
        await service.handle("p1", first, {"type": "voice_join", "game_id": "game-1"})
        clock[0] += 91
        await service.heartbeat("p1", first)
        assert "p2" not in service.sessions["preview:ROOM1"]["members"]
        assert second.latest("voice_left")["message"].startswith("Voice connection expired")
        await service.leave_socket(first)

    run(scenario())


def test_per_user_voice_rate_limit_rejects_excess_presence_changes():
    async def scenario():
        service, _, _, _, _ = build_service()
        ws = Socket()
        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1"})
        session_id = ws.latest("voice_joined")["session_id"]
        for index in range(101):
            await service.handle("p1", ws, {"type": "voice_mute_changed", "session_id": session_id,
                                              "muted": bool(index % 2)})
        assert ws.latest("voice_error")["message"] == "Voice signaling rate limit exceeded"

    run(scenario())


def test_admin_spectator_voice_uses_current_spectator_permission_and_room_setting():
    async def scenario():
        service, games, db, users, _ = build_service(private=True)
        users["ops"] = {"username": "ops", "role": "moderator"}
        ws = Socket()
        games.spectators.members["game-1"] = {"ops": ws}
        games.spectators.admin_members.add(("game-1", "ops"))
        await service.handle("ops", ws, {"type": "voice_join", "game_id": "game-1"})
        assert ws.latest("voice_joined")
        users["ops"]["role"] = "member"
        await service.handle("ops", ws, {"type": "voice_mute_changed",
                                           "session_id": ws.latest("voice_joined")["session_id"],
                                           "muted": True})
        assert ws.latest("voice_left")["message"] == "Voice access is no longer available"
        assert not service.sessions

        users["ops"]["role"] = "moderator"
        db.rooms.documents[0]["spectators_enabled"] = False
        await service.handle("ops", ws, {"type": "voice_join", "game_id": "game-1"})
        assert ws.latest("voice_error")

    run(scenario())


def test_spectator_presence_and_audio_configuration_do_not_include_hidden_cards_or_secrets():
    async def scenario():
        service, games, _, _, _ = build_service(private=True)
        ws = Socket()
        games.spectators.members["game-1"] = {"watcher": ws}
        await service.handle("watcher", ws, {"type": "voice_join", "game_id": "game-1"})
        joined = ws.latest("voice_joined")
        serialized = str(joined) + str(ws.latest("voice_presence"))
        assert "server-only-test-secret" not in serialized
        for forbidden in ("hands", "deck", "game_state", "room_code", "user_id", "sdp"):
            assert forbidden not in serialized

    run(scenario())


def test_turn_urls_with_embedded_static_credentials_are_not_sent_to_browsers():
    service, games, _, _, _ = build_service()
    configured = VoiceService(
        service.db, games, env="preview", load_user=service.load_user,
        has_spectate_permission=service.has_spectate_permission,
        stun_urls=[],
        turn_urls=[
            "turn:static-user:static-password@turn.voice.test:3478",
            "turn:turn.voice.test:3478?username=static-user&credential=static-password",
            "turn:turn.voice.test:3478?transport=udp",
        ],
        turn_shared_secret="server-only-test-secret",
    )
    servers = configured._ice_servers()
    assert len(servers) == 1
    assert servers[0]["urls"] == ["turn:turn.voice.test:3478?transport=udp"]
    assert "static-user" not in str(servers)
    assert "static-password" not in str(servers)


def _flood_signaling(service, uid, ws, session_id, count):
    """Simulate the ICE/mute/speaking traffic a real session produces before the user leaves."""
    async def flood():
        for index in range(count):
            await service.handle(uid, ws, {"type": "voice_mute_changed", "session_id": session_id,
                                           "muted": bool(index % 2)})
    return flood()


def test_leave_then_immediate_rejoin_after_signaling_traffic_is_not_rate_limited():
    async def scenario():
        service, _, _, _, _ = build_service()
        ws, other = Socket(), Socket()
        await service.handle("p2", other, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1", "request_id": "join-1"})
        first = ws.latest("voice_joined")
        assert first["request_id"] == "join-1"
        await _flood_signaling(service, "p1", ws, first["session_id"], 40)

        await service.handle("p1", ws, {"type": "voice_leave", "session_id": first["session_id"]})
        left = ws.latest("voice_left")
        assert left["peer_id"] == first["self_peer_id"]
        assert left["session_id"] == first["session_id"]
        assert "p1" not in service.sessions["preview:ROOM1"]["members"]

        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1", "request_id": "join-2"})
        second = ws.latest("voice_joined")
        assert second["request_id"] == "join-2"
        assert second["self_peer_id"] != first["self_peer_id"]
        assert not any(message.get("message") == "Too many voice join attempts" for message in ws.messages)
        members = service.sessions["preview:ROOM1"]["members"]
        assert len(members) == 2 and members["p1"]["peer_id"] == second["self_peer_id"]
        assert other.latest("voice_peer_left")["peer_id"] == first["self_peer_id"]
        assert other.latest("voice_peer_joined")["participant"]["peer_id"] == second["self_peer_id"]

    run(scenario())


def test_join_rate_limit_still_rejects_excess_join_attempts_and_echoes_request_id():
    async def scenario():
        service, _, _, _, clock = build_service()
        ws = Socket()
        for index in range(5):
            await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1",
                                            "request_id": f"join-{index}"})
            session_id = ws.latest("voice_joined")["session_id"]
            await service.handle("p1", ws, {"type": "voice_leave", "session_id": session_id})
        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1", "request_id": "join-5"})
        error = ws.latest("voice_error")
        assert error == {"type": "voice_error", "message": "Too many voice join attempts", "request_id": "join-5"}
        assert "p1" not in service.sessions.get("preview:ROOM1", {"members": {}})["members"]

        clock[0] += 11
        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1", "request_id": "join-6"})
        assert ws.latest("voice_joined")["request_id"] == "join-6"

    run(scenario())


def test_join_rejects_malformed_request_id_and_errors_carry_request_id():
    async def scenario():
        service, _, _, _, _ = build_service()
        ws, outsider = Socket(), Socket()
        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1", "request_id": "bad id!"})
        assert ws.latest("voice_error")["message"] == "Invalid voice room"
        assert "request_id" not in ws.latest("voice_error")
        assert not service.sessions
        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1", "request_id": "ok",
                                        "extra": 1})
        assert ws.latest("voice_error") == {"type": "voice_error", "message": "Invalid voice room",
                                            "request_id": "ok"}
        await service.handle("stranger", outsider, {"type": "voice_join", "game_id": "game-1",
                                                    "request_id": "nope"})
        assert outsider.latest("voice_error")["request_id"] == "nope"

    run(scenario())


def test_leave_is_never_refused_by_the_signaling_rate_limit():
    async def scenario():
        service, _, _, _, _ = build_service()
        ws = Socket()
        await service.handle("p1", ws, {"type": "voice_join", "game_id": "game-1"})
        session_id = ws.latest("voice_joined")["session_id"]
        await _flood_signaling(service, "p1", ws, session_id, 101)
        assert ws.latest("voice_error")["message"] == "Voice signaling rate limit exceeded"
        await service.handle("p1", ws, {"type": "voice_leave", "session_id": session_id})
        assert ws.messages[-1]["type"] == "voice_left"
        assert not service.sessions

    run(scenario())


def test_two_participants_independently_leave_and_rejoin_without_stale_members():
    async def scenario():
        service, _, _, _, _ = build_service()
        a, b = Socket(), Socket()
        await service.handle("p1", a, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p2", b, {"type": "voice_join", "game_id": "game-1"})
        peers = set()
        for uid, ws in (("p1", a), ("p2", b), ("p1", a), ("p2", b)):
            joined = ws.latest("voice_joined")
            await service.handle(uid, ws, {"type": "voice_leave", "session_id": joined["session_id"]})
            await service.handle(uid, ws, {"type": "voice_join", "game_id": "game-1"})
            peers.add(ws.latest("voice_joined")["self_peer_id"])
            members = service.sessions["preview:ROOM1"]["members"]
            assert set(members) == {"p1", "p2"}
            presence = ws.latest("voice_presence")["participants"]
            assert sorted(item["peer_id"] for item in presence) == sorted(
                member["peer_id"] for member in members.values())
        assert len(peers) == 4
        assert len(service.socket_index) == 2 and len(service.user_index) == 2

    run(scenario())


def test_rejoin_on_new_socket_after_websocket_reconnect():
    async def scenario():
        service, _, _, _, _ = build_service()
        old, new, other = Socket(), Socket(), Socket()
        await service.handle("p2", other, {"type": "voice_join", "game_id": "game-1"})
        await service.handle("p1", old, {"type": "voice_join", "game_id": "game-1"})
        old_peer = old.latest("voice_joined")["self_peer_id"]
        await _flood_signaling(service, "p1", old, old.latest("voice_joined")["session_id"], 30)
        assert await service.leave_socket(old)
        await service.handle("p1", new, {"type": "voice_join", "game_id": "game-1", "request_id": "after-reconnect"})
        joined = new.latest("voice_joined")
        assert joined["request_id"] == "after-reconnect" and joined["self_peer_id"] != old_peer
        assert service.sessions["preview:ROOM1"]["members"]["p1"]["ws"] is new
        assert id(old) not in service.socket_index

    run(scenario())
