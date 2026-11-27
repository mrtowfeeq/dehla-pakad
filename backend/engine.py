"""Dehla Pakad authoritative game engine.

Seat convention: seats 0..3 in COUNTER-CLOCKWISE order (play moves to the right).
right_of(s) = (s + 1) % 4 is the player immediately to s's right.
Teams: Team A (index 0) = seats 0 & 2, Team B (index 1) = seats 1 & 3 — partners sit opposite.
State is a plain dict so it can be persisted to the database and restored after restarts.
"""
import secrets

SUITS = ["S", "H", "D", "C"]
RANKS = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"]
RANK_VALUE = {r: 14 - i for i, r in enumerate(RANKS)}
NORMAL, KOTH, GRAND_SLAM = "normal", "koth", "grand_slam"
POINTS = {NORMAL: 1, KOTH: 2, GRAND_SLAM: 3}
DEAL_STAGES = (5, 4, 4)


class GameError(Exception):
    pass


def suit(c): return c[-1]
def rank(c): return c[:-1]
def is_ten(c): return rank(c) == "10"
def team_of(seat): return seat % 2
def right_of(seat): return (seat + 1) % 4
def partner(seat): return (seat + 2) % 4


def new_deck():
    return [r + s for s in SUITS for r in RANKS]


def shuffled_deck():
    deck = new_deck()
    secrets.SystemRandom().shuffle(deck)
    return deck


def deal_order(dealer):
    return [(dealer + 1 + i) % 4 for i in range(4)]


def deck_for_hands(hands, dealer):
    """Build a deck that deals exactly `hands` (lists of 13) with the 5+4+4 sequence."""
    deck, start = [], 0
    for n in DEAL_STAGES:
        for seat in deal_order(dealer):
            deck.extend(hands[seat][start:start + n])
        start += n
    return deck


def sort_hand(hand):
    return sorted(hand, key=lambda c: (SUITS.index(suit(c)), -RANK_VALUE[rank(c)]))


def trick_winner(cards, trump):
    """cards: [[seat, card], ...] in play order. Returns the winning seat."""
    lead = suit(cards[0][1])

    def strength(sc):
        c = sc[1]
        if suit(c) == trump:
            return (2, RANK_VALUE[rank(c)])
        if suit(c) == lead:
            return (1, RANK_VALUE[rank(c)])
        return (0, 0)

    return max(cards, key=strength)[0]


def legal_cards(hand, trick):
    if not trick:
        return list(hand)
    lead = suit(trick[0][1])
    follow = [c for c in hand if suit(c) == lead]
    return follow or list(hand)


def next_dealer(dealer, winner_team, vtype):
    if team_of(dealer) == winner_team:
        return right_of(dealer)
    return dealer if vtype == NORMAL else partner(dealer)


class Match:
    def __init__(self, state):
        self.s = state

    @classmethod
    def new(cls, dealer, target, deck=None):
        if dealer not in range(4) or target < 1:
            raise GameError("Invalid match settings")
        m = cls({"target": target, "scores": [0, 0], "dealer": dealer, "round_no": 0,
                 "rounds": [], "winner_team": None, "seq": 0})
        m.start_round(deck)
        return m

    # ---------- round lifecycle ----------
    def start_round(self, deck=None):
        s = self.s
        deck = list(deck) if deck else shuffled_deck()
        if len(deck) != 52 or len(set(deck)) != 52:
            raise GameError("Deck must contain 52 unique cards")
        s["round_no"] += 1
        s.update(deck=deck, hands=[[], [], [], []], deal_stage=0, trump=None, trick=[], tricks=[],
                 last_trick=None, tens=[[], []], tricks_won=[0, 0], koth=None, koth_decision=None,
                 gs_eligible=None, gs_pending=False, gs_decided=False, gs_declared=None, auto_koth_pending=None,
                 result=None,
                 turn=None, phase="trump_select", trump_selector=right_of(s["dealer"]), events=[])
        self._deal()

    def _deal(self):
        s = self.s
        n = DEAL_STAGES[s["deal_stage"]]
        for seat in deal_order(s["dealer"]):
            s["hands"][seat].extend(s["deck"][:n])
            s["deck"] = s["deck"][n:]
        s["deal_stage"] += 1
        self._event("deal", stage=s["deal_stage"], cards_each=n)

    def _event(self, kind, **data):
        self.s["seq"] += 1
        self.s["events"].append({"seq": self.s["seq"], "type": kind, **data})

    def next_round(self):
        s = self.s
        if s["phase"] != "round_over":
            raise GameError("Round is not over")
        s["dealer"] = s["result"]["next_dealer"]
        self.start_round()

    # ---------- actions ----------
    def select_trump(self, seat, trump):
        s = self.s
        if s["phase"] != "trump_select":
            raise GameError("Not time to select trump")
        if seat != s["trump_selector"]:
            raise GameError("Only the player to the dealer's right selects trump")
        if trump not in SUITS:
            raise GameError("Invalid suit")
        s["trump"] = trump
        self._event("trump", seat=seat, suit=trump)
        self._deal()
        self._deal()
        s["phase"] = "playing"
        s["turn"] = s["trump_selector"]

    def play(self, seat, card):
        s = self.s
        if s["phase"] != "playing":
            raise GameError("Cards cannot be played right now")
        if seat != s["turn"]:
            raise GameError("It is not your turn")
        hand = s["hands"][seat]
        if card not in hand:
            raise GameError("You do not hold that card")
        if card not in legal_cards(hand, s["trick"]):
            raise GameError("You must follow the leading suit")
        hand.remove(card)
        s["trick"].append([seat, card])
        self._event("play", seat=seat, card=card)
        if len(s["trick"]) < 4:
            s["turn"] = right_of(seat)
            return
        self._complete_trick()

    def koth_decide(self, seat, declare):
        s = self.s
        if s["phase"] != "koth_decision" or team_of(seat) != s["koth_decision"]:
            raise GameError("No Koth decision for you")
        team = s["koth_decision"]
        s["koth_decision"] = None
        self._event("koth_decision", seat=seat, declare=bool(declare))
        if not declare:
            return self._finish(team, NORMAL, "koth_declined")
        s["koth"] = team
        s["phase"] = "playing"
        if s["gs_pending"]:
            self._offer_grand_slam()

    def grand_slam_decide(self, seat, declare):
        s = self.s
        if s["phase"] != "gs_decision" or team_of(seat) != s["gs_eligible"]:
            raise GameError("No Grand Slam decision for you")
        s["gs_decided"] = True
        s["phase"] = "playing"
        self._event("grand_slam_decision", seat=seat, declare=bool(declare))
        auto_koth = s.get("auto_koth_pending")
        s["auto_koth_pending"] = None
        if declare:
            s["gs_declared"] = s["gs_eligible"]
            s["koth"] = None  # Grand Slam replaces any active Koth
        elif auto_koth is not None:
            # Declining after a trick-7 sweep that took the 3rd and 4th tens settles the automatic Koth.
            return self._finish(auto_koth, KOTH, "automatic_koth")

    def forfeit(self, seat):
        s = self.s
        if s["phase"] == "match_over":
            raise GameError("Match is already over")
        s["phase"] = "match_over"
        s["winner_team"] = 1 - team_of(seat)
        s["turn"] = None
        s["forfeited_by"] = seat
        self._event("forfeit", seat=seat)

    def cancel(self, seat):
        """Exit Match: ends the whole match for everyone, no points awarded."""
        s = self.s
        if s["phase"] in ("match_over", "cancelled"):
            raise GameError("Match has already ended")
        s["phase"] = "cancelled"
        s["turn"] = None
        s["koth_decision"] = None
        s["cancelled_by"] = seat
        self._event("cancelled", seat=seat)

    # ---------- resolution ----------
    def _complete_trick(self):
        s = self.s
        trick = s["trick"]
        winner = trick_winner(trick, s["trump"])
        wt, opp = team_of(winner), 1 - team_of(winner)
        tens_in = [c for _, c in trick if is_ten(c)]
        before = len(s["tens"][wt])
        s["tens"][wt].extend(tens_in)
        after = len(s["tens"][wt])
        s["tricks_won"][wt] += 1
        s["tricks"].append({"cards": trick, "winner": winner, "tens": tens_in})
        s["last_trick"] = {"cards": trick, "winner": winner}
        s["trick"] = []
        s["turn"] = winner
        n = len(s["tricks"])
        self._event("trick", winner=winner, tens=tens_in, number=n)

        if s["gs_declared"] is not None:
            g = s["gs_declared"]
            if wt != g:
                return self._finish(1 - g, GRAND_SLAM, "grand_slam_failed")
            if n == 13:
                return self._finish(g, GRAND_SLAM, "grand_slam")
            return

        if s["koth"] is not None:
            if tens_in and len(s["tens"][0]) + len(s["tens"][1]) == 4:
                return self._finish(wt, KOTH, "koth_fourth_ten")
        elif before < 3 and after == 4:
            if n == 7 and self._first_seven_team() == wt and not s["gs_decided"]:
                # Approved rule: a clean seven-trick sweep is offered Grand Slam before automatic Koth.
                s["auto_koth_pending"] = wt
                return self._offer_grand_slam()
            return self._finish(wt, KOTH, "automatic_koth")
        elif before < 3 and after == 3:
            if len(s["tens"][opp]) == 1:
                return self._finish(wt, NORMAL, "three_tens")
            s["phase"] = "koth_decision"
            s["koth_decision"] = wt
            s["gs_pending"] = n == 7 and self._first_seven_team() is not None
            return

        if s["koth"] is None:
            # Approved rules: a team with at least two tens and seven tricks wins normally as soon as the
            # opponents hold at least one ten. A 2-2 split keeps its "equal_tens" reason. When the
            # opponents have no tens, play continues so Koth stays possible.
            counts = [len(s["tens"][0]), len(s["tens"][1])]
            for team in (0, 1):
                if counts[team] >= 2 and counts[1 - team] >= 1 and s["tricks_won"][team] >= 7:
                    reason = "equal_tens" if counts == [2, 2] else "two_tens_seven_tricks"
                    return self._finish(team, NORMAL, reason)
        if n == 7 and self._first_seven_team() is not None:
            return self._offer_grand_slam()
        if n == 13:
            # Safety net; a 2-2 split is settled above once either team reaches seven tricks.
            return self._finish(0 if s["tricks_won"][0] >= 7 else 1, NORMAL, "equal_tens")

    def _first_seven_team(self):
        tricks = self.s["tricks"][:7]
        if len(tricks) < 7:
            return None
        teams = {team_of(t["winner"]) for t in tricks}
        return teams.pop() if len(teams) == 1 else None

    def _offer_grand_slam(self):
        s = self.s
        s["gs_pending"] = False
        if s["gs_decided"]:
            return
        s["gs_eligible"] = self._first_seven_team()
        s["phase"] = "gs_decision"

    def _finish(self, team, vtype, reason):
        s = self.s
        pts = POINTS[vtype]
        s["scores"][team] += pts
        nd = next_dealer(s["dealer"], team, vtype)
        s["result"] = {"winner_team": team, "type": vtype, "points": pts, "reason": reason,
                       "dealer": s["dealer"], "next_dealer": nd, "tricks_won": list(s["tricks_won"]),
                       "tens": [len(s["tens"][0]), len(s["tens"][1])],
                       # Display-only snapshot of which ten cards each team captured (uncaptured tens stay in hands).
                       "captured_tens": [list(s["tens"][0]), list(s["tens"][1])]}
        s["rounds"].append({"round": s["round_no"], **s["result"],
                            "captured_tens": [list(s["tens"][0]), list(s["tens"][1])]})
        s["turn"] = None
        s["koth_decision"] = None
        self._event("round_over", **s["result"])
        if s["scores"][team] >= s["target"]:
            s["phase"] = "match_over"
            s["winner_team"] = team
        else:
            s["phase"] = "round_over"

    # ---------- private per-seat view ----------
    def view(self, seat):
        s = self.s
        hand = s["hands"][seat] if seat is not None else []
        my_team = team_of(seat) if seat is not None else None
        show_partner = s["phase"] == "gs_decision" and my_team == s["gs_eligible"]
        return {
            "phase": s["phase"], "round_no": s["round_no"], "dealer": s["dealer"], "trump": s["trump"],
            "trump_selector": s["trump_selector"], "turn": s["turn"], "deal_stage": s["deal_stage"],
            "trick": s["trick"], "last_trick": s["last_trick"], "tens": s["tens"],
            "tricks_won": s["tricks_won"], "tricks_played": len(s["tricks"]), "scores": s["scores"],
            "target": s["target"], "hand_counts": [len(h) for h in s["hands"]],
            "hand": sort_hand(hand),
            "legal": sort_hand(legal_cards(hand, s["trick"])) if s["phase"] == "playing" and s["turn"] == seat else [],
            "koth": s["koth"], "koth_decision": s["koth_decision"], "gs_eligible": s["gs_eligible"],
            "gs_declared": s["gs_declared"], "auto_koth_pending": s.get("auto_koth_pending"),
            "result": s["result"], "rounds": s["rounds"],
            "winner_team": s["winner_team"], "my_seat": seat, "forfeited_by": s.get("forfeited_by"), "cancelled_by": s.get("cancelled_by"),
            "partner_hand": sort_hand(s["hands"][partner(seat)]) if show_partner else None,
            "seq": s["seq"],
        }
