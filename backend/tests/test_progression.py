import asyncio
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from progression import (  # noqa: E402
    achievement_cards,
    ensure_streak_history,
    level_for_xp,
    match_profile_update,
    public_progression,
)


def run(coro):
    return asyncio.run(coro)


class Cursor:
    def __init__(self, docs):
        self.docs = docs
        self.index = 0

    def sort(self, key, direction=1):
        self.docs.sort(key=lambda doc: doc.get(key) or "", reverse=direction < 0)
        return self

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.index >= len(self.docs):
            raise StopAsyncIteration
        result = copy.deepcopy(self.docs[self.index])
        self.index += 1
        return result


class FakeCollection:
    def __init__(self, docs):
        self.docs = docs

    @staticmethod
    def matches(doc, query):
        for key, expected in query.items():
            value = doc
            for part in key.split("."):
                value = value.get(part) if isinstance(value, dict) else None
            if isinstance(expected, dict) and "$ne" in expected:
                if value == expected["$ne"]:
                    return False
            elif value != expected and not (isinstance(value, list) and expected in value):
                return False
        return True

    async def find_one(self, query, projection=None):
        return copy.deepcopy(next((doc for doc in self.docs if self.matches(doc, query)), None))

    def find(self, query, projection=None):
        return Cursor([doc for doc in self.docs if self.matches(doc, query)])

    async def update_one(self, query, update):
        doc = next((item for item in self.docs if self.matches(item, query)), None)
        if doc:
            for key, value in update.get("$set", {}).items():
                doc[key] = copy.deepcopy(value)


class FakeDatabase:
    def __init__(self, user, matches):
        self.users = FakeCollection([copy.deepcopy(user)])
        self.matches = FakeCollection(copy.deepcopy(matches))


def test_xp_levels_and_legacy_progression_are_derived_consistently():
    assert level_for_xp(0) == {"level": 1, "xp": 0, "xp_in_level": 0, "xp_to_next_level": 500, "progress_percent": 0}
    assert level_for_xp(525)["level"] == 2
    assert level_for_xp(525)["xp_in_level"] == 25
    assert public_progression({"stats": {"games_played": 3, "wins": 2}})["xp"] == 400


def test_completed_match_awards_xp_stats_streak_and_unlocks_from_server_values():
    result = match_profile_update(
        {"stats": {"games_played": 9, "wins": 4, "losses": 5}, "progression": {"xp": 1100, "current_win_streak": 4, "best_win_streak": 4}},
        game_id="completed-1", team=0, winner_team=0, tricks_won=[7, 6], duration_seconds=900,
        finished_at="2026-11-25T12:00:00+00:00",
    )

    assert result["stats"]["games_played"] == 10
    assert result["stats"]["wins"] == 5
    assert result["stats_increment"]["team_tricks_won"] == 7
    assert result["progression"]["xp"] == 1250
    assert result["level_before"] == 3 and result["level_after"] == 3
    assert result["progression"]["current_win_streak"] == 5
    assert result["achievement_unlocks"]["getting_started"] == "2026-11-25T12:00:00+00:00"
    assert result["achievement_unlocks"]["winning_streak"] == "2026-11-25T12:00:00+00:00"


def test_loss_resets_streak_and_draw_is_not_counted_as_a_loss():
    loss = match_profile_update(
        {"stats": {"games_played": 3, "wins": 2, "losses": 1}, "progression": {"xp": 500, "current_win_streak": 2, "best_win_streak": 2}},
        game_id="loss", team=0, winner_team=1, tricks_won=[5, 8], duration_seconds=None, finished_at="finished",
    )
    draw = match_profile_update(
        {"stats": {"games_played": 0, "wins": 0, "losses": 0}, "progression": {}},
        game_id="draw", team=0, winner_team=None, tricks_won=[6, 7], duration_seconds=None, finished_at="finished",
    )
    assert loss["progression"]["current_win_streak"] == 0
    assert loss["progression"]["best_win_streak"] == 2
    assert draw["draw"] is True and draw["stats"]["draws"] == 1
    assert draw["stats"]["losses"] == 0


def test_legacy_matches_backfill_streak_tricks_and_duration_without_loading_full_documents():
    matches = [
        {"game_id": "a", "player_ids": ["u1"], "has_bots": False, "winner_team": 0,
         "players": [{"user_id": "u1", "team": 0}], "tricks_won": [7, 6], "duration_seconds": 600,
         "finished_at": "2026-01-01T00:10:00+00:00"},
        {"game_id": "b", "player_ids": ["u1"], "has_bots": False, "winner_team": 0,
         "players": [{"user_id": "u1", "team": 0}], "rounds": [{"tricks_won": [5, 8]}],
         "started_at": "2026-01-02T00:00:00+00:00", "finished_at": "2026-01-02T00:10:00+00:00"},
        {"game_id": "practice", "player_ids": ["u1"], "has_bots": True, "winner_team": 0,
         "players": [{"user_id": "u1", "team": 0}], "tricks_won": [13, 0], "duration_seconds": 100,
         "finished_at": "2026-01-03T00:00:00+00:00"},
    ]
    user = {"user_id": "u1", "stats": {"games_played": 2}, "progression": {}}
    db = FakeDatabase(user, matches)

    migrated = run(ensure_streak_history(db, "u1", user))

    assert migrated["progression"]["current_win_streak"] == 2
    assert migrated["progression"]["best_win_streak"] == 2
    assert migrated["progression"]["team_tricks_won"] == 12
    assert migrated["progression"]["match_duration_seconds_total"] == 1200
    assert migrated["progression"]["match_duration_count"] == 2


def test_progression_backfill_ignores_matches_from_other_environments():
    user = {"user_id": "u1", "env": "preview", "stats": {"games_played": 1}, "progression": {}}
    matches = [
        {"env": "preview", "game_id": "preview-win", "player_ids": ["u1"], "has_bots": False,
         "winner_team": 0, "players": [{"user_id": "u1", "team": 0}], "tricks_won": [7, 6],
         "duration_seconds": 600, "finished_at": "2026-01-01T00:10:00+00:00"},
        {"env": "live", "game_id": "live-loss", "player_ids": ["u1"], "has_bots": False,
         "winner_team": 1, "players": [{"user_id": "u1", "team": 0}], "tricks_won": [5, 8],
         "duration_seconds": 600, "finished_at": "2026-01-02T00:10:00+00:00"},
    ]
    db = FakeDatabase(user, matches)

    migrated = run(ensure_streak_history(db, "u1", user, env="preview"))

    assert migrated["progression"]["current_win_streak"] == 1
    assert migrated["progression"]["team_tricks_won"] == 7
    assert migrated["progression"]["match_duration_count"] == 1


def test_locked_and_unlocked_achievement_progress_is_backend_shaped():
    cards = achievement_cards({"wins": 3, "games_played": 7}, {"best_win_streak": 2}, {"first_victory": "2026-01-01T00:00:00+00:00"})
    first = next(card for card in cards if card["id"] == "first_victory")
    started = next(card for card in cards if card["id"] == "getting_started")
    assert first["unlocked"] is True and first["progress"] == 1 and first["unlocked_at"]
    assert started["unlocked"] is False and started["progress"] == 7
