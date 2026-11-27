"""Server-side profile progression rules and display shaping."""

from copy import deepcopy
from datetime import datetime

MATCH_XP = 100
WIN_BONUS_XP = 50
XP_PER_LEVEL = 500

ACHIEVEMENTS = (
    {"id": "first_victory", "name": "First Victory", "description": "Win your first match.", "icon": "trophy", "metric": "wins", "target": 1},
    {"id": "getting_started", "name": "Getting Started", "description": "Complete 10 competitive matches.", "icon": "sparkles", "metric": "games_played", "target": 10},
    {"id": "experienced_player", "name": "Experienced Player", "description": "Complete 50 competitive matches.", "icon": "medal", "metric": "games_played", "target": 50},
    {"id": "veteran", "name": "Veteran", "description": "Complete 100 competitive matches.", "icon": "shield", "metric": "games_played", "target": 100},
    {"id": "winning_streak", "name": "Winning Streak", "description": "Win 5 competitive matches in a row.", "icon": "flame", "metric": "best_win_streak", "target": 5},
    {"id": "unstoppable", "name": "Unstoppable", "description": "Win 10 competitive matches in a row.", "icon": "crown", "metric": "best_win_streak", "target": 10},
    {"id": "team_player", "name": "Team Player", "description": "Win 25 competitive matches.", "icon": "users", "metric": "wins", "target": 25},
    {"id": "champion", "name": "Champion", "description": "Win 100 competitive matches.", "icon": "gem", "metric": "wins", "target": 100},
)


def xp_for_stats(stats):
    """Derive legacy XP from the same completed-match counters used by the game."""
    return max(0, int(stats.get("games_played") or 0)) * MATCH_XP + max(0, int(stats.get("wins") or 0)) * WIN_BONUS_XP


def level_for_xp(xp):
    total = max(0, int(xp or 0))
    level, in_level = divmod(total, XP_PER_LEVEL)
    return {
        "level": level + 1,
        "xp": total,
        "xp_in_level": in_level,
        "xp_to_next_level": XP_PER_LEVEL,
        "progress_percent": round(100 * in_level / XP_PER_LEVEL),
    }


def public_progression(user):
    stats = user.get("stats") or {}
    stored = user.get("progression") or {}
    xp = stored.get("xp")
    if not isinstance(xp, int) or xp < 0:
        xp = xp_for_stats(stats)
    result = level_for_xp(xp)
    result.update({
        "current_win_streak": stored.get("current_win_streak"),
        "best_win_streak": stored.get("best_win_streak"),
    })
    return result


def achievement_value(achievement, stats, progression):
    source = progression if achievement["metric"] in ("best_win_streak", "current_win_streak") else stats
    return max(0, int(source.get(achievement["metric"]) or 0))


def achievement_cards(stats, progression, unlocks=None):
    unlocked_at = unlocks or {}
    cards = []
    for achievement in ACHIEVEMENTS:
        value = achievement_value(achievement, stats, progression)
        cards.append({
            **achievement,
            "progress": min(value, achievement["target"]),
            "unlocked": value >= achievement["target"],
            "unlocked_at": unlocked_at.get(achievement["id"]),
        })
    return cards


async def ensure_streak_history(db, user_id, user, exclude_game_id=None, env=None):
    """Backfill compact performance metrics once from legacy completed-match records."""
    progression = user.get("progression") or {}
    if progression.get("metrics_initialized"):
        return user

    query = {"player_ids": user_id, "has_bots": {"$ne": True}}
    if env is not None:
        query["env"] = env
    if exclude_game_id:
        query["game_id"] = {"$ne": exclude_game_id}
    cursor = db.matches.find(query, {
        "winner_team": 1, "players.user_id": 1, "players.team": 1, "finished_at": 1,
        "started_at": 1, "duration_seconds": 1, "tricks_won": 1, "rounds.tricks_won": 1,
    })
    cursor = cursor.sort("finished_at", 1)
    current = best = 0
    team_tricks = duration_total = duration_count = 0
    async for match in cursor:
        player = next((p for p in match.get("players", []) if p.get("user_id") == user_id), None)
        team = player.get("team") if player else None
        if team in (0, 1) and match.get("winner_team") == team:
            current += 1
            best = max(best, current)
        else:
            current = 0
        if team in (0, 1):
            match_tricks = match.get("tricks_won")
            if isinstance(match_tricks, list) and len(match_tricks) > team:
                team_tricks += max(0, int(match_tricks[team] or 0))
            else:
                for round_result in match.get("rounds", []):
                    round_tricks = round_result.get("tricks_won") or []
                    if len(round_tricks) > team:
                        team_tricks += max(0, int(round_tricks[team] or 0))
        duration = match.get("duration_seconds")
        if not isinstance(duration, (int, float)):
            try:
                start = datetime.fromisoformat(str(match["started_at"]).replace("Z", "+00:00"))
                finish = datetime.fromisoformat(str(match["finished_at"]).replace("Z", "+00:00"))
                duration = max(0, int((finish - start).total_seconds()))
            except (KeyError, TypeError, ValueError):
                duration = None
        if isinstance(duration, (int, float)) and duration >= 0:
            duration_total += int(duration)
            duration_count += 1

    updated_progression = {
        **progression,
        "current_win_streak": current,
        "best_win_streak": best,
        "streaks_initialized": True,
        "team_tricks_won": team_tricks,
        "match_duration_seconds_total": duration_total,
        "match_duration_count": duration_count,
        "metrics_initialized": True,
    }
    await db.users.update_one(
        {"user_id": user_id, "progression.metrics_initialized": {"$ne": True},
         **({"env": env} if env is not None else {})},
        {"$set": {"progression": updated_progression}},
    )
    return await db.users.find_one({"user_id": user_id, **({"env": env} if env is not None else {})},
                                   {"_id": 0}) or user


def match_profile_update(user, *, game_id, team, winner_team, tricks_won, duration_seconds, finished_at):
    """Return one user-document update for a completed competitive match."""
    current_stats = deepcopy(user.get("stats") or {})
    for key in (
        "games_played", "wins", "losses", "draws", "rounds_won", "normal_wins",
        "koth_wins", "grand_slam_wins", "team_tricks_won", "match_duration_seconds_total",
        "match_duration_count",
    ):
        try:
            current_stats[key] = max(0, int(current_stats.get(key) or 0))
        except (TypeError, ValueError):
            current_stats[key] = 0

    current_progression = deepcopy(user.get("progression") or {})
    unlocks = deepcopy(user.get("achievement_unlocks") or {})
    old_xp = current_progression.get("xp")
    if not isinstance(old_xp, int) or old_xp < 0:
        old_xp = xp_for_stats(current_stats)
    old_level = level_for_xp(old_xp)["level"]
    old_best = max(0, int(current_progression.get("best_win_streak") or 0))
    old_streak = max(0, int(current_progression.get("current_win_streak") or 0))
    old_stats = deepcopy(current_stats)

    is_draw = winner_team not in (0, 1)
    won = not is_draw and team == winner_team
    current_stats["games_played"] += 1
    if is_draw:
        current_stats["draws"] += 1
    elif won:
        current_stats["wins"] += 1
    else:
        current_stats["losses"] += 1

    streak = old_streak + 1 if won else 0
    best_streak = max(old_best, streak)
    team_tricks = 0
    if isinstance(tricks_won, list) and team in (0, 1) and len(tricks_won) > team:
        team_tricks = max(0, int(tricks_won[team] or 0))
    current_stats["team_tricks_won"] += team_tricks
    if isinstance(duration_seconds, int) and duration_seconds >= 0:
        current_stats["match_duration_seconds_total"] += duration_seconds
        current_stats["match_duration_count"] += 1

    new_xp = old_xp + MATCH_XP + (WIN_BONUS_XP if won else 0)
    current_progression.update({
        "xp": new_xp,
        "current_win_streak": streak,
        "best_win_streak": best_streak,
        "streaks_initialized": True,
        "last_completed_match_id": game_id,
        "team_tricks_won": current_stats["team_tricks_won"],
        "match_duration_seconds_total": current_stats["match_duration_seconds_total"],
        "match_duration_count": current_stats["match_duration_count"],
        "last_completed_match_at": finished_at,
    })

    # Unlock dates are set only when this match crosses a condition. Existing legacy
    # records can still make an achievement unlocked, without inventing its date.
    old_progression = {"best_win_streak": old_best, "current_win_streak": old_streak}
    new_progression = {"best_win_streak": best_streak, "current_win_streak": streak}
    for achievement in ACHIEVEMENTS:
        old_value = achievement_value(achievement, old_stats, old_progression)
        new_value = achievement_value(achievement, current_stats, new_progression)
        if old_value < achievement["target"] <= new_value and achievement["id"] not in unlocks:
            unlocks[achievement["id"]] = finished_at

    return {
        "stats": current_stats,
        "stats_increment": {
            "games_played": 1,
            "wins": 1 if won else 0,
            "losses": 1 if not is_draw and not won else 0,
            "draws": 1 if is_draw else 0,
            "team_tricks_won": team_tricks,
            "match_duration_seconds_total": duration_seconds if isinstance(duration_seconds, int) and duration_seconds >= 0 else 0,
            "match_duration_count": 1 if isinstance(duration_seconds, int) and duration_seconds >= 0 else 0,
        },
        "progression": current_progression,
        "achievement_unlocks": unlocks,
        "xp_before": old_xp,
        "level_before": old_level,
        "level_after": level_for_xp(new_xp)["level"],
        "won": won,
        "draw": is_draw,
    }

