"""Server-side 'smart' bot player for Dehla Pakad. Bots only read their own hand plus public
table information (played cards, tens, trump) — except the one-time partner reveal at Grand Slam."""
from engine import RANK_VALUE, SUITS, suit, rank, is_ten, team_of, partner, legal_cards, trick_winner

BOT_NAMES = ["Arjun", "Meera", "Kabir", "Isha", "Rohan", "Tara", "Vikram", "Zoya"]


def _val(c):
    return RANK_VALUE[rank(c)]


def _played(s):
    cards = [c for t in s["tricks"] for _, c in t["cards"]]
    return set(cards + [c for _, c in s["trick"]])


def _is_top(card, s, hand):
    """True if no unseen card of the same suit outranks `card`."""
    gone = _played(s) | set(hand)
    return all(r + suit(card) in gone for r in RANK_VALUE if RANK_VALUE[r] > _val(card))


def choose_trump(hand):
    def score(x):
        cards = [c for c in hand if suit(c) == x]
        return (len(cards), sum(_val(c) for c in cards))
    return max(SUITS, key=score)


def choose_card(s, seat):
    hand, trick, trump = s["hands"][seat], s["trick"], s["trump"]
    legal = legal_cards(hand, trick)
    low = lambda cards: min(cards, key=lambda c: (is_ten(c), suit(c) == trump, _val(c)))
    if not trick:
        tops = [c for c in legal if suit(c) != trump and not is_ten(c) and _is_top(c, s, hand)]
        if tops:
            return max(tops, key=_val)
        safe_tens = [c for c in legal if is_ten(c) and _is_top(c, s, hand)]
        if safe_tens:
            return safe_tens[0]
        non_trump = [c for c in legal if suit(c) != trump and not is_ten(c)]
        if non_trump:
            by_suit = {}
            for c in non_trump:
                by_suit.setdefault(suit(c), []).append(c)
            longest = max(by_suit.values(), key=len)
            return min(longest, key=_val)
        return low(legal)

    lead = suit(trick[0][1])
    win_seat = trick_winner(trick, trump)
    win_card = dict((st, c) for st, c in trick)[win_seat]
    last = len(trick) == 3
    tens_on_table = any(is_ten(c) for _, c in trick)

    def beats(c):
        return trick_winner(trick + [[seat, c]], trump) == seat

    partner_winning = team_of(win_seat) == team_of(seat)
    partner_safe = partner_winning and (last or (suit(win_card) == trump and _is_top(win_card, s, hand))
                                        or (suit(win_card) == lead and _is_top(win_card, s, hand) and lead != trump))
    if partner_safe:
        tens = [c for c in legal if is_ten(c)]
        return tens[0] if tens else low(legal)

    winners = [c for c in legal if beats(c)]
    if winners:
        cheapest = min(winners, key=lambda c: (suit(c) == trump, is_ten(c), _val(c)))
        if last or tens_on_table:
            return cheapest
        strong = [c for c in winners if not is_ten(c) and _is_top(c, s, hand)]
        if strong:
            return min(strong, key=lambda c: (suit(c) == trump, _val(c)))
        if suit(cheapest) == trump or tens_on_table:
            return cheapest
    return low(legal)


def decide_koth(s, seat):
    hand, trump = s["hands"][seat], s["trump"]
    captured = set(s["tens"][0] + s["tens"][1])
    fourth = next((r for r in ("10" + x for x in SUITS) if r not in captured), None)
    if fourth in hand:
        return True
    trumps = [c for c in hand if suit(c) == trump]
    return len(trumps) >= 3 and any(rank(c) in ("A", "K") for c in trumps)


def decide_grand_slam(s, seat):
    hands = s["hands"][seat] + s["hands"][partner(seat)]
    trump = s["trump"]
    trumps = [c for c in hands if suit(c) == trump]
    unseen_trumps = [r + trump for r in RANK_VALUE if r + trump not in _played(s) and r + trump not in hands]
    tops = sum(1 for c in hands if _is_top(c, s, hands))
    return not unseen_trumps and tops >= 6 or (len(trumps) >= 6 and tops >= 5)
