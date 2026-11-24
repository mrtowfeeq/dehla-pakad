import random
import pytest
from engine import Match, legal_cards, team_of
import bots


@pytest.mark.parametrize("seed", range(30))
def test_all_bot_match_plays_only_legal_moves(seed):
    random.seed(seed)
    m = Match.new(dealer=seed % 4, target=7)
    steps = 0
    while m.s["phase"] != "match_over":
        s = m.s
        if s["phase"] == "trump_select":
            m.select_trump(s["trump_selector"], bots.choose_trump(s["hands"][s["trump_selector"]]))
        elif s["phase"] == "playing":
            seat = s["turn"]
            card = bots.choose_card(s, seat)
            assert card in legal_cards(s["hands"][seat], s["trick"])
            m.play(seat, card)
        elif s["phase"] == "koth_decision":
            m.koth_decide(s["koth_decision"], bots.decide_koth(s, s["koth_decision"]))
        elif s["phase"] == "gs_decision":
            m.grand_slam_decide(s["gs_eligible"], bots.decide_grand_slam(s, s["gs_eligible"]))
        elif s["phase"] == "round_over":
            m.next_round()
        steps += 1
        assert steps < 5000
    assert max(m.s["scores"]) >= 7


def test_smart_bot_beats_random_players_more_often():
    wins = 0
    for seed in range(60):
        rnd = random.Random(seed)
        m = Match.new(dealer=seed % 4, target=5)
        while m.s["phase"] != "match_over":
            s = m.s
            smart = lambda seat: team_of(seat) == 0
            if s["phase"] == "trump_select":
                sel = s["trump_selector"]
                m.select_trump(sel, bots.choose_trump(s["hands"][sel]) if smart(sel) else rnd.choice("SHDC"))
            elif s["phase"] == "playing":
                seat = s["turn"]
                legal = legal_cards(s["hands"][seat], s["trick"])
                m.play(seat, bots.choose_card(s, seat) if smart(seat) else rnd.choice(legal))
            elif s["phase"] == "koth_decision":
                m.koth_decide(s["koth_decision"], bots.decide_koth(s, s["koth_decision"]))
            elif s["phase"] == "gs_decision":
                m.grand_slam_decide(s["gs_eligible"], bots.decide_grand_slam(s, s["gs_eligible"]))
            else:
                m.next_round()
        wins += m.s["winner_team"] == 0
    assert wins >= 40, wins
