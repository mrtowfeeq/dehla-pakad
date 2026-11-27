"""Permanent individual player medals.

For every completed round of a human-only match:

* each player on the winning team earns
      tricks they personally won x 1  +  tens in those tricks x 3  +  the victory bonus
  (so a trick holding a ten is worth 4 before the bonus);
* each player on the losing team loses the victory penalty (no trick or ten medals), but a
  lifetime balance never goes below zero: the amount actually taken is min(penalty, balance).

Victory bonus / penalty by the engine's own round classification (``result["type"]``):
normal 1, koth 4, grand_slam 13. A failed Grand Slam is classified by the engine as a Grand Slam
victory for the opponents (type "grand_slam", reason "grand_slam_failed"), so it uses 13.

A match with even one bot is not eligible: nothing is earned, deducted or recorded.

Everything is computed on the server from the authoritative trick list of the round (the seat that
won each trick and the cards in it), right when the round is completed. The breakdown is stored with
the game state before anything is applied. Each player's change is then applied with one
compare-and-set update of their own user document that

* only matches when the round key "<game_id>:<round>" is not yet in ``medal_keys`` and the balance is
  still the one just read (so the zero floor is exact even with concurrent changes), and
* adds the key and a short record of the actual change (``medal_changes``) in the same update,

so a retry, a reconnect, a repeated event, concurrent processing or a restart can never apply the same
round twice, and the actual amount is never lost. An entry in ``medal_awards`` (the player's private
medal history) is written right after, and re-created from ``medal_changes`` if a restart happened
in between.

Leagues (leagues.py) follow the balance: the same compare-and-set update stores the new league and
level (``league``, ``league_level``) and raises ``highest_league_rank`` (``$max``, never lowered), and the
``medal_changes`` record keeps the league state before and after. From that record the player's
progression events are written to ``progression_events`` with deterministic ids ("<round key>:medal",
"<round key>:level" or "<round key>:league") under a unique index, so a retry or a restart can re-create a
missing event but never a second one. Events stay "pending" until the player's client acknowledges them.
"""

import uuid

from datetime import datetime, timezone

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

try:
    from backend.env_scope import scoped_query
    from backend import leagues
except ModuleNotFoundError:  # pragma: no cover - run from the backend folder
    from env_scope import scoped_query
    import leagues

MEDALS_PER_TRICK = 1
MEDALS_PER_TEN = 3
# Fixed bonus for each winner and penalty for each loser, by the engine's victory type.
VICTORY_MEDALS = {"normal": 1, "koth": 4, "grand_slam": 13}
KEY_HISTORY = 500
CAS_ATTEMPTS = 20


def _rank(card):
    return str(card)[:-1]


def _now_iso(clock):
    return clock().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def match_is_eligible(game):
    """Human-only matches only: one bot anywhere makes the whole match ineligible."""
    players = game.get("players") or []
    return (not game.get("has_bots")) and len(players) == 4 and not any(p.get("is_bot") for p in players)


def round_breakdown(game, round_result, tricks):
    """Requested medal changes for one completed round, from the round's authoritative tricks.

    Every player is listed. Winners: tricks, tens, trick_medals, ten_medals, bonus and the requested
    net (positive). Losers: tricks and tens for reference only, the penalty and the requested net
    (negative). ``change`` and ``balance_after`` are filled in when the change is applied. None when
    the match is not eligible or the result has no winning team.
    """
    if not match_is_eligible(game):
        return None
    winner_team = round_result.get("winner_team")
    if winner_team not in (0, 1):
        return None
    victory_type = round_result.get("type")
    stake = VICTORY_MEDALS.get(victory_type, 0)
    tricks_by_seat = [0, 0, 0, 0]
    tens_by_seat = [0, 0, 0, 0]
    for trick in tricks or []:
        seat = trick.get("winner")
        if seat not in (0, 1, 2, 3):
            continue
        tricks_by_seat[seat] += 1
        # Tens are re-derived from the cards themselves rather than trusting any other field.
        tens_by_seat[seat] += sum(1 for _, card in trick.get("cards") or [] if _rank(card) == "10")
    players = []
    for p in sorted(game["players"], key=lambda x: x["seat"]):
        seat = p["seat"]
        won = p["team"] == winner_team
        trick_medals = tricks_by_seat[seat] * MEDALS_PER_TRICK if won else 0
        ten_medals = tens_by_seat[seat] * MEDALS_PER_TEN if won else 0
        bonus = stake if won else 0
        penalty = 0 if won else stake
        requested = trick_medals + ten_medals + bonus - penalty
        players.append({
            "user_id": p["user_id"], "seat": seat, "team": p["team"], "won": won,
            "tricks": tricks_by_seat[seat], "tens": tens_by_seat[seat],
            "trick_medals": trick_medals, "ten_medals": ten_medals, "bonus": bonus, "penalty": penalty,
            "requested": requested,
            # Kept for older readers: the requested net change.
            "medals": requested,
            "change": None, "balance_after": None,
        })
    return {"round": round_result.get("round"), "winner_team": winner_team, "type": victory_type,
            "reason": round_result.get("reason"), "victory_medals": stake, "players": players}


def player_net(p):
    """The actual applied change when known, else the requested one (older records: 'medals')."""
    if p.get("change") is not None:
        return p["change"]
    return p.get("requested", p.get("medals", 0))


def match_medal_summary(game):
    """Per-match view for history: eligibility, each round's breakdown and each player's net change."""
    eligible = match_is_eligible(game)
    rounds = list(game.get("medal_rounds") or []) if eligible else []
    totals = {}
    for r in rounds:
        for p in r["players"]:
            totals[p["user_id"]] = totals.get(p["user_id"], 0) + player_net(p)
    return {"eligible": eligible, "rounds": rounds, "totals": totals}


def private_view(summary_or_round, viewer_id):
    """Copy of a medal summary or round breakdown without other players' lifetime balances."""
    if not summary_or_round:
        return summary_or_round

    def strip_round(r):
        return {**r, "players": [p if p.get("user_id") == viewer_id else {**p, "balance_after": None}
                                 for p in r.get("players") or []]}

    if "rounds" in summary_or_round:
        return {**summary_or_round, "rounds": [strip_round(r) for r in summary_or_round.get("rounds") or []]}
    return strip_round(summary_or_round)


class Medals:
    def __init__(self, db, hub=None, *, env=None, clock=None):
        self.db = db
        self.hub = hub
        self.env = env
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def _user(self, uid, extra=None):
        return scoped_query({"user_id": uid, **(extra or {})}, self.env)

    async def ensure(self, uid):
        """Give a player a numeric balance (0) if they have none yet. Never changes an existing balance."""
        await self.db.users.update_one(self._user(uid, {"medals": {"$exists": False}}), {"$set": {"medals": 0}})

    async def total(self, uid):
        doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "medals": 1}) or {}
        return int(doc.get("medals") or 0)

    async def _apply_once(self, uid, key, requested):
        """Apply one round's change to one player at most once, never below zero.

        Returns (applied_now, change, balance_after, record); (False, None, None, None) for an unknown
        player. ``record`` is the stored change with the league state before and after."""
        # Give older players a numeric balance first, so the compare-and-set below can match on it.
        await self.db.users.update_one(self._user(uid, {"medals": {"$exists": False}}), {"$set": {"medals": 0}})
        for _ in range(CAS_ATTEMPTS):
            doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "medals": 1, "medal_keys": 1, "medal_changes": 1})
            if doc is None:
                return False, None, None, None
            if key in (doc.get("medal_keys") or []):
                record = next((c for c in doc.get("medal_changes") or [] if c.get("key") == key), None)
                return False, (record or {}).get("change"), (record or {}).get("balance_after"), record
            balance = int(doc.get("medals") or 0)
            change = max(requested, -balance)  # a deduction never takes the balance below zero
            after = balance + change
            before_state, after_state = leagues.state(balance), leagues.state(after)
            record = {"key": key, "change": change, "balance_before": balance, "balance_after": after,
                      "from": before_state, "to": after_state}
            updated = await self.db.users.find_one_and_update(
                self._user(uid, {"medal_keys": {"$ne": key}, "medals": balance}),
                {"$inc": {"medals": change},
                 "$set": {"league": after_state["league"], "league_level": after_state["level"]},
                 "$max": {"highest_league_rank": after_state["rank"]},
                 "$push": {"medal_keys": {"$each": [key], "$slice": -KEY_HISTORY},
                           "medal_changes": {"$each": [record], "$slice": -KEY_HISTORY}}},
                projection={"_id": 0, "medals": 1}, return_document=ReturnDocument.AFTER)
            if updated is not None:
                return True, change, after, record
            # Someone else changed this player meanwhile (or applied this round): read again.
        raise RuntimeError(f"medal update for {uid} kept conflicting")

    async def _record(self, game, breakdown, p, key):
        try:
            await self.db.medal_awards.insert_one({
                "env": self.env, "user_id": p["user_id"], "key": key, "game_id": game["id"],
                "round": breakdown["round"], "victory_type": breakdown.get("type"), "reason": breakdown.get("reason"),
                "won": p["won"], "tricks": p["tricks"], "tens": p["tens"],
                "trick_medals": p["trick_medals"], "ten_medals": p["ten_medals"],
                "bonus": p["bonus"], "penalty": p["penalty"], "requested": p["requested"],
                "change": p["change"], "balance_after": p["balance_after"],
                # Kept for older readers: the actual net change.
                "medals": p["change"],
                "ts": _now_iso(self.clock),
            })
        except DuplicateKeyError:
            pass

    async def award_round(self, game, breakdown):
        """Apply one round's changes to every human at most once per (game, round). Fills in each
        player's actual ``change`` and ``balance_after``. Returns True when the breakdown gained new
        information (so the caller saves it)."""
        if not breakdown or not match_is_eligible(game):
            return False
        key = f"{game['id']}:{breakdown['round']}"
        filled = False
        for p in breakdown["players"]:
            if p.get("change") is not None:
                continue
            requested = p.get("requested", p.get("medals", 0))
            if requested == 0:
                p["change"], p["balance_after"] = 0, await self.total(p["user_id"])
                filled = True
                continue
            applied_now, change, after, record = await self._apply_once(p["user_id"], key, requested)
            if change is None:
                continue
            p["change"], p["balance_after"] = change, after
            filled = True
            await self._record(game, breakdown, p, key)
            if applied_now and self.hub is not None:
                await self.hub.send(p["user_id"], {"type": "medals", "medals": after, "delta": change,
                                                   "game_id": game["id"], "round": breakdown["round"]})
            await self._progression_events(game, breakdown, p, key, record)
        return filled

    # ---------- progression events (league / level transitions and medal changes) ----------
    async def _progression_events(self, game, breakdown, p, key, record):
        """Write this round's events for one player (at most once each) and push the new ones."""
        if not record or record.get("from") is None:
            return  # a change recorded before leagues existed: nothing to present
        before, after = record["from"], record["to"]
        base = {"game_id": game["id"], "round": breakdown["round"], "balance_before": record.get("balance_before"),
                "balance_after": record["balance_after"]}
        events = [("medal", {**base, "change": record["change"], "won": p["won"], "victory_type": breakdown.get("type"),
                             "tricks": p["tricks"], "tens": p["tens"], "trick_medals": p["trick_medals"],
                             "ten_medals": p["ten_medals"], "bonus": p["bonus"], "penalty": p["penalty"],
                             "requested": p["requested"], "league": after})]
        if before["league"] != after["league"]:
            events.append(("league", {**base, "direction": "promotion" if after["rank"] > before["rank"] else "demotion",
                                      "from": before, "to": after}))
        elif before["level"] != after["level"]:
            events.append(("level", {**base, "direction": "up" if after["level"] > before["level"] else "down",
                                     "from": before, "to": after}))
        for kind, data in events:
            event = {"env": self.env, "user_id": p["user_id"], "id": f"{key}:{kind}", "uid": str(uuid.uuid4()),
                     "kind": kind, "data": data, "created_at": _now_iso(self.clock), "acknowledged_at": None}
            try:
                await self.db.progression_events.insert_one(event)
            except DuplicateKeyError:
                continue  # already recorded (retry, replay or restart): never a second event
            if self.hub is not None:
                await self.hub.send(p["user_id"], {"type": "progression_event", "event": public_event(event)})

    async def pending_events(self, uid, limit=20):
        cursor = self.db.progression_events.find(
            scoped_query({"user_id": uid, "acknowledged_at": None}, self.env), {"_id": 0, "env": 0})
        return [public_event(e) for e in await cursor.sort("created_at", 1).limit(limit).to_list(limit)]

    async def acknowledge(self, uid, ids):
        """Mark the player's own events as presented; unknown or other players' ids are ignored."""
        ids = [str(i) for i in ids if isinstance(i, str)][:50]
        if not ids:
            return 0
        result = await self.db.progression_events.update_many(
            scoped_query({"user_id": uid, "id": {"$in": ids}, "acknowledged_at": None}, self.env),
            {"$set": {"acknowledged_at": _now_iso(self.clock)}})
        return getattr(result, "modified_count", 0)

    async def transitions(self, uid, limit=20):
        cursor = self.db.progression_events.find(
            scoped_query({"user_id": uid, "kind": {"$in": ["level", "league"]}}, self.env), {"_id": 0, "env": 0})
        return [public_event(e) for e in await cursor.sort("created_at", -1).limit(limit).to_list(limit)]

    async def progress(self, uid):
        doc = await self.db.users.find_one(self._user(uid), {"_id": 0, "medals": 1, "highest_league_rank": 1}) or {}
        return leagues.progress(doc.get("medals") or 0, doc.get("highest_league_rank"))

    async def award_all(self, game):
        """Apply every stored round of a game (also startup recovery and match end); rounds already
        applied are skipped. Returns True when any breakdown gained new information."""
        changed = False
        for breakdown in (game.get("medal_rounds") or []):
            changed = await self.award_round(game, breakdown) or changed
        return changed

    async def history(self, uid, limit=30):
        cursor = self.db.medal_awards.find(scoped_query({"user_id": uid}, self.env), {"_id": 0, "env": 0})
        return await cursor.sort("ts", -1).limit(limit).to_list(limit)


def public_event(event):
    """An event as sent to its owner (never to anyone else)."""
    return {"id": event["id"], "kind": event["kind"], "data": event.get("data") or {},
            "created_at": event.get("created_at"), "acknowledged": event.get("acknowledged_at") is not None}
