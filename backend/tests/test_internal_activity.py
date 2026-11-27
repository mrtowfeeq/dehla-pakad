"""The loopback-only activity endpoint used by deploy.sh before restarting the backend."""
import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_medals import _import_server  # noqa: E402

server = _import_server()


def request(host, headers=None):
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/api/internal/activity", "headers": raw,
                    "client": (host, 50000) if host else None, "query_string": b""})


def test_only_direct_loopback_requests_are_served():
    assert server.is_direct_loopback(request("127.0.0.1")) is True
    assert server.is_direct_loopback(request("::1")) is True
    assert server.is_direct_loopback(request("203.0.113.9")) is False
    assert server.is_direct_loopback(request(None)) is False
    # Through Nginx the peer is also 127.0.0.1, but Nginx always adds forwarding headers.
    for header in ("X-Forwarded-For", "X-Real-IP", "Forwarded", "X-Forwarded-Host"):
        assert server.is_direct_loopback(request("127.0.0.1", {header: "198.51.100.7"})) is False


def test_activity_counts_queues_games_and_players_and_refuses_everyone_else(monkeypatch):
    monkeypatch.setattr(server, "mm_queue", ["a", "b"])
    monkeypatch.setattr(server, "mm_stake_queues", {"chai": ["c"], "city": []})
    monkeypatch.setattr(server.games, "games", {"g1": {"status": "active"}, "g2": {"status": "finished"}})
    monkeypatch.setattr(server.hub, "sockets", {"u1": {object()}, "u2": set(), "u3": {object(), object()}})
    body = asyncio.run(server.internal_activity(request("127.0.0.1")))
    assert body == {"queued_players": 3, "active_games": 1, "connected_players": 2, "draining": False}
    with pytest.raises(HTTPException) as err:
        asyncio.run(server.internal_activity(request("127.0.0.1", {"X-Forwarded-For": "198.51.100.7"})))
    assert err.value.status_code == 404
    with pytest.raises(HTTPException):
        asyncio.run(server.internal_activity(request("203.0.113.9")))


# ---------------- restart drain ----------------
def start_drain_now(seconds=300):  # what the drain endpoint does, callable from inside a running loop
    server.drain_until = server.time.monotonic() + seconds


def drain(seconds, host="127.0.0.1", headers=None):
    return asyncio.run(server.internal_drain(request(host, headers), seconds=seconds))


@pytest.fixture
def undrained(monkeypatch):
    monkeypatch.setattr(server, "drain_until", 0.0)
    monkeypatch.setattr(server, "mm_queue", [])
    monkeypatch.setattr(server, "mm_stake_queues", {"chai": []})
    monkeypatch.setattr(server, "mm_forming", 0)
    yield
    server.drain_until = 0.0


def test_drain_is_loopback_only_bounded_and_can_be_lifted(undrained):
    for host, headers in (("203.0.113.9", None), ("127.0.0.1", {"X-Forwarded-For": "198.51.100.7"})):
        with pytest.raises(HTTPException) as err:
            drain(300, host, headers)
        assert err.value.status_code == 404
    assert server.drain_seconds_left() == 0
    assert drain(300) == {"draining": True, "seconds_left": 300}
    assert asyncio.run(server.internal_activity(request("127.0.0.1")))["draining"] is True
    assert drain(10_000)["seconds_left"] == server.DRAIN_MAX_SECONDS
    assert drain(0) == {"draining": False, "seconds_left": 0}
    assert drain(-5) == {"draining": False, "seconds_left": 0}


def test_drain_expires_by_itself(undrained, monkeypatch):
    drain(60)
    clock = server.time.monotonic() + 61
    monkeypatch.setattr(server.time, "monotonic", lambda: clock)
    assert server.drain_seconds_left() == 0
    server.refuse_if_draining()  # no error once expired


def test_draining_refuses_queue_joins(undrained, monkeypatch):
    monkeypatch.setattr(server.games, "active_game_for", lambda uid: None)
    left = []

    async def leave_all_lobbies(uid):
        left.append(uid)

    monkeypatch.setattr(server, "leave_all_lobbies", leave_all_lobbies)
    drain(300)
    with pytest.raises(HTTPException) as err:
        asyncio.run(server.mm_join(None, {"user_id": "u1"}))
    assert err.value.status_code == 503 and "restarting" in err.value.detail
    assert left == [] and server.mm_queue == []


def test_drain_switched_on_mid_join_never_lands_in_the_queue(undrained, monkeypatch):
    monkeypatch.setattr(server.games, "active_game_for", lambda uid: None)

    async def leave_all_lobbies(uid):  # the drain begins while the join is awaiting
        start_drain_now()

    monkeypatch.setattr(server, "leave_all_lobbies", leave_all_lobbies)
    with pytest.raises(HTTPException) as err:
        asyncio.run(server.mm_join(None, {"user_id": "u1"}))
    assert err.value.status_code == 503
    assert server.mm_queue == []


class FakeRooms:
    def __init__(self, on_claim=None):
        self.on_claim, self.claims, self.released = on_claim, 0, []

    async def find_one_and_update(self, query, update, **kwargs):
        self.claims += 1
        if self.on_claim:
            self.on_claim()
        return {"code": query["code"], "status": "lobby", "seats": ["a", "b", "c", "d"], "ready": {}}

    async def update_one(self, query, update, **kwargs):
        if update == {"$set": {"status": "lobby"}}:
            self.released.append(query["code"])


def test_draining_refuses_game_starts_before_claiming(undrained, monkeypatch):
    rooms = FakeRooms()
    monkeypatch.setattr(server, "db", type("DB", (), {"rooms": rooms})())
    drain(300)
    with pytest.raises(HTTPException) as err:
        asyncio.run(server._start({"code": "ROOM01"}))
    assert err.value.status_code == 503
    assert rooms.claims == 0


def test_drain_switched_on_during_the_claim_gives_the_room_back(undrained, monkeypatch):
    rooms = FakeRooms(on_claim=start_drain_now)
    monkeypatch.setattr(server, "db", type("DB", (), {"rooms": rooms})())
    monkeypatch.setattr(server.games, "create", lambda *a, **k: pytest.fail("no game may be created"))
    with pytest.raises(HTTPException) as err:
        asyncio.run(server._start({"code": "ROOM01"}))
    assert err.value.status_code == 503
    assert rooms.released == ["ROOM01"]


def test_players_being_matched_still_count_as_queued(undrained, monkeypatch):
    seen = {}

    async def new_code():
        seen["queued"] = (await server.internal_activity(request("127.0.0.1")))["queued_players"]
        return "ROOM02"

    class Rooms:
        async def insert_one(self, doc):
            pass

    async def send_many(*a, **k):
        pass

    async def ready_deadline(code):
        pass

    monkeypatch.setattr(server, "new_code", new_code)
    monkeypatch.setattr(server, "db", type("DB", (), {"rooms": Rooms()})())
    monkeypatch.setattr(server.hub, "send_many", send_many)
    monkeypatch.setattr(server, "_ready_deadline", ready_deadline)
    monkeypatch.setattr(server, "mm_queue", ["a", "b", "c", "d"])

    async def run():
        code = await server._try_match("a", "free")
        await asyncio.sleep(0)
        return code

    assert asyncio.run(run()) == "ROOM02"
    assert seen["queued"] == 4  # taken off the queue, room not stored yet: still counted
    assert server.mm_forming == 0
