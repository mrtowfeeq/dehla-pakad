import asyncio
import copy
import inspect
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
import dotenv
from fastapi import HTTPException
from pydantic import ValidationError
from pymongo.errors import DuplicateKeyError, PyMongoError
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_environment_keys = ("MONGO_URL", "DB_NAME", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY")
_original_environment = {key: os.environ.get(key) for key in _environment_keys}
_original_load_dotenv = dotenv.load_dotenv


def _skip_dotenv(*args, **kwargs):
    return False


dotenv.load_dotenv = _skip_dotenv
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


class MemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(document) for document in documents]

    @staticmethod
    def matches(document, query):
        for key, expected in query.items():
            value = document.get(key)
            if isinstance(expected, dict) and "$in" in expected:
                if value not in expected["$in"]:
                    return False
            elif value != expected:
                return False
        return True

    async def find_one(self, query, projection=None):
        document = next((doc for doc in self.documents if self.matches(doc, query)), None)
        return copy.deepcopy(document)

    async def count_documents(self, query):
        return sum(self.matches(document, query) for document in self.documents)

    async def update_one(self, query, update):
        document = next((doc for doc in self.documents if self.matches(doc, query)), None)
        if document is None:
            return SimpleNamespace(matched_count=0)
        document.update(copy.deepcopy(update.get("$set", {})))
        return SimpleNamespace(matched_count=1)

    async def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))
        return SimpleNamespace(inserted_id=len(self.documents))


class MemoryDatabase:
    def __init__(self, users=()):
        self.users = MemoryCollection(users)
        self.admin_audit_logs = MemoryCollection()
        self.admin_role_locks = MemoryLockCollection()


class MemoryLockCollection:
    def __init__(self):
        self.document = None

    async def find_one_and_update(self, query, update, upsert=False, return_document=None):
        now = query["lease_until"]["$lte"]
        if self.document and self.document["lease_until"] > now:
            raise DuplicateKeyError("The role lock is held")
        if self.document is None and not upsert:
            return None
        self.document = {"_id": query["_id"], **copy.deepcopy(update["$set"])}
        return copy.deepcopy(self.document)

    async def update_one(self, query, update):
        if not self.document or any(self.document.get(key) != value for key, value in query.items()):
            return SimpleNamespace(matched_count=0)
        self.document.update(copy.deepcopy(update.get("$set", {})))
        return SimpleNamespace(matched_count=1)


def run(coro):
    return asyncio.run(coro)


def request(path, method="GET", query=b"", headers=(), client=("127.0.0.1", 12345)):
    return Request({
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1", "method": method, "scheme": "http", "path": path,
        "raw_path": path.encode(), "query_string": query, "root_path": "",
        "headers": [(key.lower().encode(), value.encode()) for key, value in headers],
        "client": client, "server": ("local.test", 80), "state": {},
    })


def fake_database(users=()):
    database = MemoryDatabase(users)
    server.db = database
    server.games.db = database
    return database


def test_authenticated_staff_denial_is_audited_without_query_or_credential_data():
    async def run_case():
        database = fake_database()
        server._admin_request_hits.clear()
        req = request("/api/users", query=b"token=never-log-this")
        guard = server.require_role("admin")
        with pytest.raises(HTTPException) as denied:
            await guard(req, {"user_id": "support-1", "role": "support"})

        assert denied.value.status_code == 403
        record = database.admin_audit_logs.documents[-1]
        assert record["admin_id"] == "support-1"
        assert record["action"] == "authorization_denied"
        assert record["target_id"] == "/api/users"
        assert "never-log-this" not in str(record)

    run(run_case())


def test_unauthenticated_admin_denial_is_audited_without_token_data():
    async def run_case():
        database = fake_database()
        req = request("/api/admin/overview", query=b"token=never-log-this")

        async def unauthorized(_request):
            return SimpleNamespace(status_code=401)

        response = await server.audit_denied_admin_access(req, unauthorized)
        record = database.admin_audit_logs.documents[-1]
        assert response.status_code == 401
        assert record["admin_id"] is None
        assert record["action"] == "authorization_denied"
        assert record["target_id"] == "/api/admin/overview"
        assert "never-log-this" not in str(record)

    run(run_case())


def test_admin_cannot_change_own_role_and_denial_is_recorded():
    async def run_case():
        database = fake_database([{"user_id": "admin-1", "env": "preview", "role": "admin"}])
        req = request("/api/users/admin-1/role", method="PATCH")
        with pytest.raises(HTTPException) as denied:
            await server.set_role("admin-1", server.RoleIn(role="support"), req,
                                  {"user_id": "admin-1", "role": "admin"})

        assert denied.value.status_code == 403
        assert database.users.documents[0]["role"] == "admin"
        assert database.admin_audit_logs.documents[-1]["action"] == "role_change_denied"
        assert database.admin_audit_logs.documents[-1]["reason"] == "Administrators cannot change their own role"

    run(run_case())


def test_demoting_an_admin_revokes_their_open_privileged_spectator_sessions():
    async def run_case():
        database = fake_database([
            {"user_id": "admin-1", "env": "preview", "role": "admin"},
            {"user_id": "admin-2", "env": "preview", "role": "admin"},
        ])
        server._health_admin_role_cache["admin-2"] = server.time.monotonic() + server.HEALTH_ADMIN_ROLE_CACHE_TTL
        req = request("/api/users/admin-2/role", method="PATCH")
        revoke = AsyncMock(return_value=1)
        original_revoke = server.games.revoke_admin_spectators
        server.games.revoke_admin_spectators = revoke
        try:
            result = await server.set_role("admin-2", server.RoleIn(role="support"), req,
                                           {"user_id": "admin-1", "role": "admin"})
        finally:
            server.games.revoke_admin_spectators = original_revoke

        assert result == {"user_id": "admin-2", "role": "support"}
        assert database.users.documents[1]["role"] == "support"
        assert "admin-2" not in server._health_admin_role_cache
        revoke.assert_awaited_once_with("admin-2")
        assert database.admin_audit_logs.documents[-1]["action"] == "role_changed"

    run(run_case())


def test_role_api_rejects_mass_assignment_fields():
    with pytest.raises(ValidationError):
        server.RoleIn.model_validate({"role": "support", "env": "live", "email": "attacker@example.invalid"})


def test_sensitive_admin_requests_have_per_actor_rate_limits():
    server._admin_request_hits.clear()
    assert server.allow_admin_request("admin-1", "role-change", limit=2, now=100.0)
    assert server.allow_admin_request("admin-1", "role-change", limit=2, now=100.1)
    assert not server.allow_admin_request("admin-1", "role-change", limit=2, now=100.2)
    assert server.allow_admin_request("admin-2", "role-change", limit=2, now=100.2)
    assert server.allow_admin_request("admin-1", "role-change", limit=2, now=160.0)


def test_environment_filters_are_exact_and_exclude_untagged_records():
    assert server.IN_ENV == {"env": server.ENV}
    query = server.scoped_query({"status": "active"}, server.ENV)
    records = MemoryCollection([
        {"env": server.ENV, "status": "active"},
        {"env": "other", "status": "active"},
        {"status": "active"},
    ])
    assert run(records.count_documents(query)) == 1
    assert server.games._scope({"id": "game-1"}) == {"id": "game-1", "env": server.ENV}


def test_new_rooms_are_tagged_and_code_checks_are_environment_scoped(monkeypatch):
    class Rooms:
        def __init__(self):
            self.find_queries = []
            self.inserted = None

        async def find_one(self, query, projection=None):
            self.find_queries.append(query)
            return None

        async def insert_one(self, document):
            self.inserted = copy.deepcopy(document)

    async def run_case():
        rooms = Rooms()
        monkeypatch.setattr(server, "db", SimpleNamespace(rooms=rooms))
        monkeypatch.setattr(server, "ensure_free", AsyncMock())
        monkeypatch.setattr(server, "leave_all_lobbies", AsyncMock())
        monkeypatch.setattr(server, "room_view", AsyncMock(return_value={"ok": True}))
        result = await server.create_room(server.RoomCreateIn(target=5), {"user_id": "player-1"})
        assert result == {"ok": True}
        assert rooms.find_queries == [{"code": rooms.inserted["code"], "env": server.ENV}]
        assert rooms.inserted["env"] == server.ENV

    run(run_case())


def test_admin_chart_aggregation_includes_the_environment_filter():
    class Cursor:
        async def to_list(self, _limit):
            return []

    class Collection:
        pipeline = None

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return Cursor()

    async def run_case():
        collection = Collection()
        await server._admin_daily_counts(collection, "finished_at", server.datetime.now(server.timezone.utc),
                                         server.datetime.now(server.timezone.utc), server.IN_ENV)
        assert collection.pipeline[0]["$match"]["env"] == server.ENV

    run(run_case())


def test_current_member_does_not_adopt_a_user_or_role_from_another_environment(monkeypatch):
    class ScopedUsers:
        def __init__(self):
            self.documents = [{"user_id": "same-clerk-id", "env": "live", "role": "admin", "username": "live-user"}]
            self.queries = []

        async def find_one(self, query, projection=None):
            self.queries.append(query)
            return next((copy.deepcopy(doc) for doc in self.documents
                         if all(doc.get(key) == value for key, value in query.items())), None)

        async def update_one(self, query, update):
            self.queries.append(query)
            return SimpleNamespace(matched_count=0)

        async def find_one_and_update(self, query, update, **kwargs):
            self.queries.append(query)
            document = copy.deepcopy(update["$setOnInsert"])
            self.documents.append(document)
            return document

    async def run_case():
        users = ScopedUsers()
        monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
        monkeypatch.setattr(server, "_clerk_identity", lambda _uid: ("player@example.invalid", False))
        member = await server.current_member(request("/api/me"), {"user_id": "same-clerk-id"})
        assert member["role"] == "member"
        assert member["env"] == server.ENV
        assert all(query.get("env") == server.ENV for query in users.queries)

    run(run_case())


def test_admin_audit_records_are_tagged_with_the_current_environment():
    async def run_case():
        database = fake_database()
        await server.games.audit_admin("admin-1", "dashboard_viewed")
        assert database.admin_audit_logs.documents[-1]["env"] == server.ENV

    run(run_case())


def test_bootstrap_admin_requires_a_verified_explicitly_configured_email(monkeypatch):
    response = SimpleNamespace(
        raise_for_status=lambda: None,
        json=lambda: {"email_addresses": [
            {"email_address": "admin@example.invalid", "verification": {"status": "unverified"}},
            {"email_address": "verified@example.invalid", "verification": {"status": "verified"}},
        ]},
    )
    monkeypatch.setattr(server.requests, "get", lambda *args, **kwargs: response)
    monkeypatch.setenv("CLERK_SECRET_KEY", "test-clerk-key")
    monkeypatch.setenv("ADMIN_EMAIL", "admin@example.invalid")
    assert server._clerk_identity("user-1") == ("verified@example.invalid", False)
    monkeypatch.setenv("ADMIN_EMAIL", " VERIFIED@example.invalid,other@example.invalid ")
    assert server._clerk_identity("user-1") == ("verified@example.invalid", True)


def test_forwarded_ip_is_ignored_unless_direct_peer_is_a_configured_proxy(monkeypatch):
    req = request("/api/me", headers=[("x-forwarded-for", "198.51.100.17")],
                  client=("203.0.113.24", 51234))
    monkeypatch.delenv("TRUSTED_PROXY_CIDRS", raising=False)
    assert server.client_ip(req) == "203.0.113.24"

    trusted_req = request("/api/me", headers=[("x-forwarded-for", "198.51.100.17")],
                          client=("10.2.0.8", 51234))
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "10.2.0.0/24")
    assert server.client_ip(trusted_req) == "198.51.100.17"


def test_forwarded_ip_chain_stops_at_first_untrusted_hop(monkeypatch):
    req = request("/api/me", headers=[("x-forwarded-for", "192.0.2.10, 10.2.0.5")],
                  client=("10.2.0.8", 51234))
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "10.2.0.0/24")
    assert server.client_ip(req) == "192.0.2.10"


def test_forwarded_host_is_ignored_for_untrusted_direct_peers(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "10.2.0.0/24")
    req = request("/api/__clerk/session", headers=[("x-forwarded-host", "attacker.example.invalid")],
                  client=("203.0.113.24", 51234))
    assert server.trusted_proxy_header(req, "x-forwarded-host") is None
    trusted_req = request("/api/__clerk/session", headers=[("x-forwarded-host", "app.example.invalid")],
                          client=("10.2.0.8", 51234))
    assert server.trusted_proxy_header(trusted_req, "x-forwarded-host") == "app.example.invalid"


def test_websocket_authentication_requires_first_message_not_query_parameter(monkeypatch):
    assert "token" not in inspect.signature(server.ws_endpoint).parameters

    class FakeWebSocket:
        def __init__(self, first_message):
            self.first_message = first_message
            self.query_params = {"token": "must-not-authenticate-from-query"}
            self.closed = []
            self.sent = []

        async def accept(self):
            pass

        async def receive_json(self):
            return self.first_message

        async def close(self, code):
            self.closed.append(code)

        async def send_json(self, message):
            self.sent.append(message)

    async def run_case():
        verify = Mock(side_effect=HTTPException(status_code=401, detail="Invalid or expired session"))
        monkeypatch.setattr(server, "verify_session_token", verify)
        invalid = FakeWebSocket({"type": "sync_game", "token": "query-fallback-must-not-run"})
        await server.ws_endpoint(invalid)
        assert invalid.closed == [4401]
        assert invalid.sent == []
        verify.assert_not_called()

        rejected = FakeWebSocket({"type": "auth", "token": "bad-token"})
        await server.ws_endpoint(rejected)
        assert rejected.closed == [4401]
        assert rejected.sent == []
        verify.assert_called_once_with("bad-token")

    run(run_case())


def test_role_update_lock_serializes_writers_and_releases_for_recovery():
    async def run_case():
        database = fake_database()
        order = []

        async def update(name):
            async with server.admin_role_update_lock():
                order.append(f"start-{name}")
                await asyncio.sleep(0.02)
                order.append(f"end-{name}")

        await asyncio.gather(update("one"), update("two"))
        assert order in (["start-one", "end-one", "start-two", "end-two"],
                         ["start-two", "end-two", "start-one", "end-one"])
        assert database.admin_role_locks.document["lease_until"].timestamp() == 0

    run(run_case())


def test_social_relationship_and_invitation_mutations_are_environment_scoped(monkeypatch):
    class ScopedRecords:
        def __init__(self, documents=()):
            self.documents = copy.deepcopy(list(documents))
            self.queries = []
            self.updates = []
            self.inserts = []

        async def find_one(self, query, projection=None):
            self.queries.append(copy.deepcopy(query))
            return copy.deepcopy(next((doc for doc in self.documents if all(doc.get(k) == v for k, v in query.items())), None))

        def find(self, query, projection=None):
            self.queries.append(copy.deepcopy(query))
            docs = [copy.deepcopy(doc) for doc in self.documents
                    if all(doc.get(k) == v for k, v in query.items() if not k.startswith("$"))]
            return ScopedCursor(docs)

        async def update_one(self, query, update, upsert=False):
            self.queries.append(copy.deepcopy(query))
            self.updates.append((copy.deepcopy(query), copy.deepcopy(update)))
            document = next((doc for doc in self.documents if all(doc.get(k) == v for k, v in query.items())), None)
            if document:
                document.update(copy.deepcopy(update.get("$set", {})))
            elif upsert:
                document = copy.deepcopy(update.get("$setOnInsert", {}))
                self.documents.append(document)
            return SimpleNamespace(matched_count=1 if document else 0)

        async def delete_many(self, query):
            self.queries.append(copy.deepcopy(query))
            before = len(self.documents)
            env = query.get("env")
            pairs = query.get("$or", [])
            self.documents = [doc for doc in self.documents if not (
                doc.get("env") == env and any(all(doc.get(k) == v for k, v in pair.items()) for pair in pairs)
            )]
            return SimpleNamespace(deleted_count=before - len(self.documents))

        async def insert_one(self, document):
            self.inserts.append(copy.deepcopy(document))
            self.documents.append(copy.deepcopy(document))

    class ScopedCursor:
        def __init__(self, documents):
            self.documents = documents

        def sort(self, *_args):
            return self

        def limit(self, *_args):
            return self

        async def to_list(self, _limit):
            return copy.deepcopy(self.documents)

        def __aiter__(self):
            self._index = 0
            return self

        async def __anext__(self):
            if self._index >= len(self.documents):
                raise StopAsyncIteration
            document = self.documents[self._index]
            self._index += 1
            return copy.deepcopy(document)

    async def run_case():
        friendships = ScopedRecords([
            {"env": server.ENV, "user_id": "a", "friend_id": "b"},
            {"env": "live" if server.ENV != "live" else "preview", "user_id": "a", "friend_id": "b"},
        ])
        requests = ScopedRecords([
            {"env": server.ENV, "id": "shared-request-id", "from_id": "a", "to_id": "b", "status": "pending"},
            {"env": "live" if server.ENV != "live" else "preview", "id": "shared-request-id", "from_id": "a", "to_id": "b", "status": "pending"},
        ])
        invitations = ScopedRecords()
        monkeypatch.setattr(server, "db", SimpleNamespace(friends=friendships, friend_requests=requests, invitations=invitations))
        monkeypatch.setattr(server.hub, "send", AsyncMock())
        monkeypatch.setattr(server, "get_member_room", AsyncMock(return_value={
            "env": server.ENV, "code": "ROOM1", "is_public": False, "status": "lobby",
        }))
        member = {"user_id": "b", "username": "Bee"}

        async def users_for(ids):
            available = {"a": {"user_id": "a", "username": "A"},
                         "b": {"user_id": "b", "username": "Bee"}}
            return {user_id: available[user_id] for user_id in ids if user_id in available}

        monkeypatch.setattr(server, "users_by_ids", AsyncMock(side_effect=users_for))
        listed_friends = await server.list_friends({"user_id": "a"})
        assert [friend["user_id"] for friend in listed_friends] == ["b"]
        assert friendships.queries[-1]["env"] == server.ENV
        listed_requests = await server.friend_requests(member)
        assert [item["id"] for item in listed_requests["incoming"]] == ["shared-request-id"]
        assert requests.queries[-2].get("env") == server.ENV

        await server.respond_request("shared-request-id", "accept", member)
        assert requests.documents[0]["status"] == "accepted"
        assert requests.documents[1]["status"] == "pending"
        assert all(query.get("env") == server.ENV for query, _ in requests.updates)
        assert friendships.queries[-2].get("env") == server.ENV
        assert all(record.get("env") == server.ENV for record in friendships.documents if record.get("since"))

        await server.remove_friend("b", {"user_id": "a"})
        assert len(friendships.documents) == 1
        assert friendships.documents[0]["env"] != server.ENV
        assert friendships.queries[-1]["env"] == server.ENV

        friendships.documents.append({"env": server.ENV, "user_id": "a", "friend_id": "b"})
        await server.invite("ROOM1", server.InviteIn(user_id="b"), {"user_id": "a", "username": "A"})
        assert invitations.inserts[0]["env"] == server.ENV
        assert invitations.queries[-1].get("env") == server.ENV

    run(run_case())


def test_environment_compound_unique_indexes_do_not_declare_global_identity_keys():
    required = {
        "users": {"user_id", "username_lower"},
        "friends": {"user_id", "friend_id"},
        "friend_requests": {"id"},
        "invitations": {"id"},
        "rooms": {"code"},
        "games": {"id"},
        "spectator_sessions": {"game_id", "user_id"},
        "matches": {"game_id"},
    }
    for collection, identity_fields in required.items():
        unique_indexes = [index.document for index in server.INDEXES[collection] if index.document.get("unique")]
        for identity in identity_fields:
            index = next(index for index in unique_indexes if identity in index["key"])
            assert list(index["key"])[0] == "env", (collection, identity, index)
    username_index = next(index.document for index in server.INDEXES["users"]
                          if index.document["name"] == "env_username_lower_unique")
    assert username_index["partialFilterExpression"] == {"username_lower": {"$type": "string"}}
    for collection, models in server.INDEXES.items():
        for model in models:
            document = model.document
            if document.get("expireAfterSeconds") is not None:
                continue
            assert next(iter(document["key"])) == "env", (collection, document["name"])


def test_environment_indexes_cover_scoped_lookup_and_sorted_query_shapes():
    def keys(collection, name):
        index = next(index.document for index in server.INDEXES[collection]
                     if index.document["name"] == name)
        return list(index["key"].items())

    assert keys("users", "env_leaderboard") == [
        ("env", 1), ("stats.wins", -1), ("stats.games_played", 1),
    ]
    assert keys("rooms", "env_created_at_desc") == [("env", 1), ("created_at", -1)]
    assert keys("games", "env_room_code") == [("env", 1), ("room_code", 1)]
    assert keys("invitations", "env_to_status_created") == [
        ("env", 1), ("to_id", 1), ("status", 1), ("created_at", -1),
    ]
    assert keys("invitations", "env_to_room") == [("env", 1), ("to_id", 1), ("room_code", 1)]
    ttl = next(index.document for index in server.INDEXES["spectator_sessions"]
               if index.document.get("expireAfterSeconds") is not None)
    assert list(ttl["key"].items()) == [("expires_at", 1)]
    assert ttl["expireAfterSeconds"] == 0


def test_username_lookup_queries_include_the_partial_index_type_filter(monkeypatch):
    class EmptyCursor:
        def limit(self, _count):
            return self

        async def to_list(self, _count):
            return []

    class Users:
        def __init__(self):
            self.queries = []

        def find(self, query, projection=None):
            self.queries.append(copy.deepcopy(query))
            return EmptyCursor()

        async def find_one(self, query, projection=None):
            self.queries.append(copy.deepcopy(query))
            return None

    async def run_case(users):
        monkeypatch.setattr(server, "db", SimpleNamespace(users=users))
        member = {"user_id": "current-user"}
        await server.search_users("abc", member)
        with pytest.raises(HTTPException) as profile_missing:
            await server.profile("abc", member)
        assert profile_missing.value.status_code == 404
        with pytest.raises(HTTPException) as friend_missing:
            await server.send_friend_request(server.FriendRequestIn(username="abc"), member)
        assert friend_missing.value.status_code == 404
        with pytest.raises(HTTPException) as history_missing:
            await server.match_history(username="abc", member=member)
        assert history_missing.value.status_code == 404

    users = Users()
    run(run_case(users))
    username_queries = [query["username_lower"] for query in users.queries]
    assert username_queries
    assert all(predicate.get("$type") == "string" for predicate in username_queries)


def test_ensure_indexes_attempts_all_models_and_logs_each_creation_failure(monkeypatch, caplog):
    class IndexCollection:
        def __init__(self, name, attempted):
            self.name = name
            self.attempted = attempted

        async def create_indexes(self, models):
            model_name = models[0].document["name"]
            self.attempted.append((self.name, model_name))
            if self.name == "rooms" and model_name == "env_code_unique":
                raise RuntimeError("simulated duplicate key from legacy index")

    class IndexDatabase:
        def __init__(self):
            self.attempted = []
            self.collections = {}

        def __getitem__(self, name):
            return self.collections.setdefault(name, IndexCollection(name, self.attempted))

    async def run_case(database):
        monkeypatch.setattr(server, "db", database)
        await server.ensure_indexes()

    database = IndexDatabase()
    caplog.set_level("ERROR", logger=server.logger.name)
    run(run_case(database))

    expected_attempts = sum(len(models) for models in server.INDEXES.values())
    assert len(database.attempted) == expected_attempts
    assert ("rooms", "env_code_unique") in database.attempted
    assert ("games", "env_id_unique") in database.attempted  # creation continues after failure
    assert any("ensure_indexes(rooms.env_code_unique) failed (RuntimeError)" in record.message
               for record in caplog.records)
    assert all("simulated duplicate key from legacy index" not in record.message for record in caplog.records)
    assert server.INDEX_INITIALIZATION_STATE["status"] == "critical"
    assert server.INDEX_INITIALIZATION_STATE["failures"] == [{
        "collection": "rooms", "index": "env_code_unique", "error_type": "RuntimeError",
    }]


def test_closing_a_room_deletes_only_same_environment_room_and_private_chat(monkeypatch):
    class DeleteCollection:
        def __init__(self, documents):
            self.documents = copy.deepcopy(documents)
            self.queries = []

        async def delete_one(self, query):
            self.queries.append(copy.deepcopy(query))
            for index, doc in enumerate(self.documents):
                if all(doc.get(key) == value for key, value in query.items()):
                    self.documents.pop(index)
                    return SimpleNamespace(deleted_count=1)
            return SimpleNamespace(deleted_count=0)

        async def delete_many(self, query):
            self.queries.append(copy.deepcopy(query))
            before = len(self.documents)
            self.documents = [doc for doc in self.documents if not all(doc.get(k) == v for k, v in query.items())]
            return SimpleNamespace(deleted_count=before - len(self.documents))

    async def run_case():
        other_env = "live" if server.ENV != "live" else "preview"
        rooms = DeleteCollection([{"env": server.ENV, "code": "SAME", "status": "lobby"},
                                  {"env": other_env, "code": "SAME", "status": "lobby"}])
        chat = DeleteCollection([
            {"env": server.ENV, "room_code": "SAME", "channel": "private_lobby"},
            {"env": other_env, "room_code": "SAME", "channel": "private_lobby"},
        ])
        monkeypatch.setattr(server, "db", SimpleNamespace(rooms=rooms, chat_messages=chat))
        monkeypatch.setattr(server.hub, "send", AsyncMock())
        await server._leave({"env": server.ENV, "code": "SAME", "is_public": False, "status": "lobby",
                             "seats": ["last-player", None, None, None]}, "last-player")
        assert rooms.documents == [{"env": other_env, "code": "SAME", "status": "lobby"}]
        assert chat.documents == [{"env": other_env, "room_code": "SAME", "channel": "private_lobby"}]
        assert rooms.queries[0]["env"] == server.ENV
        assert chat.queries[0]["env"] == server.ENV

    run(run_case())


def test_explicit_legacy_environment_migration_is_dry_run_by_default_and_idempotent():
    from env_scope import assign_explicit_legacy_environment

    class MigrationCollection:
        def __init__(self):
            self.documents = [
                {"_id": "legacy-one", "value": 1},
                {"_id": "already-preview", "env": "preview"},
                {"_id": "unlisted", "value": 3},
            ]

        async def find_one(self, query, projection=None):
            return copy.deepcopy(next((doc for doc in self.documents if doc["_id"] == query["_id"]), None))

        async def update_one(self, query, update):
            doc = next((item for item in self.documents if item["_id"] == query["_id"]), None)
            if doc is not None and doc.get("env") is None:
                doc.update(copy.deepcopy(update["$set"]))
                return SimpleNamespace(matched_count=1)
            return SimpleNamespace(matched_count=0)

    async def run_case():
        collection = MigrationCollection()
        assignments = [{"_id": "legacy-one", "env": "preview"}, {"_id": "already-preview", "env": "preview"}]
        dry_run = await assign_explicit_legacy_environment(collection, assignments)
        assert dry_run == {"dry_run": True, "would_tag": 1, "already_tagged": 1, "tagged": 0}
        assert "env" not in collection.documents[0]
        applied = await assign_explicit_legacy_environment(collection, assignments, dry_run=False)
        assert applied == {"dry_run": False, "would_tag": 1, "already_tagged": 1, "tagged": 1}
        rerun = await assign_explicit_legacy_environment(collection, assignments, dry_run=False)
        assert rerun == {"dry_run": False, "would_tag": 0, "already_tagged": 2, "tagged": 0}
        assert collection.documents[0]["env"] == "preview"
        assert "env" not in collection.documents[2]

    run(run_case())


def test_explicit_legacy_migration_rejects_conflicts_before_writing_any_records():
    from env_scope import EnvironmentMigrationConflict, assign_explicit_legacy_environment

    class MigrationCollection:
        def __init__(self):
            self.documents = [{"_id": "safe-legacy"}, {"_id": "owned-by-live", "env": "live"}]
            self.writes = 0

        async def find_one(self, query, projection=None):
            return copy.deepcopy(next((doc for doc in self.documents if doc["_id"] == query["_id"]), None))

        async def update_one(self, query, update):
            self.writes += 1
            return SimpleNamespace(matched_count=0)

    async def run_case():
        collection = MigrationCollection()
        with pytest.raises(EnvironmentMigrationConflict):
            await assign_explicit_legacy_environment(collection, [
                {"_id": "safe-legacy", "env": "preview"},
                {"_id": "owned-by-live", "env": "preview"},
            ], dry_run=False)
        assert collection.writes == 0
        assert "env" not in collection.documents[0]

    run(run_case())


class HealthIndexCursor:
    def __init__(self, indexes):
        self.indexes = copy.deepcopy(indexes)

    async def to_list(self, length=None):
        return copy.deepcopy(self.indexes)


class HealthCollection:
    def __init__(self, indexes):
        self.indexes = indexes
        self.create_indexes_calls = 0

    def list_indexes(self):
        return HealthIndexCursor(self.indexes)

    async def create_indexes(self, _models):
        self.create_indexes_calls += 1
        raise AssertionError("Health diagnostics must never create indexes")


class HealthDatabase:
    def __init__(self, *, indexes=None, ping_error=None):
        indexes = indexes or {}
        self.collections = {
            collection: HealthCollection(indexes.get(collection, []))
            for collection in server.INDEXES
        }
        self.ping_error = ping_error

    async def command(self, name):
        assert name == "ping"
        if self.ping_error:
            raise self.ping_error
        return {"ok": 1}

    def __getitem__(self, collection):
        return self.collections[collection]


def _declared_mongo_indexes():
    return {
        collection: [
            {
                "name": model.document["name"],
                "key": dict(model.document["key"]),
                **{key: value for key, value in model.document.items()
                   if key not in {"name", "key"}},
            }
            for model in models
        ]
        for collection, models in server.INDEXES.items()
    }


def _ready_index_state():
    return {"status": "healthy", "started_at": "2026-01-01T00:00:00Z",
            "completed_at": "2026-01-01T00:00:01Z", "attempted": sum(map(len, server.INDEXES.values())),
            "failures": []}


def _install_health_database(monkeypatch, database):
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server.games, "db", database)
    monkeypatch.setattr(server.games, "audit_admin", AsyncMock())
    monkeypatch.setattr(server, "INDEX_INITIALIZATION_STATE", _ready_index_state())
    monkeypatch.setenv("DB_NAME", "dehla_pakad_health_test")


def test_admin_system_health_reports_healthy_metadata_and_audits_access(monkeypatch):
    async def run_case():
        database = HealthDatabase(indexes=_declared_mongo_indexes())
        _install_health_database(monkeypatch, database)
        result = await server.admin_system_health({"user_id": "admin-health"})

        assert result["status"] == "healthy"
        assert result["database"] == {"status": "healthy", "name": "dehla_pakad_health_test"}
        assert result["indexes"]["verified_count"] == result["indexes"]["declared_count"]
        assert result["indexes"]["missing_count"] == 0
        assert result["spectator_ttl"]["status"] == "healthy"
        assert result["spectator_ttl"]["declared"]["expire_after_seconds"] == 0
        assert result["websocket"]["status"] == "healthy"
        server.games.audit_admin.assert_awaited_once_with(
            "admin-health", "system_health_viewed", target_type="system_health"
        )
        assert all(collection.create_indexes_calls == 0 for collection in database.collections.values())

    run(run_case())


def test_admin_system_health_reports_missing_required_index(monkeypatch):
    async def run_case():
        indexes = _declared_mongo_indexes()
        indexes["users"] = [item for item in indexes["users"] if item["name"] != "env_leaderboard"]
        _install_health_database(monkeypatch, HealthDatabase(indexes=indexes))
        result = await server.admin_system_health({"user_id": "admin-health"})

        assert result["status"] == "critical"
        assert result["indexes"]["missing_count"] == 1
        missing = next(item for item in result["indexes"]["items"] if item["declared"]["name"] == "env_leaderboard")
        assert missing["verification"]["issues"] == ["missing"]

    run(run_case())


def test_admin_system_health_reports_incompatible_unique_partial_and_ttl_options(monkeypatch):
    async def run_case():
        indexes = _declared_mongo_indexes()
        users_index = next(item for item in indexes["users"] if item["name"] == "env_username_lower_unique")
        users_index["partialFilterExpression"] = {"username_lower": {"$type": "number"}}
        users_index["unique"] = False
        room_index = next(item for item in indexes["rooms"] if item["name"] == "env_code_unique")
        room_index["key"] = {"env": 1, "code": -1}
        ttl_index = next(item for item in indexes["spectator_sessions"] if item["name"] == "expires_ttl")
        ttl_index["expireAfterSeconds"] = 60
        _install_health_database(monkeypatch, HealthDatabase(indexes=indexes))
        result = await server.admin_system_health({"user_id": "admin-health"})

        assert result["status"] == "critical"
        incompatible = {issue for item in result["indexes"]["items"]
                        for issue in item["verification"]["issues"]}
        assert {"key_pattern_mismatch", "unique_mismatch", "partial_filter_mismatch", "ttl_mismatch"} <= incompatible
        assert result["spectator_ttl"]["status"] == "critical"

    run(run_case())


def test_admin_system_health_handles_unavailable_database_without_exposing_secrets(monkeypatch):
    async def run_case():
        secret_uri = "mongodb://audit-user:do-not-return@db.internal/health?token=private"
        database = HealthDatabase(ping_error=RuntimeError(secret_uri))
        _install_health_database(monkeypatch, database)
        monkeypatch.setenv("DB_NAME", secret_uri)
        result = await server.admin_system_health({"user_id": "admin-health"})

        rendered = repr(result)
        assert result["status"] == "critical"
        assert result["database"] == {"status": "critical", "name": None}
        assert result["indexes"]["status"] == "unknown"
        assert result["indexes"]["unknown_count"] == result["indexes"]["declared_count"]
        assert secret_uri not in rendered
        assert "do-not-return" not in rendered
        assert all(not collection.indexes for collection in database.collections.values())

    run(run_case())


def test_system_health_permission_is_admin_only_and_denial_is_audited(monkeypatch):
    async def run_case():
        server._admin_request_hits.clear()
        server._health_admin_role_cache.clear()
        fake_database([{"user_id": "support-health", "env": server.ENV, "role": "support"}])
        audit = AsyncMock()
        monkeypatch.setattr(server.games, "audit_admin", audit)
        guard = server.require_system_health_admin()
        with pytest.raises(HTTPException) as denied:
            await guard(request("/api/admin/system-health"), {"user_id": "support-health"})
        assert denied.value.status_code == 403
        audit.assert_awaited_once()
        assert server.has_admin_permission("admin", "admin:system-health:read")
        assert not server.has_admin_permission("moderator", "admin:system-health:read")
        assert not server.has_admin_permission("support", "admin:system-health:read")

    run(run_case())


def test_recently_verified_admin_can_read_health_when_mongodb_is_down(monkeypatch):
    class OfflineUsers:
        async def find_one(self, *_args, **_kwargs):
            raise PyMongoError("simulated unavailable database")

    async def run_case():
        database = HealthDatabase(ping_error=PyMongoError("simulated unavailable database"))
        database.users = OfflineUsers()
        _install_health_database(monkeypatch, database)
        monkeypatch.setattr(server, "_health_admin_role_cache", {
            "admin-offline": server.time.monotonic() + server.HEALTH_ADMIN_ROLE_CACHE_TTL,
        })
        guard = server.require_system_health_admin()
        admin = await guard(request("/api/admin/system-health"), {"user_id": "admin-offline"})
        result = await server.admin_system_health(admin)

        assert admin["role"] == "admin"
        assert result["database"]["status"] == "critical"
        assert result["indexes"]["status"] == "unknown"
        assert result["status"] == "critical"

    run(run_case())


def test_expired_cached_admin_role_cannot_authorize_diagnostics_when_database_is_down(monkeypatch):
    class OfflineUsers:
        async def find_one(self, *_args, **_kwargs):
            raise PyMongoError("simulated unavailable database")

    async def run_case():
        database = HealthDatabase(ping_error=PyMongoError("simulated unavailable database"))
        database.users = OfflineUsers()
        _install_health_database(monkeypatch, database)
        monkeypatch.setattr(server, "_health_admin_role_cache", {"admin-expired": 0})
        guard = server.require_system_health_admin()
        with pytest.raises(HTTPException) as denied:
            await guard(request("/api/admin/system-health"), {"user_id": "admin-expired"})
        assert denied.value.status_code == 503

    run(run_case())


def _player_nested_get(document, key):
    value = document
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _player_matches(document, query):
    for key, expected in query.items():
        if key == "$and":
            if not all(_player_matches(document, item) for item in expected):
                return False
            continue
        if key == "$or":
            if not any(_player_matches(document, item) for item in expected):
                return False
            continue
        value = _player_nested_get(document, key)
        if isinstance(expected, dict) and any(str(operator).startswith("$") for operator in expected):
            for operator, operand in expected.items():
                if operator == "$exists" and ((value is not None) != operand):
                    return False
                if operator == "$eq" and value != operand:
                    return False
                if operator == "$ne" and value == operand:
                    return False
                if operator == "$in" and value not in operand:
                    return False
                if operator == "$lte" and (value is None or value > operand):
                    return False
                if operator == "$gte" and (value is None or value < operand):
                    return False
                if operator == "$lt" and (value is None or value >= operand):
                    return False
                if operator == "$gt" and (value is None or value <= operand):
                    return False
                if operator == "$type" and (operand != "string" or not isinstance(value, str)):
                    return False
                if operator == "$regex" and (not isinstance(value, str) or re.search(
                        operand, value, re.IGNORECASE if expected.get("$options") == "i" else 0) is None):
                    return False
        elif isinstance(value, list):
            if expected not in value:
                return False
        elif value != expected:
            return False
    return True


class PlayerFixtureCursor:
    def __init__(self, documents):
        self.documents = copy.deepcopy(documents)
        self.offset = 0
        self.limit_value = None

    def sort(self, fields, direction=None):
        if isinstance(fields, str):
            fields = [(fields, direction or 1)]
        for field, order in reversed(list(fields)):
            self.documents.sort(key=lambda document: (_player_nested_get(document, field) is None,
                                                       _player_nested_get(document, field)), reverse=order < 0)
        return self

    def skip(self, amount):
        self.offset = amount
        return self

    def limit(self, amount):
        self.limit_value = amount
        return self

    async def to_list(self, length=None):
        result = self.documents[self.offset:]
        maximum = self.limit_value if self.limit_value is not None else length
        return copy.deepcopy(result[:maximum] if maximum is not None else result)


def _player_project(document, projection):
    if not projection or not any(value for key, value in projection.items() if key != "_id"):
        return copy.deepcopy(document)
    result = {}
    player_fields = [field.split(".", 1)[1] for field, include in projection.items()
                     if include and field.startswith("players.")]
    for field, include in projection.items():
        if not include or field == "_id":
            continue
        if field.startswith("players."):
            continue
        value = _player_nested_get(document, field)
        if value is None:
            continue
        if "." not in field:
            result[field] = copy.deepcopy(value)
            continue
        target = result
        parts = field.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = copy.deepcopy(value)
    if player_fields:
        result["players"] = [
            {field: copy.deepcopy(_player_nested_get(player, field)) for field in player_fields
             if _player_nested_get(player, field) is not None}
            for player in document.get("players", ())
        ]
    return result


class PlayerFixtureCollection:
    def __init__(self, documents=()):
        self.documents = copy.deepcopy(list(documents))
        self.queries = []

    async def find_one(self, query, projection=None):
        self.queries.append(copy.deepcopy(query))
        document = next((item for item in self.documents if _player_matches(item, query)), None)
        return _player_project(document, projection) if document is not None else None

    async def count_documents(self, query):
        return sum(_player_matches(item, query) for item in self.documents)

    def find(self, query, projection=None):
        self.queries.append(copy.deepcopy(query))
        return PlayerFixtureCursor([_player_project(item, projection) for item in self.documents
                                    if _player_matches(item, query)])

    async def update_one(self, query, update):
        for document in self.documents:
            if not _player_matches(document, query):
                continue
            for field, value in update.get("$set", {}).items():
                document[field] = copy.deepcopy(value)
            for field in update.get("$unset", {}):
                document.pop(field, None)
            for field, value in update.get("$push", {}).items():
                document.setdefault(field, []).append(copy.deepcopy(value))
            return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)

    async def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))
        return SimpleNamespace(inserted_id=len(self.documents))


class PlayerFixtureDatabase:
    def __init__(self, *, users=(), matches=(), notes=()):
        self.users = PlayerFixtureCollection(users)
        self.matches = PlayerFixtureCollection(matches)
        self.admin_player_notes = PlayerFixtureCollection(notes)
        self.admin_audit_logs = PlayerFixtureCollection()
        self.admin_role_locks = MemoryLockCollection()


def _install_player_database(monkeypatch, database):
    monkeypatch.setattr(server, "db", database)
    monkeypatch.setattr(server.games, "db", database)
    monkeypatch.setattr(server.games, "audit_admin", AsyncMock())
    server._admin_request_hits.clear()
    return database


def _player_document(user_id, *, env=None, username=None, created_at="2025-01-01T00:00:00Z", **fields):
    return {
        "user_id": user_id, "env": env or server.ENV, "username": username or user_id,
        "username_lower": (username or user_id).lower(), "display_name": username or user_id,
        "role": "member", "created_at": created_at, "last_seen": "2025-02-01T00:00:00Z",
        "avatar_color": "#38bdf8", "avatar_icon": "spade",
        "stats": {"games_played": 0, "wins": 0, "losses": 0, "draws": 0},
        **fields,
    }


def test_player_directory_is_environment_scoped_searchable_sorted_and_server_paginated(monkeypatch):
    async def run_case():
        other_env = "live" if server.ENV != "live" else "preview"
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[
            _player_document("user_alice2", username="AliceTwo", created_at="2025-03-01T00:00:00Z"),
            _player_document("user_alice1", username="AliceOne", created_at="2025-02-01T00:00:00Z",
                             stats={"games_played": 3, "wins": 2, "losses": 1, "draws": 0},
                             progression={"xp": 350, "current_win_streak": 2}),
            _player_document("user_alice1", env=other_env, username="AliceLive"),
            _player_document("user_bob", username="Bob"),
        ]))
        result = await server.admin_player_directory(
            q="alice", status=None, registered_after=None, registered_before=None,
            sort="username_asc", offset=0, limit=1, admin={"user_id": "staff", "role": "admin"},
        )
        assert result["total"] == 2
        assert len(result["items"]) == 1
        assert result["items"][0]["user_id"] == "user_alice1"
        assert result["items"][0]["level"] == 1
        assert result["items"][0]["xp"] == 350
        assert result["items"][0]["games_played"] == 3
        assert result["offset"] == 0 and result["limit"] == 1
        assert database.users.queries[-1]["$and"][0] == {"env": server.ENV}
        assert not {"email", "role", "password", "token", "account_restriction"} & set(result["items"][0])

    run(run_case())


def test_player_directory_status_and_registration_filters_exclude_expired_and_other_environment(monkeypatch):
    async def run_case():
        other_env = "live" if server.ENV != "live" else "preview"
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[
            _player_document("active", username="active", created_at="2025-01-05T00:00:00Z"),
            _player_document("suspended", username="suspended", account_status="suspended",
                             account_restriction={"type": "suspended", "expires_at": "2099-01-01T00:00:00Z"}),
            _player_document("expired", username="expired", account_status="suspended",
                             account_restriction={"type": "suspended", "expires_at": "2000-01-01T00:00:00Z"}),
            _player_document("foreign-ban", env=other_env, account_status="banned"),
        ]))
        suspended = await server.admin_player_directory(
            q=None, status="suspended", registered_after=None, registered_before=None,
            sort="registered_desc", offset=0, limit=25, admin={"user_id": "staff", "role": "moderator"},
        )
        active = await server.admin_player_directory(
            q="expired", status="active", registered_after=datetime(2024, 1, 1, tzinfo=timezone.utc),
            registered_before=None, sort="registered_asc", offset=0, limit=25,
            admin={"user_id": "staff", "role": "moderator"},
        )
        assert [item["user_id"] for item in suspended["items"]] == ["suspended"]
        assert [item["user_id"] for item in active["items"]] == ["expired"]
        assert active["items"][0]["account_status"] == "active"

    run(run_case())


def test_player_directory_search_supports_legacy_username_and_user_id_prefixes(monkeypatch):
    async def run_case():
        legacy = _player_document("clerk_legacy1", username="OldUsername")
        legacy.pop("username_lower")
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[legacy]))
        by_name = await server.admin_player_directory(
            q="olduser", status=None, registered_after=None, registered_before=None,
            sort="registered_desc", offset=0, limit=25, admin={"user_id": "staff", "role": "admin"},
        )
        by_id = await server.admin_player_directory(
            q="clerk_", status=None, registered_after=None, registered_before=None,
            sort="registered_desc", offset=0, limit=25, admin={"user_id": "staff", "role": "admin"},
        )
        assert [item["user_id"] for item in by_name["items"]] == ["clerk_legacy1"]
        assert [item["user_id"] for item in by_id["items"]] == ["clerk_legacy1"]
        assert database.users.queries

    run(run_case())


def test_admin_player_detail_uses_authoritative_stats_and_environment_scoped_match_history(monkeypatch):
    async def run_case():
        other_env = "live" if server.ENV != "live" else "preview"
        target = _player_document("player-1", username="Asha", stats={"games_played": 2, "wins": 1, "losses": 1, "draws": 0},
                                  progression={"xp": 250, "match_duration_seconds_total": 1200, "match_duration_count": 2,
                                               "team_tricks_won": 19},
                                  achievement_unlocks={"first_victory": "2025-02-01T00:00:00Z"},
                                  moderation_history=[
                                      {"id": "mod-current", "env": server.ENV, "action": "suspended", "actor_id": "staff-1",
                                       "reason": "Abuse", "timestamp": "2025-03-01T00:00:00Z", "previous_status": "active",
                                       "new_status": "suspended", "expires_at": "2025-03-02T00:00:00Z"},
                                      {"id": "mod-other", "env": other_env, "action": "banned", "actor_id": "foreign",
                                       "reason": "Foreign", "timestamp": "2025-03-01T00:00:00Z", "new_status": "banned"},
                                  ])
        matches = [{"env": server.ENV, "id": "match-1", "player_ids": ["player-1"], "finished_at": "2025-03-01T00:00:00Z",
                    "scores": [7, 4], "winner_team": 0, "target": 5,
                    "players": [{"user_id": "player-1", "team": 0, "username": "Asha", "display_name": "Asha"}],
                    "state": {"hands": ["hidden"]}, "rounds": [{"cards": ["secret"]}]},
                   {"env": other_env, "id": "match-foreign", "player_ids": ["player-1"], "finished_at": "2025-03-02T00:00:00Z"}]
        notes = [{"env": server.ENV, "id": "note-1", "target_user_id": "player-1", "author_id": "staff-1",
                  "content": "Follow up", "created_at": "2025-03-01T00:00:00Z"},
                 {"env": other_env, "id": "note-foreign", "target_user_id": "player-1", "author_id": "foreign",
                  "content": "Do not expose", "created_at": "2025-03-01T00:00:00Z"}]
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(
            users=[target, _player_document("staff-1", username="Mod")], matches=matches, notes=notes,
        ))
        result = await server.admin_player_detail("player-1", {"user_id": "staff-1", "role": "admin"})

        assert result["statistics"]["games_played"] == 2
        assert result["statistics"]["win_percent"] == 50
        assert result["statistics"]["average_match_duration_seconds"] == 600
        assert result["progression"]["xp"] == 250
        assert len(result["match_history"]) == 1
        assert result["match_history"][0]["outcome"] == "win"
        assert "state" not in result["match_history"][0] and "rounds" not in result["match_history"][0]
        assert [event["id"] for event in result["moderation_history"]] == ["mod-current"]
        assert [note["id"] for note in result["internal_notes"]] == ["note-1"]
        assert result["internal_notes"][0]["author_name"] == "Mod"
        assert "moderation_history" not in server.public_user(target)
        assert "internal_notes" not in server.public_user(target)
        assert all(query.get("env") == server.ENV for query in database.matches.queries)

    run(run_case())


def test_missing_legacy_statistics_are_reported_as_unavailable_not_zero(monkeypatch):
    async def run_case():
        legacy_user = _player_document("legacy-player")
        legacy_user.pop("stats")
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[legacy_user]))
        result = await server.admin_player_detail("legacy-player", {"user_id": "admin-1", "role": "admin"})

        assert result["statistics"]["games_played"] is None
        assert result["statistics"]["wins"] is None
        assert result["statistics"]["win_percent"] is None
        assert result["progression"]["level"] is None
        row = await server.admin_player_directory(
            q=None, status=None, registered_after=None, registered_before=None,
            sort="registered_desc", offset=0, limit=25, admin={"user_id": "admin-1", "role": "admin"},
        )
        assert row["items"][0]["games_played"] is None
        assert row["items"][0]["xp"] is None
        assert database.users.queries

    run(run_case())


def test_support_player_detail_does_not_disclose_internal_notes(monkeypatch):
    async def run_case():
        target = _player_document("player-1", moderation_history=[
            {"id": "private-event", "env": server.ENV, "action": "banned", "actor_id": "admin",
             "reason": "Internal moderation reason", "timestamp": "2025-01-01T00:00:00Z", "new_status": "banned"},
        ])
        note = {"env": server.ENV, "id": "private-note", "target_user_id": "player-1", "author_id": "staff",
                "content": "Internal only", "created_at": "2025-01-01T00:00:00Z"}
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[target], notes=[note]))
        result = await server.admin_player_detail("player-1", {"user_id": "support", "role": "support"})
        assert result["internal_notes"] == []
        assert result["moderation_history"] == []
        assert not any(item["kind"] == "moderation" for item in result["recent_activity"])
        assert database.admin_player_notes.queries == []

    run(run_case())


def test_internal_player_notes_are_environment_scoped_and_audited(monkeypatch):
    async def run_case():
        other_env = "live" if server.ENV != "live" else "preview"
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[
            _player_document("player-1"), _player_document("player-1", env=other_env),
        ]))
        note = await server.admin_add_player_note(
            "player-1", server.PlayerNoteIn(content="  Check follow-up status. "),
            request("/api/admin/players/player-1/notes", method="POST"),
            {"user_id": "moderator-1", "username": "mod", "role": "moderator"},
        )
        assert note["content"] == "Check follow-up status."
        assert note["env"] == server.ENV
        assert len(database.admin_player_notes.documents) == 1
        assert database.admin_player_notes.documents[0]["target_user_id"] == "player-1"
        server.games.audit_admin.assert_awaited_once_with(
            "moderator-1", "player_note_added", target_type="player", target_id="player-1",
            reason="Internal administrator note added",
        )

    run(run_case())


def test_player_suspension_expires_automatically_and_preserves_match_history(monkeypatch):
    async def run_case():
        user = _player_document("player-1", stats={"games_played": 1, "wins": 1, "losses": 0, "draws": 0})
        match = {"env": server.ENV, "id": "kept-match", "player_ids": ["player-1"], "scores": [7, 3]}
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[user], matches=[match]))
        admin = {"user_id": "moderator-1", "username": "mod", "role": "moderator"}
        request_obj = request("/api/admin/players/player-1/suspend", method="POST")
        server._admin_request_hits.clear()
        result = await server.admin_suspend_player(
            "player-1", server.SuspendPlayerIn(duration_hours=1, reason="Repeated abusive chat"), request_obj, admin,
        )
        updated = database.users.documents[0]
        assert result["account_status"] == "suspended"
        assert updated["account_status"] == "suspended"
        assert updated["account_restriction"]["actor_id"] == "moderator-1"
        assert len(updated["moderation_history"]) == 1
        assert updated["moderation_history"][0]["expires_at"] == result["expires_at"]
        assert database.matches.documents == [match]
        server.games.audit_admin.assert_awaited_once()

        with pytest.raises(HTTPException) as blocked:
            await server.current_member(request("/api/me"), {"user_id": "player-1"})
        assert blocked.value.status_code == 403
        assert "Repeated abusive chat" in blocked.value.detail

        updated["account_restriction"]["expires_at"] = "2000-01-01T00:00:00Z"
        restored = await server.current_member(request("/api/me"), {"user_id": "player-1"})
        assert restored["role"] == "member"
        assert updated["account_status"] == "active"
        assert "account_restriction" not in updated
        assert updated["moderation_history"][-1]["action"] == "suspension_expired"
        assert database.matches.documents == [match]
        assert any(call.args[1] == "player_suspension_expired" for call in server.games.audit_admin.await_args_list)

    run(run_case())


def test_permanent_ban_unban_and_self_target_denials_are_audited(monkeypatch):
    async def run_case():
        match = {"env": server.ENV, "id": "kept", "player_ids": ["player-1"]}
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(
            users=[_player_document("player-1"), _player_document("admin-1", username="Admin")], matches=[match],
        ))
        admin = {"user_id": "admin-1", "username": "Admin", "role": "admin"}
        server._admin_request_hits.clear()
        with pytest.raises(HTTPException) as self_ban:
            await server.admin_ban_player("admin-1", server.PlayerReasonIn(reason="Self target"),
                                          request("/api/admin/players/admin-1/ban", method="POST"), admin)
        assert self_ban.value.status_code == 403
        assert server.games.audit_admin.await_args.args[1] == "player_moderation_denied"
        assert database.users.documents[1].get("account_status", "active") == "active"
        assert database.users.documents[1].get("moderation_history", []) == []
        with pytest.raises(HTTPException) as self_suspend:
            await server.admin_suspend_player(
                "admin-1", server.SuspendPlayerIn(duration_hours=1, reason="Self target"),
                request("/api/admin/players/admin-1/suspend", method="POST"), admin,
            )
        assert self_suspend.value.status_code == 403
        assert database.users.documents[1].get("account_status", "active") == "active"
        assert database.users.documents[1].get("moderation_history", []) == []

        await server.admin_ban_player("player-1", server.PlayerReasonIn(reason="Severe abuse"),
                                      request("/api/admin/players/player-1/ban", method="POST"), admin)
        banned_user = database.users.documents[0]
        assert banned_user["account_status"] == "banned"
        assert banned_user["moderation_history"][-1]["actor_id"] == "admin-1"
        with pytest.raises(HTTPException) as blocked:
            await server.current_member(request("/api/me"), {"user_id": "player-1"})
        assert blocked.value.status_code == 403

        await server.admin_unban_player("player-1", server.PlayerReasonIn(reason="Appeal reviewed"),
                                        request("/api/admin/players/player-1/unban", method="POST"), admin)
        assert banned_user["account_status"] == "active"
        assert "account_restriction" not in banned_user
        assert [event["action"] for event in banned_user["moderation_history"]] == ["banned", "unbanned"]
        assert database.matches.documents == [match]
        assert [call.args[1] for call in server.games.audit_admin.await_args_list].count("player_banned") == 1
        assert [call.args[1] for call in server.games.audit_admin.await_args_list].count("player_unbanned") == 1

    run(run_case())


def test_persisted_ban_status_cannot_be_cleared_by_a_stale_expired_suspension(monkeypatch):
    async def run_case():
        user = _player_document("player-1", account_status="banned", account_restriction={
            "type": "suspended", "reason": "Old suspension", "expires_at": "2000-01-01T00:00:00Z",
        })
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[user]))
        with pytest.raises(HTTPException) as blocked:
            await server.current_member(request("/api/me"), {"user_id": "player-1"})
        assert blocked.value.status_code == 403
        assert database.users.documents[0]["account_status"] == "banned"
        assert database.users.documents[0]["account_restriction"]["expires_at"] == "2000-01-01T00:00:00Z"

    run(run_case())


def test_player_moderation_and_notes_never_cross_environment(monkeypatch):
    async def run_case():
        other_env = "live" if server.ENV != "live" else "preview"
        foreign = _player_document("foreign-player", env=other_env, username="Foreign")
        database = _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[foreign]))
        admin = {"user_id": "admin-1", "username": "Admin", "role": "admin"}
        with pytest.raises(HTTPException) as missing:
            await server.admin_ban_player("foreign-player", server.PlayerReasonIn(reason="Cross env"),
                                          request("/api/admin/players/foreign-player/ban", method="POST"), admin)
        assert missing.value.status_code == 404
        with pytest.raises(HTTPException) as missing_note:
            await server.admin_add_player_note(
                "foreign-player", server.PlayerNoteIn(content="Cross env"),
                request("/api/admin/players/foreign-player/notes", method="POST"), admin,
            )
        assert missing_note.value.status_code == 404
        assert database.users.documents == [foreign]
        assert database.admin_player_notes.documents == []
        assert server.games.audit_admin.await_count == 2

    run(run_case())


def test_player_permission_denials_audit_actor_and_target(monkeypatch):
    async def run_case():
        _install_player_database(monkeypatch, PlayerFixtureDatabase(users=[
            _player_document("support-1", username="Support", role="support"),
        ]))
        guard = server.require_player_permission("player:ban")
        request_obj = request("/api/admin/players/target-1/ban", method="POST")
        request_obj.scope["path_params"] = {"player_id": "target-1"}
        with pytest.raises(HTTPException) as denied:
            await guard(request_obj, {"user_id": "support-1", "role": "support"})
        assert denied.value.status_code == 403
        server.games.audit_admin.assert_awaited_once()
        args = server.games.audit_admin.await_args
        assert args.args[:2] == ("support-1", "player_moderation_denied")
        assert args.kwargs["target_id"] == "target-1"
        assert args.kwargs["success"] is False

    run(run_case())


def test_rejected_moderation_request_is_audited_without_logging_request_data(monkeypatch):
    async def run_case():
        _install_player_database(monkeypatch, PlayerFixtureDatabase())
        request_obj = request("/api/admin/players/player-1/ban", method="POST", query=b"debug=must-not-be-logged")
        request_obj.state.authenticated_user_id = "admin-1"

        async def invalid_request(_request):
            return SimpleNamespace(status_code=422)

        result = await server.audit_denied_admin_access(request_obj, invalid_request)
        assert result.status_code == 422
        server.games.audit_admin.assert_awaited_once()
        call = server.games.audit_admin.await_args
        assert call.args[:2] == ("admin-1", "player_moderation_denied")
        assert call.kwargs["target_id"] == "player-1"
        assert call.kwargs["reason"] == "Player-management request rejected (HTTP 422)"
        assert "debug" not in str(call.kwargs)

    run(run_case())
