"""Coin wallet: earned-only coins, stake tables, the daily reward and the free top-up.

Coins can never be bought, cashed out or sent to another player. Only the server changes a balance.

Every change is one atomic update of the player's own user document. That update also records a key
("<reason>:<ref>") in a short list on the document and only applies when the key is not there yet, so a
retry, a reconnect or a restart can never charge or pay the same thing twice. A coin-history entry
(collection ``coin_ledger``) is written right after each applied change.
"""

from datetime import datetime, timedelta, timezone

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

try:
    from backend.env_scope import scoped_query
except ModuleNotFoundError:  # pragma: no cover - run from the backend folder
    from env_scope import scoped_query

STARTING_COINS = 1000
DAILY_REWARDS = (50, 100, 150, 200, 250, 300, 350)
TOPUP_THRESHOLD = 100
TOPUP_AMOUNT = 200
TOPUP_COOLDOWN = timedelta(hours=4)
TABLE_FEE_PERCENT = 10
KEY_HISTORY = 200
# The day for the daily reward changes at midnight Indian time.
IST = timezone(timedelta(hours=5, minutes=30))

STAKE_TIERS = {
    "chai": {"id": "chai", "name": "Chai Table", "entry": 100, "min_level": 1},
    "city": {"id": "city", "name": "City Table", "entry": 500, "min_level": 3},
    "royal": {"id": "royal", "name": "Royal Table", "entry": 2500, "min_level": 6},
    "maharaja": {"id": "maharaja", "name": "Maharaja Table", "entry": 10000, "min_level": 10},
}


def winner_payout(entry):
    """Each of the two winning partners receives half of the pot after the table fee."""
    pot = 4 * entry
    return pot * (100 - TABLE_FEE_PERCENT) // 100 // 2


def tier_view(tier_id):
    tier = STAKE_TIERS.get(tier_id)
    if not tier:
        return None
    pot = 4 * tier["entry"]
    payout = winner_payout(tier["entry"])
    return {**tier, "pot": pot, "payout": payout, "fee": pot - 2 * payout}


def utc_iso(moment):
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


class WalletError(Exception):
    """A wallet request the player cannot make right now (shown to them as is)."""


class InsufficientCoins(WalletError):
    def __init__(self, user_id, needed):
        super().__init__("Not enough coins for this table")
        self.user_id = user_id
        self.needed = needed


class Wallet:
    def __init__(self, db, hub=None, *, env=None, clock=None):
        self.db = db
        self.hub = hub
        self.env = env
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def _user(self, uid, extra=None):
        return scoped_query({"user_id": uid, **(extra or {})}, self.env)

    async def balance(self, uid):
        doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "coins": 1})
        return int((doc or {}).get("coins") or 0)

    async def ensure(self, uid):
        """Give a player their starting coins once (players from before coins existed included)."""
        res = await self.db.users.update_one(
            self._user(uid, {"coins": {"$exists": False}}),
            {"$set": {"coins": STARTING_COINS}, "$push": {"wallet_keys": {"$each": ["starting_coins:start"], "$slice": -KEY_HISTORY}}},
        )
        if getattr(res, "modified_count", 0):
            await self._record(uid, "starting_coins", "start", STARTING_COINS, STARTING_COINS)
        return await self.balance(uid)

    async def _record(self, uid, reason, ref, amount, balance_after):
        try:
            await self.db.coin_ledger.insert_one({
                "env": self.env, "user_id": uid, "key": f"{reason}:{ref}", "reason": reason, "ref": ref,
                "amount": amount, "balance_after": balance_after, "ts": utc_iso(self.clock()),
            })
        except DuplicateKeyError:
            pass

    async def apply(self, uid, delta, reason, ref, *, require_funds=False, extra_query=None, extra_set=None, notify=True):
        """Change a balance once per (reason, ref). Returns {"applied", "duplicate", "coins"}."""
        key = f"{reason}:{ref}"
        await self.ensure(uid)
        query = self._user(uid, {"wallet_keys": {"$ne": key}})
        if require_funds and delta < 0:
            query["coins"] = {"$gte": -delta}
        query.update(extra_query or {})
        update = {"$inc": {"coins": delta}, "$push": {"wallet_keys": {"$each": [key], "$slice": -KEY_HISTORY}}}
        if extra_set:
            update["$set"] = extra_set
        doc = await self.db.users.find_one_and_update(
            query, update, projection={"_id": 0, "coins": 1}, return_document=ReturnDocument.AFTER)
        if doc is None:
            current = await self.db.users.find_one(self._user(uid), {"_id": 0, "coins": 1, "wallet_keys": 1}) or {}
            return {"applied": False, "duplicate": key in (current.get("wallet_keys") or []),
                    "coins": int(current.get("coins") or 0)}
        balance = int(doc.get("coins") or 0)
        await self._record(uid, reason, ref, delta, balance)
        if notify and self.hub is not None:
            await self.hub.send(uid, {"type": "wallet", "coins": balance, "delta": delta, "reason": reason})
        return {"applied": True, "duplicate": False, "coins": balance}

    async def has_key(self, uid, key):
        doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "wallet_keys": 1}) or {}
        return key in (doc.get("wallet_keys") or [])

    # ---------- daily reward and top-up ----------
    def _today(self):
        local = self.clock().astimezone(IST).date()
        return local.isoformat(), (local - timedelta(days=1)).isoformat()

    def _daily_status(self, daily):
        today, yesterday = self._today()
        last = (daily or {}).get("last")
        streak = int((daily or {}).get("streak") or 0)
        claimed_today = last == today
        current = streak if last in (today, yesterday) else 0
        # The next claim continues the streak: today's if not claimed yet, otherwise tomorrow's.
        index = current % len(DAILY_REWARDS)
        return {
            "claimed_today": claimed_today, "streak": current,
            "next_reward": DAILY_REWARDS[index], "next_day": index + 1,
            "rewards": list(DAILY_REWARDS),
        }

    async def claim_daily(self, uid):
        today, yesterday = self._today()
        doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "wallet_daily": 1}) or {}
        daily = doc.get("wallet_daily") or {}
        if daily.get("last") == today:
            raise WalletError("Today's reward is already claimed. Come back tomorrow!")
        streak = int(daily.get("streak") or 0) + 1 if daily.get("last") == yesterday else 1
        amount = DAILY_REWARDS[(streak - 1) % len(DAILY_REWARDS)]
        result = await self.apply(uid, amount, "daily", today,
                                  extra_query={"wallet_daily.last": {"$ne": today}},
                                  extra_set={"wallet_daily": {"last": today, "streak": streak}})
        if not result["applied"]:
            raise WalletError("Today's reward is already claimed. Come back tomorrow!")
        return {"amount": amount, "streak": streak, "coins": result["coins"]}

    def _topup_status(self, coins, last_iso):
        now = self.clock()
        last = parse_iso(last_iso)
        available_at = last + TOPUP_COOLDOWN if last else None
        cooling = available_at is not None and available_at > now
        return {"eligible": coins < TOPUP_THRESHOLD and not cooling, "amount": TOPUP_AMOUNT,
                "threshold": TOPUP_THRESHOLD, "available_at": utc_iso(available_at) if cooling else None}

    async def claim_topup(self, uid):
        coins = await self.ensure(uid)
        doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "wallet_topup_at": 1}) or {}
        status = self._topup_status(coins, doc.get("wallet_topup_at"))
        if coins >= TOPUP_THRESHOLD:
            raise WalletError(f"Free coins are for balances under {TOPUP_THRESHOLD}")
        if not status["eligible"]:
            raise WalletError("Your next free coins aren't ready yet")
        now = self.clock()
        cutoff = utc_iso(now - TOPUP_COOLDOWN)
        result = await self.apply(
            uid, TOPUP_AMOUNT, "topup", utc_iso(now),
            extra_query={"coins": {"$lt": TOPUP_THRESHOLD},
                         "$or": [{"wallet_topup_at": {"$exists": False}}, {"wallet_topup_at": {"$lte": cutoff}}]},
            extra_set={"wallet_topup_at": utc_iso(now)})
        if not result["applied"]:
            raise WalletError("Your next free coins aren't ready yet")
        return {"amount": TOPUP_AMOUNT, "coins": result["coins"]}

    async def state(self, uid, level=1):
        coins = await self.ensure(uid)
        doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "wallet_daily": 1, "wallet_topup_at": 1}) or {}
        tiers = []
        for tier_id in STAKE_TIERS:
            view = tier_view(tier_id)
            tiers.append({**view, "unlocked": level >= view["min_level"], "affordable": coins >= view["entry"]})
        return {"coins": coins, "daily": self._daily_status(doc.get("wallet_daily")),
                "topup": self._topup_status(coins, doc.get("wallet_topup_at")), "tiers": tiers,
                "table_fee_percent": TABLE_FEE_PERCENT}

    async def history(self, uid, limit=30):
        cursor = self.db.coin_ledger.find(scoped_query({"user_id": uid}, self.env), {"_id": 0, "env": 0})
        return await cursor.sort("ts", -1).limit(limit).to_list(limit)

    # ---------- stake tables ----------
    async def collect_entries(self, uids, tier_id, ref):
        """Take the entry from every player, all or nothing. Raises InsufficientCoins (after refunding)."""
        entry = STAKE_TIERS[tier_id]["entry"]
        charged = []
        for uid in uids:
            result = await self.apply(uid, -entry, "stake_entry", ref, require_funds=True)
            if result["applied"] or result["duplicate"]:
                charged.append(uid)
                continue
            await self.refund(charged, tier_id, ref)
            raise InsufficientCoins(uid, entry)
        return charged

    async def refund(self, uids, tier_id, ref):
        entry = STAKE_TIERS[tier_id]["entry"]
        for uid in uids:
            await self.apply(uid, entry, "stake_refund", ref)

    async def refund_if_charged(self, uids, tier_id, ref):
        """Recovery: refund only players whose entry for this table was actually taken."""
        charged = [uid for uid in uids if uid and await self.has_key(uid, f"stake_entry:{ref}")]
        await self.refund(charged, tier_id, ref)
        return charged

    async def pay_winners(self, uids, tier_id, ref):
        payout = winner_payout(STAKE_TIERS[tier_id]["entry"])
        for uid in uids:
            await self.apply(uid, payout, "stake_win", ref)
        return payout
