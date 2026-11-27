"""Leagues and league levels, derived only from a player's lifetime medal balance (medals.py).

There is no separate currency: the current league and level are a pure function of the current
medal balance, so they move up and down with it. Only the highest league ever reached is remembered
on its own (users.highest_league_rank, which only ever increases).

Leagues (lifetime medals) and their five levels (I lowest ... V highest). Each league's range is split
into five equal steps; every threshold below is the first medal count of that level, and each level runs
up to one less than the next threshold, so the table is contiguous with no gaps or overlaps:

    League    Range         I      II     III    IV     V      (step)
    Bronze    0-99          0      20     40     60     80     (20)
    Silver    100-299       100    140    180    220    260    (40)
    Gold      300-599       300    360    420    480    540    (60)
    Platinum  600-999       600    680    760    840    920    (80)
    Diamond   1000-1999     1000   1200   1400   1600   1800   (200)
    Master    2000-4999     2000   2600   3200   3800   4400   (600)
    Legend    5000+         5000   7500   10000  12500  15000  (2500)

Legend has no upper limit: its levels keep the fixed 2,500-medal step, and Legend V (15,000+) is the
top level, with no further level to reach.

To retune, change ``LEAGUES`` (and ``LEGEND_STEP``); every level threshold is derived from it.
"""

LEAGUES = (
    # (id, name, first medal count)
    ("bronze", "Bronze", 0),
    ("silver", "Silver", 100),
    ("gold", "Gold", 300),
    ("platinum", "Platinum", 600),
    ("diamond", "Diamond", 1000),
    ("master", "Master", 2000),
    ("legend", "Legend", 5000),
)
LEGEND_STEP = 2500
LEVELS_PER_LEAGUE = 5
ROMAN = ("I", "II", "III", "IV", "V")
LEGEND_RULE = (f"Legend has no upper limit: each level is {LEGEND_STEP:,} medals wide, "
               f"and Legend V ({LEAGUES[-1][2] + 4 * LEGEND_STEP:,}+) is the highest level.")


def _build_levels():
    levels = []
    for index, (league_id, name, start) in enumerate(LEAGUES):
        if index + 1 < len(LEAGUES):
            end = LEAGUES[index + 1][2]  # first medal count of the next league
            step = (end - start) / LEVELS_PER_LEAGUE
            mins = [start + round(step * n) for n in range(LEVELS_PER_LEAGUE)]
        else:
            mins = [start + LEGEND_STEP * n for n in range(LEVELS_PER_LEAGUE)]
        for n, minimum in enumerate(mins):
            levels.append({"league": league_id, "league_name": name, "league_rank": index, "level": n + 1,
                           "label": ROMAN[n], "min": minimum})
    for i, lvl in enumerate(levels):  # each level ends right before the next one starts
        lvl["max"] = levels[i + 1]["min"] - 1 if i + 1 < len(levels) else None
    return tuple(levels)


LEVELS = _build_levels()
LEAGUE_IDS = tuple(league_id for league_id, _, _ in LEAGUES)
LEAGUE_RANK = {league_id: i for i, league_id in enumerate(LEAGUE_IDS)}


def league_range(league_id):
    """(min, max or None) lifetime medals for a league, e.g. for leaderboard filters."""
    i = LEAGUE_RANK[league_id]
    return LEAGUES[i][2], (LEAGUES[i + 1][2] - 1 if i + 1 < len(LEAGUES) else None)


def level_for(medals):
    """The level entry (league, level 1-5, thresholds) for a medal balance; negatives count as 0."""
    medals = max(0, int(medals or 0))
    found = LEVELS[0]
    for lvl in LEVELS:
        if medals >= lvl["min"]:
            found = lvl
        else:
            break
    return found


def state(medals):
    """Compact, comparable state stored with every medal change: {league, level, rank}."""
    lvl = level_for(medals)
    return {"league": lvl["league"], "level": lvl["level"], "rank": lvl["league_rank"]}


def public_league(medals):
    """What anyone may see about a player's league (derived from the public medal total)."""
    lvl = level_for(medals)
    return {"id": lvl["league"], "name": lvl["league_name"], "level": lvl["level"], "level_label": lvl["label"]}


def _percent(value, start, end):
    if end is None or end <= start:
        return 100
    return max(0, min(100, round(100 * (value - start) / (end - start))))


def progress(medals, highest_rank=None):
    """Full progression view for a balance: current league and level, progress to the next level and
    to the next league (separately), and the highest league ever reached."""
    medals = max(0, int(medals or 0))
    lvl = level_for(medals)
    index = LEVELS.index(lvl)
    next_level = LEVELS[index + 1] if index + 1 < len(LEVELS) and LEVELS[index + 1]["league"] == lvl["league"] else None
    league_index = lvl["league_rank"]
    league_min = LEAGUES[league_index][2]
    next_league = LEAGUES[league_index + 1] if league_index + 1 < len(LEAGUES) else None
    top_level = index + 1 == len(LEVELS)
    # Level V's "next level" is the next league's Level I.
    next_level_min = next_level["min"] if next_level else (next_league[2] if next_league else None)
    highest = max(league_index, int(highest_rank) if highest_rank is not None else league_index)
    return {
        "medals": medals,
        "league": lvl["league"], "league_name": lvl["league_name"], "league_rank": league_index,
        "level": lvl["level"], "level_label": lvl["label"],
        "level_min": lvl["min"], "level_max": lvl["max"],
        "next_level_min": next_level_min,
        "medals_to_next_level": None if next_level_min is None else next_level_min - medals,
        "level_progress_percent": 100 if next_level_min is None else _percent(medals, lvl["min"], next_level_min),
        "league_min": league_min,
        "next_league": None if not next_league else {"id": next_league[0], "name": next_league[1], "min": next_league[2]},
        "medals_to_next_league": None if not next_league else next_league[2] - medals,
        "league_progress_percent": 100 if not next_league else _percent(medals, league_min, next_league[2]),
        "is_top_level": top_level,
        "highest_league": {"id": LEAGUES[highest][0], "name": LEAGUES[highest][1], "rank": highest},
        "legend_rule": LEGEND_RULE if lvl["league"] == "legend" else None,
    }


def config():
    """The whole table, for display (the server stays the authority for every player's state)."""
    return {"leagues": [{"id": i, "name": n, "min": m, "max": league_range(i)[1]} for i, n, m in LEAGUES],
            "levels": [dict(lvl) for lvl in LEVELS], "legend_step": LEGEND_STEP, "legend_rule": LEGEND_RULE}
