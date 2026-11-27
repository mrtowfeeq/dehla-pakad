"""Room start / leave races: a stale readiness check must never create a game with an empty seat,
and a leave that loses the race to a start must not alter the seating the game was created with."""
import asyncio
import copy
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import dotenv
import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_environment_keys = ("MONGO_URL", "DB_NAME", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY")
_original_environment = {key: os.environ.get(key) for key in _environment_keys}
_original_load_dotenv = dotenv.load_dotenv
dotenv.load_dotenv = lambda *args, **kwargs: False
os.environ.update({
    "MONGO_URL": "mongodb://127.0.0.1:27017",
    "DB_NAME": "dehla_pakad_security_tests",
    "CLERK_PUBLISHABLE_KEY": "pk_test_security_audit",
    "CLERK_SECRET_KEY": "sk_test_security_audit",
})
try:
    import server  # noqa: E402
finally:
    dotenv.load_dotenv = _original_load_dotenv
    for key, value in _original_environment.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _get(document, path):
    value = document
    for part in path.split("."):
        if isinstance(value, list) and part.isdigit():
            value = value[int(part)] if int(part) < len(value) else None
        elif isinstance(value, dict):
            value = value.get(part)
        else:
            return None
    return value


def _set(document, path, value):
    parts = path.split(".")
    target = document
    for part in parts[:-1]:
        target = target[int(part)] if isinstance(target, list) else target.setdefault(part, {})
    if isinstance(target, list):
        target[int(parts[-1])] = copy.deepcopy(value)
    else:
        target[parts[-1]] = copy.deepcopy(value)


class Result:
    def __init__(self, matched=0, deleted=0):
        self.matched_count = matched
        self.modified_count = matched
        self.deleted_count = deleted


class Rooms:
    def __init__(self, documents):
        self.documents = [copy.deepcopy(d) for d in documents]

    def _match(self, query):
        return next((d for d in self.documents if all(_get(d, k) == v for k, v in query.items())), None)

    async def find_one(self, query, projection=None):
        return copy.deepcopy(self._match(query))

    async def find_one_and_update(self, query, update, projection=None, return_document=None):
        document = self._match(query)
        if document is None:
            return None
        before = copy.deepcopy(document)
        self._apply(document, update)
        return before if return_document == server.ReturnDocument.BEFORE else copy.deepcopy(document)

    async def update_one(self, query, update):
        document = self._match(query)
        if document is None:
            return Result()
        self._apply(document, update)
        return Result(matched=1)

    async def delete_one(self, query):
        document = self._match(query)
        if document is None:
            return Result()
        self.documents.remove(document)
        return Result(deleted=1)

    @staticmethod
    def _apply(document, update):
        for path, value in update.get("$set", {}).items():
            _set(document, path, value)
        for path in update.get("$unset", {}):
            parts = path.split(".")
            parent = _get(document, ".".join(parts[:-1])) if len(parts) > 1 else document
            if isinstance(parent, dict):
                parent.pop(parts[-1], None)


def lobby(seats, ready=None, **extra):
    return {"env": server.ENV, "code": "ABC123", "host_id": "u0", "is_public": False, "status": "lobby",
            "target": 7, "dealer_seat": 0, "seats": list(seats), "bots": {},
            "ready": ready if ready is not None else {u: True for u in seats if u}, **extra}


@pytest.fixture
def patched(monkeypatch):
    def install(rooms):
        monkeypatch.setattr(server, "db", type("DB", (), {"rooms": rooms})())
        create = AsyncMock(return_value={"id": "game-1"})
        monkeypatch.setattr(server.games, "create", create)
        monkeypatch.setattr(server.games, "broadcast", AsyncMock())
        monkeypatch.setattr(server.games, "kick_bots", Mock())
        monkeypatch.setattr(server.hub, "send_many", AsyncMock())
        monkeypatch.setattr(server.hub, "send", AsyncMock())
        monkeypatch.setattr(server, "broadcast_room", AsyncMock(side_effect=lambda room: {"code": room["code"]}))
        monkeypatch.setattr(server.voice_service, "leave_room_user", AsyncMock())
        return create
    return install


def run(coro):
    return asyncio.run(coro)


def test_start_rejects_a_room_that_lost_a_player_after_the_readiness_check(patched):
    full = lobby(["u0", "u1", "u2", "u3"])
    rooms = Rooms([lobby(["u0", None, "u2", "u3"], ready={"u0": True, "u2": True, "u3": True})])
    create = patched(rooms)
    with pytest.raises(HTTPException) as error:
        run(server._start(full))  # the caller's snapshot is stale: u1 already left
    assert error.value.status_code == 409
    create.assert_not_awaited()
    assert rooms.documents[0]["status"] == "lobby" and "game_id" not in rooms.documents[0]


def test_start_rejects_a_player_who_unreadied_after_the_check(patched):
    rooms = Rooms([lobby(["u0", "u1", "u2", "u3"], ready={"u0": True, "u1": False, "u2": True, "u3": True})])
    create = patched(rooms)
    with pytest.raises(HTTPException):
        run(server._start(lobby(["u0", "u1", "u2", "u3"])))
    create.assert_not_awaited()
    assert rooms.documents[0]["status"] == "lobby"


def test_failed_game_creation_releases_the_room_instead_of_leaving_it_starting(patched):
    rooms = Rooms([lobby(["u0", "u1", "u2", "u3"])])
    create = patched(rooms)
    create.side_effect = RuntimeError("user lookup failed")
    with pytest.raises(RuntimeError):
        run(server._start(lobby(["u0", "u1", "u2", "u3"])))
    assert rooms.documents[0]["status"] == "lobby"


def test_start_creates_one_game_from_the_claimed_seating_and_a_second_start_is_refused(patched):
    rooms = Rooms([lobby(["u0", "u1", "u2", "u3"])])
    create = patched(rooms)
    run(server._start(lobby(["u0", "u1", "u2", "u3"])))
    create.assert_awaited_once()
    assert create.await_args.args[0]["seats"] == ["u0", "u1", "u2", "u3"]
    assert rooms.documents[0]["status"] == "playing" and rooms.documents[0]["game_id"] == "game-1"
    with pytest.raises(HTTPException) as error:
        run(server._start(lobby(["u0", "u1", "u2", "u3"])))
    assert error.value.status_code == 409
    assert create.await_count == 1


def test_leave_that_loses_the_race_to_start_keeps_the_game_seating(patched, monkeypatch):
    rooms = Rooms([{**lobby(["u0", "u1", "u2", "u3"]), "status": "starting"}])
    patched(rooms)
    stale = lobby(["u0", "u1", "u2", "u3"])
    assert run(server._leave(copy.deepcopy(stale), "u1")) is False
    assert rooms.documents[0]["seats"] == ["u0", "u1", "u2", "u3"]
    monkeypatch.setattr(server, "get_member_room", AsyncMock(return_value=copy.deepcopy(stale)))
    with pytest.raises(HTTPException) as error:
        run(server.leave_room("ABC123", {"user_id": "u1"}))
    assert error.value.status_code == 409
    assert rooms.documents[0]["seats"] == ["u0", "u1", "u2", "u3"]


def test_leave_clears_only_the_leaving_seat_and_keeps_a_concurrent_join(patched):
    # u2 joined after the leaving player's snapshot was read.
    rooms = Rooms([lobby(["u0", "u1", "u2", None], ready={"u0": True, "u1": True})])
    patched(rooms)
    stale = lobby(["u0", "u1", None, None], ready={"u0": True, "u1": True})
    assert run(server._leave(stale, "u1")) is True
    document = rooms.documents[0]
    assert document["seats"] == ["u0", None, "u2", None]
    assert document["ready"] == {"u0": True}
    assert stale["seats"] == ["u0", None, "u2", None]  # broadcast uses the fresh room


def test_host_leaving_passes_host_to_the_next_human(patched):
    rooms = Rooms([lobby(["u0", "u1", None, None])])
    patched(rooms)
    assert run(server._leave(lobby(["u0", "u1", None, None]), "u0")) is True
    assert rooms.documents[0]["host_id"] == "u1" and rooms.documents[0]["seats"] == [None, "u1", None, None]
