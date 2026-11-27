"""One active session per account: SessionGuard policy plus REST and WebSocket enforcement in server.py."""
import asyncio
import copy
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import dotenv
import pytest
from fastapi import HTTPException, WebSocketDisconnect
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from session_guard import (  # noqa: E402
    SESSION_REPLACED_MESSAGE, SessionGuard, SessionInvalid, SessionReplaced, SessionUnavailable,
)

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


def run(coro):
    return asyncio.run(coro)


class Sessions:
    """In-memory `user_sessions` with the unique (env, user_id) index and conditional updates."""

    def __init__(self, delay=0):
        self.docs = []
        self.delay = delay
        self.fail = False

    def _match(self, query):
        return next((d for d in self.docs if all(d.get(k) == v for k, v in query.items())), None)

    async def find_one(self, query, projection=None):
        if self.fail:
            raise RuntimeError("database down")
        await asyncio.sleep(self.delay)
        doc = self._match(query)
        return copy.deepcopy(doc) if doc else None

    async def insert_one(self, doc):
        await asyncio.sleep(self.delay)
        if self._match({"env": doc.get("env"), "user_id": doc["user_id"]}):
            raise DuplicateKeyError("env_user_id_unique")
        self.docs.append(copy.deepcopy(doc))

    async def update_one(self, query, update):
        await asyncio.sleep(self.delay)
        doc = self._match(query)
        if doc is None:
            return SimpleNamespace(matched_count=0)
        doc.update(copy.deepcopy(update["$set"]))
        return SimpleNamespace(matched_count=1)


class Clerk:
    def __init__(self, sessions):
        self.sessions = sessions  # sid -> (user_id, created_at, status)
        self.fetched = []
        self.revoked = []
        self.down = False

    async def fetch(self, sid):
        self.fetched.append(sid)
        if self.down:
            raise ConnectionError("clerk unreachable")
        if sid not in self.sessions:
            raise SessionInvalid("unknown")
        uid, created_at, status = self.sessions[sid]
        return {"user_id": uid, "created_at": created_at, "status": status}

    async def revoke(self, sid):
        self.revoked.append(sid)


def make_guard(clerk, *, db=None, now=None, on_replaced=None, env="preview"):
    db = db or SimpleNamespace(user_sessions=Sessions())
    clock = (lambda: now[0]) if now else None
    kwargs = {"clock": clock} if clock else {}
    guard = SessionGuard(db, env, fetch_session=clerk.fetch, revoke_session=clerk.revoke,
                         on_replaced=on_replaced, **kwargs)
    return guard, db


async def settle():
    for _ in range(3):
        await asyncio.sleep(0)


SESSIONS = {
    "sess_chrome": ("user_a", 1000, "active"),
    "sess_firefox": ("user_a", 2000, "active"),
    "sess_phone": ("user_a", 3000, "active"),
    "sess_b": ("user_b", 1500, "active"),
}


# ---------- policy ----------

def test_first_login_registers_and_repeat_requests_need_no_clerk_or_db_calls():
    async def case():
        clerk = Clerk(SESSIONS)
        guard, db = make_guard(clerk)
        await guard.check("user_a", "sess_chrome")
        assert db.user_sessions.docs[0]["session_id"] == "sess_chrome"
        db.user_sessions.fail = True  # a cached active session must not touch the database
        for _ in range(5):
            await guard.check("user_a", "sess_chrome")
        assert clerk.fetched == ["sess_chrome"] and clerk.revoked == []

    run(case())


def test_newer_login_replaces_the_old_session_which_is_rejected_and_revoked():
    async def case():
        clerk = Clerk(SESSIONS)
        replaced = []

        async def on_replaced(uid, old, new):
            replaced.append((uid, old, new))

        guard, db = make_guard(clerk, on_replaced=on_replaced)
        await guard.check("user_a", "sess_chrome")
        await guard.check("user_a", "sess_firefox")  # Device B logs in
        await settle()
        assert db.user_sessions.docs[0]["session_id"] == "sess_firefox"
        assert replaced == [("user_a", "sess_chrome", "sess_firefox")]
        assert clerk.revoked == ["sess_chrome"]
        assert guard.is_replaced("user_a", "sess_chrome") and not guard.is_replaced("user_a", "sess_firefox")
        with pytest.raises(SessionReplaced) as error:
            await guard.check("user_a", "sess_chrome")  # Device A can no longer act
        assert str(error.value) == SESSION_REPLACED_MESSAGE
        await guard.check("user_a", "sess_firefox")  # Device B keeps working (refresh, reconnects)

    run(case())


def test_an_older_session_seen_after_a_newer_one_never_takes_over():
    async def case():
        clerk = Clerk(SESSIONS)
        guard, db = make_guard(clerk)
        await guard.check("user_a", "sess_firefox")
        with pytest.raises(SessionReplaced):
            await guard.check("user_a", "sess_chrome")  # created earlier, first request arrives later
        await settle()
        assert db.user_sessions.docs[0]["session_id"] == "sess_firefox"
        assert clerk.revoked == ["sess_chrome"]

    run(case())


def test_different_accounts_stay_signed_in_independently():
    async def case():
        clerk = Clerk(SESSIONS)
        replaced = AsyncMock()
        guard, db = make_guard(clerk, on_replaced=replaced)
        await guard.check("user_a", "sess_chrome")
        await guard.check("user_b", "sess_b")
        await guard.check("user_a", "sess_chrome")
        await guard.check("user_b", "sess_b")
        assert sorted(d["user_id"] for d in db.user_sessions.docs) == ["user_a", "user_b"]
        replaced.assert_not_awaited()
        assert clerk.revoked == []

    run(case())


@pytest.mark.parametrize("order", [("sess_chrome", "sess_firefox", "sess_phone"),
                                   ("sess_phone", "sess_firefox", "sess_chrome"),
                                   ("sess_firefox", "sess_phone", "sess_chrome")])
def test_simultaneous_logins_converge_on_the_newest_session(order):
    async def case():
        clerk = Clerk(SESSIONS)
        db = SimpleNamespace(user_sessions=Sessions(delay=0.001))
        # Separate guards model separate processes racing on the same database record.
        guards = [make_guard(clerk, db=db)[0] for _ in order]
        await asyncio.gather(*(g.check("user_a", sid) for g, sid in zip(guards, order)), return_exceptions=True)
        assert len(db.user_sessions.docs) == 1
        assert db.user_sessions.docs[0]["session_id"] == "sess_phone"
        fresh = make_guard(clerk, db=db)[0]
        await fresh.check("user_a", "sess_phone")
        for older in ("sess_chrome", "sess_firefox"):
            with pytest.raises(SessionReplaced):
                await fresh.check("user_a", older)

    run(case())


def test_sessions_clerk_does_not_vouch_for_are_rejected_without_changing_the_active_one():
    async def case():
        clerk = Clerk({**SESSIONS, "sess_revoked": ("user_a", 9000, "revoked"),
                       "sess_other_user": ("user_b", 9000, "active")})
        guard, db = make_guard(clerk)
        await guard.check("user_a", "sess_chrome")
        for sid in ("sess_revoked", "sess_other_user", "sess_unknown"):
            with pytest.raises(SessionInvalid):
                await guard.check("user_a", sid)
        with pytest.raises(SessionInvalid):
            await guard.check("user_a", None)
        assert db.user_sessions.docs[0]["session_id"] == "sess_chrome"

    run(case())


def test_clerk_or_database_outage_blocks_only_unverified_sessions():
    async def case():
        clerk = Clerk(SESSIONS)
        guard, db = make_guard(clerk)
        await guard.check("user_a", "sess_chrome")
        clerk.down = True
        with pytest.raises(SessionUnavailable):
            await guard.check("user_a", "sess_firefox")
        await guard.check("user_a", "sess_chrome")  # the established session keeps working
        assert db.user_sessions.docs[0]["session_id"] == "sess_chrome"
        db.user_sessions.fail = True
        with pytest.raises(SessionUnavailable):
            await guard.check("user_b", "sess_b")

    run(case())


def test_a_replacement_made_by_another_process_is_seen_after_the_cache_expires():
    async def case():
        now = [100.0]
        clerk = Clerk(SESSIONS)
        guard, db = make_guard(clerk, now=now)
        other, _ = make_guard(clerk, db=db, now=now)
        await guard.check("user_a", "sess_chrome")
        await other.check("user_a", "sess_firefox")  # newer login handled by another worker
        await guard.check("user_a", "sess_chrome")  # still within this worker's cache window
        now[0] += guard.cache_ttl + 1
        with pytest.raises(SessionReplaced):
            await guard.check("user_a", "sess_chrome")

    run(case())


# ---------- server integration ----------

@pytest.fixture
def server_guard(monkeypatch):
    clerk = Clerk(SESSIONS)
    db = SimpleNamespace(user_sessions=Sessions())
    guard = SessionGuard(db, server.ENV, fetch_session=clerk.fetch, revoke_session=clerk.revoke,
                         on_replaced=server.close_replaced_sessions)
    monkeypatch.setattr(server, "session_guard", guard)
    monkeypatch.setattr(server, "socket_sessions", {})
    return guard, clerk


def test_rest_dependency_rejects_the_replaced_session_with_a_machine_readable_401(server_guard):
    async def case():
        await server.require_active_session({"user_id": "user_a", "session_id": "sess_chrome"})
        await server.require_active_session({"user_id": "user_a", "session_id": "sess_firefox"})
        with pytest.raises(HTTPException) as error:
            await server.require_active_session({"user_id": "user_a", "session_id": "sess_chrome"})
        assert error.value.status_code == 401
        assert error.value.detail == {"code": "session_replaced", "message": SESSION_REPLACED_MESSAGE}
        assert await server.require_active_session({"user_id": "user_a", "session_id": "sess_firefox"})
        with pytest.raises(HTTPException) as missing:
            await server.require_active_session({"user_id": "user_a", "session_id": None})
        assert missing.value.status_code == 401

    run(case())


def test_every_authenticated_route_depends_on_the_session_policy():
    from fastapi.dependencies.utils import get_flat_dependant

    unprotected = []
    for route in server.app.routes:
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        calls = {dep.call for dep in get_flat_dependant(dependant).dependencies}
        if server.require_user in calls and server.require_active_session not in calls:
            unprotected.append(route.path)
    assert unprotected == []


class FakeSocket:
    def __init__(self, messages):
        self.incoming = asyncio.Queue()
        for message in messages:
            self.incoming.put_nowait(message)
        self.sent = []
        self.closed = []

    async def accept(self):
        pass

    async def receive_json(self):
        message = await self.incoming.get()
        if isinstance(message, Exception):
            raise message
        return message

    async def send_json(self, message):
        self.sent.append(message)

    async def close(self, code=1000):
        self.closed.append(code)
        self.incoming.put_nowait(WebSocketDisconnect(code))


@pytest.fixture
def ws_server(monkeypatch, server_guard):
    users = {"user_a": {"username": "alice", "role": "member"}, "user_b": {"username": "bob", "role": "member"}}

    class Users:
        async def find_one(self, query, projection=None):
            user = users.get(query.get("user_id"))
            return copy.deepcopy(user) if user else None

        async def update_one(self, *args, **kwargs):
            return SimpleNamespace(matched_count=1)

    monkeypatch.setattr(server, "db", SimpleNamespace(users=Users()))
    monkeypatch.setattr(server, "hub", server.Hub())
    monkeypatch.setattr(server, "notify_presence", AsyncMock())
    monkeypatch.setattr(server.voice_service, "leave_socket", AsyncMock())
    monkeypatch.setattr(server.games, "disconnect_spectator", AsyncMock())
    monkeypatch.setattr(server.games, "active_game_for", lambda uid: None)
    handle = AsyncMock(return_value=None)
    monkeypatch.setattr(server.games, "handle", handle)
    tokens = {"tok_chrome": ("user_a", "sess_chrome"), "tok_firefox": ("user_a", "sess_firefox"),
              "tok_b": ("user_b", "sess_b")}
    monkeypatch.setattr(server, "verify_session_token",
                        lambda token: {"sub": tokens[token][0], "sid": tokens[token][1]})
    return server_guard, handle


def auth(token):
    return {"type": "auth", "token": token}


async def until(predicate, timeout=2.0):
    """Token verification runs in a worker thread, so wait for the observable result instead of ticks."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.005)


def said_hello(socket):
    return any(m.get("type") == "hello" for m in socket.sent)


def test_newer_login_closes_the_old_socket_and_the_old_session_cannot_reconnect(ws_server):
    (guard, clerk), handle = ws_server

    async def case():
        chrome = FakeSocket([auth("tok_chrome")])
        other_user = FakeSocket([auth("tok_b")])
        chrome_task = asyncio.create_task(server.ws_endpoint(chrome))
        other_task = asyncio.create_task(server.ws_endpoint(other_user))
        await until(lambda: said_hello(chrome) and said_hello(other_user))

        # Same account logs in on Firefox: its first authenticated request takes over.
        await server.require_active_session({"user_id": "user_a", "session_id": "sess_firefox"})
        await asyncio.wait_for(chrome_task, 1)
        assert {"type": "session_replaced", "message": SESSION_REPLACED_MESSAGE} in chrome.sent
        assert chrome.closed[0] == server.WS_SESSION_REPLACED_CLOSE
        assert not other_user.closed  # another account is untouched

        # The old session's reconnect attempt is refused before it joins the hub.
        retry = FakeSocket([auth("tok_chrome")])
        await asyncio.wait_for(server.ws_endpoint(retry), 1)
        assert retry.closed == [server.WS_SESSION_REPLACED_CLOSE]
        assert not any(m.get("type") == "hello" for m in retry.sent)
        assert server.hub.sockets.get("user_a", set()) == set()

        # The newest session connects and can act.
        firefox = FakeSocket([auth("tok_firefox"), {"type": "game_action", "game_id": "g1", "action": "play"}])
        firefox_task = asyncio.create_task(server.ws_endpoint(firefox))
        await until(lambda: said_hello(firefox) and handle.await_count == 1)
        handle.assert_awaited_once()
        assert handle.await_args.args[0] == "user_a"
        await firefox.close()
        await other_user.close()
        await asyncio.wait_for(asyncio.gather(firefox_task, other_task), 1)
        assert server.socket_sessions == {}

    run(case())


def test_a_replaced_socket_cannot_send_game_actions_even_before_it_is_closed(ws_server):
    (guard, clerk), handle = ws_server

    async def case():
        chrome = FakeSocket([auth("tok_chrome")])
        task = asyncio.create_task(server.ws_endpoint(chrome))
        await until(lambda: said_hello(chrome))
        # Simulate the replacement being known before the close reaches this socket.
        guard._cache("user_a", "sess_firefox", 2000)
        await chrome.incoming.put({"type": "game_action", "game_id": "g1", "action": "play", "card": "AS"})
        await asyncio.wait_for(task, 1)
        handle.assert_not_awaited()
        assert chrome.closed[0] == server.WS_SESSION_REPLACED_CLOSE

    run(case())
