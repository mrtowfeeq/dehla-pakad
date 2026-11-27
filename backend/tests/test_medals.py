"""Individual medals: 1 per trick a player personally wins + 3 per ten in those tricks, only for the
winning team of a completed round, only in human-only matches, awarded exactly once per round."""
import asyncio
import copy
import sys
from pathlib import Path

from pymongo.errors import DuplicateKeyError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import GRAND_SLAM, KOTH, NORMAL, Match, legal_cards, team_of  # noqa: E402
from game_service import GameService, Hub  # noqa: E402
from medals import Medals, match_is_eligible, match_medal_summary, round_breakdown  # noqa: E402


# ---------------- a small fake MongoDB ----------------
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
        if isinstance(expected, dict) and expected and all(k.startswith("$") for k in expected):
            for op, operand in expected.items():
                if op == "$ne" and ((operand in actual) if isinstance(actual, list) else actual == operand):
                    return False
                if op == "$in" and not (set(actual) & set(operand) if isinstance(actual, list) else actual in operand):
                    return False
                if op == "$exists" and (actual is not None) != operand:
                    return False
                if op == "$gt" and (actual is None or actual <= operand):
                    return False
                if op == "$gte" and (actual is None or actual < operand):
                    return False
                if op == "$lt" and (actual is None or actual >= operand):
                    return False
                if op == "$lte" and (actual is None or actual > operand):
                    return False
                if op == "$nin" and actual in operand:
                    return False
        elif isinstance(actual, list) and not isinstance(expected, list):
            if expected not in actual:
                return False
        elif actual != expected:
            return False
    return True


def _set(doc, path, value):
    parts = path.split(".")
    for part in parts[:-1]:
        doc = doc.setdefault(part, {})
    doc[parts[-1]] = copy.deepcopy(value)


def _apply(doc, update):
    for path, value in update.get("$set", {}).items():
        _set(doc, path, value)
    for path, amount in update.get("$inc", {}).items():
        _set(doc, path, (_get(doc, path) or 0) + amount)
    for path, value in update.get("$max", {}).items():
        current = _get(doc, path)
        if current is None or value > current:
            _set(doc, path, value)
    for path, spec in update.get("$push", {}).items():
        items = list(_get(doc, path) or []) + list(spec["$each"])
        _set(doc, path, items[spec["$slice"]:] if "$slice" in spec else items)


class Result:
    def __init__(self, matched=0, upserted_id=None):
        self.matched_count = self.modified_count = matched
        self.upserted_id = upserted_id


class Cursor:
    def __init__(self, docs):
        self.docs = [copy.deepcopy(d) for d in docs]

    def __aiter__(self):
        self._it = iter(self.docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration

    def sort(self, field, direction=1):
        keys = field if isinstance(field, list) else [(field, direction)]
        for name, order in reversed(keys):  # stable sorts, last key first
            def value(d, name=name):
                v = _get(d, name)
                if v is None:  # like MongoDB: a missing value sorts below every number and string
                    return (-1, 0)
                return (0, v) if isinstance(v, (int, float)) else (1, str(v))
            self.docs.sort(key=value, reverse=order == -1)
        return self

    def skip(self, n):
        self.docs = self.docs[n:]
        return self

    def limit(self, n):
        self.docs = self.docs[:n]
        return self

    async def to_list(self, n):
        return self.docs if n is None else self.docs[:n]


class Collection:
    def __init__(self, docs=None, unique=None):
        self.docs = [copy.deepcopy(d) for d in (docs or [])]
        self.unique = unique
        self.interleave = False  # yield to other tasks between reads and writes (concurrency tests)

    def _first(self, query):
        return next((d for d in self.docs if _matches(d, query)), None)

    async def find_one(self, query, projection=None):
        found = copy.deepcopy(self._first(query))
        if self.interleave:
            await asyncio.sleep(0)
        return found

    def find(self, query, projection=None):
        return Cursor(d for d in self.docs if _matches(d, query))

    async def insert_one(self, doc):
        if self.unique and any(all(d.get(k) == doc.get(k) for k in self.unique) for d in self.docs):
            raise DuplicateKeyError("duplicate")
        self.docs.append(copy.deepcopy(doc))

    async def update_one(self, query, update, upsert=False):
        doc = self._first(query)
        if doc is None:
            if not upsert:
                return Result()
            doc = {k: v for k, v in query.items() if not isinstance(v, dict)}
            doc.update(copy.deepcopy(update.get("$setOnInsert", {})))
            self.docs.append(doc)
            _apply(doc, {k: v for k, v in update.items() if k != "$setOnInsert"})
            return Result(upserted_id=len(self.docs))
        _apply(doc, {k: v for k, v in update.items() if k != "$setOnInsert"})
        return Result(matched=1)

    async def count_documents(self, query):
        return sum(1 for d in self.docs if _matches(d, query))

    async def update_many(self, query, update):
        hits = [d for d in self.docs if _matches(d, query)]
        for d in hits:
            _apply(d, update)
        return Result(matched=len(hits))

    async def find_one_and_update(self, query, update, projection=None, return_document=None):
        if self.interleave:
            await asyncio.sleep(0)
        doc = self._first(query)
        if doc is None:
            return None
        _apply(doc, update)
        return copy.deepcopy(doc)


UIDS = ["u0", "u1", "u2", "u3"]


class Database:
    def __init__(self, start=None):  # start: {user id: starting medal balance}
        start = start or {}
        self.users = Collection([{"user_id": u, "username": u, "stats": {}, **({"medals": start[u]} if u in start else {})}
                                 for u in UIDS])
        self.games = Collection()
        self.matches = Collection()
        self.rooms = Collection([{"code": "ROOM01", "status": "playing"}])
        self.game_events = Collection()
        self.medal_awards = Collection(unique=("env", "user_id", "key"))
        self.progression_events = Collection(unique=("env", "user_id", "id"))


def run(coro):
    return asyncio.run(coro)


def make_service(db=None, start=None):
    db = db or Database(start)
    hub = Hub()
    service = GameService(db, hub, schedule_turn_timers=False)
    service.medals = Medals(db, hub)
    return service, db


async def new_game(service, bots=(), target=10):
    seats = [f"bot{s}" if s in bots else UIDS[s] for s in range(4)]
    room = {"code": "ROOM01", "seats": seats, "dealer_seat": 3, "target": target, "is_public": False,
            "host_id": "u0", "turn_duration": 30,
            "bots": {f"bot{s}": {"username": f"Bot {s}"} for s in bots}}
    return await service.create(room)


def lifetime(db):
    return {d["user_id"]: d.get("medals", 0) for d in db.users.docs}


# ---------------- crafted rounds with real cards ----------------
def trick(winner, *cards):
    """A completed earlier trick: the winner seat and the four cards (in any seat order)."""
    return {"winner": winner, "cards": [((winner + i) % 4, c) for i, c in enumerate(cards)],
            "tens": [c for c in cards if c[:-1] == "10"]}


def crafted(hands, prior, *, trump="S", leader=0, scores=None, koth=None, target=10):
    m = Match.new(dealer=3, target=target)
    s = m.s
    tens = [[], []]
    tricks_won = [0, 0]
    for t in prior:
        tens[team_of(t["winner"])].extend(t["tens"])
        tricks_won[team_of(t["winner"])] += 1
    s.update(hands=[list(h) for h in hands], trump=trump, phase="playing", turn=leader, trick=[],
             tens=tens, tricks=copy.deepcopy(prior), tricks_won=tricks_won, scores=list(scores or [0, 0]), koth=koth)
    return m


def play_trick(m, cards):
    for card in cards:
        m.play(m.s["turn"], card)


async def finish_round(service, game, match):
    """Put the crafted state on the game and run the service's real post-action step."""
    # The crafted round was just completed by the last play, as if that play went through the service.
    just_completed = match.s["phase"] in ("round_over", "match_over") and match.s.get("result")
    rounds_before = len(match.s["rounds"]) - (1 if just_completed else 0)
    game["state"] = match.s
    await service._after_change(game, rounds_before)


def by_user(breakdown):
    """user -> (tricks, tens, trick medals, ten medals, bonus, penalty, actual change)."""
    return {p["user_id"]: (p["tricks"], p["tens"], p["trick_medals"], p["ten_medals"], p["bonus"], p["penalty"], p["change"])
            for p in breakdown["players"]}


def three_tens_round(target=10):
    """Normal win ('three_tens'): seat 0 takes 10S earlier, seat 2 a plain trick, seat 1 takes 10D for
    team B; then seat 0 wins a trick with 10H and 10C -> team A has three tens, B has one."""
    prior = [trick(0, "10S", "2S", "3S", "4S"), trick(2, "AD", "2D", "3D", "4D"), trick(1, "10D", "5D", "6D", "7D")]
    hands = [["10H", "AC"], ["2H", "2C"], ["10C", "3C"], ["4H", "4C"]]
    m = crafted(hands, prior, trump="S", target=target)
    play_trick(m, ["10H", "2H", "10C", "4H"])
    return m


def koth_round(target=10):
    """Automatic Koth for team A: seat 2 took 10S and 10D earlier, seat 1 a plain trick; seat 0 then
    wins a trick holding 10H and 10C."""
    prior = [trick(2, "10S", "2S", "3S", "4S"), trick(2, "10D", "5D", "6D", "7D"), trick(1, "AC", "2C", "3C", "4C")]
    m = crafted([["10H", "AC"], ["2H", "2C"], ["10C", "3C"], ["4H", "4C"]], prior, trump="S", target=target)
    play_trick(m, ["10H", "2H", "10C", "4H"])
    return m


def failed_grand_slam_round():
    """Team A declared Grand Slam and won tricks 1-12 (one with 10S); seat 1 wins the last trick."""
    winners = [0, 2] * 6
    prior = [trick(w, *[f"{r}{s}" for r in ("2", "3", "4", "5")]) for w, s in zip(winners, "SDCSDCSDCSDC")]
    prior[0] = trick(0, "10S", "6S", "7S", "8S")
    m = crafted([["2H"], ["AH"], ["3H"], ["4H"]], prior, trump="S")
    m.s["gs_eligible"] = m.s["gs_declared"] = 0
    m.s["gs_decided"] = True
    play_trick(m, ["2H", "AH", "3H", "4H"])
    return m


def grand_slam_round():
    hands = [["AH", "KH", "QH", "JH", "9H", "8H"], ["2C", "3C", "4C", "5C", "6C", "10C"],
             ["2D", "3D", "4D", "5D", "6D", "10D"], ["7C", "8C", "9C", "JC", "QC", "KC"]]
    prior = [trick(0, "10S", "2S", "3S", "4S"), trick(2, "10H", "5S", "6S", "7S")] + \
            [trick(w, "AS", "8S", "9S", "JS") for w in (0, 2, 0, 2, 0)]
    m = crafted(hands, prior, trump="H")
    m.s["gs_eligible"] = m.s["gs_declared"] = 0
    m.s["gs_decided"] = True
    while m.s["phase"] == "playing":
        seat = m.s["turn"]
        m.play(seat, legal_cards(m.s["hands"][seat], m.s["trick"])[-1])
    return m


def play_round(round_factory, start=None, **game_kwargs):
    service, db = make_service(start=start)
    game = run(new_game(service, **game_kwargs))
    m = round_factory()
    run(finish_round(service, game, m))
    return service, db, game, m


# ---------------- 1-2, 9-10: normal win and loss; a ten is worth 4 + the bonus; losers get no trick medals ----------------
def test_normal_win_earns_tricks_tens_and_one_bonus_and_each_loser_loses_one():
    service, db, game, m = play_round(three_tens_round, start={u: 10 for u in UIDS})
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["reason"]) == (0, NORMAL, "three_tens")
    b = game["medal_rounds"][0]
    assert b["victory_medals"] == 1
    # Seat 0: 2 tricks, 3 tens -> 2 + 9 + 1 = 12. Seat 2: 1 plain trick -> 1 + 0 + 1 = 2.
    # Seat 1 won a trick holding 10D but its team lost: no trick or ten medals, only the -1 penalty.
    assert by_user(b) == {"u0": (2, 3, 2, 9, 1, 0, 12), "u1": (1, 1, 0, 0, 0, 1, -1),
                          "u2": (1, 0, 1, 0, 1, 0, 2), "u3": (0, 0, 0, 0, 0, 1, -1)}
    assert lifetime(db) == {"u0": 22, "u1": 9, "u2": 12, "u3": 9}


def test_a_trick_with_a_ten_is_four_medals_plus_the_victory_bonus():
    game = {"id": "g", "has_bots": False, "players": [{"user_id": u, "seat": i, "team": i % 2} for i, u in enumerate(UIDS)]}
    b = round_breakdown(game, {"round": 1, "winner_team": 1, "type": "normal"}, [trick(3, "10H", "2H", "3H", "4H")])
    p = next(x for x in b["players"] if x["user_id"] == "u3")
    assert (p["trick_medals"] + p["ten_medals"], p["bonus"], p["requested"]) == (4, 1, 5)


# ---------------- 3-6, 13: Koth and Grand Slam bonuses and penalties ----------------
def test_koth_win_earns_four_bonus_and_each_loser_loses_four():
    service, db, game, m = play_round(koth_round, start={u: 10 for u in UIDS})
    assert (m.s["result"]["type"], m.s["result"]["reason"]) == (KOTH, "automatic_koth")
    # Seat 0: 1 trick, 2 tens -> 1 + 6 + 4 = 11. Seat 2: 2 tricks, 2 tens -> 2 + 6 + 4 = 12.
    assert by_user(game["medal_rounds"][0]) == {"u0": (1, 2, 1, 6, 4, 0, 11), "u1": (1, 0, 0, 0, 0, 4, -4),
                                                "u2": (2, 2, 2, 6, 4, 0, 12), "u3": (0, 0, 0, 0, 0, 4, -4)}
    assert lifetime(db) == {"u0": 21, "u1": 6, "u2": 22, "u3": 6}


def test_grand_slam_win_earns_thirteen_bonus_and_each_loser_loses_thirteen():
    service, db, game, m = play_round(grand_slam_round, start={u: 20 for u in UIDS})
    assert (m.s["result"]["type"], m.s["result"]["reason"]) == (GRAND_SLAM, "grand_slam")
    expected = {u: 20 for u in UIDS}
    for t in m.s["tricks"]:  # independent count from the engine's own per-trick tens list
        expected[UIDS[t["winner"]]] += 1 + 3 * len(t["tens"])
    for u in ("u0", "u2"):
        expected[u] += 13
    for u in ("u1", "u3"):
        expected[u] -= 13
    assert lifetime(db) == expected
    assert {p["user_id"]: (p["bonus"], p["penalty"]) for p in game["medal_rounds"][0]["players"]} == \
        {"u0": (13, 0), "u1": (0, 13), "u2": (13, 0), "u3": (0, 13)}


def test_a_failed_grand_slam_uses_the_engines_classification_a_grand_slam_for_the_opponents():
    service, db, game, m = play_round(failed_grand_slam_round, start={"u0": 20, "u1": 0, "u2": 2, "u3": 5})
    r = m.s["result"]
    # The engine scores it as a Grand Slam victory (3 points) for the opponents of the declaring team.
    assert (r["winner_team"], r["type"], r["reason"], r["points"]) == (1, GRAND_SLAM, "grand_slam_failed", 3)
    b = game["medal_rounds"][0]
    assert b["type"] == GRAND_SLAM and b["victory_medals"] == 13
    # Seat 1 won only the last trick (no ten): 1 + 13. Seat 3: 0 + 13. The declaring team loses 13 each,
    # with no credit for their 12 tricks; seat 2 only had 2, so only 2 are taken.
    assert by_user(b) == {"u0": (6, 1, 0, 0, 0, 13, -13), "u1": (1, 0, 1, 0, 13, 0, 14),
                          "u2": (6, 0, 0, 0, 0, 13, -2), "u3": (0, 0, 0, 0, 13, 0, 13)}
    assert lifetime(db) == {"u0": 7, "u1": 14, "u2": 0, "u3": 18}


def failed_koth_round():
    """Team A captured three tens and declared Koth; team B (seat 1) then wins the trick holding the
    fourth ten (10C), so the engine gives the Koth to team B."""
    prior = [trick(0, "10S", "2S", "3S", "4S"), trick(2, "10D", "5D", "6D", "7D"),
             trick(0, "10H", "2H", "3H", "4H"), trick(1, "KS", "5S", "6S", "7S")]
    m = crafted([["2C"], ["AC"], ["3C"], ["10C"]], prior, trump="S", koth=0)
    play_trick(m, ["2C", "AC", "3C", "10C"])
    return m


def test_a_failed_koth_gives_the_opponents_their_medals_plus_four_and_the_declaring_team_loses_four():
    service, db, game, m = play_round(failed_koth_round, start={"u0": 10, "u1": 10, "u2": 3, "u3": 0})
    r = m.s["result"]
    assert m.s["koth"] == 0  # team A declared Koth ...
    # ... but the engine's final result gives the round to team B as a Koth victory.
    assert (r["winner_team"], r["type"], r["reason"], r["points"]) == (1, KOTH, "koth_fourth_ten", 2)
    b = game["medal_rounds"][0]
    assert (b["winner_team"], b["type"], b["victory_medals"]) == (1, KOTH, 4)
    # Seat 1: 2 tricks (one holding the fourth ten) -> 2 + 3 + 4 = 9. Seat 3: no tricks -> 0 + 0 + 4.
    # Team A captured three tens and won three tricks but gets no trick or ten medals, only -4 each;
    # seat 2 had 3 medals, so only 3 are taken.
    assert by_user(b) == {"u0": (2, 2, 0, 0, 0, 4, -4), "u1": (2, 1, 2, 3, 4, 0, 9),
                          "u2": (1, 1, 0, 0, 0, 4, -3), "u3": (0, 0, 0, 0, 4, 0, 4)}
    assert lifetime(db) == {"u0": 6, "u1": 19, "u2": 0, "u3": 4}
    assert {p["user_id"]: p["won"] for p in b["players"]} == {"u0": False, "u1": True, "u2": False, "u3": True}
    awards = {a["user_id"]: a for a in db.medal_awards.docs}
    assert (awards["u2"]["penalty"], awards["u2"]["change"], awards["u2"]["balance_after"]) == (4, -3, 0)
    assert (awards["u1"]["victory_type"], awards["u1"]["bonus"], awards["u1"]["change"]) == (KOTH, 4, 9)
    # Exactly once: processing the same result again changes nothing.
    run(service._after_change(game, 0))
    run(service.medals.award_all(game))
    assert lifetime(db) == {"u0": 6, "u1": 19, "u2": 0, "u3": 4} and len(db.medal_awards.docs) == 4


def test_a_failed_grand_slam_gives_the_opponents_their_medals_plus_thirteen_and_the_declaring_team_loses_thirteen():
    service, db, game, m = play_round(failed_grand_slam_round, start={"u0": 40, "u1": 1, "u2": 13, "u3": 0})
    r = m.s["result"]
    assert m.s["gs_declared"] == 0  # team A declared Grand Slam ...
    assert (r["winner_team"], r["type"], r["reason"], r["points"]) == (1, GRAND_SLAM, "grand_slam_failed", 3)
    b = game["medal_rounds"][0]
    assert (b["winner_team"], b["type"], b["victory_medals"]) == (1, GRAND_SLAM, 13)
    # Seat 1 won only the last trick (no ten) -> 1 + 0 + 13; seat 3 -> 0 + 0 + 13.
    # Team A won 12 tricks (one with 10S) but only loses 13 each.
    assert by_user(b) == {"u0": (6, 1, 0, 0, 0, 13, -13), "u1": (1, 0, 1, 0, 13, 0, 14),
                          "u2": (6, 0, 0, 0, 0, 13, -13), "u3": (0, 0, 0, 0, 13, 0, 13)}
    assert lifetime(db) == {"u0": 27, "u1": 15, "u2": 0, "u3": 13}


def test_failed_declarations_change_nothing_in_bot_matches():
    for factory in (failed_koth_round, failed_grand_slam_round):
        service, db = make_service(start={u: 20 for u in UIDS})
        game = run(new_game(service, bots=(3,)))
        run(finish_round(service, game, factory()))
        assert lifetime(db) == {u: 20 for u in UIDS} and db.medal_awards.docs == [] and not game.get("medal_rounds")

# ---------------- 7-8: the zero floor ----------------
def test_a_deduction_never_takes_a_balance_below_zero_and_records_the_actual_amount():
    service, db, game, m = play_round(koth_round, start={"u1": 2})  # u3 has no medals field at all
    b = game["medal_rounds"][0]
    loser = {p["user_id"]: p for p in b["players"] if not p["won"]}
    assert (loser["u1"]["penalty"], loser["u1"]["requested"], loser["u1"]["change"], loser["u1"]["balance_after"]) == (4, -4, -2, 0)
    assert (loser["u3"]["penalty"], loser["u3"]["change"], loser["u3"]["balance_after"]) == (4, 0, 0)
    assert lifetime(db)["u1"] == 0 and lifetime(db)["u3"] == 0
    awards = {a["user_id"]: a for a in db.medal_awards.docs}
    assert (awards["u1"]["penalty"], awards["u1"]["change"], awards["u1"]["balance_after"]) == (4, -2, 0)
    assert (awards["u3"]["penalty"], awards["u3"]["change"]) == (4, 0)
    # A second loss at zero stays at zero.
    game2 = run(new_game(service))
    run(finish_round(service, game2, koth_round()))
    assert lifetime(db)["u1"] == 0 and lifetime(db)["u3"] == 0


# ---------------- 11-12: bots ----------------
def test_one_bot_or_several_bots_means_no_earnings_bonuses_or_deductions_for_anyone():
    for bots in ((1,), (1, 3), (0, 1, 2)):
        service, db = make_service(start={u: 10 for u in UIDS})
        game = run(new_game(service, bots=bots))
        assert game["has_bots"] is True and not match_is_eligible(game)
        run(finish_round(service, game, koth_round()))
        assert game.get("medal_rounds") in (None, [])
        assert lifetime(db) == {u: 10 for u in UIDS} and db.medal_awards.docs == []
        assert all("medal_keys" not in d for d in db.users.docs)
        assert match_medal_summary(game) == {"eligible": False, "rounds": [], "totals": {}}


def test_a_bot_flag_on_any_player_also_blocks_medals_even_if_the_game_flag_is_missing():
    game = {"id": "g", "players": [{"user_id": u, "seat": i, "team": i % 2, "is_bot": i == 2} for i, u in enumerate(UIDS)]}
    assert round_breakdown(game, {"round": 1, "winner_team": 0, "type": "koth"}, [trick(0, "10H", "2H", "3H", "4H")]) is None


# ---------------- full rounds driven by validated player actions ----------------
async def play_to_round_end(service, game):
    while game["state"]["phase"] not in ("round_over", "match_over"):
        s = game["state"]
        gid = game["id"]
        if s["phase"] == "trump_select":
            await service.handle(UIDS[s["trump_selector"]], {"game_id": gid, "action": "select_trump", "suit": "S"})
        elif s["phase"] == "playing":
            seat = s["turn"]
            card = legal_cards(s["hands"][seat], s["trick"])[0]
            await service.handle(UIDS[seat], {"game_id": gid, "action": "play", "card": card})
        elif s["phase"] == "koth_decision":
            await service.handle(UIDS[s["koth_decision"]], {"game_id": gid, "action": "koth", "declare": False})
        else:
            await service.handle(UIDS[s["gs_eligible"]], {"game_id": gid, "action": "grand_slam", "declare": False})


def test_a_round_played_through_the_service_matches_an_independent_count():
    service, db = make_service(start={u: 50 for u in UIDS})
    game = run(new_game(service))
    run(play_to_round_end(service, game))
    s = game["state"]
    result = s["rounds"][-1]
    stake = {"normal": 1, "koth": 4, "grand_slam": 13}[result["type"]]
    expected = {u: 50 for u in UIDS}
    for p in game["players"]:
        expected[p["user_id"]] += stake if p["team"] == result["winner_team"] else -stake
    for t in s["tricks"]:
        if team_of(t["winner"]) == result["winner_team"]:
            expected[UIDS[t["winner"]]] += 1 + 3 * len(t["tens"])
    assert lifetime(db) == expected
    winners = [p for p in game["medal_rounds"][0]["players"] if p["won"]]
    assert sum(p["tricks"] for p in winners) == result["tricks_won"][result["winner_team"]]
    assert sum(p["tens"] for p in winners) == result["tens"][result["winner_team"]]
    # The breakdown, with the actual changes, is saved with the game.
    assert db.games.docs[0]["medal_rounds"] == game["medal_rounds"]
    assert all(p["change"] is not None for p in db.games.docs[0]["medal_rounds"][0]["players"])


# ---------------- 16: lifetime totals, awards and history stay consistent ----------------
def test_lifetime_totals_awards_and_match_history_agree_across_matches():
    service, db = make_service(start={"u1": 3})
    first = run(new_game(service, target=1))
    run(finish_round(service, first, three_tens_round(target=1)))  # target 1: this round ends the match
    assert first["status"] == "finished"
    second = run(new_game(service, target=1))
    run(finish_round(service, second, three_tens_round(target=1)))
    assert lifetime(db) == {"u0": 24, "u1": 1, "u2": 4, "u3": 0}
    rows = {r["game_id"]: r for r in db.matches.docs}
    medals = rows[first["id"]]["medals"]
    assert medals["eligible"] is True and medals["totals"] == {"u0": 12, "u1": -1, "u2": 2, "u3": 0}
    assert by_user(medals["rounds"][0])["u3"] == (0, 0, 0, 0, 0, 1, 0)  # penalty 1, nothing to take
    # Every player's lifetime total = starting balance + the sum of the actual changes in history.
    starts = {"u0": 0, "u1": 3, "u2": 0, "u3": 0}
    for u in UIDS:
        history = run(service.medals.history(u))
        assert starts[u] + sum(h["change"] for h in history) == lifetime(db)[u]
        assert starts[u] + sum(rows[g]["medals"]["totals"][u] for g in rows) == lifetime(db)[u]
        latest = max(history, key=lambda h: (h["ts"], h["game_id"] == second["id"]))
        assert latest["balance_after"] == lifetime(db)[u]
    u0 = [h for h in run(service.medals.history("u0")) if h["game_id"] == first["id"]][0]
    assert (u0["tricks"], u0["tens"], u0["trick_medals"], u0["ten_medals"], u0["bonus"], u0["penalty"], u0["change"]) == \
        (2, 3, 2, 9, 1, 0, 12)


# ---------------- 14-15: repeats, reconnects, restarts and concurrency ----------------
def test_repeated_results_reconnects_and_restarts_never_apply_twice():
    service, db, game, m = play_round(koth_round, start={u: 10 for u in UIDS})
    after = lifetime(db)
    assert after == {"u0": 21, "u1": 6, "u2": 22, "u3": 6}
    run(service._after_change(game, 0))  # the same result processed again
    run(service.medals.award_all(game))
    fresh = copy.deepcopy(game["medal_rounds"][0])
    for p in fresh["players"]:
        p["change"] = p["balance_after"] = None  # as if the actual changes had not been saved
    run(service.medals.award_round(game, fresh))
    assert by_user(fresh) == by_user(game["medal_rounds"][0])  # filled back from the user's own record
    for uid in UIDS:  # refreshes and reconnects only read the game
        service.view_for(game, uid)
        run(service.get(game["id"]))
    restarted, _ = make_service(db)
    run(restarted.load_active())
    run(restarted.load_active())
    assert lifetime(db) == after and len(db.medal_awards.docs) == 4


def test_a_restart_after_the_breakdown_was_saved_but_before_anything_was_applied_applies_it_once():
    service, db = make_service(start={u: 10 for u in UIDS})
    service.medals = None  # crash window: state + breakdown saved, nothing applied
    game = run(new_game(service))
    run(finish_round(service, game, koth_round()))
    assert lifetime(db) == {u: 10 for u in UIDS} and db.games.docs[0]["medal_rounds"]
    restarted, _ = make_service(db)
    run(restarted.load_active())
    run(restarted.load_active())
    assert lifetime(db) == {"u0": 21, "u1": 6, "u2": 22, "u3": 6}
    assert all(p["change"] is not None for p in db.games.docs[0]["medal_rounds"][0]["players"])


def test_a_restart_between_the_balance_change_and_the_history_entry_recreates_the_entry_once():
    service, db = make_service(start={"u1": 2})
    service.medals = None
    game = run(new_game(service))
    run(finish_round(service, game, koth_round()))
    key = f"{game['id']}:1"
    medals = Medals(db)
    run(medals._apply_once("u1", key, -4))  # the balance changed, then the process stopped
    assert lifetime(db)["u1"] == 0 and db.medal_awards.docs == []
    restarted, _ = make_service(db)
    run(restarted.load_active())
    entry = next(a for a in db.medal_awards.docs if a["user_id"] == "u1")
    assert (entry["change"], entry["balance_after"]) == (-2, 0) and lifetime(db)["u1"] == 0


def test_finished_match_recovery_replays_without_duplicates():
    service, db = make_service(start={u: 10 for u in UIDS})
    game = run(new_game(service, target=1))
    run(finish_round(service, game, three_tens_round(target=1)))
    assert game["status"] == "finished"
    run(service._finish_match(copy.deepcopy(db.games.docs[0])))
    run(service._finish_match(copy.deepcopy(db.games.docs[0])))
    assert lifetime(db) == {"u0": 22, "u1": 9, "u2": 12, "u3": 9} and len(db.matches.docs) == 1


def test_concurrent_processing_applies_each_round_once_and_keeps_the_zero_floor():
    service, db = make_service(start={"u0": 5, "u1": 3, "u2": 0, "u3": 1})
    db.users.interleave = True
    medals = Medals(db)
    game = run(new_game(service))
    first = round_breakdown(game, {"round": 1, "winner_team": 0, "type": "koth"}, [trick(0, "AS", "2S", "3S", "4S")])
    second = round_breakdown(game, {"round": 2, "winner_team": 0, "type": "koth"}, [trick(2, "AH", "2H", "3H", "4H")])

    async def race():
        # The same round processed three times at once, alongside a different round for the same players.
        await asyncio.gather(*(medals.award_round(game, copy.deepcopy(b)) for b in (first, first, second, first, second)))

    run(race())
    # Round 1: u0 +1+4, u2 +4; u1 -4 (3 -> 0), u3 -4 (1 -> 0). Round 2: u0 +4, u2 +1+4; u1, u3 stay 0.
    assert lifetime(db) == {"u0": 14, "u1": 0, "u2": 9, "u3": 0}
    for u in UIDS:
        doc = next(d for d in db.users.docs if d["user_id"] == u)
        assert sorted(doc["medal_keys"]) == sorted({f"{game['id']}:1", f"{game['id']}:2"})
        changes = {c["key"]: c["change"] for c in doc["medal_changes"]}
        start = {"u0": 5, "u1": 3, "u2": 0, "u3": 1}[u]
        assert start + sum(changes.values()) == lifetime(db)[u] >= 0
    assert len(db.medal_awards.docs) == 8


# ---------------- cancelled and incomplete rounds ----------------
def test_cancelled_forfeited_or_unfinished_rounds_change_nothing():
    service, db = make_service(start={u: 10 for u in UIDS})
    service.hub.send_many = lambda *a, **k: asyncio.sleep(0)
    game = run(new_game(service))
    m2 = crafted([["10H", "AC"], ["2H", "2C"], ["10C", "3C"], ["4H", "4C"]],
                 [trick(0, "10S", "2S", "3S", "4S")], trump="S")
    m2.play(0, "10H")  # mid-trick: nothing is complete
    run(finish_round(service, game, m2))
    assert lifetime(db) == {u: 10 for u in UIDS} and not game.get("medal_rounds")
    run(service.cancel(game["id"], "u1"))
    assert lifetime(db) == {u: 10 for u in UIDS}
    service2, db2 = make_service(start={u: 10 for u in UIDS})
    game2 = run(new_game(service2))
    Match(game2["state"]).forfeit(1)
    run(service2._after_change(game2, 0))
    assert lifetime(db2) == {u: 10 for u in UIDS} and db2.matches.docs[0]["medals"]["rounds"] == []


# ---------------- authenticated API and privacy ----------------
def _import_server():
    import os
    import dotenv
    keys = ("MONGO_URL", "DB_NAME", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY")
    saved = {k: os.environ.get(k) for k in keys}
    original = dotenv.load_dotenv
    dotenv.load_dotenv = lambda *a, **k: False
    os.environ.update({"MONGO_URL": "mongodb://127.0.0.1:27017", "DB_NAME": "dehla_pakad_medal_tests",
                       "CLERK_PUBLISHABLE_KEY": "pk_test_medals", "CLERK_SECRET_KEY": "sk_test_medals"})
    try:
        import server
    finally:
        dotenv.load_dotenv = original
        for k, v in saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
    return server


def test_medal_api_returns_the_stored_total_history_and_rules(monkeypatch):
    server = _import_server()
    db = Database()
    db.users.docs[0].update(env=server.ENV, medals=42)
    db.medal_awards.docs.append({"env": server.ENV, "user_id": "u0", "key": "g:1", "game_id": "g", "round": 1,
                                 "tricks": 2, "tens": 1, "change": 6, "ts": "2026-11-27T10:00:00Z"})
    monkeypatch.setattr(server, "medals", Medals(db, env=server.ENV))
    body = run(server.medal_state({"user_id": "u0"}))
    assert body["medals"] == 42 and (body["per_trick"], body["per_ten"]) == (1, 3)
    assert body["victory"] == {"normal": 1, "koth": 4, "grand_slam": 13}
    assert [h["key"] for h in body["history"]] == ["g:1"]
    assert server.public_user({"user_id": "u0", "medals": 42})["medals"] == 42
    assert server.public_user({"user_id": "u1"})["medals"] == 0


def test_views_and_history_show_only_the_viewers_own_lifetime_balance():
    server = _import_server()
    service, db, game, m = play_round(koth_round, start={u: 10 for u in UIDS})
    for uid in UIDS:
        players = {p["user_id"]: p for p in service.view_for(game, uid)["round_medals"]["players"]}
        assert players[uid]["balance_after"] is not None
        assert all(p["balance_after"] is None for u, p in players.items() if u != uid)
        assert all(p["change"] is not None for p in players.values())  # changes are public, balances are not
    row = {"game_id": game["id"], "medals": match_medal_summary(game)}
    shown = server.hide_medal_balances(row, "u1")["medals"]["rounds"][0]["players"]
    assert [p["balance_after"] is not None for p in shown] == [False, True, False, False]
    assert row["medals"]["rounds"][0]["players"][0]["balance_after"] is not None  # the stored row is untouched


def test_leaderboard_ranks_every_human_player_by_medals_and_every_row_carries_medals(monkeypatch):
    server = _import_server()
    db = Database()
    for doc, medals, wins in zip(db.users.docs, (12, 300, 0, 90), (9, 1, 5, 3)):
        doc.update(env=server.ENV, medals=medals, stats={"wins": wins, "games_played": 10})
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "medals", Medals(db, env=server.ENV))
    by_medals = run(server.leaderboard("medals", member={"user_id": "u0"}))["rows"]
    # Everyone is ranked (players at 0 medals are in Bronze); see test_leagues.py for paging and filters.
    assert [(r["username"], r["medals"], r["rank"]) for r in by_medals] == [("u1", 300, 1), ("u3", 90, 2), ("u0", 12, 3), ("u2", 0, 4)]
    by_wins = run(server.leaderboard("wins", member={"user_id": "u0"}))
    assert [(r["username"], r["medals"]) for r in by_wins] == [("u0", 12), ("u2", 0), ("u3", 90), ("u1", 300)]

def test_the_match_over_view_carries_every_rounds_changes_with_only_your_own_balance():
    service, db = make_service(start={u: 10 for u in UIDS})
    game = run(new_game(service, target=1))
    assert service.view_for(game, "u0")["match_medals"] is None  # not over yet
    run(finish_round(service, game, koth_round(target=1)))
    assert game["state"]["phase"] == "match_over"
    for uid in UIDS:
        summary = service.view_for(game, uid)["match_medals"]
        assert summary["eligible"] is True and summary["totals"] == {"u0": 11, "u1": -4, "u2": 12, "u3": -4}
        balances = {p["user_id"]: p["balance_after"] for p in summary["rounds"][0]["players"]}
        assert balances[uid] == lifetime(db)[uid] and all(v is None for u, v in balances.items() if u != uid)
    reloaded, _ = make_service(db)  # a refresh after the match reads the finished game back
    finished = run(reloaded.get(game["id"]))
    assert reloaded.view_for(finished, "u2")["match_medals"]["totals"]["u2"] == 12
    bots_service, _ = make_service()
    bot_game = run(new_game(bots_service, bots=(2,), target=1))
    run(finish_round(bots_service, bot_game, koth_round(target=1)))
    view = bots_service.view_for(bot_game, "u0")
    assert view["match_medals"] is None and view["medals_eligible"] is False