"""Service-level gameplay coverage: server-authoritative actions over GameService.handle, per-seat
broadcasts, duplicate/concurrent submissions, restore after restart, match completion, and timeouts."""
import asyncio
import copy
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import Match, team_of  # noqa: E402
import game_service as game_service_module  # noqa: E402
from game_service import TURN_GRACE_SECONDS, GameService, Hub  # noqa: E402
from test_match_results import Collection  # noqa: E402

PRIVATE_STATE_KEYS = {"hands", "deck", "tricks", "events"}


class Database:
    def __init__(self, users):
        self.events = []
        self.games = Collection("games", self)
        self.matches = Collection("matches", self)
        self.rooms = Collection("rooms", self, [{"code": "ROOM01", "status": "playing"}])
        self.users = Collection("users", self, users)
        self.game_events = Collection("game_events", self)


class Socket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(copy.deepcopy(message))

    def states(self):
        return [m for m in self.messages if m.get("type") == "game_state"]


def users():
    return [{"user_id": f"u{seat}", "username": f"player{seat}", "display_name": f"Player {seat}",
             "stats": {"games_played": 0, "wins": 0, "losses": 0}} for seat in range(4)]


def run(coro):
    return asyncio.run(coro)


async def new_game(target=5, dealer=0, now=None):
    db = Database(users())
    hub = Hub()
    sockets = {}
    for seat in range(4):
        sockets[f"u{seat}"] = Socket()
        hub.add(f"u{seat}", sockets[f"u{seat}"])
    clock = (lambda: now[0]) if now else None
    kwargs = {"clock": clock} if clock else {}
    service = GameService(db, hub, schedule_turn_timers=False, **kwargs)
    room = {"code": "ROOM01", "seats": [f"u{seat}" for seat in range(4)], "dealer_seat": dealer,
            "target": target, "is_public": False, "host_id": "u0", "turn_duration": 30}
    game = await service.create(room)
    return service, game, db, sockets


def uid_for(seat):
    return f"u{seat}"


async def act_once(service, game):
    """Perform the next required action as the correct player, declining every optional bonus."""
    s = game["state"]
    gid = game["id"]
    if s["phase"] == "trump_select":
        return await service.handle(uid_for(s["trump_selector"]), {"game_id": gid, "action": "select_trump", "suit": "S"})
    if s["phase"] == "playing":
        seat = s["turn"]
        legal = service.view_for(game, uid_for(seat))["state"]["legal"]
        return await service.handle(uid_for(seat), {"game_id": gid, "action": "play", "card": legal[0]})
    if s["phase"] == "koth_decision":
        return await service.handle(uid_for(s["koth_decision"]), {"game_id": gid, "action": "koth", "declare": False})
    if s["phase"] == "gs_decision":
        return await service.handle(uid_for(s["gs_eligible"]), {"game_id": gid, "action": "grand_slam", "declare": False})
    raise AssertionError(f"no action for phase {s['phase']}")


async def act_once_or_error(service, game):
    """Between rounds no player may act: try a play from every seat and return the last reply."""
    reply = None
    for seat in range(4):
        hand = game["state"]["hands"][seat] or ["AS"]
        reply = await service.handle(uid_for(seat), {"game_id": game["id"], "action": "play", "card": hand[0]})
        assert reply["type"] == "error"
    return reply


def assert_private(message, seat):
    state = message["state"]
    assert not PRIVATE_STATE_KEYS & set(state)
    assert state["my_seat"] == seat
    assert len(state["hand"]) == state["hand_counts"][seat]
    if state["phase"] != "gs_decision" or state["gs_eligible"] != team_of(seat):
        assert state["partner_hand"] is None


def test_full_round_is_driven_only_by_validated_actions_and_each_seat_sees_only_its_own_hand(monkeypatch):
    async def case():
        service, game, db, sockets = await new_game(target=5, dealer=0)
        gid = game["id"]
        assert game["state"]["trump_selector"] == 1
        for _ in range(80):
            if game["state"]["phase"] in ("round_over", "match_over"):
                break
            assert await act_once(service, game) is None
        assert game["state"]["phase"] == "round_over"
        result = game["state"]["result"]
        for seat in range(4):
            states = sockets[uid_for(seat)].states()
            assert states, "every seat receives broadcasts"
            seqs = [m["state"]["seq"] for m in states]
            assert seqs == sorted(seqs)
            for message in states:
                assert_private(message, seat)
        persisted = await db.games.find_one({"id": gid})
        assert persisted["state"]["result"] == result and persisted["state"]["phase"] == "round_over"

        # The server scheduled the next round; replace its real delay with an immediate run.
        scheduled = service.timers.pop(gid)
        assert not scheduled.done()
        scheduled.cancel()
        assert (await act_once_or_error(service, game))["type"] == "error"
        assert game_service_module.deadline_timestamp(game["next_round_at"]) is not None
        game["next_round_at"] = game_service_module.utc_iso(service.clock())  # the deadline has arrived
        await service._next_round_later(gid)
        s = game["state"]
        assert s["round_no"] == 2 and s["phase"] == "trump_select" and s["dealer"] == result["next_dealer"]
        assert s["trump_selector"] == (result["next_dealer"] + 1) % 4
        assert s["scores"][result["winner_team"]] == result["points"]
        assert (await db.games.find_one({"id": gid}))["state"]["round_no"] == 2

    run(case())


def test_actions_from_the_wrong_seat_or_a_stranger_change_nothing():
    async def case():
        service, game, _, _ = await new_game()
        gid = game["id"]
        seq = game["state"]["seq"]
        assert await service.handle("stranger", {"game_id": gid, "action": "select_trump", "suit": "H"}) == \
            {"type": "error", "message": "Game not found"}
        reply = await service.handle("u2", {"game_id": gid, "action": "select_trump", "suit": "H"})
        assert reply["type"] == "error"
        reply = await service.handle("u1", {"game_id": gid, "action": "teleport"})
        assert reply == {"type": "error", "message": "Unknown action"}
        reply = await service.handle("u1", {"game_id": gid, "action": "play", "card": game["state"]["hands"][1][0]})
        assert reply["type"] == "error"
        assert game["state"]["seq"] == seq and game["state"]["trump"] is None

    run(case())


def test_repeated_and_concurrent_submissions_apply_exactly_one_action():
    async def case():
        service, game, _, _ = await new_game()
        gid = game["id"]
        await act_once(service, game)  # trump
        seat = game["state"]["turn"]
        legal = service.view_for(game, uid_for(seat))["state"]["legal"]
        play = {"game_id": gid, "action": "play", "card": legal[0]}
        assert await service.handle(uid_for(seat), play) is None
        duplicate = await service.handle(uid_for(seat), play)
        assert duplicate["type"] == "error"
        assert game["state"]["trick"] == [[seat, legal[0]]] and len(game["state"]["hands"][seat]) == 12

        nxt = game["state"]["turn"]
        options = service.view_for(game, uid_for(nxt))["state"]["legal"]
        first = {"game_id": gid, "action": "play", "card": options[0]}
        second = {"game_id": gid, "action": "play", "card": options[-1]}
        replies = await asyncio.gather(service.handle(uid_for(nxt), first), service.handle(uid_for(nxt), second))
        assert sorted(r is None for r in replies) == [False, True]
        assert len(game["state"]["trick"]) == 2 and len(game["state"]["hands"][nxt]) == 12

        # Concurrent duplicate trump/koth style decisions: only the first is accepted.
        service2, game2, _, _ = await new_game()
        trump = {"game_id": game2["id"], "action": "select_trump", "suit": "D"}
        other = {"game_id": game2["id"], "action": "select_trump", "suit": "C"}
        replies = await asyncio.gather(service2.handle("u1", trump), service2.handle("u1", other))
        assert replies[0] is None and replies[1]["type"] == "error" and game2["state"]["trump"] == "D"
        assert [len(h) for h in game2["state"]["hands"]] == [13] * 4

    run(case())


def test_koth_decision_cannot_be_taken_twice_by_both_teammates_at_once():
    async def case():
        service, game, _, _ = await new_game()
        s = game["state"]
        s.update(phase="koth_decision", koth_decision=1, turn=1, trump="S",
                 tens=[[], ["10C", "10D", "10H"]], tricks=[{"cards": [], "winner": 1, "tens": []}] * 3,
                 tricks_won=[0, 3])
        gid = game["id"]
        replies = await asyncio.gather(
            service.handle("u1", {"game_id": gid, "action": "koth", "declare": True}),
            service.handle("u3", {"game_id": gid, "action": "koth", "declare": False}),
        )
        assert replies[0] is None and replies[1]["type"] == "error"
        assert s["koth"] == 1 and s["phase"] == "playing" and s["result"] is None
        assert await service.handle("u0", {"game_id": gid, "action": "koth", "declare": False}) is not None

    run(case())


def test_restart_restores_an_active_mid_trick_game_exactly_and_play_continues():
    async def case():
        service, game, db, _ = await new_game()
        for _ in range(6):  # trump + 5 cards: mid second trick
            assert await act_once(service, game) is None
        before = copy.deepcopy(game["state"])
        assert len(before["trick"]) == 1 and len(before["tricks"]) == 1

        restored = GameService(db, Hub(), schedule_turn_timers=False)
        await restored.load_active()
        again = restored.games[game["id"]]
        assert again["state"] == before
        for seat in range(4):
            view = restored.view_for(again, uid_for(seat))["state"]
            assert sorted(view["hand"]) == sorted(before["hands"][seat])
        seat = again["state"]["turn"]
        legal = restored.view_for(again, uid_for(seat))["state"]["legal"]
        assert await restored.handle(uid_for(seat), {"game_id": again["id"], "action": "play", "card": legal[0]}) is None
        assert len(again["state"]["trick"]) == 2

    run(case())


def test_final_trick_finishes_the_match_once_and_persists_one_authoritative_result():
    async def case():
        service, game, db, sockets = await new_game(target=5)
        s = game["state"]
        s.update(phase="playing", trump="S", turn=0, trick=[], scores=[4, 2], round_no=4,
                 hands=[["AH"], ["10H"], ["2H"], ["3H"]], tens=[["10C", "10D"], ["10S"]],
                 tricks=[{"cards": [], "winner": w, "tens": []} for w in [1, 0] * 6], tricks_won=[6, 6],
                 rounds=[{"round": r, "winner_team": t, "type": "normal", "points": 1, "reason": "three_tens",
                          "tricks_won": [7, 6], "tens": [3, 1]} for r, t in ((1, 0), (2, 1), (3, 0))])
        s["scores"] = [4, 2]
        service._assign_turn_deadline(game)
        gid = game["id"]
        for seat, card in ((0, "AH"), (1, "10H"), (2, "2H"), (3, "3H")):
            assert await service.handle(uid_for(seat), {"game_id": gid, "action": "play", "card": card}) is None
        assert s["phase"] == "match_over" and s["winner_team"] == 0 and s["scores"] == [5, 2]
        assert game["status"] == "finished" and gid not in service.games
        assert len(db.matches.docs) == 1
        record = db.matches.docs[0]
        assert record["winner_team"] == 0 and record["scores"] == [5, 2] and record["game_id"] == gid
        assert (await db.games.find_one({"id": gid}))["status"] == "finished"
        assert sockets["u0"].states()[-1]["status"] == "finished"

        # Late or replayed actions and refreshes cannot add points or history rows.
        assert (await service.handle("u1", {"game_id": gid, "action": "forfeit"}))["type"] == "error"
        await service.get(gid)
        await service.get(gid)
        assert len(db.matches.docs) == 1
        winners = [u for u in db.users.docs if u["user_id"] in ("u0", "u2")]
        assert all(u["stats"].get("rounds_won") == 1 for u in winners)
        assert all(u["stats"].get("normal_wins") == 1 for u in winners)

    run(case())


def test_two_tens_seven_tricks_ends_the_round_mid_deal_and_is_persisted_and_broadcast():
    async def case():
        service, game, db, sockets = await new_game(target=5)
        s = game["state"]
        s.update(phase="playing", trump="S", turn=0, trick=[], scores=[0, 0],
                 hands=[["AC", "2D", "3D"], ["2C", "4D", "5D"], ["3C", "6D", "7D"], ["4C", "8D", "9D"]],
                 tens=[["10S", "10H"], ["10D"]],
                 tricks=[{"cards": [], "winner": w, "tens": []} for w in [1, 0, 2, 1, 0, 2, 3, 0, 2, 1]],
                 tricks_won=[6, 4])
        service._assign_turn_deadline(game)
        gid = game["id"]
        for seat, card in ((0, "AC"), (1, "2C"), (2, "3C"), (3, "4C")):
            assert await service.handle(uid_for(seat), {"game_id": gid, "action": "play", "card": card}) is None
        r = s["result"]
        assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (0, "normal", 1, "two_tens_seven_tricks")
        assert s["phase"] == "round_over" and s["scores"] == [1, 0] and len(s["tricks"]) == 11
        persisted = (await db.games.find_one({"id": gid}))["state"]
        assert persisted["result"] == r and persisted["scores"] == [1, 0] and persisted["phase"] == "round_over"
        assert game["turn_id"] is None and gid in service.timers  # next round scheduled, no turn timer
        for seat in range(4):
            last = sockets[uid_for(seat)].states()[-1]["state"]
            assert last["result"]["reason"] == "two_tens_seven_tricks" and last["scores"] == [1, 0]
            assert last["hand_counts"] == [2, 2, 2, 2]
        # Cards left in hand cannot be played after the round ended.
        reply = await service.handle("u0", {"game_id": gid, "action": "play", "card": "2D"})
        assert reply["type"] == "error" and len(s["tricks"]) == 11
        service.timers.pop(gid).cancel()

    run(case())


# ---------- round results: authoritative next-round deadline ----------

async def finished_round_game(now):
    service, game, db, sockets = await new_game(target=5, now=now)
    s = game["state"]
    s.update(phase="playing", trump="S", turn=0, trick=[], scores=[0, 0],
             hands=[["AC", "2D", "3D"], ["2C", "4D", "5D"], ["3C", "6D", "7D"], ["4C", "8D", "9D"]],
             tens=[["10S", "10H"], ["10D"]],
             tricks=[{"cards": [], "winner": w, "tens": []} for w in [1, 0, 2, 1, 0, 2, 3, 0, 2, 1]],
             tricks_won=[6, 4])
    service._assign_turn_deadline(game)
    for seat, card in ((0, "AC"), (1, "2C"), (2, "3C"), (3, "4C")):
        assert await service.handle(uid_for(seat), {"game_id": game["id"], "action": "play", "card": card}) is None
    assert s["phase"] == "round_over"
    return service, game, db, sockets


def test_round_over_has_one_persisted_deadline_shared_by_all_players_and_reconnects():
    async def case():
        now = [1_000_000.0]
        service, game, db, sockets = await finished_round_game(now)
        gid = game["id"]
        expected = game_service_module.utc_iso(now[0] + game_service_module.NEXT_ROUND_DELAY)
        assert game["next_round_at"] == expected
        assert (await db.games.find_one({"id": gid}))["next_round_at"] == expected
        for seat in range(4):
            message = sockets[uid_for(seat)].states()[-1]
            assert message["next_round_at"] == expected and message["state"]["phase"] == "round_over"
            assert message["state"]["result"]["captured_tens"] == [["10S", "10H"], ["10D"]]
        now[0] += 4  # a player reconnects partway through: same deadline, later server time
        again = service.view_for(game, "u2")
        assert again["next_round_at"] == expected and again["server_time"] == game_service_module.utc_iso(now[0])
        spectator = service.spectator_view(game)
        assert spectator["next_round_at"] == expected
        assert spectator["state"]["result"]["captured_tens"] == [["10S", "10H"], ["10D"]]
        service.timers.pop(gid).cancel()

    run(case())


def test_next_round_starts_once_at_the_deadline_and_clears_it(monkeypatch):
    async def case():
        now = [1_000_000.0]
        service, game, db, _ = await finished_round_game(now)
        gid = game["id"]
        service.timers.pop(gid).cancel()
        slept = []

        async def fake_sleep(delay):
            slept.append(delay)
            now[0] += delay

        monkeypatch.setattr(game_service_module.asyncio, "sleep", fake_sleep)
        now[0] += 3
        await service._next_round_later(gid)
        assert slept == [pytest.approx(game_service_module.NEXT_ROUND_DELAY - 3)]
        s = game["state"]
        assert s["round_no"] == 2 and s["phase"] == "trump_select" and game["next_round_at"] is None
        assert (await db.games.find_one({"id": gid}))["next_round_at"] is None
        assert service.view_for(game, "u0")["next_round_at"] is None
        # A duplicate or late timer for the old result does nothing.
        await service._next_round_later(gid)
        assert s["round_no"] == 2 and s["phase"] == "trump_select"

    run(case())


def test_stale_timer_for_an_older_deadline_cannot_create_a_round(monkeypatch):
    async def case():
        now = [1_000_000.0]
        service, game, _, _ = await finished_round_game(now)
        gid = game["id"]
        service.timers.pop(gid).cancel()

        async def swap_deadline_while_sleeping(delay):
            game["next_round_at"] = game_service_module.utc_iso(now[0] + 99)  # a different result's deadline

        monkeypatch.setattr(game_service_module.asyncio, "sleep", swap_deadline_while_sleeping)
        await service._next_round_later(gid)
        assert game["state"]["round_no"] == 1 and game["state"]["phase"] == "round_over"

    run(case())


def test_restart_resumes_only_the_remaining_results_time(monkeypatch):
    async def case():
        now = [1_000_000.0]
        service, game, db, _ = await finished_round_game(now)
        service.timers.pop(game["id"]).cancel()
        deadline = game["next_round_at"]
        now[0] += 6  # the process restarts six seconds into the pause
        delays = []

        async def record_sleep(delay):
            delays.append(delay)

        monkeypatch.setattr(game_service_module.asyncio, "sleep", record_sleep)
        restarted = GameService(db, Hub(), clock=lambda: now[0], schedule_turn_timers=False)
        await restarted.load_active()
        await restarted.timers[game["id"]]
        assert restarted.games[game["id"]]["next_round_at"] is None  # it then started the next round
        assert delays[0] == pytest.approx(game_service_module.NEXT_ROUND_DELAY - 6)
        assert deadline is not None

    run(case())


def test_round_saved_without_a_deadline_gets_one_on_restart(monkeypatch):
    async def case():
        now = [1_000_000.0]
        service, game, db, _ = await finished_round_game(now)
        service.timers.pop(game["id"]).cancel()
        stored = await db.games.find_one({"id": game["id"]})
        for doc in db.games.docs:
            doc.pop("next_round_at", None)
        restarted = GameService(db, Hub(), clock=lambda: now[0], schedule_turn_timers=False)

        async def never(delay):
            await asyncio.Event().wait()

        monkeypatch.setattr(game_service_module.asyncio, "sleep", never)
        await restarted.load_active()
        restored = restarted.games[game["id"]]
        assert restored["next_round_at"] == game_service_module.utc_iso(now[0] + game_service_module.NEXT_ROUND_DELAY)
        assert (await db.games.find_one({"id": game["id"]}))["next_round_at"] == restored["next_round_at"]
        restarted.timers.pop(game["id"]).cancel()
        assert stored["state"]["phase"] == "round_over"

    run(case())


# ---------- decision timers ----------

def decision_game(phase, deciding_team, trick_winner, bot_seats=(), now=None):
    now = now or [1_000_000.0]
    match = Match.new(dealer=3, target=7)
    match.select_trump(0, "S")
    s = match.s
    s.update(phase=phase, turn=trick_winner, trump="S")
    if phase == "koth_decision":
        s["koth_decision"] = deciding_team
    elif phase == "gs_decision":
        s["gs_eligible"] = deciding_team
    players = [{"user_id": f"u{seat}", "seat": seat, "team": seat % 2, "username": f"p{seat}",
                "is_bot": seat in bot_seats} for seat in range(4)]
    game = {"id": "decision-game", "room_code": "ROOM01", "is_public": False, "has_bots": bool(bot_seats),
            "players": players, "state": s, "status": "active", "turn_duration": 15,
            "created_at": "2026-11-26T10:00:00+00:00", "updated_at": "2026-11-26T10:00:00+00:00"}
    db = Database(users())
    service = GameService(db, Hub(), clock=lambda: now[0], schedule_turn_timers=False)
    service.games[game["id"]] = game
    service._assign_turn_deadline(game)
    db.games.docs.append(copy.deepcopy(game))
    return service, game, now


@pytest.mark.parametrize("phase", ["koth_decision", "gs_decision"])
def test_decision_timer_belongs_to_the_human_when_a_bot_won_the_trick(phase):
    service, game, _ = decision_game(phase, deciding_team=0, trick_winner=2, bot_seats=(2,))
    assert service.view_for(game, "u0")["turn_seat"] == 0
    assert service.spectator_view(game)["turn_seat"] == 0
    assert game["turn_id"].endswith(":0")


@pytest.mark.parametrize("phase", ["koth_decision", "gs_decision"])
def test_decision_timer_stays_with_the_trick_winner_for_all_human_and_all_bot_teams(phase):
    service, game, _ = decision_game(phase, deciding_team=1, trick_winner=3)
    assert service.view_for(game, "u1")["turn_seat"] == 3
    service, game, _ = decision_game(phase, deciding_team=1, trick_winner=3, bot_seats=(1, 3))
    assert service.view_for(game, "u0")["turn_seat"] == 3


def test_playing_and_trump_turn_seat_match_the_engine_actor():
    service, game, _ = decision_game("playing", deciding_team=None, trick_winner=2, bot_seats=(2,))
    assert service.view_for(game, "u0")["turn_seat"] == 2
    game["state"].update(phase="trump_select", trump_selector=1)
    assert service.view_for(game, "u0")["turn_seat"] == 1
    game["state"].update(phase="round_over")
    assert service.view_for(game, "u0")["turn_seat"] is None


async def expire(service, game, now):
    now[0] += game["turn_duration"] + TURN_GRACE_SECONDS + 1
    async with service.locks[game["id"]]:
        return await service._advance_turn_timer_locked(game)


def test_approved_rule_expired_koth_decision_declines_koth_and_never_forfeits():
    async def case():
        service, game, now = decision_game("koth_decision", deciding_team=0, trick_winner=2, bot_seats=(2,))
        assert await expire(service, game, now) == "auto_decision"
        s = game["state"]
        assert s.get("forfeited_by") is None and s["phase"] == "round_over"
        r = s["result"]
        assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (0, "normal", 1, "koth_declined")
        assert game["status"] == "active" and game["turn_id"] is None

    run(case())


def test_approved_rule_expired_grand_slam_decision_declines_and_play_continues():
    async def case():
        service, game, now = decision_game("gs_decision", deciding_team=0, trick_winner=2, bot_seats=(2,))
        assert await expire(service, game, now) == "auto_decision"
        s = game["state"]
        assert s.get("forfeited_by") is None and s["phase"] == "playing"
        assert s["gs_decided"] is True and s["gs_declared"] is None and s["turn"] == 2
        assert game["turn_id"] and game["turn_phase"] == "normal"  # the next turn gets a fresh timer

    run(case())


def test_approved_rule_expired_grand_slam_after_automatic_koth_sweep_scores_the_koth():
    async def case():
        service, game, now = decision_game("gs_decision", deciding_team=1, trick_winner=3)
        game["state"]["auto_koth_pending"] = 1
        assert await expire(service, game, now) == "auto_decision"
        r = game["state"]["result"]
        assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, "koth", 2, "automatic_koth")

    run(case())


def test_approved_rule_expired_trump_selection_picks_the_strongest_suit_and_never_forfeits():
    async def case():
        now = [1_000_000.0]
        service, game, _, _ = await new_game(now=now)
        first_five = list(game["state"]["hands"][1])
        expected = game_service_module.bots.choose_trump(first_five)
        now[0] += game["turn_duration"] + TURN_GRACE_SECONDS + 1
        # A racing action from the selector after expiry is not applied on top of the default.
        reply = await service.handle("u1", {"game_id": game["id"], "action": "select_trump", "suit": "X"})
        assert reply == {"type": "error", "message": "Turn expired. The default choice was made automatically."}
        s = game["state"]
        assert s.get("forfeited_by") is None and s["trump"] == expected and s["phase"] == "playing"
        assert [len(h) for h in s["hands"]] == [13] * 4 and s["turn"] == 1

    run(case())
