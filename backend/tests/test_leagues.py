"""Leagues, league levels, promotions and demotions, progression events and the medal leaderboard."""
import asyncio
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import leagues  # noqa: E402
from medals import Medals  # noqa: E402
from test_medals import (UIDS, Database, _import_server, finish_round, koth_round, lifetime, make_service,  # noqa: E402
                         new_game, run)

# ---------------- 1-3, 9-10: thresholds ----------------
EXPECTED = {
    "bronze": [0, 20, 40, 60, 80], "silver": [100, 140, 180, 220, 260], "gold": [300, 360, 420, 480, 540],
    "platinum": [600, 680, 760, 840, 920], "diamond": [1000, 1200, 1400, 1600, 1800],
    "master": [2000, 2600, 3200, 3800, 4400], "legend": [5000, 7500, 10000, 12500, 15000],
}


def test_every_league_has_five_contiguous_levels_with_the_documented_thresholds():
    assert [lvl["min"] for lvl in leagues.LEVELS] == [m for lid in leagues.LEAGUE_IDS for m in EXPECTED[lid]]
    for a, b in zip(leagues.LEVELS, leagues.LEVELS[1:]):
        assert a["max"] == b["min"] - 1  # no gaps, no overlaps
    assert leagues.LEVELS[-1]["max"] is None  # Legend V has no upper limit
    assert [leagues.league_range(lid) for lid in leagues.LEAGUE_IDS] == [
        (0, 99), (100, 299), (300, 599), (600, 999), (1000, 1999), (2000, 4999), (5000, None)]


@pytest.mark.parametrize("league_id", list(EXPECTED))
def test_exact_boundaries_of_every_level(league_id):
    mins = EXPECTED[league_id]
    for n, minimum in enumerate(mins):
        at = leagues.public_league(minimum)
        assert (at["id"], at["level"], at["level_label"]) == (league_id, n + 1, ("I", "II", "III", "IV", "V")[n])
        below = leagues.state(minimum - 1)
        if minimum > 0:
            assert (below["league"], below["level"]) != (league_id, n + 1)  # one medal less is the level below
    if league_id != "legend":
        top = leagues.state(leagues.league_range(league_id)[1])
        assert (top["league"], top["level"]) == (league_id, 5)


def test_zero_and_negative_balances_are_bronze_one():
    for medals in (0, None, -5):
        assert leagues.public_league(medals) == {"id": "bronze", "name": "Bronze", "level": 1, "level_label": "I"}
    p = leagues.progress(0)
    assert (p["next_level_min"], p["level_progress_percent"], p["next_league"]["id"], p["league_progress_percent"]) == (20, 0, "silver", 0)


def test_progress_to_the_next_level_and_league_are_separate():
    p = leagues.progress(250)  # Silver IV (220-259)
    assert (p["league"], p["level"], p["level_min"], p["next_level_min"], p["medals_to_next_level"]) == ("silver", 4, 220, 260, 10)
    assert p["level_progress_percent"] == 75
    assert (p["next_league"]["id"], p["medals_to_next_league"], p["league_progress_percent"]) == ("gold", 50, 75)
    v = leagues.progress(290)  # Silver V: the next level is Gold I
    assert (v["level"], v["next_level_min"], v["medals_to_next_level"]) == (5, 300, 10)


def test_legend_has_five_levels_and_a_clear_rule_with_no_upper_limit():
    assert [leagues.public_league(m)["level"] for m in (5000, 7499, 7500, 10000, 12500, 14999, 15000, 999999)] == [1, 1, 2, 3, 4, 4, 5, 5]
    top = leagues.progress(40000)
    assert top["is_top_level"] and top["next_level_min"] is None and top["next_league"] is None
    assert top["level_progress_percent"] == 100 and top["league_progress_percent"] == 100
    assert "2,500" in top["legend_rule"] and "15,000" in top["legend_rule"]
    assert leagues.progress(12000)["medals_to_next_level"] == 500


def test_highest_league_comes_from_storage_and_never_reports_below_the_current_league():
    assert leagues.progress(50, highest_rank=3)["highest_league"]["id"] == "platinum"
    assert leagues.progress(700, highest_rank=1)["highest_league"]["id"] == "platinum"
    assert leagues.progress(700)["highest_league"]["id"] == "platinum"


# ---------------- 4-8: promotions and demotions through real medal changes ----------------
def game_of(gid="g1"):
    return {"id": gid, "has_bots": False, "players": [{"user_id": u, "seat": i, "team": i % 2} for i, u in enumerate(UIDS)]}


def breakdown(round_no, changes, vtype="normal"):
    """Requested changes per player: positive = win, negative = loss penalty."""
    players = []
    for seat, uid in enumerate(UIDS):
        req = changes.get(uid, 0)
        won = req > 0
        players.append({"user_id": uid, "seat": seat, "team": seat % 2, "won": won, "tricks": 0, "tens": 0,
                        "trick_medals": max(req - 1, 0) if won else 0, "ten_medals": 0, "bonus": 1 if won else 0,
                        "penalty": -req if req < 0 else 0, "requested": req, "medals": req, "change": None, "balance_after": None})
    return {"round": round_no, "winner_team": 0, "type": vtype, "players": players}


def events_of(db, uid, kind=None):
    return [e for e in db.progression_events.docs if e["user_id"] == uid and (kind is None or e["kind"] == kind)]


def user(db, uid):
    return next(d for d in db.users.docs if d["user_id"] == uid)


def test_promotion_within_a_league_and_to_a_higher_league():
    db = Database({"u0": 15, "u1": 95})
    medals = Medals(db)
    run(medals.award_round(game_of(), breakdown(1, {"u0": 10, "u1": 10})))
    up = events_of(db, "u0", "level")[0]["data"]  # Bronze I (15) -> Bronze II (25)
    assert (up["direction"], up["from"]["level"], up["to"]["level"], up["balance_after"]) == ("up", 1, 2, 25)
    assert events_of(db, "u0", "league") == []
    promo = events_of(db, "u1", "league")[0]["data"]  # Bronze V (95) -> Silver I (105)
    assert (promo["direction"], promo["from"]["league"], promo["to"]["league"], promo["to"]["level"]) == ("promotion", "bronze", "silver", 1)
    assert events_of(db, "u1", "level") == []  # one transition, not two
    assert (user(db, "u1")["league"], user(db, "u1")["league_level"], user(db, "u1")["highest_league_rank"]) == ("silver", 1, 1)


def test_demotion_within_a_league_and_to_a_lower_league_and_the_highest_league_stays():
    db = Database({"u0": 145, "u1": 102})
    medals = Medals(db)
    run(medals.award_round(game_of(), breakdown(1, {"u0": 10, "u1": 10})))  # u0 Silver II 155, u1 Silver I 112
    run(medals.award_round(game_of(), breakdown(2, {"u0": -13, "u1": -13}, "grand_slam")))
    assert events_of(db, "u0", "level") == []  # 145 -> 155 -> 142: always Silver II, so no transition yet
    run(medals.award_round(game_of(), breakdown(3, {"u0": -4}, "koth")))  # 142 -> 138: Silver II -> Silver I
    down = events_of(db, "u0", "level")[-1]["data"]
    assert (down["direction"], down["from"]["level"], down["to"]["level"], down["balance_after"]) == ("down", 2, 1, 138)
    demo = events_of(db, "u1", "league")[-1]["data"]  # 112 -> 99: Silver I -> Bronze V
    assert (demo["direction"], demo["from"]["league"], demo["to"]["league"], demo["to"]["level"]) == ("demotion", "silver", "bronze", 5)
    assert (user(db, "u1")["league"], user(db, "u1")["league_level"]) == ("bronze", 5)
    assert user(db, "u1")["highest_league_rank"] == 1  # Silver stays the highest ever reached
    assert leagues.progress(lifetime(db)["u1"], user(db, "u1")["highest_league_rank"])["highest_league"]["id"] == "silver"


def test_staying_on_the_same_level_creates_no_transition_and_zero_stays_bronze():
    db = Database({"u0": 21, "u1": 0})
    medals = Medals(db)
    run(medals.award_round(game_of(), breakdown(1, {"u0": 5, "u1": -4})))
    assert events_of(db, "u0", "level") == [] and events_of(db, "u0", "league") == []
    assert [e["kind"] for e in events_of(db, "u0")] == ["medal"]
    zero = events_of(db, "u1", "medal")[0]["data"]
    assert (zero["change"], zero["penalty"], zero["balance_after"]) == (0, 4, 0)
    assert (user(db, "u1")["league"], user(db, "u1")["league_level"], user(db, "u1")["medals"]) == ("bronze", 1, 0)


def test_a_real_round_records_medal_events_for_everyone_with_the_breakdown():
    service, db = make_service(start={"u0": 95, "u1": 10, "u2": 0, "u3": 302})
    game = run(new_game(service))
    run(finish_round(service, game, koth_round()))  # u0 +11, u2 +12, u1 -4, u3 -4
    assert lifetime(db) == {"u0": 106, "u1": 6, "u2": 12, "u3": 298}
    assert events_of(db, "u0", "league")[0]["data"]["direction"] == "promotion"  # Bronze V -> Silver I
    assert events_of(db, "u3", "league")[0]["data"]["direction"] == "demotion"  # Gold I -> Silver V
    medal = events_of(db, "u2", "medal")[0]["data"]
    assert (medal["won"], medal["trick_medals"], medal["ten_medals"], medal["bonus"], medal["change"]) == (True, 2, 6, 4, 12)


# ---------------- 11-12: human-only ----------------
def test_bot_matches_change_no_league_state_and_create_no_events():
    service, db = make_service(start={u: 95 for u in UIDS})
    game = run(new_game(service, bots=(1,)))
    run(finish_round(service, game, koth_round()))
    assert db.progression_events.docs == []
    assert all("league" not in d and "highest_league_rank" not in d for d in db.users.docs)
    medals = Medals(db)
    run(medals.award_round({**game_of(), "has_bots": True}, breakdown(9, {"u0": 50})))
    assert db.progression_events.docs == [] and lifetime(db)["u0"] == 95


# ---------------- 13-15: duplicates, concurrency, restarts and reconnects ----------------
def test_repeated_results_never_create_a_second_transition_or_push():
    db = Database({"u1": 95})
    sent = []

    class Hub:
        async def send(self, uid, msg):
            sent.append((uid, msg["type"], (msg.get("event") or {}).get("id")))

    medals = Medals(db, Hub())
    b = breakdown(1, {"u1": 10})
    for _ in range(3):
        run(medals.award_round(game_of(), copy.deepcopy(b)))
    assert [e["kind"] for e in events_of(db, "u1")] == ["medal", "league"]
    assert [s for s in sent if s[1] == "progression_event"] == [("u1", "progression_event", "g1:1:medal"),
                                                                ("u1", "progression_event", "g1:1:league")]


def test_concurrent_rounds_keep_balance_league_and_events_consistent():
    db = Database({"u0": 95})
    db.users.interleave = True
    medals = Medals(db)

    async def race():
        await asyncio.gather(*(medals.award_round(game_of(), breakdown(n, {"u0": 3})) for n in (1, 2, 3, 1, 2, 3)))

    run(race())
    assert lifetime(db)["u0"] == 104
    doc = user(db, "u0")
    assert (doc["league"], doc["league_level"], doc["highest_league_rank"]) == ("silver", 1, 1)
    # Every change is chained: each one starts where the previous one ended.
    changes = sorted(doc["medal_changes"], key=lambda c: c["balance_before"])
    assert [(c["balance_before"], c["balance_after"]) for c in changes] == [(95, 98), (98, 101), (101, 104)]
    leagues_ = [e for e in events_of(db, "u0", "league")]
    assert len(leagues_) == 1 and leagues_[0]["data"]["to"]["league"] == "silver"
    assert len(events_of(db, "u0", "medal")) == 3


def test_a_restart_after_the_balance_changed_recreates_missing_events_exactly_once():
    db = Database({"u1": 95})
    medals = Medals(db)
    run(medals._apply_once("u1", "g1:1", 10))  # balance and league changed, then the process stopped
    assert db.progression_events.docs == [] and user(db, "u1")["league"] == "silver"
    for _ in range(2):
        run(Medals(db).award_round(game_of(), breakdown(1, {"u1": 10})))
    assert [e["kind"] for e in events_of(db, "u1")] == ["medal", "league"] and lifetime(db)["u1"] == 105


def test_pending_events_survive_reconnects_until_acknowledged_and_only_by_their_owner():
    db = Database({"u0": 95, "u1": 95})
    medals = Medals(db)
    run(medals.award_round(game_of(), breakdown(1, {"u0": 10, "u1": 10})))
    first = run(medals.pending_events("u0"))
    assert [e["id"] for e in first] == ["g1:1:medal", "g1:1:league"]
    assert run(medals.pending_events("u0")) == first  # a refresh or reconnect sees the same events
    assert run(medals.acknowledge("u1", ["g1:1:medal"])) == 1  # u1 acknowledges only u1's own event
    assert [e["id"] for e in run(medals.pending_events("u0"))] == ["g1:1:medal", "g1:1:league"]
    assert run(medals.acknowledge("u0", ["g1:1:medal", "g1:1:league", "nope"])) == 2
    assert run(medals.pending_events("u0")) == []
    assert run(medals.acknowledge("u0", ["g1:1:medal"])) == 0  # acknowledging again changes nothing
    assert [e["kind"] for e in run(medals.transitions("u0"))] == ["league"]


# ---------------- 17-18: privacy and the leaderboard ----------------
def test_public_profiles_show_league_and_medals_but_not_private_progress():
    server = _import_server()
    public = server.public_user({"user_id": "u0", "medals": 650, "highest_league_rank": 5,
                                 "medal_changes": [{"key": "x"}], "medal_keys": ["x"]})
    assert public["league"] == {"id": "platinum", "name": "Platinum", "level": 1, "level_label": "I"}
    assert public["medals"] == 650
    assert not {"highest_league_rank", "medal_changes", "medal_keys", "league_progress"} & set(public)


@pytest.fixture
def board(monkeypatch):
    server = _import_server()
    db = Database()
    db.users.docs = []
    people = [("ann", 5200, 3), ("bob", 1500, 9), ("cat", 650, 1), ("dan", 650, 4), ("eve", 320, 0),
              ("fay", 120, 2), ("gus", 40, 5), ("hal", 0, 0), ("ivy", None, 0), ("jon", 900, 0)]
    for name, medals, wins in people:
        doc = {"user_id": name, "env": server.ENV, "username": name, "stats": {"wins": wins, "games_played": 10}}
        if medals is not None:
            doc["medals"] = medals
        db.users.docs.append(doc)
    db.users.docs.append({"user_id": "zed", "env": server.ENV, "username": "zed", "medals": 9999, "account_status": "banned", "stats": {}})
    db.users.docs.append({"user_id": "new", "env": server.ENV, "username": None, "medals": 50, "stats": {}})
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "medals", Medals(db, env=server.ENV))
    return server


def test_medal_leaderboard_pages_on_the_server_and_excludes_ineligible_accounts(board):
    first = run(board.leaderboard("medals", page=1, page_size=5, member={"user_id": "fay"}))
    assert (first["total"], first["pages"], first["page"]) == (10, 2, 1)
    assert [(r["username"], r["rank"], r["league"]["id"]) for r in first["rows"]] == [
        ("ann", 1, "legend"), ("bob", 2, "diamond"), ("jon", 3, "platinum"), ("dan", 4, "platinum"), ("cat", 5, "platinum")]
    second = run(board.leaderboard("medals", page=2, page_size=5, member={"user_id": "fay"}))
    assert [(r["username"], r["rank"]) for r in second["rows"]] == [("eve", 6), ("fay", 7), ("gus", 8), ("hal", 9), ("ivy", 10)]
    assert first["me"] == {"rank": 7, "medals": 120, "league": {"id": "silver", "name": "Silver", "level": 1, "level_label": "I"}, "page": 2}
    names = {r["username"] for r in first["rows"] + second["rows"]}
    assert "zed" not in names and "new" not in names  # banned and unfinished accounts; bots have no accounts
    assert all("medal_changes" not in r for r in first["rows"])


def test_league_filters_show_that_league_with_global_ranks(board):
    plat = run(board.leaderboard("medals", league="platinum", page_size=5, member={"user_id": "cat"}))
    assert [(r["username"], r["rank"]) for r in plat["rows"]] == [("jon", 3), ("dan", 4), ("cat", 5)]
    assert plat["total"] == 3 and plat["me"]["rank"] == 5 and plat["me"]["page"] == 1
    bronze = run(board.leaderboard("medals", league="bronze", page_size=5, member={"user_id": "cat"}))
    assert [r["username"] for r in bronze["rows"]] == ["gus", "hal", "ivy"]  # includes players with no medals yet
    assert bronze["me"]["page"] is None  # you are not in this league
    legend = run(board.leaderboard("medals", league="legend", member={"user_id": "cat"}))
    assert [r["username"] for r in legend["rows"]] == ["ann"]
    with pytest.raises(board.HTTPException):
        run(board.leaderboard("medals", league="wood", member={"user_id": "cat"}))


def test_leaderboard_page_size_and_page_are_clamped(board):
    out = run(board.leaderboard("medals", page=0, page_size=500, member={"user_id": "ann"}))
    assert (out["page"], out["page_size"]) == (1, 50) and len(out["rows"]) == 10
    assert out["me"]["rank"] == 1

def test_your_rank_matches_your_row_even_beside_players_with_no_medals_yet(board):
    # "hal" has 0 medals; "ivy" has no medals field at all and sorts below everyone with a number.
    out = run(board.leaderboard("medals", page=2, page_size=5, member={"user_id": "hal"}))
    row = next(r for r in out["rows"] if r["username"] == "hal")
    assert out["me"]["rank"] == row["rank"] == 9
    for member in ("ann", "dan", "cat", "fay"):
        page = run(board.leaderboard("medals", page=1, page_size=50, member={"user_id": member}))
        assert page["me"]["rank"] == next(r["rank"] for r in page["rows"] if r["username"] == member)
