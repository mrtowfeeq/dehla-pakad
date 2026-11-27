import copy
from datetime import datetime, timezone

import pytest

from lobby_chat import (
    LobbyChatAccessError,
    LobbyChatRateLimiter,
    existing_room_chat_filter,
    load_private_lobby_history,
    send_private_lobby_message,
)


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, field, direction):
        self.docs.sort(key=lambda doc: doc.get(field, ""), reverse=direction < 0)
        return self

    def limit(self, count):
        self.docs = self.docs[:count]
        return self

    async def to_list(self, length):
        return copy.deepcopy(self.docs[:length])


class FakeCollection:
    def __init__(self, docs=()):
        self.docs = [copy.deepcopy(doc) for doc in docs]

    @staticmethod
    def _matches(doc, query):
        for key, expected in query.items():
            actual = doc.get(key)
            if key == "seats":
                if expected not in (actual or []):
                    return False
            elif isinstance(expected, dict) and "$ne" in expected:
                if actual == expected["$ne"]:
                    return False
            elif actual != expected:
                return False
        return True

    async def find_one(self, query, projection=None):
        return next((copy.deepcopy(doc) for doc in self.docs if self._matches(doc, query)), None)

    def find(self, query, projection=None):
        return FakeCursor([doc for doc in self.docs if self._matches(doc, query)])

    async def insert_one(self, doc):
        self.docs.append(copy.deepcopy(doc))


class FakeDatabase:
    def __init__(self):
        self.rooms = FakeCollection([
            {"code": "PRIV1", "is_public": False, "status": "lobby", "seats": ["a", "b", None, None]},
            {"code": "PRIV2", "is_public": False, "status": "lobby", "seats": ["c", "d", None, None]},
            {"code": "PUB01", "is_public": True, "status": "lobby", "seats": ["e", "f", None, None]},
            {"code": "PLAY1", "is_public": False, "status": "playing", "seats": ["g", "h", "i", "j"]},
        ])
        self.chat_messages = FakeCollection()
        self.users = FakeCollection([
            {"user_id": user_id, "username": f"player-{user_id}"}
            for user_id in "abcdefghij"
        ])


class FakeHub:
    def __init__(self, connected=()):
        self.connected = set(connected)
        self.deliveries = []

    async def send_many(self, user_ids, message):
        recipients = [user_id for user_id in set(user_ids) if user_id in self.connected]
        self.deliveries.append((recipients, copy.deepcopy(message)))


def run(coro):
    try:
        coro.send(None)
    except StopIteration as completed:
        return completed.value
    raise RuntimeError("The fake database test attempted to await external I/O")


def test_private_members_send_receive_and_messages_stay_in_their_room():
    db = FakeDatabase()
    hub = FakeHub(connected={"a", "b", "c", "d"})
    limiter = LobbyChatRateLimiter()

    assert run(send_private_lobby_message(db, hub, limiter, "a", {"room_code": "priv1", "text": "hello"})) is None
    assert run(send_private_lobby_message(db, hub, limiter, "b", {"room_code": "PRIV1", "text": "hi back"})) is None
    assert run(send_private_lobby_message(db, hub, limiter, "c", {"room_code": "PRIV2", "text": "other room"})) is None

    assert [set(entry[0]) for entry in hub.deliveries] == [{"a", "b"}, {"a", "b"}, {"c", "d"}]
    assert all(entry[1]["type"] == "private_lobby_chat_message" for entry in hub.deliveries)
    assert [doc["channel"] for doc in db.chat_messages.docs] == ["private_lobby"] * 3
    assert [doc["room_code"] for doc in db.chat_messages.docs] == ["PRIV1", "PRIV1", "PRIV2"]

    room_one = run(load_private_lobby_history(db, "PRIV1", "a"))
    assert {message["text"] for message in room_one} == {"hello", "hi back"}


@pytest.mark.parametrize("code,user_id", [("PRIV1", "outsider"), ("MISSING", "a")])
def test_users_outside_a_room_cannot_send_or_read_history(code, user_id):
    db = FakeDatabase()
    hub = FakeHub(connected={"a", "b"})
    result = run(send_private_lobby_message(
        db, hub, LobbyChatRateLimiter(), user_id, {"room_code": code, "text": "intrusion"}
    ))
    assert result["type"] == "private_lobby_chat_error"
    assert db.chat_messages.docs == []
    with pytest.raises(LobbyChatAccessError):
        run(load_private_lobby_history(db, code, user_id))


@pytest.mark.parametrize("code,user_id", [("PUB01", "e"), ("PLAY1", "g")])
def test_public_rooms_and_started_games_reject_private_lobby_channel(code, user_id):
    db = FakeDatabase()
    result = run(send_private_lobby_message(
        db, FakeHub(), LobbyChatRateLimiter(), user_id, {"room_code": code, "text": "not allowed"}
    ))
    assert result["type"] == "private_lobby_chat_error"
    assert db.chat_messages.docs == []
    with pytest.raises(LobbyChatAccessError):
        run(load_private_lobby_history(db, code, user_id))


def test_history_is_persisted_room_scoped_and_returned_oldest_first():
    db = FakeDatabase()
    hub = FakeHub()  # sender is offline; persistence still succeeds
    limiter = LobbyChatRateLimiter()
    run(send_private_lobby_message(db, hub, limiter, "a", {"room_code": "PRIV1", "text": "missed while offline"}))
    db.chat_messages.docs.append({
        "id": "other-room", "room_code": "PRIV2", "channel": "private_lobby", "ts": "2026-01-01T00:00:00+00:00"
    })

    history_after_reconnect = run(load_private_lobby_history(db, "PRIV1", "a"))
    assert len(history_after_reconnect) == 1
    assert history_after_reconnect[0]["text"] == "missed while offline"
    assert history_after_reconnect[0]["username"] == "player-a"
    assert datetime.fromisoformat(history_after_reconnect[0]["ts"]).tzinfo == timezone.utc


def test_history_returns_only_the_most_recent_sixty_messages():
    db = FakeDatabase()
    db.chat_messages.docs = [
        {"id": str(i), "room_code": "PRIV1", "channel": "private_lobby", "ts": f"2026-01-01T00:{i:02d}:00+00:00"}
        for i in range(65)
    ]
    history = run(load_private_lobby_history(db, "PRIV1", "a"))
    assert len(history) == 60
    assert [message["id"] for message in history] == [str(i) for i in range(5, 65)]


def test_private_lobby_chat_reads_and_writes_only_the_requested_environment():
    db = FakeDatabase()
    db.rooms.docs = [
        {"env": "live", "code": "PRIV1", "is_public": False, "status": "lobby", "seats": ["a", "live-seat"]},
        {"env": "preview", "code": "PRIV1", "is_public": False, "status": "lobby", "seats": ["a", "preview-seat"]},
    ]
    db.users.docs = [
        {"env": "live", "user_id": "a", "username": "live-a"},
        {"env": "preview", "user_id": "a", "username": "preview-a"},
    ]
    db.chat_messages.docs = [
        {"env": "live", "id": "live-message", "room_code": "PRIV1", "channel": "private_lobby",
         "text": "live only", "ts": "2026-01-01T00:00:00+00:00"},
        {"env": "preview", "id": "preview-message", "room_code": "PRIV1", "channel": "private_lobby",
         "text": "preview only", "ts": "2026-01-01T00:00:01+00:00"},
    ]
    history = run(load_private_lobby_history(db, "PRIV1", "a", env="preview"))
    assert [message["id"] for message in history] == ["preview-message"]

    hub = FakeHub(connected={"a", "live-seat", "preview-seat"})
    assert run(send_private_lobby_message(
        db, hub, LobbyChatRateLimiter(), "a", {"room_code": "PRIV1", "text": "preview write"}, env="preview"
    )) is None
    new_message = db.chat_messages.docs[-1]
    assert new_message["env"] == "preview"
    assert set(hub.deliveries[-1][0]) == {"a", "preview-seat"}


def test_existing_room_chat_history_keeps_public_and_game_messages_separate():
    db = FakeDatabase()
    db.chat_messages.docs = [
        {"id": "public-chat", "room_code": "PRIV1", "text": "existing room chat"},
        {"id": "game-chat", "room_code": "PRIV1", "channel": "game", "text": "game chat"},
        {"id": "lobby-chat", "room_code": "PRIV1", "channel": "private_lobby", "text": "lobby only"},
    ]
    cursor = db.chat_messages.find(existing_room_chat_filter("PRIV1"))
    messages = run(cursor.to_list(60))
    assert {message["id"] for message in messages} == {"public-chat", "game-chat"}


def test_message_length_and_chat_rate_limits_are_enforced():
    db = FakeDatabase()
    hub = FakeHub()
    limiter = LobbyChatRateLimiter(limit=1, window=10, clock=lambda: 1.0)
    too_long = run(send_private_lobby_message(
        db, hub, LobbyChatRateLimiter(), "a", {"room_code": "PRIV1", "text": "x" * 301}
    ))
    assert too_long["type"] == "private_lobby_chat_error"

    assert run(send_private_lobby_message(db, hub, limiter, "a", {"room_code": "PRIV1", "text": "one"})) is None
    limited = run(send_private_lobby_message(db, hub, limiter, "a", {"room_code": "PRIV1", "text": "two"}))
    assert limited["type"] == "private_lobby_chat_error"
    assert len(db.chat_messages.docs) == 1
