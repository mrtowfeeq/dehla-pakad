"""Rule-scenario coverage for the authoritative engine, checked against the documented rules in AGENTS.md.

Tests named "current_behaviour" / "approved_rule" pin rule interactions the original written rules left
open; they were confirmed by the project owner on 2026-11-26 and are now documented in AGENTS.md.
Changing them requires explicit rule approval, not just a code change.
"""
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import (  # noqa: E402
    GRAND_SLAM, KOTH, NORMAL, POINTS, GameError, Match, deck_for_hands, is_ten, legal_cards, new_deck,
    partner, right_of, team_of,
)


def fake_tricks(winners):
    return [{"cards": [], "winner": w, "tens": []} for w in winners]


def crafted(hands, *, trump="S", leader=0, dealer=3, tens=None, winners=(), scores=None, target=10, koth=None):
    m = Match.new(dealer=dealer, target=target)
    s = m.s
    s.update(hands=[list(h) for h in hands], trump=trump, phase="playing", turn=leader, trick=[],
             tens=[list(t) for t in (tens or [[], []])], tricks=fake_tricks(winners), scores=list(scores or [0, 0]),
             koth=koth)
    s["tricks_won"] = [sum(1 for w in winners if team_of(w) == k) for k in (0, 1)]
    return m


def play_trick(m, cards):
    for card in cards:
        m.play(m.s["turn"], card)


SWEEP_SIX = [0, 2, 0, 2, 0, 2]  # team 0 won tricks 1-6


# ---------- dealing, trump selection, turn order ----------

@pytest.mark.parametrize("dealer", range(4))
def test_deal_sequence_is_5_4_4_starting_right_of_dealer_for_every_dealer(dealer):
    deck = new_deck()
    hands = [deck[i * 13:(i + 1) * 13] for i in range(4)]
    m = Match.new(dealer=dealer, target=5, deck=deck_for_hands(hands, dealer))
    selector = right_of(dealer)
    assert m.s["trump_selector"] == selector
    for seat in range(4):
        assert m.s["hands"][seat] == hands[seat][:5]
    # Before trump is chosen nobody has more than five cards and no card can be played.
    for seat in range(4):
        view = m.view(seat)
        assert view["hand_counts"] == [5, 5, 5, 5] and view["legal"] == [] and view["trump"] is None
    with pytest.raises(GameError):
        m.play(selector, m.s["hands"][selector][0])
    m.select_trump(selector, "H")
    for seat in range(4):
        assert m.s["hands"][seat] == hands[seat]
    assert m.s["deck"] == [] and m.s["turn"] == selector and m.s["phase"] == "playing"


def test_trump_can_only_be_selected_once_and_must_be_a_real_suit():
    m = Match.new(dealer=0, target=5)
    with pytest.raises(GameError):
        m.select_trump(1, "X")
    with pytest.raises(GameError):
        m.select_trump(1, "")
    m.select_trump(1, "C")
    with pytest.raises(GameError):
        m.select_trump(1, "H")
    assert m.s["trump"] == "C" and sum(len(h) for h in m.s["hands"]) == 52


def test_play_moves_to_the_right_and_trick_winner_leads_next():
    hands = [["2H", "AC"], ["3H", "2C"], ["AH", "3C"], ["4H", "4C"]]
    m = crafted(hands, trump="S", leader=1)
    order = []
    for _ in range(4):
        order.append(m.s["turn"])
        m.play(m.s["turn"], next(c for c in m.s["hands"][m.s["turn"]] if c.endswith("H")))
    assert order == [1, 2, 3, 0]
    assert m.s["last_trick"]["winner"] == 2 and m.s["turn"] == 2


def test_lead_suit_must_be_followed_even_when_holding_trump():
    hands = [["KD", "5C"], ["2D", "AS"], ["3C", "4C"], ["9D", "6C"]]
    m = crafted(hands, trump="S")
    m.play(0, "KD")
    assert legal_cards(m.s["hands"][1], m.s["trick"]) == ["2D"]
    with pytest.raises(GameError):
        m.play(1, "AS")


def test_low_trump_beats_lead_suit_ace_and_off_suit_discard_never_wins():
    hands = [["KD"], ["2S"], ["AD"], ["AC"]]
    m = crafted(hands, trump="S")
    play_trick(m, ["KD", "2S", "AD", "AC"])
    assert m.s["last_trick"]["winner"] == 1


def test_trump_lead_is_won_by_the_highest_trump():
    hands = [["5S"], ["AH"], ["QS"], ["2S"]]
    m = crafted(hands, trump="S")
    play_trick(m, ["5S", "AH", "QS", "2S"])
    assert m.s["last_trick"]["winner"] == 2


# ---------- tens and Koth ----------

def test_three_tens_in_one_trick_with_fourth_held_by_opponents_is_a_normal_win():
    hands = [["10H"], ["AH"], ["10D"], ["10C"]]
    m = crafted(hands, trump="S", tens=[["10S"], []], winners=[0])
    play_trick(m, ["10H", "AH", "10D", "10C"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, NORMAL, 1, "three_tens")


def test_three_tens_in_one_trick_with_fourth_unclaimed_offers_koth():
    hands = [["10H", "2C"], ["AH", "3C"], ["10D", "4C"], ["10C", "5D"]]
    m = crafted(hands, trump="S", winners=[1])
    play_trick(m, ["10H", "AH", "10D", "10C"])
    assert m.s["phase"] == "koth_decision" and m.s["koth_decision"] == 1 and m.s["result"] is None


def test_three_tens_taken_by_a_team_already_holding_one_is_automatic_koth():
    # Team 1 already holds one ten and takes three more: the 3rd and 4th land in the same trick.
    m = crafted([["10H"], ["AH"], ["10D"], ["10C"]], trump="S", tens=[[], ["10S"]], winners=[1], leader=1)
    play_trick(m, ["AH", "10D", "10C", "10H"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, KOTH, 2, "automatic_koth")


def test_all_four_tens_in_one_trick_is_automatic_koth():
    m = crafted([["10H"], ["10S"], ["10D"], ["10C"]], trump="S")
    play_trick(m, ["10H", "10S", "10D", "10C"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, KOTH, 2, "automatic_koth")


def test_koth_decision_blocks_every_other_action_and_can_only_be_made_once():
    hands = [["10H", "2C"], ["AH", "3C"], ["4H", "4C"], ["5H", "5C"]]
    m = crafted(hands, trump="S", tens=[[], ["10C", "10D"]], winners=[1, 0])
    play_trick(m, ["10H", "AH", "4H", "5H"])
    assert m.s["phase"] == "koth_decision"
    for seat in range(4):
        with pytest.raises(GameError):
            m.play(seat, m.s["hands"][seat][0])
        with pytest.raises(GameError):
            m.grand_slam_decide(seat, True)
    with pytest.raises(GameError):
        m.koth_decide(2, True)  # opponents
    m.koth_decide(3, True)       # partner of the trick winner may decide
    with pytest.raises(GameError):
        m.koth_decide(1, False)  # no second decision
    assert m.s["koth"] == 1 and m.s["phase"] == "playing" and m.s["turn"] == 1


def test_declared_koth_ignores_non_ten_tricks_until_the_fourth_ten_falls():
    hands = [["2C", "10S"], ["AC", "AS"], ["3C", "2S"], ["4C", "3S"]]
    m = crafted(hands, trump="H", tens=[[], ["10C", "10D", "10H"]], winners=[1, 1, 1], koth=1, leader=1)
    play_trick(m, ["AC", "3C", "4C", "2C"])
    assert m.s["phase"] == "playing" and m.s["result"] is None
    play_trick(m, ["AS", "2S", "3S", "10S"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, KOTH, 2, "koth_fourth_ten")


# ---------- Grand Slam / 13 Mann ----------

def _sweep_trick7(third_ten=False, both_last_tens=False):
    """Team 0 wins tricks 1-6; seat 0 leads trick 7 and wins it."""
    lead = "10H" if third_ten or both_last_tens else "AH"
    hands = [[lead, "AC"], ["2H", "2C"], ["10C" if both_last_tens else "3H", "3C"], ["4H", "4C"]]
    tens = [["10S", "10D"], []] if (third_ten or both_last_tens) else [["10S"], []]
    m = crafted(hands, trump="S", tens=tens, winners=SWEEP_SIX)
    play_trick(m, [lead, "2H", hands[2][0], "4H"])
    return m


def test_grand_slam_peek_is_only_for_the_eligible_team_and_only_during_the_decision():
    m = _sweep_trick7()
    assert m.s["phase"] == "gs_decision" and m.s["gs_eligible"] == 0
    assert set(m.view(0)["partner_hand"]) == set(m.s["hands"][2])
    assert set(m.view(2)["partner_hand"]) == set(m.s["hands"][0])
    assert m.view(1)["partner_hand"] is None and m.view(3)["partner_hand"] is None
    assert m.view(None)["partner_hand"] is None
    for seat in range(4):
        with pytest.raises(GameError):
            m.play(seat, m.s["hands"][seat][0])
    with pytest.raises(GameError):
        m.grand_slam_decide(1, True)
    m.grand_slam_decide(2, False)
    with pytest.raises(GameError):
        m.grand_slam_decide(0, True)  # declining means no second chance
    assert all(m.view(seat)["partner_hand"] is None for seat in range(4))
    assert m.s["gs_declared"] is None and m.s["phase"] == "playing"


def test_koth_on_trick_seven_then_declare_koth_leads_to_grand_slam_offer():
    m = _sweep_trick7(third_ten=True)
    assert m.s["phase"] == "koth_decision" and m.s["gs_pending"] is True
    m.koth_decide(0, True)
    assert m.s["phase"] == "gs_decision" and m.s["gs_eligible"] == 0 and m.s["koth"] == 0
    m.grand_slam_decide(0, True)
    assert m.s["gs_declared"] == 0 and m.s["koth"] is None


def test_current_behaviour_declining_koth_on_trick_seven_ends_round_without_grand_slam_offer():
    m = _sweep_trick7(third_ten=True)
    m.koth_decide(2, False)
    r = m.s["result"]
    assert (r["type"], r["points"], r["reason"]) == (NORMAL, 1, "koth_declined")
    assert m.s["phase"] == "round_over" and m.s["gs_eligible"] is None


def test_approved_rule_trick_seven_sweep_with_automatic_koth_is_offered_grand_slam_first():
    m = _sweep_trick7(both_last_tens=True)
    assert m.s["phase"] == "gs_decision" and m.s["gs_eligible"] == 0 and m.s["result"] is None
    assert m.s["auto_koth_pending"] == 0 and m.view(0)["auto_koth_pending"] == 0
    assert set(m.view(2)["partner_hand"]) == set(m.s["hands"][0])
    with pytest.raises(GameError):
        m.grand_slam_decide(1, False)


def test_approved_rule_declining_that_grand_slam_settles_the_automatic_koth():
    m = _sweep_trick7(both_last_tens=True)
    m.grand_slam_decide(2, False)
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (0, KOTH, 2, "automatic_koth")
    assert m.s["scores"] == [2, 0] and m.s["auto_koth_pending"] is None and m.s["phase"] == "round_over"


def test_approved_rule_declaring_that_grand_slam_replaces_the_automatic_koth():
    m = _sweep_trick7(both_last_tens=True)
    m.grand_slam_decide(0, True)
    assert m.s["gs_declared"] == 0 and m.s["koth"] is None and m.s["auto_koth_pending"] is None
    assert m.s["phase"] == "playing" and m.s["result"] is None and m.s["turn"] == 0
    # Losing the next trick now fails the Grand Slam instead of scoring the Koth.
    m.s["hands"] = [["2D"], ["AD"], ["3D"], ["4D"]]
    play_trick(m, ["2D", "AD", "3D", "4D"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, GRAND_SLAM, 3, "grand_slam_failed")


def test_automatic_koth_on_trick_seven_without_a_sweep_still_ends_the_round_at_once():
    hands = [["10H", "AC"], ["2H", "2C"], ["10C", "3C"], ["4H", "4C"]]
    m = crafted(hands, trump="S", tens=[["10S", "10D"], []], winners=[1, 0, 2, 0, 2, 0])
    play_trick(m, ["10H", "2H", "10C", "4H"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["reason"]) == (0, KOTH, "automatic_koth")
    assert m.s["gs_eligible"] is None and m.s.get("auto_koth_pending") is None


def test_koth_declared_before_trick_seven_survives_a_declined_grand_slam():
    hands = [["AH", "AC", "10C"], ["2H", "2C", "3D"], ["3H", "3C", "4D"], ["4H", "4C", "5D"]]
    m = crafted(hands, trump="S", tens=[["10S", "10D", "10H"], []], winners=SWEEP_SIX, koth=0)
    play_trick(m, ["AH", "2H", "3H", "4H"])
    assert m.s["phase"] == "gs_decision"
    m.grand_slam_decide(0, False)
    assert m.s["koth"] == 0 and m.s["phase"] == "playing"
    play_trick(m, ["AC", "2C", "3C", "4C"])
    assert m.s["phase"] == "playing"
    play_trick(m, ["10C", "3D", "4D", "5D"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["reason"]) == (0, KOTH, "koth_fourth_ten")


def test_declared_grand_slam_ignores_tens_and_scores_exactly_three_points():
    # Team 0 declared Grand Slam after 7 tricks and captures the last two tens on the way to 13.
    # Without the declaration, the 3rd and 4th tens would have ended the round as Koth.
    hands = [["AH", "KH", "QH", "JH", "9H", "8H"], ["2C", "3C", "4C", "5C", "6C", "10C"],
             ["2D", "3D", "4D", "5D", "6D", "10D"], ["7C", "8C", "9C", "JC", "QC", "KC"]]
    m = crafted(hands, trump="H", tens=[["10S", "10H"], []], winners=[0, 2, 0, 2, 0, 2, 0], scores=[2, 4])
    m.s["gs_eligible"] = m.s["gs_declared"] = 0
    m.s["gs_decided"] = True
    for _ in range(24):
        seat = m.s["turn"]
        m.play(seat, legal_cards(m.s["hands"][seat], m.s["trick"])[-1])
        if m.s["phase"] != "playing":
            break
    assert len(m.s["tricks"]) == 13 and len(m.s["tens"][0]) == 4
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (0, GRAND_SLAM, 3, "grand_slam")
    assert m.s["scores"] == [5, 4]


def test_grand_slam_failure_on_the_last_trick_awards_opponents_three_points():
    m = crafted([["2H"], ["AH"], ["3H"], ["4H"]], trump="S", tens=[["10S", "10H"], ["10D", "10C"]],
                winners=[0, 2] * 6)
    m.s["gs_eligible"] = m.s["gs_declared"] = 0
    play_trick(m, ["2H", "AH", "3H", "4H"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, GRAND_SLAM, 3, "grand_slam_failed")
    assert m.s["scores"] == [0, 3]


# ---------- equal tens, round and match lifecycle ----------

@pytest.mark.parametrize("winner_team", [0, 1])
def test_two_tens_each_goes_to_the_team_with_seven_tricks(winner_team):
    # 12 tricks split 6-6 (first trick to team 1 so no Grand Slam streak); trick 13 decides it.
    prior = [1, 0] * 6
    hands = [["AH"], ["2H"], ["3H"], ["4H"]] if winner_team == 0 else [["2H"], ["AH"], ["3H"], ["4H"]]
    m = crafted(hands, trump="S", tens=[["10S", "10H"], ["10D", "10C"]], winners=prior)
    play_trick(m, [h[0] for h in hands])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (winner_team, NORMAL, 1, "equal_tens")
    assert r["tricks_won"][winner_team] == 7


def test_approved_rule_two_two_tens_ends_the_round_the_moment_a_team_reaches_seven_tricks():
    # Tens already 2-2; team 0 has 6 tricks after 9 played. Trick 10 gives team 0 its seventh.
    hands = [["AH", "AC", "AD"], ["2H", "2C", "2D"], ["3H", "3C", "3D"], ["4H", "4C", "4D"]]
    m = crafted(hands, trump="S", tens=[["10S", "10H"], ["10D", "10C"]], winners=[1, 0, 2, 1, 3, 0, 2, 0, 2])
    assert m.s["tricks_won"] == [6, 3]
    play_trick(m, ["AH", "2H", "3H", "4H"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (0, NORMAL, 1, "equal_tens")
    assert r["tricks_won"] == [7, 3] and len(m.s["tricks"]) == 10 and m.s["phase"] == "round_over"
    assert m.s["scores"] == [1, 0]
    # The remaining three tricks are never played.
    for seat in range(4):
        with pytest.raises(GameError):
            m.play(seat, m.s["hands"][seat][0])
    assert [len(h) for h in m.s["hands"]] == [2, 2, 2, 2]


def test_approved_rule_tens_becoming_two_two_after_seven_tricks_ends_the_round_on_that_trick():
    # Team 1 already has seven tricks; this trick gives team 0 its second ten, making the split 2-2.
    hands = [["10H", "AC"], ["2H", "2C"], ["AH", "3C"], ["4H", "4C"]]
    m = crafted(hands, trump="S", tens=[["10S"], ["10D", "10C"]], winners=[1, 3, 1, 3, 1, 3, 1, 0])
    assert m.s["tricks_won"] == [1, 7]
    play_trick(m, ["10H", "2H", "AH", "4H"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["reason"]) == (1, NORMAL, "equal_tens")
    assert r["tricks_won"] == [2, 7] and len(m.s["tricks"]) == 9


def test_two_two_tens_continue_until_a_team_reaches_seven_tricks():
    hands = [["AH", "AC"], ["2H", "2C"], ["3H", "3C"], ["4H", "4C"]]
    m = crafted(hands, trump="S", tens=[["10S", "10H"], ["10D", "10C"]], winners=[1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
    assert m.s["tricks_won"] == [5, 5]
    play_trick(m, ["AH", "2H", "3H", "4H"])
    assert m.s["phase"] == "playing" and m.s["result"] is None and m.s["tricks_won"] == [6, 5]
    play_trick(m, ["AC", "2C", "3C", "4C"])
    assert m.s["result"]["reason"] == "equal_tens" and m.s["result"]["winner_team"] == 0
    assert len(m.s["tricks"]) == 12


# ---------- two tens + seven tricks while the opponents hold a ten ----------

def _assert_two_tens_win(m, team, tricks_played):
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (team, NORMAL, 1, "two_tens_seven_tricks")
    assert m.s["phase"] == "round_over" and len(m.s["tricks"]) == tricks_played
    assert m.s["scores"][team] == 1 and m.s["scores"][1 - team] == 0
    for seat in range(4):  # the remaining tricks are never played
        with pytest.raises(GameError):
            m.play(seat, m.s["hands"][seat][0])


@pytest.mark.parametrize("team", [0, 1])
def test_approved_rule_seventh_trick_after_the_second_ten_wins_immediately(team):
    # The team already holds two tens (opponents one, one unclaimed) and wins its seventh trick.
    leader = team  # seat 0 for team 0, seat 1 for team 1
    winners = [team, team + 2, 1 - team, team, team + 2, 1 - team, team, 3 - team, team + 2]  # 6 for team
    tens = [["10S", "10H"], ["10D"]] if team == 0 else [["10D"], ["10S", "10H"]]
    hands = [["2C", "2D"], ["3C", "3D"], ["4C", "4D"], ["5C", "5D"]]
    hands[leader] = ["AC", "2D"]
    m = crafted(hands, trump="S", tens=tens, winners=winners, leader=leader)
    assert m.s["tricks_won"][team] == 6
    for _ in range(4):
        seat = m.s["turn"]
        m.play(seat, legal_cards(m.s["hands"][seat], m.s["trick"])[0])
    _assert_two_tens_win(m, team, 10)


@pytest.mark.parametrize("team", [0, 1])
def test_approved_rule_second_ten_after_seven_tricks_wins_immediately(team):
    # The team already has seven tricks and one ten; the opponents hold one. It now takes its second ten.
    leader = team
    winners = [team, team + 2] * 3 + [team, 1 - team]  # 7 tricks for team, 1 for the opponents
    tens = [["10S"], ["10D"]] if team == 0 else [["10D"], ["10S"]]
    hands = [["2C", "2D"], ["3C", "3D"], ["4C", "4D"], ["5C", "5D"]]
    hands[leader] = ["10C", "2D"]
    hands[(leader + 1) % 4] = ["9C", "3D"]
    hands[(leader + 2) % 4] = ["8C", "4D"]
    hands[(leader + 3) % 4] = ["7C", "5D"]
    m = crafted(hands, trump="S", tens=tens, winners=winners, leader=leader)
    assert m.s["tricks_won"][team] == 7
    play_trick(m, ["10C", "9C", "8C", "7C"])
    assert len(m.s["tens"][team]) == 2
    _assert_two_tens_win(m, team, 9)


@pytest.mark.parametrize("team", [0, 1])
def test_approved_rule_opponents_first_ten_ends_the_round_for_the_team_with_two_tens_and_seven_tricks(team):
    # The team has two tens and seven tricks while the opponents had none; the opponents then win a ten.
    opponent_seat = 1 - team
    winners = [team, team + 2] * 3 + [team]
    tens = [["10S", "10H"], []] if team == 0 else [[], ["10S", "10H"]]
    hands = [["2C", "2D"], ["3C", "3D"], ["4C", "4D"], ["5C", "5D"]]
    hands[opponent_seat] = ["AC", "9H"]
    hands[(opponent_seat + 1) % 4] = ["10C", "9D"]
    m = crafted(hands, trump="S", tens=tens, winners=winners, leader=opponent_seat)
    play_trick(m, [m.s["hands"][s][0] for s in [(opponent_seat + i) % 4 for i in range(4)]])
    assert len(m.s["tens"][1 - team]) == 1 and m.s["last_trick"]["winner"] == opponent_seat
    _assert_two_tens_win(m, team, 8)


@pytest.mark.parametrize("team", [0, 1])
def test_two_tens_and_seven_tricks_with_opponents_on_zero_tens_keeps_playing_and_koth_stays_possible(team):
    winners = [team, team + 2] * 3 + [team, team + 2]  # eight tricks, opponents have none
    tens = [["10S", "10H"], []] if team == 0 else [[], ["10S", "10H"]]
    hands = [["2C", "2D", "2H"], ["3C", "3D", "3H"], ["4C", "4D", "4H"], ["5C", "5D", "5H"]]
    hands[team] = ["AC", "9D", "9H"]
    m = crafted(hands, trump="S", tens=tens, winners=winners, leader=team)
    m.s["gs_decided"] = True
    # A trick without tens: nothing ends.
    for _ in range(4):
        seat = m.s["turn"]
        m.play(seat, legal_cards(m.s["hands"][seat], m.s["trick"])[0])
    assert m.s["phase"] == "playing" and m.s["result"] is None and m.s["tricks_won"][team] == 9
    # Capturing the third ten with the opponents still on zero is a Koth decision, exactly as before.
    leader = m.s["turn"]
    m.s["hands"][leader] = ["AD"] + m.s["hands"][leader][1:]
    m.s["hands"][(leader + 1) % 4] = ["10D"] + m.s["hands"][(leader + 1) % 4][1:]
    for _ in range(4):
        seat = m.s["turn"]
        m.play(seat, legal_cards(m.s["hands"][seat], m.s["trick"])[0])
    assert m.s["phase"] == "koth_decision" and m.s["koth_decision"] == team and m.s["result"] is None


def test_two_two_split_keeps_the_equal_tens_reason():
    hands = [["AH", "2C"], ["2H", "3C"], ["3H", "4C"], ["4H", "5C"]]
    m = crafted(hands, trump="S", tens=[["10S", "10H"], ["10D", "10C"]], winners=[1, 0, 1, 0, 1, 0, 2, 0, 3, 0, 1])
    assert m.s["tricks_won"] == [6, 5]
    play_trick(m, ["AH", "2H", "3H", "4H"])
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["reason"]) == (0, NORMAL, "equal_tens")


def test_declared_koth_is_never_cut_short_by_the_two_tens_condition():
    # Koth team holds three tens and passes seven tricks; only the fourth ten ends the round.
    hands = [["AC", "AD", "2H"], ["2C", "2D", "10H"], ["3C", "3D", "3H"], ["4C", "4D", "4H"]]
    m = crafted(hands, trump="S", tens=[["10S", "10D", "10C"], []], winners=[1, 0, 2, 0, 2, 0, 2], koth=0, leader=0)
    m.s["gs_decided"] = True
    play_trick(m, ["AC", "2C", "3C", "4C"])
    play_trick(m, ["AD", "2D", "3D", "4D"])
    assert m.s["tricks_won"][0] == 8 and m.s["phase"] == "playing" and m.s["result"] is None
    play_trick(m, ["2H", "10H", "3H", "4H"])  # opponents capture the fourth ten
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (1, KOTH, 2, "koth_fourth_ten")


def test_grand_slam_offer_and_declared_grand_slam_are_unchanged():
    # A trick-7 sweep is still offered Grand Slam (opponents have no tens, so the new rule cannot fire).
    m = _sweep_trick7()
    assert m.s["phase"] == "gs_decision"
    m.grand_slam_decide(0, True)
    # Declared Grand Slam ignores tens entirely: even with two tens and 8 tricks play goes on to 13.
    m.s["tens"] = [["10S", "10H"], ["10D"]]  # artificial: GS logic must not consult the ten split
    m.s["hands"] = [["KH", "QH"], ["2H", "3H"], ["4H", "5H"], ["6H", "7H"]]
    play_trick(m, ["KH", "2H", "4H", "6H"])
    assert m.s["phase"] == "playing" and m.s["result"] is None and m.s["tricks_won"][0] == 8


def test_after_a_declined_grand_slam_the_sweep_team_wins_once_opponents_take_a_ten():
    hands = [["AH", "AC", "2D"], ["2H", "2C", "AD"], ["3H", "3C", "10C"], ["4H", "4C", "3D"]]
    m = crafted(hands, trump="S", tens=[["10S", "10H"], []], winners=SWEEP_SIX)
    play_trick(m, ["AH", "2H", "3H", "4H"])
    assert m.s["phase"] == "gs_decision"
    m.grand_slam_decide(0, False)
    play_trick(m, ["AC", "2C", "3C", "4C"])
    assert m.s["phase"] == "playing" and m.s["tricks_won"] == [8, 0]
    m.s["turn"] = 1  # opponents lead and capture a ten
    m.s["hands"] = [["2D"], ["AD"], ["10D"], ["3D"]]
    play_trick(m, ["AD", "10D", "3D", "2D"])
    assert m.s["tens"][1] == ["10D"]
    r = m.s["result"]
    assert (r["winner_team"], r["type"], r["points"], r["reason"]) == (0, NORMAL, 1, "two_tens_seven_tricks")


def test_round_result_records_exactly_which_tens_each_team_captured_and_keeps_them_in_history():
    hands = [["10H", "AC"], ["AH", "2C"], ["4H", "3C"], ["5H", "4C"]]
    m = crafted(hands, trump="S", tens=[["10S"], ["10C", "10D"]], winners=[1, 0, 1])
    play_trick(m, ["10H", "AH", "4H", "5H"])
    r = m.s["result"]
    assert r["captured_tens"] == [["10S"], ["10C", "10D", "10H"]]
    assert m.s["rounds"][-1]["captured_tens"] == [["10S"], ["10C", "10D", "10H"]]
    # The snapshot is a copy: the next round's fresh ten lists never alter the stored result.
    m.next_round()
    assert m.s["tens"] == [[], []]
    assert m.s["rounds"][-1]["captured_tens"] == [["10S"], ["10C", "10D", "10H"]]
    # Scoring is unchanged by the snapshot.
    assert (m.s["rounds"][-1]["type"], m.s["rounds"][-1]["points"], m.s["scores"]) == (NORMAL, 1, [0, 1])


def test_early_ending_reports_uncaptured_tens_as_missing_from_both_teams():
    hands = [["AC", "2D", "10C"], ["2C", "4D", "5D"], ["3C", "6D", "7D"], ["4C", "8D", "9D"]]
    m = crafted(hands, trump="S", tens=[["10S", "10H"], ["10D"]], winners=[1, 0, 2, 1, 0, 2, 3, 0, 2, 1])
    play_trick(m, ["AC", "2C", "3C", "4C"])
    r = m.s["result"]
    assert r["reason"] == "two_tens_seven_tricks"
    assert r["captured_tens"] == [["10S", "10H"], ["10D"]]
    assert "10C" in m.s["hands"][0]  # still in a hand, so it belongs to neither team


def test_no_action_is_accepted_between_rounds_and_next_round_resets_round_state():
    m = crafted([["10H"], ["AH"], ["4H"], ["5H"]], trump="S", tens=[["10S"], ["10C", "10D"]], winners=[1, 0, 1])
    play_trick(m, ["10H", "AH", "4H", "5H"])
    assert m.s["phase"] == "round_over"
    seq = m.s["seq"]
    for call in (lambda: m.play(m.s["result"]["next_dealer"], "2C"), lambda: m.select_trump(0, "S"),
                 lambda: m.koth_decide(1, True), lambda: m.grand_slam_decide(1, True)):
        with pytest.raises(GameError):
            call()
    m.next_round()
    s = m.s
    assert s["round_no"] == 2 and s["phase"] == "trump_select" and s["seq"] > seq
    assert s["tens"] == [[], []] and s["tricks"] == [] and s["tricks_won"] == [0, 0]
    assert s["koth"] is None and s["gs_declared"] is None and s["gs_eligible"] is None
    assert s["scores"] == [0, 1] and [len(h) for h in s["hands"]] == [5] * 4
    with pytest.raises(GameError):
        m.next_round()


def test_match_over_is_final():
    m = crafted([["10H"], ["AH"], ["4H"], ["5H"]], trump="S", tens=[["10S"], ["10C", "10D"]],
                winners=[1, 0, 1], scores=[0, 4], target=5)
    play_trick(m, ["10H", "AH", "4H", "5H"])
    assert m.s["phase"] == "match_over" and m.s["winner_team"] == 1
    with pytest.raises(GameError):
        m.forfeit(0)
    with pytest.raises(GameError):
        m.next_round()
    with pytest.raises(GameError):
        m.cancel(0)
    assert m.s["scores"] == [0, 5]


# ---------- randomized whole-match invariants ----------

def _random_match(seed):
    rng = random.Random(seed)
    m = Match.new(dealer=rng.randrange(4), target=rng.choice([5, 7, 10]))
    seen_seq = m.s["seq"]
    rounds_checked = 0
    while m.s["phase"] != "match_over":
        s = m.s
        if s["phase"] == "trump_select":
            assert [len(h) for h in s["hands"]] == [5] * 4
            m.select_trump(s["trump_selector"], rng.choice("SHDC"))
            assert sorted(sum(s["hands"], [])) == sorted(new_deck())
        elif s["phase"] == "playing":
            seat = s["turn"]
            for other in range(4):
                if other != seat:
                    with pytest.raises(GameError):
                        m.play(other, s["hands"][other][0]) if s["hands"][other] else m.play(other, "AS")
            legal = legal_cards(s["hands"][seat], s["trick"])
            assert legal and set(legal) <= set(s["hands"][seat])
            m.play(seat, rng.choice(legal))
        elif s["phase"] == "koth_decision":
            m.koth_decide(s["koth_decision"] + 2 * rng.randrange(2), rng.random() < 0.5)
        elif s["phase"] == "gs_decision":
            m.grand_slam_decide(s["gs_eligible"] + 2 * rng.randrange(2), rng.random() < 0.3)
        elif s["phase"] == "round_over":
            r = s["result"]
            assert r["points"] == POINTS[r["type"]]
            # Which-ten snapshot: exactly the engine's own ownership lists; with the cards still in
            # hands, every ten is accounted for exactly once.
            assert r["captured_tens"] == s["tens"] and s["rounds"][-1]["captured_tens"] == s["tens"]
            assert [len(t) for t in r["captured_tens"]] == r["tens"]
            in_hands = [c for h in s["hands"] for c in h if is_ten(c)]
            accounted = r["captured_tens"][0] + r["captured_tens"][1] + in_hands
            assert sorted(accounted) == sorted(["10S", "10H", "10D", "10C"])
            played = [c for t in s["tricks"] for _, c in t["cards"]]
            assert len(played) == len(set(played)) == 4 * len(s["tricks"])
            tens = s["tens"][0] + s["tens"][1]
            assert sorted(tens) == sorted(c for c in played if is_ten(c))
            if r["reason"] in ("equal_tens", "two_tens_seven_tricks"):
                w = r["winner_team"]
                tens_now = [len(t) for t in s["tens"]]
                assert r["type"] == NORMAL and tens_now[w] >= 2 and tens_now[1 - w] >= 1
                assert (tens_now == [2, 2]) == (r["reason"] == "equal_tens")
                assert s["tricks_won"][w] >= 7 > s["tricks_won"][1 - w]
                # The round ends on the first trick where the condition holds for either team.
                last = s["tricks"][-1]
                prev_won = list(s["tricks_won"])
                prev_won[team_of(last["winner"])] -= 1
                prev_tens = list(tens_now)
                prev_tens[team_of(last["winner"])] -= len(last["tens"])
                assert not any(prev_tens[t] >= 2 and prev_tens[1 - t] >= 1 and prev_won[t] >= 7 for t in (0, 1))
                assert all(len(h) == 13 - len(s["tricks"]) for h in s["hands"])
            if r["type"] == GRAND_SLAM and r["reason"] == "grand_slam":
                assert s["tricks_won"][r["winner_team"]] == 13
            rounds_checked += 1
            m.next_round()
        assert m.s["seq"] >= seen_seq
        seen_seq = m.s["seq"]
    s = m.s
    assert sum(r["points"] for r in s["rounds"]) == sum(s["scores"])
    assert s["scores"][s["winner_team"]] >= s["target"] > s["scores"][1 - s["winner_team"]]
    return rounds_checked


@pytest.mark.parametrize("seed", range(40))
def test_random_matches_respect_scoring_and_card_invariants(seed):
    assert _random_match(seed) >= 0


def test_partner_helper_and_teams_are_opposite_seats():
    for seat in range(4):
        assert team_of(partner(seat)) == team_of(seat) and team_of(right_of(seat)) != team_of(seat)
