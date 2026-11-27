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
    assert body == {"queued_players": 3, "active_games": 1, "connected_players": 2}
    with pytest.raises(HTTPException) as err:
        asyncio.run(server.internal_activity(request("127.0.0.1", {"X-Forwarded-For": "198.51.100.7"})))
    assert err.value.status_code == 404
    with pytest.raises(HTTPException):
        asyncio.run(server.internal_activity(request("203.0.113.9")))
