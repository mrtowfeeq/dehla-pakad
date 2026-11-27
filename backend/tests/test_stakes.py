"""Stake tables: entries taken all-or-nothing at start, winners paid once, refunds on exit and crash
recovery, private-room stake settings and per-tier matchmaking queues."""
import asyncio
import copy
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import dotenv
import pytest
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_environment_keys = ("MONGO_URL", "DB_NAME", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY")
_original_environment = {key: os.environ.get(key) for key in _environment_keys}
_original_load_dotenv = dotenv.load_dotenv
dotenv.load_dotenv = lambda *args, **kwargs: False
os.environ.update({
    "MONGO_URL": "mongodb://127.0.0.1:27017",
    "DB_NAME": "dehla_pakad_stake_tests",
    "CLERK_PUBLISHABLE_KEY": "pk_test_stakes",
    "CLERK_SECRET_KEY": "sk_test_stakes",
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

from engine import Match  # noqa: E402
from game_service import GameService  # noqa: E402
from wallet import Wallet  # noqa: E402


# ---------------- a small fake MongoDB ----------------
def _get(doc, path):
    value = doc
    for part in path.split("."):
        if isinstance(value, list) and part.isdigit():
            value = value[int(part)] if int(part) < len(value) else None
        elif isinstance(value, dict):
            value = value.get(part)
        else:
            return None
    return value


def _matches(doc, query):
    for field, expected in query.items():
        if field == "$or":
            if not any(_matches(doc, option) for option in expected):
                return False
            continue
        actual = _get(doc, field)
        if isinstance(expected, dict) and expected and all(k.startswith("$") for k in expected):
            for op, operand in expected.items():
                if op == "$ne" and ((operand in actual) if isinstance(actual, list) else actual == operand):
                    return False
                if op == "$exists" and ((actual is not None) != operand):
                    return False
                if op == "$gte" and (actual is None or actual < operand):
                    return False
                if op == "$lt" and (actual is None or actual >= operand):
                    return False
                if op == "$lte" and (actual is None or actual > operand):
                    return False
                if op == "$in" and actual not in operand:
                    return False
        elif isinstance(actual, list) and not isinstance(expected, list):
            if expected not in actual:
                return False
        elif actual != expected:
            return False
    return True


def _set(doc, path, value):
    parts = path.split(".")
    target = doc
    for part in parts[:-1]:
        target = target[int(part)] if isinstance(target, list) else target.setdefault(part, {})
    if isinstance(target, list):
        target[int(parts[-1])] = copy.deepcopy(value)
    else:
        target[parts[-1]] = copy.deepcopy(value)


def _apply(doc, update):
    for path, value in update.get("$set", {}).items():
        _set(doc, path, value)
    for path in update.get("$unset", {}):
        parts = path.split(".")
        parent = _get(doc, ".".join(parts[:-1])) if len(parts) > 1 else doc
        if isinstance(parent, dict):
            parent.pop(parts[-1], None)
    for path, amount in update.get("$inc", {}).items():
        _set(doc, path, (_get(doc, path) or 0) + amount)
    for path, spec in update.get("$push", {}).items():
        items = list(_get(doc, path) or []) + list(spec["$each"])
        _set(doc, path, items[spec["$slice"]:] if "$slice" in spec else items)


class Result:
    def __init__(self, matched=0, deleted=0):
        self.matched_count = self.modified_count = matched
        self.deleted_count = deleted


class Cursor:
    def __init__(self, docs):
        self.docs = docs

    def __aiter__(self):
        self._it = iter(self.docs)
        return self

    async def __anext__(self):
        try:
            return copy.deepcopy(next(self._it))
        except StopIteration:
            raise StopAsyncIteration

    def sort(self, field, direction=1):
        self.docs.sort(key=lambda d: d.get(field) or "", reverse=direction == -1)
        return self

    def limit(self, n):
        self.docs = self.docs[:n]
        return self

    async def to_list(self, n):
        return copy.deepcopy(self.docs[:n])


class Collection:
    def __init__(self, docs=None, unique=None):
        self.docs = [copy.deepcopy(d) for d in (docs or [])]
        self.unique = unique

    def _first(self, query):
        return next((d for d in self.docs if _matches(d, query)), None)

    async def find_one(self, query, projection=None):
        return copy.deepcopy(self._first(query))

    def find(self, query, projection=None):
        return Cursor([d for d in self.docs if _matches(d, query)])

    async def insert_one(self, doc):
        if self.unique and any(all(d.get(k) == doc.get(k) for k in self.unique) for d in self.docs):
            raise DuplicateKeyError("duplicate")
        self.docs.append(copy.deepcopy(doc))

    async def update_one(self, query, update, upsert=False):
        doc = self._first(query)
        if doc is None:
            return Result()
        _apply(doc, update)
        return Result(matched=1)

    async def find_one_and_update(self, query, update, projection=None, return_document=None, upsert=False):
        doc = self._first(query)
        if doc is None:
            return None
        before = copy.deepcopy(doc)
        _apply(doc, update)
        return before if return_document == server.ReturnDocument.BEFORE else copy.deepcopy(doc)

    async def delete_one(self, query):
        doc = self._first(query)
        if doc is None:
            return Result()
        self.docs.remove(doc)
        return Result(deleted=1)


class DB:
    def __init__(self, coins, rooms=(), games=()):
        self.users = Collection([{"user_id": u, "env": server.ENV, "username": u.upper(), "coins": c} for u, c in coins.items()])
        self.coin_ledger = Collection(unique=("env", "user_id", "key"))
        self.rooms = Collection(rooms)
        self.games = Collection(games)
        self.game_events = Collection()
        self.invitations = Collection()


def run(coro):
    return asyncio.run(coro)


SEATS = ["u0", "u1", "u2", "u3"]


def room(stake="chai", public=False, **extra):
    return {"env": server.ENV, "code": "ABC123", "host_id": None if public else "u0", "is_public": public,
            "status": "lobby", "target": 7, "dealer_seat": 0, "seats": list(SEATS), "bots": {},
            "ready": {u: True for u in SEATS}, **({"stake_tier": stake} if stake else {}), **extra}


@pytest.fixture
def env(monkeypatch):
    def install(coins, rooms=(), games=()):
        db = DB(coins, rooms, games)
        monkeypatch.setattr(server, "db", db)
        wallet = Wallet(db, AsyncMock(), env=server.ENV)
        monkeypatch.setattr(server, "wallet", wallet)
        create = AsyncMock(return_value={"id": "game-1"})
        monkeypatch.setattr(server.games, "create", create)
        monkeypatch.setattr(server.games, "broadcast", AsyncMock())
        monkeypatch.setattr(server.games, "kick_bots", Mock())
        monkeypatch.setattr(server.games, "active_game_for", Mock(return_value=None))
        monkeypatch.setattr(server.hub, "send_many", AsyncMock())
        monkeypatch.setattr(server.hub, "send", AsyncMock())
        monkeypatch.setattr(server, "broadcast_room", AsyncMock(side_effect=lambda r: {"code": r["code"], "stake": r.get("stake_tier")}))
        monkeypatch.setattr(server, "_ready_deadline", AsyncMock())
        server.mm_queue.clear()
        for queue in server.mm_stake_queues.values():
            queue.clear()
        return db, create
    yield install
    server.mm_queue.clear()
    for queue in server.mm_stake_queues.values():
        queue.clear()


def coins(db):
    return {d["user_id"]: d["coins"] for d in db.users.docs}


def member(uid, xp=0):
    return {"user_id": uid, "username": uid.upper(), "stats": {}, "progression": {"xp": xp}}


# ---------------- starting a stake table ----------------
def test_start_takes_every_entry_once_and_creates_the_game_with_the_stake(env):
    db, create = env({u: 1000 for u in SEATS}, rooms=[room()])
    run(server._start(room()))
    stake = create.await_args.kwargs["stake"]
    assert {k: stake[k] for k in ("tier", "entry", "payout")} == {"tier": "chai", "entry": 100, "payout": 180}
    assert stake["ref"].startswith("ABC123-")
    assert coins(db) == {u: 900 for u in SEATS}
    saved = db.rooms.docs[0]
    assert saved["status"] == "playing" and "stake_hold" not in saved


def test_a_player_short_of_coins_blocks_a_private_start_and_nobody_is_charged(env):
    db, create = env({"u0": 1000, "u1": 1000, "u2": 50, "u3": 1000}, rooms=[room()])
    with pytest.raises(HTTPException) as error:
        run(server._start(room()))
    assert error.value.status_code == 409 and "U2" in error.value.detail
    create.assert_not_awaited()
    assert coins(db) == {"u0": 1000, "u1": 1000, "u2": 50, "u3": 1000}
    assert db.rooms.docs[0]["status"] == "lobby" and "stake_hold" not in db.rooms.docs[0]


def test_a_public_stake_lobby_drops_the_short_player_and_requeues_the_others(env, monkeypatch):
    db, _ = env({"u0": 1000, "u1": 1000, "u2": 50, "u3": 1000}, rooms=[room(public=True)])
    dissolve = AsyncMock()
    monkeypatch.setattr(server, "_dissolve_public", dissolve)
    with pytest.raises(HTTPException):
        run(server._start(room(public=True)))
    assert dissolve.await_args.args[1] == {"u2"}


def test_a_failed_game_creation_gives_every_entry_back(env):
    db, create = env({u: 1000 for u in SEATS}, rooms=[room()])
    create.side_effect = RuntimeError("boom")
    with pytest.raises(RuntimeError):
        run(server._start(room()))
    assert coins(db) == {u: 1000 for u in SEATS}
    assert db.rooms.docs[0]["status"] == "lobby"


def test_startup_recovery_refunds_only_entries_taken_for_a_table_that_never_started(env):
    db, _ = env({u: 1000 for u in SEATS},
                rooms=[{**room(), "status": "starting", "stake_hold": {"tier": "city", "ref": "R1"}}])
    run(server.wallet.apply("u0", -500, "stake_entry", "R1", require_funds=True))
    run(server.wallet.apply("u1", -500, "stake_entry", "R1", require_funds=True))
    run(server.recover_stake_holds())
    assert coins(db) == {u: 1000 for u in SEATS}
    assert "stake_hold" not in db.rooms.docs[0]


def test_startup_recovery_leaves_entries_alone_when_the_game_was_created(env):
    db, _ = env({u: 900 for u in SEATS},
                rooms=[{**room(), "status": "starting", "stake_hold": {"tier": "chai", "ref": "R2"}}],
                games=[{"env": server.ENV, "id": "g", "stake": {"ref": "R2"}}])
    for u in SEATS:
        db.users.docs[SEATS.index(u)]["wallet_keys"] = ["stake_entry:R2"]
    run(server.recover_stake_holds())
    assert coins(db) == {u: 900 for u in SEATS}


# ---------------- private room settings ----------------
def test_host_sets_and_removes_a_stake_and_every_ready_is_cleared(env, monkeypatch):
    db, _ = env({u: 1000 for u in SEATS}, rooms=[room(stake=None)])
    monkeypatch.setattr(server, "get_member_room", AsyncMock(side_effect=lambda *a: copy.deepcopy(db.rooms.docs[0])))
    run(server.room_settings("ABC123", server.RoomSettingsIn(stake_tier="chai"), member("u0")))
    assert db.rooms.docs[0]["stake_tier"] == "chai" and db.rooms.docs[0]["ready"] == {}
    run(server.room_settings("ABC123", server.RoomSettingsIn(stake_tier="free"), member("u0")))
    assert "stake_tier" not in db.rooms.docs[0]


def test_stakes_and_bots_never_mix_and_tables_are_level_locked(env, monkeypatch):
    db, _ = env({u: 1000 for u in SEATS}, rooms=[room(stake=None, bots={"bot_1": {"username": "Bot"}})])
    monkeypatch.setattr(server, "get_member_room", AsyncMock(side_effect=lambda *a: copy.deepcopy(db.rooms.docs[0])))
    with pytest.raises(HTTPException) as error:
        run(server.room_settings("ABC123", server.RoomSettingsIn(stake_tier="chai"), member("u0")))
    assert error.value.status_code == 409
    db.rooms.docs[0]["bots"] = {}
    with pytest.raises(HTTPException) as error:
        run(server.room_settings("ABC123", server.RoomSettingsIn(stake_tier="city"), member("u0")))  # level 3 table
    assert error.value.status_code == 403
    run(server.room_settings("ABC123", server.RoomSettingsIn(stake_tier="city"), member("u0", xp=1000)))
    db.rooms.docs[0]["seats"] = ["u0", None, None, None]
    with pytest.raises(HTTPException) as error:
        run(server.add_bot("ABC123", member("u0")))
    assert error.value.status_code == 409


def test_ready_needs_the_entry_in_the_wallet(env, monkeypatch):
    db, _ = env({"u0": 1000, "u1": 40}, rooms=[room(ready={})])
    monkeypatch.setattr(server, "get_member_room", AsyncMock(side_effect=lambda *a: copy.deepcopy(db.rooms.docs[0])))
    with pytest.raises(HTTPException) as error:
        run(server.set_ready("ABC123", server.ReadyIn(ready=True), member("u1")))
    assert error.value.status_code == 409 and "100 coins" in error.value.detail
    run(server.set_ready("ABC123", server.ReadyIn(ready=True), member("u0")))
    assert db.rooms.docs[0]["ready"]["u0"] is True
    run(server.set_ready("ABC123", server.ReadyIn(ready=False), member("u1")))  # un-readying is always allowed


# ---------------- matchmaking ----------------
def test_stake_queues_are_separate_and_four_players_make_a_stake_lobby(env):
    db, _ = env({u: 1000 for u in SEATS} | {"poor": 10})
    with pytest.raises(HTTPException):
        run(server.mm_join(server.MatchmakingJoinIn(tier="chai"), member("poor")))
    status = run(server.mm_join(server.MatchmakingJoinIn(tier="chai"), member("u0")))
    assert (status["tier"], status["position"], status["stake"]["entry"]) == ("chai", 1, 100)
    run(server.mm_join(None, member("u1")))  # free table
    assert server.mm_queue == ["u1"] and server.mm_stake_queues["chai"] == ["u0"]
    run(server.mm_join(server.MatchmakingJoinIn(tier="chai"), member("u1")))  # switching moves the player
    assert server.mm_queue == [] and server.mm_stake_queues["chai"] == ["u0", "u1"]
    run(server.mm_join(server.MatchmakingJoinIn(tier="chai"), member("u2")))
    result = run(server.mm_join(server.MatchmakingJoinIn(tier="chai"), member("u3")))
    assert result["queued"] is False
    lobby = db.rooms.docs[0]
    assert lobby["is_public"] is True and lobby["stake_tier"] == "chai" and sorted(lobby["seats"]) == SEATS
    assert server.mm_stake_queues["chai"] == []
    run(server.mm_leave(member("u0")))


# ---------------- game end ----------------
class RecordingWallet:
    def __init__(self):
        self.calls = []

    async def pay_winners(self, uids, tier, ref):
        self.calls.append(("pay", sorted(uids), tier, ref))

    async def refund(self, uids, tier, ref):
        self.calls.append(("refund", sorted(uids), tier, ref))


def stake_game(players=SEATS):
    return {"id": "g1", "env": server.ENV, "room_code": "ABC123", "status": "active",
            "players": [{"user_id": u, "seat": i, "team": i % 2, "username": u} for i, u in enumerate(players)],
            "state": Match.new(dealer=0, target=5).s, "stake": {"tier": "chai", "ref": "S1"}}


def test_the_winning_partners_are_paid_and_a_game_without_stake_pays_nobody():
    service = GameService(None, server.Hub())
    service.wallet = RecordingWallet()
    run(service._settle_stake(stake_game(), 1))
    run(service._settle_stake({**stake_game(), "stake": None}, 1))
    assert service.wallet.calls == [("pay", ["u1", "u3"], "chai", "S1")]


def test_exit_match_refunds_everyone_except_the_player_who_left():
    db = DB({}, rooms=[room()], games=[stake_game()])
    service = GameService(db, server.Hub(), schedule_turn_timers=False, env=server.ENV)
    service.hub.send_many = AsyncMock()
    service.wallet = RecordingWallet()
    service.games["g1"] = stake_game()
    run(service.cancel("g1", "u2"))
    assert service.wallet.calls == [("refund", ["u0", "u1", "u3"], "chai", "S1")]
