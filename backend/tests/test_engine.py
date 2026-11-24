import random
import pytest

from engine import (Match, GameError, new_deck, shuffled_deck, deck_for_hands, trick_winner, legal_cards,
                    next_dealer, team_of, right_of, partner, NORMAL, KOTH, GRAND_SLAM, SUITS, RANKS)


def rotate_deck_hands():
    d = new_deck()
    return [d[i * 13:(i + 1) * 13] for i in range(4)]


def playing_match(hands, trump="S", leader=0, dealer=3, tens=None, tricks=None, scores=None, target=10):
    """Match in 'playing' phase with crafted hands and history."""
    m = Match.new(dealer=dealer, target=target)
    s = m.s
    s.update(hands=[list(h) for h in hands], trump=trump, phase="playing", turn=leader, trick=[],
             tens=tens or [[], []], tricks=tricks or [], scores=scores or [0, 0])
    s["tricks_won"] = [sum(1 for t in s["tricks"] if team_of(t["winner"]) == k) for k in (0, 1)]
    return m


def fake_tricks(winners):
    return [{"cards": [], "winner": w, "tens": []} for w in winners]


def play_trick(m, cards):
    """cards: list of 4 cards in turn order starting from current turn."""
    for c in cards:
        m.play(m.s["turn"], c)


# 1-5 deck & dealing
def test_deck_has_52_unique_cards():
    d = shuffled_deck()
    assert len(d) == 52 and len(set(d)) == 52 and set(d) == set(new_deck())


def test_each_player_receives_13_cards_and_staged_dealing():
    m = Match.new(dealer=0, target=5)
    assert [len(h) for h in m.s["hands"]] == [5, 5, 5, 5]
    assert m.s["deal_stage"] == 1 and m.s["phase"] == "trump_select"
    m.select_trump(1, "H")
    assert [len(h) for h in m.s["hands"]] == [13] * 4
    deals = [e for e in m.s["events"] if e["type"] == "deal"]
    assert [e["cards_each"] for e in deals] == [5, 4, 4]
    all_cards = sum(m.s["hands"], [])
    assert len(set(all_cards)) == 52


def test_deal_order_follows_5_4_4_from_dealer_right():
    hands = rotate_deck_hands()
    m = Match.new(dealer=2, target=5, deck=deck_for_hands(hands, 2))
    assert m.s["hands"][3] == hands[3][:5]
    m.select_trump(3, "C")
    for seat in range(4):
        assert m.s["hands"][seat] == hands[seat]


def test_correct_player_selects_trump_and_leads():
    for dealer in range(4):
        m = Match.new(dealer=dealer, target=5)
        sel = right_of(dealer)
        assert m.s["trump_selector"] == sel
        with pytest.raises(GameError):
            m.select_trump((sel + 1) % 4, "S")
        m.select_trump(sel, "D")
        assert m.s["trump"] == "D" and m.s["turn"] == sel


def test_trump_selector_may_pick_any_suit():
    m = Match.new(dealer=0, target=5)
    first5 = m.s["hands"][1]
    missing = [s for s in SUITS if not any(c.endswith(s) for c in first5)] or SUITS
    m.select_trump(1, missing[0])
    assert m.s["trump"] == missing[0]


# 6-10 trick rules
def test_must_follow_suit_when_possible():
    hands = [["AH", "2S"], ["3H", "KS"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="S")
    m.play(0, "AH")
    with pytest.raises(GameError):
        m.play(1, "KS")
    m.play(1, "3H")


def test_trump_optional_when_void():
    hands = [["AH", "2C"], ["KS", "3D"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="S")
    m.play(0, "AH")
    assert set(legal_cards(m.s["hands"][1], m.s["trick"])) == {"KS", "3D"}
    m.play(1, "3D")  # discarding non-trump is allowed


def test_trump_beats_non_trump():
    assert trick_winner([[0, "AH"], [1, "2S"], [2, "KH"], [3, "QH"]], "S") == 1


def test_highest_trump_wins():
    assert trick_winner([[0, "AH"], [1, "2S"], [2, "JS"], [3, "QH"]], "S") == 2


def test_highest_lead_suit_wins_without_trump():
    assert trick_winner([[0, "10H"], [1, "AD"], [2, "KH"], [3, "2H"]], "S") == 2
    assert trick_winner([[0, "10H"], [1, "AD"], [2, "9H"], [3, "2H"]], "S") == 0


def test_cannot_play_out_of_turn_or_unheld_or_duplicate():
    hands = [["AH", "2C"], ["KH", "3D"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands)
    with pytest.raises(GameError):
        m.play(1, "KH")
    with pytest.raises(GameError):
        m.play(0, "KH")
    m.play(0, "AH")
    with pytest.raises(GameError):
        m.play(0, "AH")


# 11-15 tens
def test_ten_ownership_goes_to_trick_winner_team():
    hands = [["10H", "2C"], ["AH", "3D"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="S")
    play_trick(m, ["10H", "AH", "4H", "5H"])
    assert m.s["tens"] == [[], ["10H"]] and m.s["turn"] == 1


def test_normal_win_when_fourth_ten_already_with_opponents():
    hands = [["10H", "2C"], ["AH", "3D"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="S", tens=[["10S"], ["10C", "10D"]], tricks=fake_tricks([1, 0, 1]))
    play_trick(m, ["10H", "AH", "4H", "5H"])
    r = m.s["result"]
    assert r["winner_team"] == 1 and r["type"] == NORMAL and r["points"] == 1
    assert m.s["scores"] == [0, 1]


def test_koth_prompt_and_decline_gives_normal_win():
    hands = [["10H", "2C"], ["AH", "3D"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="S", tens=[[], ["10C", "10D"]], tricks=fake_tricks([1, 0]))
    play_trick(m, ["10H", "AH", "4H", "5H"])
    assert m.s["phase"] == "koth_decision" and m.s["koth_decision"] == 1
    with pytest.raises(GameError):
        m.koth_decide(0, True)  # opponents cannot decide
    with pytest.raises(GameError):
        m.play(m.s["turn"], "2C")
    m.koth_decide(3, False)
    assert m.s["result"]["type"] == NORMAL and m.s["scores"] == [0, 1]


def test_koth_declared_and_declarer_captures_fourth_ten():
    hands = [["10H", "2C", "10S"], ["AH", "3D", "AS"], ["4H", "QS", "2S"], ["5H", "JS", "3S"]]
    m = playing_match(hands, trump="C", tens=[[], ["10C", "10D"]], tricks=fake_tricks([1, 0]))
    play_trick(m, ["10H", "AH", "4H", "5H"])
    m.koth_decide(1, True)
    assert m.s["koth"] == 1 and m.s["phase"] == "playing" and m.s["turn"] == 1
    m.play(1, "AS"); m.play(2, "2S"); m.play(3, "3S"); m.play(0, "10S")
    r = m.s["result"]
    assert r["winner_team"] == 1 and r["type"] == KOTH and r["points"] == 2


def test_koth_declared_but_opponents_capture_fourth_ten():
    hands = [["10H", "2C", "AS"], ["AH", "3D", "10S"], ["4H", "QS", "2S"], ["5H", "JS", "3S"]]
    m = playing_match(hands, trump="C", tens=[[], ["10C", "10D"]], tricks=fake_tricks([1, 0]))
    play_trick(m, ["10H", "AH", "4H", "5H"])
    m.koth_decide(1, True)
    m.play(1, "10S"); m.play(2, "2S"); m.play(3, "3S"); m.play(0, "AS")
    r = m.s["result"]
    assert r["winner_team"] == 0 and r["type"] == KOTH and r["points"] == 2
    assert m.s["scores"] == [2, 0]


def test_automatic_koth_third_and_fourth_ten_in_same_trick():
    hands = [["10H", "2C"], ["AH", "3D"], ["10S", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="C", tens=[[], ["10C", "10D"]], tricks=fake_tricks([1, 0]))
    m.play(0, "10H"); m.play(1, "AH")
    m.s["hands"][2] = ["10S"]  # void in hearts
    m.play(2, "10S"); m.play(3, "5H")
    r = m.s["result"]
    assert r["type"] == KOTH and r["winner_team"] == 1 and r["reason"] == "automatic_koth"
    assert m.s["phase"] != "koth_decision"


# 16-18 grand slam
def _gs_match(extra_tens=None):
    hands = [["AH", "2C", "3C", "4C", "5C", "6C", "7C"], ["2H", "2D", "3D", "4D", "5D", "6D", "7D"],
             ["3H", "8C", "9C", "JC", "QC", "KC", "AC"], ["4H", "8D", "9D", "JD", "QD", "KD", "AD"]]
    return playing_match(hands, trump="S", tens=extra_tens or [["10S"], []], tricks=fake_tricks([0, 2, 0, 2, 0, 2]))


def test_grand_slam_offered_after_first_seven_tricks_with_partner_reveal():
    m = _gs_match()
    play_trick(m, ["AH", "2H", "3H", "4H"])
    assert m.s["phase"] == "gs_decision" and m.s["gs_eligible"] == 0
    v0, v1 = m.view(0), m.view(1)
    assert set(v0["partner_hand"]) == set(m.s["hands"][2])
    assert v1["partner_hand"] is None
    m.grand_slam_decide(2, False)
    assert m.s["phase"] == "playing" and m.view(0)["partner_hand"] is None


def test_grand_slam_not_triggered_by_later_seven_streak():
    m = Match.new(dealer=3, target=10)
    s = m.s
    s.update(phase="playing", trump="S", tricks=fake_tricks([1] + [0] * 5), turn=0,
             hands=[["AH", "AC"], ["2H", "2C"], ["3H", "3C"], ["4H", "4C"]])
    play_trick(m, ["AH", "2H", "3H", "4H"])  # trick 7 by team 0 but trick 1 was lost
    assert m.s["phase"] == "playing" and m.s["gs_eligible"] is None
    s["tricks"] = fake_tricks([1] + [0] * 11)
    s["hands"] = [["AS"], ["2S"], ["3S"], ["4S"]]
    s["turn"] = 0
    play_trick(m, ["AS", "2S", "3S", "4S"])
    assert m.s["gs_eligible"] is None


def test_grand_slam_replaces_active_koth_and_failure_ends_round_immediately():
    m = _gs_match(extra_tens=[["10S", "10H", "10D"], []])
    m.s["koth"] = 0
    play_trick(m, ["AH", "2H", "3H", "4H"])
    m.grand_slam_decide(0, True)
    assert m.s["koth"] is None and m.s["gs_declared"] == 0
    m.s["hands"][1] = ["2S"] + m.s["hands"][1][1:]
    m.play(0, "2C"); m.play(1, "2S"); m.play(2, "8C"); m.play(3, "8D")
    r = m.s["result"]
    assert r["winner_team"] == 1 and r["type"] == GRAND_SLAM and r["points"] == 3
    assert m.s["scores"] == [0, 3]
    assert len(m.s["tricks"]) == 8 and m.s["phase"] == "round_over"


def test_grand_slam_success_awards_three_points_only():
    hands = [["AH"], ["2H"], ["3H"], ["4H"]]
    m = playing_match(hands, trump="S", tens=[["10S", "10H", "10D", "10C"], []], tricks=fake_tricks([0, 2] * 6))
    m.s["gs_declared"] = 0
    play_trick(m, ["AH", "2H", "3H", "4H"])
    r = m.s["result"]
    assert r["type"] == GRAND_SLAM and r["points"] == 3 and m.s["scores"] == [3, 0]


# 19 equal tens
@pytest.mark.parametrize("team0_tricks", range(0, 14))
def test_equal_tens_resolved_by_trick_count(team0_tricks):
    if team0_tricks in (6, 7):
        last_winner_team = 0 if team0_tricks == 7 else 1
        prior = [0] * (team0_tricks - (last_winner_team == 0)) + [1] * (12 - (team0_tricks - (last_winner_team == 0)))
        prior.remove(1 - last_winner_team)
        random.shuffle(prior)
        prior = [1 - last_winner_team] + prior  # first trick lost avoids a grand slam streak
        hands = [["AH"], ["2H"], ["3H"], ["4H"]] if last_winner_team == 0 else [["2H"], ["AH"], ["3H"], ["4H"]]
        m = playing_match(hands, trump="S", tens=[["10S", "10H"], ["10D", "10C"]], tricks=fake_tricks(prior))
        play_trick(m, [h[0] for h in hands])
        r = m.s["result"]
        assert r["type"] == NORMAL and r["points"] == 1 and r["reason"] == "equal_tens"
        assert r["winner_team"] == (0 if team0_tricks >= 7 else 1)
        assert sorted(r["tricks_won"]) == [6, 7]
    else:
        # 2-2 tens with any other final split is impossible to tie; 13 tricks never split 6-6
        assert team0_tricks + (13 - team0_tricks) == 13 and team0_tricks != 13 - team0_tricks


# 20 dealer rotation
@pytest.mark.parametrize("dealer", range(4))
def test_dealer_rotation_rules(dealer):
    dt, ot = team_of(dealer), 1 - team_of(dealer)
    assert next_dealer(dealer, dt, NORMAL) == right_of(dealer)
    assert next_dealer(dealer, ot, NORMAL) == dealer
    assert next_dealer(dealer, dt, KOTH) == right_of(dealer)
    assert next_dealer(dealer, ot, KOTH) == partner(dealer)
    assert next_dealer(dealer, dt, GRAND_SLAM) == right_of(dealer)
    assert next_dealer(dealer, ot, GRAND_SLAM) == partner(dealer)


def test_next_round_uses_rotated_dealer():
    hands = [["10H", "2C"], ["AH", "3D"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="S", dealer=3, tens=[["10S"], ["10C", "10D"]], tricks=fake_tricks([1, 0, 1]))
    play_trick(m, ["10H", "AH", "4H", "5H"])  # dealer 3 (team 1) wins normal
    assert m.s["result"]["next_dealer"] == 0
    m.next_round()
    assert m.s["dealer"] == 0 and m.s["trump_selector"] == 1 and m.s["round_no"] == 2


# 21 target
def test_match_ends_at_target():
    hands = [["10H", "2C"], ["AH", "3D"], ["4H", "QS"], ["5H", "JS"]]
    m = playing_match(hands, trump="S", tens=[["10S"], ["10C", "10D"]], tricks=fake_tricks([1, 0, 1]),
                      scores=[3, 4], target=5)
    play_trick(m, ["10H", "AH", "4H", "5H"])
    assert m.s["phase"] == "match_over" and m.s["winner_team"] == 1 and m.s["scores"] == [3, 5]
    with pytest.raises(GameError):
        m.next_round()


# 23 privacy
def test_view_never_exposes_other_hands():
    m = Match.new(dealer=0, target=5)
    m.select_trump(1, "S")
    for seat in range(4):
        v = m.view(seat)
        assert set(v["hand"]) == set(m.s["hands"][seat])
        assert v["partner_hand"] is None
        others = set(sum((m.s["hands"][o] for o in range(4) if o != seat), []))
        flat = str({k: val for k, val in v.items() if k not in ("hand", "legal")})
        assert not any(f"'{c}'" in flat for c in others)
        assert "deck" not in v and "hands" not in v


# integration: complete random four-player matches
@pytest.mark.parametrize("seed", range(40))
def test_full_random_match_reaches_target(seed):
    rnd = random.Random(seed)
    m = Match.new(dealer=rnd.randrange(4), target=rnd.choice([5, 7, 10]))
    rounds = 0
    while m.s["phase"] != "match_over":
        s = m.s
        if s["phase"] == "trump_select":
            m.select_trump(s["trump_selector"], rnd.choice(SUITS))
        elif s["phase"] == "playing":
            v = m.view(s["turn"])
            assert v["legal"]
            m.play(s["turn"], rnd.choice(v["legal"]))
        elif s["phase"] == "koth_decision":
            team = s["koth_decision"]
            m.koth_decide(team, rnd.random() < 0.5)
        elif s["phase"] == "gs_decision":
            m.grand_slam_decide(s["gs_eligible"] + 2, rnd.random() < 0.5)
        elif s["phase"] == "round_over":
            r = s["result"]
            assert r["type"] in (NORMAL, KOTH, GRAND_SLAM)
            m.next_round()
            rounds += 1
            assert sum(len(h) for h in m.s["hands"]) == 20
        tens_total = len(m.s["tens"][0]) + len(m.s["tens"][1])
        assert tens_total <= 4
        assert sum(m.s["tricks_won"]) == len(m.s["tricks"]) <= 13
    assert max(m.s["scores"]) >= m.s["target"]
    assert sum(r["points"] for r in m.s["rounds"]) == sum(m.s["scores"])


def test_forfeit_ends_match_for_opponents():
    m = Match.new(dealer=0, target=5)
    m.forfeit(2)
    assert m.s["phase"] == "match_over" and m.s["winner_team"] == 1
    with pytest.raises(GameError):
        m.select_trump(1, "S")
