import asyncio
import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wallet import (DAILY_REWARDS, STARTING_COINS, STAKE_TIERS, TOPUP_AMOUNT, InsufficientCoins, Wallet,  # noqa: E402
                    WalletError, tier_view, winner_payout)


def _get(doc, path):
    value = doc
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _matches(doc, query):
    for field, expected in query.items():
        if field == "$or":
            if not any(_matches(doc, option) for option in expected):
                return False
            continue
        actual = _get(doc, field)
        if isinstance(expected, dict) and any(k.startswith("$") for k in expected):
            for op, operand in expected.items():
                if op == "$ne":
                    if (operand in actual) if isinstance(actual, list) else actual == operand:
                        return False
                elif op == "$exists":
                    if (actual is not None) != operand:
                        return False
                elif op == "$gte" and (actual is None or actual < operand):
                    return False
                elif op == "$lt" and (actual is None or actual >= operand):
                    return False
                elif op == "$lte" and (actual is None or actual > operand):
                    return False
        elif actual != expected:
            return False
    return True


def _apply(doc, update):
    for path, value in update.get("$set", {}).items():
        doc[path] = copy.deepcopy(value)
    for path, amount in update.get("$inc", {}).items():
        doc[path] = doc.get(path, 0) + amount
    for path, spec in update.get("$push", {}).items():
        items = list(doc.get(path) or []) + list(spec["$each"])
        doc[path] = items[spec["$slice"]:] if "$slice" in spec else items


class Result:
    def __init__(self, modified):
        self.modified_count = modified
        self.matched_count = modified


class Users:
    def __init__(self, docs):
        self.docs = docs

    async def find_one(self, query, projection=None):
        return next((copy.deepcopy(d) for d in self.docs if _matches(d, query)), None)

    async def update_one(self, query, update):
        doc = next((d for d in self.docs if _matches(d, query)), None)
        if doc is None:
            return Result(0)
        _apply(doc, update)
        return Result(1)

    async def find_one_and_update(self, query, update, projection=None, return_document=None):
        doc = next((d for d in self.docs if _matches(d, query)), None)
        if doc is None:
            return None
        _apply(doc, update)
        return copy.deepcopy(doc)


class Cursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, field, direction):
        self.docs.sort(key=lambda d: d[field], reverse=direction == -1)
        return self

    def limit(self, n):
        self.docs = self.docs[:n]
        return self

    async def to_list(self, n):
        return self.docs[:n]


class Ledger:
    def __init__(self):
        self.docs = []

    async def insert_one(self, doc):
        if any(d["env"] == doc["env"] and d["user_id"] == doc["user_id"] and d["key"] == doc["key"] for d in self.docs):
            raise DuplicateKeyError("duplicate")
        self.docs.append(copy.deepcopy(doc))

    def find(self, query, projection=None):
        return Cursor([{k: v for k, v in d.items() if k != "env"} for d in self.docs if _matches(d, query)])


class Hub:
    def __init__(self):
        self.sent = []

    async def send(self, uid, msg):
        self.sent.append((uid, msg))


class DB:
    def __init__(self, uids, coins=None):
        self.users = Users([{"user_id": u, "env": "preview", **({"coins": coins[u]} if coins and u in coins else {})} for u in uids])
        self.coin_ledger = Ledger()


class Clock:
    def __init__(self, moment):
        self.now = moment

    def __call__(self):
        return self.now


def make(uids=("a", "b", "c", "d"), coins=None, moment=datetime(2026, 11, 27, 6, 0, tzinfo=timezone.utc)):
    db, hub, clock = DB(uids, coins), Hub(), Clock(moment)
    return Wallet(db, hub, env="preview", clock=clock), db, hub, clock


def run(coro):
    return asyncio.run(coro)


def coins_of(db, uid):
    return next(d for d in db.users.docs if d["user_id"] == uid).get("coins")


def test_tier_payouts_split_the_pot_after_a_ten_percent_fee():
    assert [winner_payout(t["entry"]) for t in STAKE_TIERS.values()] == [180, 900, 4500, 18000]
    chai = tier_view("chai")
    assert (chai["pot"], chai["payout"], chai["fee"]) == (400, 180, 40)
    assert tier_view("nope") is None


def test_starting_coins_are_given_once_and_recorded():
    wallet, db, _, _ = make()
    assert run(wallet.ensure("a")) == STARTING_COINS
    assert run(wallet.ensure("a")) == STARTING_COINS
    assert [e["reason"] for e in db.coin_ledger.docs] == ["starting_coins"]


def test_a_change_applies_once_per_reason_and_ref_and_never_overdraws():
    wallet, db, hub, _ = make(coins={"a": 300})
    first = run(wallet.apply("a", 50, "test", "x"))
    again = run(wallet.apply("a", 50, "test", "x"))
    assert first == {"applied": True, "duplicate": False, "coins": 350}
    assert again == {"applied": False, "duplicate": True, "coins": 350}
    short = run(wallet.apply("a", -400, "spend", "y", require_funds=True))
    assert short == {"applied": False, "duplicate": False, "coins": 350}
    assert hub.sent == [("a", {"type": "wallet", "coins": 350, "delta": 50, "reason": "test"})]
    assert [(e["key"], e["amount"], e["balance_after"]) for e in db.coin_ledger.docs] == [("test:x", 50, 350)]


def test_entries_are_all_or_nothing_and_a_short_player_gets_everyone_refunded():
    wallet, db, _, _ = make(coins={"a": 1000, "b": 1000, "c": 50, "d": 1000})
    with pytest.raises(InsufficientCoins) as err:
        run(wallet.collect_entries(["a", "b", "c", "d"], "chai", "ROOM-1"))
    assert err.value.user_id == "c"
    assert [coins_of(db, u) for u in "abcd"] == [1000, 1000, 50, 1000]
    assert [e["key"] for e in db.coin_ledger.docs] == [
        "stake_entry:ROOM-1", "stake_entry:ROOM-1", "stake_refund:ROOM-1", "stake_refund:ROOM-1"]


def test_entries_then_winner_payout_once():
    wallet, db, _, _ = make(coins={u: 1000 for u in "abcd"})
    assert run(wallet.collect_entries(list("abcd"), "chai", "G1")) == list("abcd")
    # A retried start does not charge twice.
    assert run(wallet.collect_entries(list("abcd"), "chai", "G1")) == list("abcd")
    assert [coins_of(db, u) for u in "abcd"] == [900] * 4
    assert run(wallet.pay_winners(["a", "c"], "chai", "G1")) == 180
    run(wallet.pay_winners(["a", "c"], "chai", "G1"))  # recovery replay pays nothing more
    assert [coins_of(db, u) for u in "abcd"] == [1080, 900, 1080, 900]


def test_recovery_refunds_only_players_who_were_actually_charged():
    wallet, db, _, _ = make(coins={u: 1000 for u in "abcd"})
    run(wallet.apply("a", -500, "stake_entry", "R", require_funds=True))
    run(wallet.apply("b", -500, "stake_entry", "R", require_funds=True))
    assert run(wallet.refund_if_charged(list("abcd"), "city", "R")) == ["a", "b"]
    assert [coins_of(db, u) for u in "abcd"] == [1000] * 4


def test_daily_reward_streak_resets_after_a_missed_day_and_follows_indian_midnight():
    wallet, db, _, clock = make(coins={"a": 0})
    before = run(wallet.state("a"))["daily"]
    assert (before["claimed_today"], before["next_day"], before["next_reward"]) == (False, 1, DAILY_REWARDS[0])
    assert run(wallet.claim_daily("a"))["amount"] == DAILY_REWARDS[0]
    # Once today's reward is taken, the next one shown is tomorrow's (day 2).
    after = run(wallet.state("a"))["daily"]
    assert (after["claimed_today"], after["streak"], after["next_day"], after["next_reward"]) == (True, 1, 2, DAILY_REWARDS[1])
    with pytest.raises(WalletError):
        run(wallet.claim_daily("a"))
    # 18:31 UTC is already the next day in India.
    clock.now = datetime(2026, 11, 27, 18, 31, tzinfo=timezone.utc)
    second = run(wallet.claim_daily("a"))
    assert (second["amount"], second["streak"]) == (DAILY_REWARDS[1], 2)
    state = run(wallet.state("a"))
    assert state["daily"]["claimed_today"] is True and state["daily"]["streak"] == 2
    clock.now += timedelta(days=2)  # a day missed
    third = run(wallet.claim_daily("a"))
    assert (third["amount"], third["streak"]) == (DAILY_REWARDS[0], 1)
    assert coins_of(db, "a") == DAILY_REWARDS[0] * 2 + DAILY_REWARDS[1]


def test_free_top_up_only_below_one_hundred_and_once_every_four_hours():
    wallet, db, _, clock = make(coins={"a": 500, "b": 40})
    with pytest.raises(WalletError):
        run(wallet.claim_topup("a"))
    assert run(wallet.claim_topup("b")) == {"amount": TOPUP_AMOUNT, "coins": 240}
    run(wallet.apply("b", -200, "spend", "1", require_funds=True))
    with pytest.raises(WalletError):
        run(wallet.claim_topup("b"))
    assert run(wallet.state("b"))["topup"]["available_at"] is not None
    clock.now += timedelta(hours=4, minutes=1)
    assert run(wallet.claim_topup("b"))["coins"] == 240


def test_state_lists_tiers_with_level_locks_and_affordability():
    wallet, _, _, _ = make(coins={"a": 600})
    tiers = {t["id"]: t for t in run(wallet.state("a", level=3))["tiers"]}
    assert (tiers["chai"]["unlocked"], tiers["chai"]["affordable"]) == (True, True)
    assert (tiers["city"]["unlocked"], tiers["city"]["affordable"]) == (True, True)
    assert (tiers["royal"]["unlocked"], tiers["royal"]["affordable"]) == (False, False)


def test_history_is_newest_first():
    wallet, _, _, clock = make(coins={"a": 100})
    run(wallet.apply("a", 5, "x", "1"))
    clock.now += timedelta(minutes=1)
    run(wallet.apply("a", 7, "x", "2"))
    assert [e["amount"] for e in run(wallet.history("a"))] == [7, 5]
