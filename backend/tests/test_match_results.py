import asyncio
import copy
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import Match  # noqa: E402
from game_service import GameService, Hub  # noqa: E402


class Cursor:
    def __init__(self, docs):
        self.docs = docs
        self.index = 0

    def __aiter__(self):
        return self

    def sort(self, key, direction=1):
        self.docs.sort(key=lambda doc: doc.get(key) or "", reverse=direction < 0)
        return self

    async def __anext__(self):
        if self.index >= len(self.docs):
            raise StopAsyncIteration
        doc = self.docs[self.index]
        self.index += 1
        return copy.deepcopy(doc)


class Collection:
    def __init__(self, name, db, docs=None):
        self.name = name
        self.db = db
        self.docs = docs or []

    @staticmethod
    def _matches(doc, query):
        for key, expected in query.items():
            value = doc
            for part in key.split("."):
                value = value.get(part) if isinstance(value, dict) else None
            if isinstance(expected, dict) and "$in" in expected:
                if value not in expected["$in"]:
                    return False
            elif isinstance(expected, dict) and "$ne" in expected:
                if value == expected["$ne"]:
                    return False
            elif value != expected and not (isinstance(value, list) and expected in value):
                return False
        return True

    async def find_one(self, query, projection=None):
        doc = next((d for d in self.docs if self._matches(d, query)), None)
        return copy.deepcopy(doc) if doc else None

    def find(self, query, projection=None):
        return Cursor([d for d in self.docs if self._matches(d, query)])

    async def insert_one(self, doc):
        saved = copy.deepcopy(doc)
        self.docs.append(saved)
        self.db.events.append((self.name, "insert", saved.get("id")))
        return SimpleNamespace(inserted_id=saved.get("id"))

    async def update_one(self, query, update, upsert=False):
        doc = next((d for d in self.docs if self._matches(d, query)), None)
        if doc is None and upsert:
            doc = {k: v for k, v in query.items() if not k.startswith("$")}
            doc.update(copy.deepcopy(update.get("$setOnInsert", {})))
            self.docs.append(doc)
            self.db.events.append((self.name, "upsert", query.get("game_id")))
            return SimpleNamespace(upserted_id=doc.get("id", query.get("game_id")))
        if doc is None:
            return SimpleNamespace(upserted_id=None)
        self._apply(doc, update)
        self.db.events.append((self.name, "update", query.get("id", query.get("user_id", query.get("code")))))
        return SimpleNamespace(upserted_id=None)

    async def update_many(self, query, update):
        count = 0
        for doc in self.docs:
            if self._matches(doc, query):
                self._apply(doc, update)
                count += 1
        return SimpleNamespace(modified_count=count)

    @staticmethod
    def _apply(doc, update):
        for key, value in update.get("$set", {}).items():
            doc[key] = copy.deepcopy(value)
        for path, amount in update.get("$inc", {}).items():
            target = doc
            parts = path.split(".")
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = target.get(parts[-1], 0) + amount


class Database:
    def __init__(self, game):
        self.events = []
        self.games = Collection("games", self, [copy.deepcopy(game)])
        self.matches = Collection("matches", self)
        self.rooms = Collection("rooms", self, [{"code": game["room_code"], "status": "playing"}])
        self.users = Collection("users", self, [
            {"user_id": p["user_id"], "stats": {"games_played": 0, "wins": 0, "losses": 0}}
            for p in game["players"]
        ])


def make_finished_game(status="active"):
    match = Match.new(dealer=0, target=5)
    state = match.s
    state.update(
        phase="match_over",
        scores=[5, 4],
        winner_team=0,
        round_no=3,
        rounds=[
            {"round": 1, "winner_team": 0, "type": "normal", "points": 1, "reason": "three_tens", "tricks_won": [7, 6], "tens": [3, 1]},
            {"round": 2, "winner_team": 1, "type": "koth", "points": 2, "reason": "koth_fourth_ten", "tricks_won": [5, 8], "tens": [1, 3]},
            {"round": 3, "winner_team": 0, "type": "normal", "points": 1, "reason": "three_tens", "tricks_won": [8, 5], "tens": [3, 1]},
        ],
        tricks_won=[8, 5],
        trump="H",
        last_trick={"cards": [[0, "AH"], [1, "KH"], [2, "QH"], [3, "JH"]], "winner": 0},
        result={"winner_team": 0, "type": "normal", "points": 1, "reason": "three_tens", "tricks_won": [8, 5], "tens": [3, 1]},
        forfeited_by=None,
    )
    players = [
        {"user_id": f"user-{seat}", "seat": seat, "team": seat % 2, "username": f"Player {seat + 1}", "avatar_color": "#345", "avatar_icon": "star", "is_bot": False}
        for seat in range(4)
    ]
    return {
        "id": "game-result-1", "room_code": "PRIVATE1", "is_public": False, "has_bots": False,
        "players": players, "state": state, "status": status,
        "created_at": "2026-11-25T10:00:00+00:00", "updated_at": "2026-11-25T10:30:00+00:00",
        "finished_at": "2026-11-25T10:30:00+00:00",
    }


def run(coro):
    return asyncio.run(coro)


def test_terminal_game_and_authoritative_summary_are_saved_before_match_history():
    game = make_finished_game()
    db = Database(game)
    service = GameService(db, Hub())
    service.games[game["id"]] = game

    run(service._after_change(game, len(game["state"]["rounds"])))

    saved_game = db.games.docs[0]
    assert saved_game["status"] == "finished"
    assert saved_game["state"]["phase"] == "match_over"
    summary = saved_game["result_summary"]
    assert summary["winner_team"] == 0
    assert summary["scores"] == [5, 4]
    assert summary["tricks_won"] == [20, 19]
    assert summary["total_tricks"] == 39
    assert summary["rounds_played"] == 3
    assert summary["duration_seconds"] == 1800
    assert summary["final_trump"] == "H"
    assert len(db.matches.docs) == 1
    assert db.matches.docs[0]["result_summary"] == summary
    event_names = [event[0] for event in db.events]
    assert event_names.index("games") < event_names.index("matches")


def test_repeated_completion_persists_one_history_record_and_updates_game_stats_once():
    game = make_finished_game()
    db = Database(game)
    service = GameService(db, Hub())

    run(service._persist_completed_game(game))
    run(service._persist_completed_game(game))

    assert len(db.matches.docs) == 1
    for user in db.users.docs:
        assert user["stats"]["games_played"] == 1
        assert user["stats"]["wins"] == (1 if user["user_id"] in ("user-0", "user-2") else 0)
        assert user["stats"]["losses"] == (0 if user["user_id"] in ("user-0", "user-2") else 1)
        assert user["progression"]["xp"] == (150 if user["stats"]["wins"] else 100)
        assert user["progression"]["team_tricks_won"] == (20 if user["stats"]["wins"] else 19)
        assert user["progression"]["match_duration_count"] == 1


def test_finished_game_refresh_and_sync_recovery_return_one_result_to_all_seats():
    game = make_finished_game(status="finished")
    db = Database(game)
    service = GameService(db, Hub())

    loaded = run(service.get(game["id"]))
    snapshots = [service.view_for(loaded, player["user_id"]) for player in game["players"]]

    assert len(db.matches.docs) == 1
    assert all(snapshot["state"]["phase"] == "match_over" for snapshot in snapshots)
    assert all(snapshot["status"] == "finished" for snapshot in snapshots)
    assert all(snapshot["result_summary"] == snapshots[0]["result_summary"] for snapshot in snapshots)
    assert [player["username"] for player in db.matches.docs[0]["players"]] == [f"Player {i}" for i in range(1, 5)]


def test_startup_repairs_a_finished_game_missing_its_history_record():
    game = make_finished_game(status="finished")
    db = Database(game)
    service = GameService(db, Hub())

    run(service.load_active())

    assert len(db.matches.docs) == 1
    assert db.matches.docs[0]["game_id"] == game["id"]
    assert db.matches.docs[0]["scores"] == [5, 4]
