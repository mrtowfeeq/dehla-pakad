import asyncio
import copy
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from pydantic import TypeAdapter, ValidationError
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import Match, legal_cards  # noqa: E402
from game_service import (  # noqa: E402
    DEFAULT_TURN_DURATION,
    PUBLIC_TURN_DURATION,
    TURN_DURATIONS,
    TURN_GRACE_SECONDS,
    TurnDuration,
    GameService,
    Hub,
    validate_turn_duration,
)
import game_service as game_service_module  # noqa: E402


class MemoryCollection:
    def __init__(self, documents=()):
        self.documents = [copy.deepcopy(document) for document in documents]

    @staticmethod
    def matches(document, query):
        for key, expected in query.items():
            actual = document
            for part in key.split("."):
                actual = actual.get(part) if isinstance(actual, dict) else None
            if isinstance(expected, dict) and "$in" in expected:
                if actual not in expected["$in"]:
                    return False
            elif isinstance(expected, dict) and "$ne" in expected:
                if actual == expected["$ne"]:
                    return False
            elif actual != expected and not (isinstance(actual, list) and expected in actual):
                return False
        return True

    async def find_one(self, query, projection=None):
        return copy.deepcopy(next((d for d in self.documents if self.matches(d, query)), None))

    async def insert_one(self, document):
        self.documents.append(copy.deepcopy(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def update_one(self, query, update, upsert=False):
        document = next((d for d in self.documents if self.matches(d, query)), None)
        if document is None and upsert:
            document = copy.deepcopy(update.get("$setOnInsert", {}))
            document.update({key: value for key, value in query.items() if not key.startswith("$")})
            self.documents.append(document)
            return SimpleNamespace(upserted_id=document.get("id", query.get("game_id")))
        if document is None:
            return SimpleNamespace(upserted_id=None)
        for path, value in update.get("$set", {}).items():
            target = document
            parts = path.split(".")
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = copy.deepcopy(value)
        for path, amount in update.get("$inc", {}).items():
            target = document
            parts = path.split(".")
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = target.get(parts[-1], 0) + amount
        return SimpleNamespace(upserted_id=None)

    async def update_many(self, query, update):
        for document in self.documents:
            if self.matches(document, query):
                for path, amount in update.get("$inc", {}).items():
                    target = document
                    parts = path.split(".")
                    for part in parts[:-1]:
                        target = target.setdefault(part, {})
                    target[parts[-1]] = target.get(parts[-1], 0) + amount
        return SimpleNamespace(modified_count=0)


class MemoryDatabase:
    def __init__(self):
        self.games = MemoryCollection()
        self.matches = MemoryCollection()
        self.rooms = MemoryCollection([{"code": "TIMER1", "status": "playing"}])
        self.game_events = MemoryCollection()
        self.users = MemoryCollection()


def make_service_game(now, *, duration=30, is_public=False, bot_seat=None, schedule_turn_timers=False, sleep=asyncio.sleep):
    match = Match.new(dealer=0, target=7)
    selector = match.s["trump_selector"]
    match.select_trump(selector, "S")
    players = [
        {"user_id": f"player-{seat}", "seat": seat, "team": seat % 2,
         "username": f"Player {seat}", "is_bot": seat == bot_seat}
        for seat in range(4)
    ]
    game = {
        "id": "timer-game", "room_code": "TIMER1", "is_public": is_public,
        "has_bots": bot_seat is not None, "players": players, "state": match.s,
        "status": "active", "turn_duration": duration,
        "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-01-01T00:00:00+00:00",
    }
    db = MemoryDatabase()
    service = GameService(db, Hub(), clock=lambda: now[0], schedule_turn_timers=schedule_turn_timers, sleep=sleep)
    service.games[game["id"]] = game
    service._assign_turn_deadline(game)
    db.games.documents.append(copy.deepcopy(game))
    return service, game


def run(coro):
    return asyncio.run(coro)


def test_allowed_turn_durations_and_default_are_consistent():
    api_duration = TypeAdapter(TurnDuration)
    assert DEFAULT_TURN_DURATION == PUBLIC_TURN_DURATION == 30
    assert TURN_DURATIONS == (15, 20, 30, 45, 60)
    for duration in TURN_DURATIONS:
        assert validate_turn_duration(duration) == duration
        assert api_duration.validate_python(duration) == duration
    for duration in (0, 10, 25, 90, True, "30"):
        try:
            validate_turn_duration(duration)
        except ValueError:
            pass
        else:
            raise AssertionError(f"accepted unsupported duration: {duration!r}")
    with pytest.raises(ValidationError):
        api_duration.validate_python(25)


def test_deadline_is_shared_by_all_players_and_survives_reconnect_sync():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=45)
    deadline = game["turn_deadline"]
    expected = datetime.fromtimestamp(now[0] + 45, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    assert deadline == expected

    now[0] += 12
    snapshots = [service.view_for(game, player["user_id"]) for player in game["players"]]
    assert {snapshot["turn_deadline"] for snapshot in snapshots} == {deadline}
    assert {snapshot["turn_duration"] for snapshot in snapshots} == {45}
    assert {snapshot["turn_phase"] for snapshot in snapshots} == {"normal"}
    assert {snapshot["turn_grace_deadline"] for snapshot in snapshots} == {None}
    assert {snapshot["server_time"] for snapshot in snapshots} == {
        datetime.fromtimestamp(now[0], timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    }

    reconnecting_socket = object()
    service.hub.add("player-0", reconnecting_socket)
    assert service.view_for(game, "player-0")["players"][0]["online"] is True
    service.hub.remove("player-0", reconnecting_socket)
    recovered = run(service.get(game["id"]))
    assert recovered["turn_deadline"] == deadline
    assert recovered["turn_phase"] == "normal"
    assert service.view_for(recovered, "player-0")["players"][0]["online"] is False


def test_game_creation_persists_private_choice_and_fixed_public_duration():
    now = [1_800_000_000.0]
    db = MemoryDatabase()
    ids = [f"player-{seat}" for seat in range(4)]
    db.users.documents = [{"user_id": uid, "username": uid} for uid in ids]
    service = GameService(db, Hub(), clock=lambda: now[0], schedule_turn_timers=False)

    private = run(service.create({
        "code": "PRIVATE", "is_public": False, "seats": ids, "dealer_seat": 0,
        "target": 7, "turn_duration": 45,
    }))
    public = run(service.create({
        "code": "PUBLIC", "is_public": True, "seats": ids, "dealer_seat": 0,
        "target": 7, "turn_duration": 45,
    }))

    assert private["turn_duration"] == 45
    assert private["turn_deadline"] == datetime.fromtimestamp(now[0] + 45, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    assert public["turn_duration"] == PUBLIC_TURN_DURATION
    assert public["turn_deadline"] == datetime.fromtimestamp(now[0] + PUBLIC_TURN_DURATION, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def test_existing_public_match_keeps_its_configured_duration_after_reconnect(monkeypatch):
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=PUBLIC_TURN_DURATION, is_public=True)
    deadline = game["turn_deadline"]
    now[0] += 5
    monkeypatch.setattr(game_service_module, "PUBLIC_TURN_DURATION", 45)

    assert service._ensure_turn_deadline(game) is False
    assert game["turn_duration"] == 30
    assert game["turn_deadline"] == deadline


def test_normal_deadline_starts_persisted_grace_without_changing_active_player():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    hand_before = list(game["state"]["hands"][seat])
    normal_deadline = game["turn_deadline"]
    old_turn_id = game["turn_id"]
    normal_token = service._timer_token(game)
    now[0] += 15

    result = run(service._timeout_turn(game["id"], normal_token))

    expected_grace = datetime.fromtimestamp(now[0] + TURN_GRACE_SECONDS, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    assert result == "grace"
    assert game["turn_phase"] == "grace"
    assert game["turn_deadline"] == normal_deadline
    assert game["turn_grace_deadline"] == expected_grace
    assert game["turn_id"] == old_turn_id
    assert game["state"]["turn"] == seat
    assert game["state"]["hands"][seat] == hand_before
    assert service.db.games.documents[0]["turn_phase"] == "grace"
    assert service.db.games.documents[0]["turn_grace_deadline"] == expected_grace
    assert [event["type"] for event in service.db.game_events.documents].count("turn_grace_started") == 1


def test_grace_countdown_is_shared_and_does_not_act_before_five_seconds():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    hand_before = list(game["state"]["hands"][seat])
    now[0] += 15
    assert run(service._timeout_turn(game["id"], service._timer_token(game))) == "grace"
    grace_token = service._timer_token(game)

    first = [service.view_for(game, player["user_id"]) for player in game["players"]]
    assert {snapshot["turn_phase"] for snapshot in first} == {"grace"}
    assert {snapshot["turn_grace_deadline"] for snapshot in first} == {game["turn_grace_deadline"]}
    assert deadline_timestamp_for_test(game["turn_grace_deadline"]) - now[0] == TURN_GRACE_SECONDS

    now[0] += 4
    assert run(service._timeout_turn(game["id"], grace_token)) is None
    later = service.view_for(game, "player-0")
    assert deadline_timestamp_for_test(later["turn_grace_deadline"]) - now[0] == 1
    assert game["state"]["hands"][seat] == hand_before
    assert game["state"]["turn"] == seat


def deadline_timestamp_for_test(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def test_reconnect_during_grace_preserves_remaining_deadline():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    now[0] += 15
    run(service._timeout_turn(game["id"], service._timer_token(game)))
    grace_deadline = game["turn_grace_deadline"]
    turn_id = game["turn_id"]
    now[0] += 3

    restarted = GameService(service.db, Hub(), clock=lambda: now[0], schedule_turn_timers=False)
    recovered = run(restarted.get(game["id"]))

    assert recovered["turn_phase"] == "grace"
    assert recovered["turn_grace_deadline"] == grace_deadline
    assert recovered["turn_id"] == turn_id
    assert deadline_timestamp_for_test(grace_deadline) - now[0] == 2


def test_valid_manual_card_during_grace_cancels_auto_play_and_resets_next_turn_timer():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    card = Match(game["state"]).view(seat)["legal"][0]
    old_turn_id = game["turn_id"]
    now[0] += 17

    response = run(service.handle(f"player-{seat}", {
        "game_id": game["id"], "action": "play", "card": card,
    }))

    assert response is None
    assert game["state"]["trick"] == [[seat, card]]
    assert len(game["state"]["hands"][seat]) == 12
    assert game["turn_id"] != old_turn_id
    assert game["turn_phase"] == "normal"
    assert game["turn_grace_deadline"] is None
    assert [event["type"] for event in service.db.game_events.documents].count("turn_auto_play") == 0


def test_grace_expiry_automatically_plays_a_legal_card_once():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    legal = legal_cards(game["state"]["hands"][seat], game["state"]["trick"])
    expected_card = legal[0]
    now[0] += 15
    assert run(service._timeout_turn(game["id"], service._timer_token(game))) == "grace"
    grace_token = service._timer_token(game)
    now[0] += TURN_GRACE_SECONDS

    result = run(service._timeout_turn(game["id"], grace_token))

    assert result == "auto_play"
    assert game["state"]["trick"] == [[seat, expected_card]]
    assert expected_card not in game["state"]["hands"][seat]
    assert game["turn_id"] != grace_token[0]
    assert game["turn_phase"] == "normal"
    assert [event["type"] for event in service.db.game_events.documents].count("turn_auto_play") == 1


def test_automatic_play_obeys_follow_suit_validation():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    game["state"]["trick"] = [[(seat + 3) % 4, "AH"]]
    game["state"]["hands"][seat] = ["KS", "9H"]
    game["state"]["seq"] += 1
    service._assign_turn_deadline(game)
    legal = legal_cards(game["state"]["hands"][seat], game["state"]["trick"])
    assert legal == ["9H"]

    now[0] += 15
    run(service._timeout_turn(game["id"], service._timer_token(game)))
    grace_token = service._timer_token(game)
    now[0] += TURN_GRACE_SECONDS
    result = run(service._timeout_turn(game["id"], grace_token))

    assert result == "auto_play"
    assert game["state"]["trick"][-1] == [seat, "9H"]
    assert "KS" in game["state"]["hands"][seat]


def test_duplicate_stale_and_concurrent_timeout_events_play_exactly_one_card():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    normal_token = service._timer_token(game)
    now[0] += 15

    assert run(service._timeout_turn(game["id"], normal_token)) == "grace"
    assert run(service._timeout_turn(game["id"], normal_token)) is None
    grace_token = service._timer_token(game)
    now[0] += TURN_GRACE_SECONDS

    async def duplicate_events():
        return await asyncio.gather(
            service._timeout_turn(game["id"], grace_token),
            service._timeout_turn(game["id"], grace_token),
        )

    outcomes = run(duplicate_events())
    assert outcomes.count("auto_play") == 1
    assert sum(len(event["data"].get("card", "")) > 0 for event in service.db.game_events.documents if event["type"] == "turn_auto_play") == 1
    assert len(game["state"]["trick"]) == 1
    assert len(game["state"]["hands"][seat]) == 12


def test_concurrent_manual_submission_at_grace_expiry_cannot_double_play():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    card = Match(game["state"]).view(seat)["legal"][0]
    now[0] += 15
    run(service._timeout_turn(game["id"], service._timer_token(game)))
    grace_token = service._timer_token(game)
    now[0] += TURN_GRACE_SECONDS

    async def race():
        return await asyncio.gather(
            service.handle(f"player-{seat}", {"game_id": game["id"], "action": "play", "card": card}),
            service._timeout_turn(game["id"], grace_token),
        )

    run(race())
    assert len(game["state"]["trick"]) == 1
    assert len(game["state"]["hands"][seat]) == 12
    assert [event["type"] for event in service.db.game_events.documents].count("turn_auto_play") == 1


def test_unavailable_legal_card_uses_engine_forfeit_recovery_without_fabricating_card():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    seat = game["state"]["turn"]
    game["state"]["hands"][seat] = []
    service._assign_turn_deadline(game)
    now[0] += 15
    run(service._timeout_turn(game["id"], service._timer_token(game)))
    grace_token = service._timer_token(game)
    now[0] += TURN_GRACE_SECONDS

    result = run(service._timeout_turn(game["id"], grace_token))

    assert result == "forfeit"
    assert game["state"]["phase"] == "match_over"
    assert game["state"]["forfeited_by"] == seat
    assert not [event for event in service.db.game_events.documents if event["type"] == "turn_auto_play"]
    assert [event["type"] for event in service.db.game_events.documents].count("timeout_auto_play_failed") == 1


def test_end_of_game_cancels_pending_turn_and_grace_timers():
    now = [1_800_000_000.0]

    async def held_sleep(_seconds):
        await asyncio.Event().wait()

    service, game = make_service_game(now, schedule_turn_timers=True, sleep=held_sleep)

    async def finish():
        service._schedule_turn_timeout(game)
        task = service.turn_timers[game["id"]]
        await asyncio.sleep(0)
        Match(game["state"]).forfeit(game["state"]["turn"])
        await service._after_change(game, 0)
        assert task.cancelled() or task.cancelling()

    run(finish())
    assert game["turn_id"] is None
    assert game["turn_deadline"] is None
    assert game["turn_phase"] is None
    assert game["turn_grace_deadline"] is None
    assert game["id"] not in service.turn_timers


def test_timer_scheduler_uses_a_controllable_sleep_without_real_waits():
    now = [1_800_000_000.0]

    class ManualSleeper:
        def __init__(self):
            self.waiters = []

        async def __call__(self, seconds):
            future = asyncio.get_running_loop().create_future()
            self.waiters.append((seconds, future))
            await future

        def release(self, index):
            self.waiters[index][1].set_result(None)

    sleeper = ManualSleeper()
    service, game = make_service_game(now, duration=15, schedule_turn_timers=True, sleep=sleeper)

    async def drive():
        service._schedule_turn_timeout(game)
        original = service.turn_timers[game["id"]]
        await asyncio.sleep(0)
        assert sleeper.waiters[0][0] == 15
        now[0] += 15
        sleeper.release(0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert game["turn_phase"] == "grace"
        assert sleeper.waiters[1][0] == TURN_GRACE_SECONDS
        now[0] += TURN_GRACE_SECONDS
        sleeper.release(1)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await original
        assert any(event["type"] == "turn_auto_play" for event in service.db.game_events.documents)
        service._cancel_turn_timeout(game["id"])

    run(drive())


def test_successful_action_resets_deadline_for_next_turn():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=20)
    previous_deadline = game["turn_deadline"]
    seat = game["state"]["turn"]
    card = Match(game["state"]).view(seat)["legal"][0]
    now[0] += 7
    Match(game["state"]).play(seat, card)

    run(service._after_change(game, 0))

    expected = datetime.fromtimestamp(now[0] + 20, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    assert game["turn_deadline"] == expected
    assert game["turn_deadline"] != previous_deadline
    assert game["turn_id"] == f"{game['state']['seq']}:{game['state']['phase']}:{game['state']['turn']}"


def test_stale_timeout_job_cannot_act_after_turn_changes():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=15)
    old_token = service._timer_token(game)
    seat = game["state"]["turn"]
    card = Match(game["state"]).view(seat)["legal"][0]

    assert run(service.handle(f"player-{seat}", {
        "game_id": game["id"], "action": "play", "card": card,
    })) is None
    next_seat = game["state"]["turn"]
    next_hand = list(game["state"]["hands"][next_seat])
    now[0] += 15

    assert run(service._timeout_turn(game["id"], old_token)) is None
    assert game["state"]["turn"] == next_seat
    assert game["state"]["hands"][next_seat] == next_hand
    assert not [event for event in service.db.game_events.documents if event["type"] == "turn_auto_play"]


def test_bot_turn_keeps_the_shared_deadline_and_game_completion_clears_it():
    now = [1_800_000_000.0]
    service, game = make_service_game(now, duration=30, bot_seat=1)
    deadline = game["turn_deadline"]
    assert service._turn_seat(game) == 1
    assert service._bot_turn(game) == ("play", 1)
    assert service.view_for(game, "player-0")["turn_deadline"] == deadline

    match = Match(game["state"])
    match.forfeit(1)

    async def complete():
        service.schedule_turn_timers = True
        service._schedule_turn_timeout(game)
        task = service.turn_timers[game["id"]]
        service._schedule_turn_timeout(game)
        assert service.turn_timers[game["id"]] is task
        await service._after_change(game, 0)

    run(complete())

    assert game["status"] == "finished"
    assert game["turn_deadline"] is None and game["turn_id"] is None
    assert game["turn_phase"] is None and game["turn_grace_deadline"] is None
    assert game["id"] not in service.turn_timers


def test_bot_turn_plays_normally_before_deadline_without_timeout_interference():
    now = [1_800_000_000.0]
    async def no_wait(_seconds):
        await asyncio.sleep(0)

    service, game = make_service_game(now, duration=15, bot_seat=1, sleep=no_wait)
    hand_before = list(game["state"]["hands"][1])
    run(service._run_bots(game["id"]))

    assert len(game["state"]["hands"][1]) == len(hand_before) - 1
    assert game["state"]["trick"][0][0] == 1
    assert game["turn_phase"] == "normal"
    assert any(event["type"] == "play" and event["data"].get("bot") for event in service.db.game_events.documents)
    assert not [event for event in service.db.game_events.documents if event["type"] == "turn_auto_play"]


def test_bot_may_finish_its_action_during_grace_before_server_auto_play():
    now = [1_800_000_000.0]

    async def no_wait(_seconds):
        await asyncio.sleep(0)

    service, game = make_service_game(now, duration=15, bot_seat=1, sleep=no_wait)
    now[0] += 15

    run(service._run_bots(game["id"]))

    assert game["state"]["trick"][0][0] == 1
    assert game["turn_phase"] == "normal"
    assert any(event["type"] == "play" and event["data"].get("bot") for event in service.db.game_events.documents)
    assert not [event for event in service.db.game_events.documents if event["type"] == "turn_auto_play"]
