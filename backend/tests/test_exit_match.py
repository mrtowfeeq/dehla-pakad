"""Exit Match (iteration 4): each seat can cancel, idempotency, post-cancel actions, offline on disconnect.
Run from backend/: RUN_LIVE_TESTS=1 E2E_BASE=<backend url> pytest tests/test_exit_match.py -n 0 -v -s
Reuses existing Clerk users (dev quota full): EXIT_RUN (default 1659). Settings: see live_env.py."""
import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_env  # noqa: E402

BASE_URL = live_env.configure()  # skips unless RUN_LIVE_TESTS=1
from ws_auth import connect_authenticated  # noqa: E402
import e2e_match  # noqa: E402

e2e_match.BASE = BASE_URL
e2e_match.RUN = int(os.environ.get("EXIT_RUN", "1659"))
WS = live_env.websocket_url(BASE_URL)
MSG = "The match has ended because a player exited."


@pytest.fixture(scope="module")
def ps():
    players = [e2e_match.P(i) for i in range(1, 5)]
    for p in players:
        p.api("GET", "/me").raise_for_status()
    return players


def start(ps, bots=0):
    for p in ps:
        me = p.api("GET", "/me").json()
        if me.get("active_game_id"):
            p.api("POST", f"/games/{me['active_game_id']}/exit")
        if me.get("lobby_code"):
            p.api("POST", f"/rooms/{me['lobby_code']}/leave")
        p.api("POST", "/matchmaking/leave")
    host = ps[0]
    code = host.api("POST", "/rooms", json={"target": 5}).json()["code"]
    for p in ps[1:]:
        assert p.api("POST", f"/rooms/{code}/join").status_code == 200
    for _ in range(bots):
        host.api("POST", f"/rooms/{code}/bots").raise_for_status()
    for p in ps:
        p.api("POST", f"/rooms/{code}/ready", json={"ready": True}).raise_for_status()
    r = host.api("POST", f"/rooms/{code}/start")
    assert r.status_code == 200, r.text
    return code, r.json()["game_id"]


async def collect(ws, bucket):
    try:
        async for raw in ws:
            bucket.append(json.loads(raw))
    except Exception:
        pass


# Exit Match: every seat (0..3) can trigger cancellation via REST; all 4 get exactly one notice
@pytest.mark.parametrize("exit_seat", [0, 1, 2, 3])
def test_each_seat_can_exit(ps, exit_seat):
    async def run():
        code, gid = start(ps)
        by_seat = {p.api("GET", f"/games/{gid}").json()["state"]["my_seat"]: p for p in ps}
        msgs, socks = {}, []
        for p in ps:
            msgs[p.name] = []
            ws = await connect_authenticated(WS, p.tok)
            socks.append(ws)
            asyncio.create_task(collect(ws, msgs[p.name]))
        await asyncio.sleep(1)
        r = await asyncio.to_thread(by_seat[exit_seat].api, "POST", f"/games/{gid}/exit")
        assert r.status_code == 200 and r.json()["status"] == "cancelled"
        await asyncio.sleep(1.5)
        for p in ps:
            got = [m for m in msgs[p.name] if m["type"] == "match_cancelled"]
            assert len(got) == 1 and got[0]["message"] == MSG and got[0]["game_id"] == gid, (p.name, got)
            g = p.api("GET", f"/games/{gid}").json()
            assert g["status"] == "cancelled" and g["state"]["cancelled_by"] == exit_seat
            assert p.api("GET", "/me").json()["active_game_id"] is None
        for ws in socks:
            await ws.close()
    asyncio.run(run())


# Exit during play (after trump): scores stay as-is, later play is rejected
def test_exit_mid_play_and_actions_rejected(ps):
    async def run():
        code, gid = start(ps)
        by_seat = {p.api("GET", f"/games/{gid}").json()["state"]["my_seat"]: p for p in ps}
        st = by_seat[0].api("GET", f"/games/{gid}").json()["state"]
        sel = by_seat[st["trump_selector"]]
        ws = await connect_authenticated(WS, sel.tok)
        bucket = []
        asyncio.create_task(collect(ws, bucket))
        await ws.send(json.dumps({"type": "game_action", "game_id": gid, "action": "select_trump", "suit": "H"}))
        await asyncio.sleep(1)
        st = by_seat[0].api("GET", f"/games/{gid}").json()["state"]
        assert st["phase"] == "playing"
        scores = st["scores"]
        assert by_seat[2].api("POST", f"/games/{gid}/exit").status_code == 200
        g = by_seat[0].api("GET", f"/games/{gid}").json()
        assert g["status"] == "cancelled" and g["state"]["scores"] == scores
        turn_p = by_seat[st["turn"]]
        ws2 = await connect_authenticated(WS, turn_p.tok)
        b2 = []
        asyncio.create_task(collect(ws2, b2))
        await asyncio.sleep(0.5)
        mark = len(b2)
        await ws2.send(json.dumps({"type": "game_action", "game_id": gid, "action": "play", "card": "AS"}))
        await asyncio.sleep(0.8)
        after = b2[mark:]
        assert after and after[0]["type"] == "error", after
        # second exit is idempotent
        assert by_seat[1].api("POST", f"/games/{gid}/exit").status_code == 200
        await ws.close()
        await ws2.close()
    asyncio.run(run())


# Non-member cannot exit someone else's game
def test_non_member_exit_404(ps):
    code, gid = start(ps[:1], bots=3)
    outsider = ps[1]
    r = outsider.api("POST", f"/games/{gid}/exit")
    assert r.status_code == 404
    assert ps[0].api("GET", f"/games/{gid}").json()["status"] == "active"
    assert ps[0].api("POST", f"/games/{gid}/exit").status_code == 200


# Temporary disconnect: status active, other players see online False, reconnect -> True
def test_disconnect_shows_offline_not_cancel(ps):
    async def run():
        code, gid = start(ps)
        socks = {}
        states = {p.name: [] for p in ps}
        for p in ps:
            socks[p.name] = await connect_authenticated(WS, p.tok)
            asyncio.create_task(collect(socks[p.name], states[p.name]))
        await asyncio.sleep(1)
        victim = ps[3]
        await socks[victim.name].close()
        await asyncio.sleep(1.5)
        g = ps[0].api("GET", f"/games/{gid}").json()
        assert g["status"] == "active"
        vp = [pl for pl in g["players"] if pl["user_id"] == victim.uid][0]
        assert vp["online"] is False
        socks[victim.name] = await connect_authenticated(WS, victim.tok)
        await asyncio.sleep(1)
        g = ps[0].api("GET", f"/games/{gid}").json()
        assert [pl for pl in g["players"] if pl["user_id"] == victim.uid][0]["online"] is True
        assert victim.api("GET", "/me").json()["active_game_id"] == gid
        ps[0].api("POST", f"/games/{gid}/exit")
        for ws in socks.values():
            await ws.close()
    asyncio.run(run())
