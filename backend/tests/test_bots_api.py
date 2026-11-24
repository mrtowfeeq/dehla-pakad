"""Iteration 3: bot players in private rooms (lobby API + full practice match over WS).
Reuses existing Clerk test users (dev instance is at 100-user quota). Run: pytest tests/test_bots_api.py -n 0 -v -s
Env BOT_RUN selects the existing player{i}_{RUN}+clerk_test users (default set below is a test-data RUN id, not a URL)."""
import asyncio
import json
import os
import random
import sys
import time

import pytest
import websockets

sys.path.insert(0, "/app/backend/tests")
import e2e_match  # noqa: E402

BASE_URL = None
for line in open("/app/frontend/.env"):
    if line.startswith("REACT_APP_BACKEND_URL="):
        BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
e2e_match.BASE = BASE_URL
e2e_match.RUN = int(os.environ.get("BOT_RUN", "1659"))
WS = BASE_URL.replace("http", "ws") + "/api/ws"


@pytest.fixture(scope="module")
def ps():
    out = []
    for i in (1, 2, 3):
        p = e2e_match.P(i)
        assert p.api("GET", "/me").status_code == 200
        p.api("POST", "/matchmaking/leave")
        out.append(p)
    return out


def new_room(p, target=2):
    r = p.api("POST", "/rooms", json={"target": target})
    assert r.status_code == 200, r.text
    return r.json()["code"]


# Lobby: add / fill / full 409 / remove / permissions
def test_add_fill_remove_bots(ps):
    h, other = ps[0], ps[1]
    code = new_room(h)
    r = h.api("POST", f"/rooms/{code}/bots")
    assert r.status_code == 200
    room = r.json()
    b = room["seats"][1]
    assert b["is_bot"] is True and b["username"].startswith("Bot ") and room["ready"][b["user_id"]] is True
    for _ in range(2):
        assert h.api("POST", f"/rooms/{code}/bots").status_code == 200
    room = h.api("GET", f"/rooms/{code}").json()
    names = [s["username"] for s in room["seats"][1:]]
    assert len(set(names)) == 3 and all(s["is_bot"] for s in room["seats"][1:])
    full = h.api("POST", f"/rooms/{code}/bots")
    assert full.status_code == 409
    rm = h.api("DELETE", f"/rooms/{code}/bots/{room['seats'][2]['user_id']}")
    assert rm.status_code == 200 and rm.json()["seats"][2] is None
    assert h.api("DELETE", f"/rooms/{code}/bots/bot_nope").status_code == 404
    # second human joins the free seat
    j = other.api("POST", f"/rooms/{code}/join")
    assert j.status_code == 200 and j.json()["seats"][2]["user_id"] == other.uid
    # non-host cannot add/remove bots
    assert other.api("DELETE", f"/rooms/{code}/bots/{room['seats'][1]['user_id']}").status_code == 403
    # host leaves -> human becomes host; human leaves -> only bots remain -> room deleted
    assert h.api("POST", f"/rooms/{code}/leave").status_code == 200
    room = other.api("GET", f"/rooms/{code}").json()
    assert room["host_id"] == other.uid
    assert other.api("POST", f"/rooms/{code}/leave").status_code == 200
    assert other.api("GET", f"/rooms/{code}").status_code == 404
    assert other.api("POST", f"/rooms/{code}/join").status_code == 404


def test_non_host_cannot_add_bot_and_swap(ps):
    h, other = ps[0], ps[1]
    code = new_room(h)
    other.api("POST", f"/rooms/{code}/join").raise_for_status()
    assert other.api("POST", f"/rooms/{code}/bots").status_code == 403
    h.api("POST", f"/rooms/{code}/bots").raise_for_status()
    room = h.api("GET", f"/rooms/{code}").json()
    ids = [s and s["user_id"] for s in room["seats"]]  # [h, other, bot, None]
    assert ids[2].startswith("bot_")
    # swap partner: put bot opposite host (seat 2 already), move other to seat 3
    ids[1], ids[3] = ids[3], ids[1]
    r = h.api("POST", f"/rooms/{code}/seats", json={"seats": ids})
    assert r.status_code == 200 and r.json()["seats"][3]["user_id"] == other.uid and r.json()["seats"][2]["is_bot"]
    # swap bot to seat 1 (opponent)
    ids[1], ids[2] = ids[2], ids[1]
    r = h.api("POST", f"/rooms/{code}/seats", json={"seats": ids})
    assert r.status_code == 200 and r.json()["seats"][1]["is_bot"] and r.json()["seats"][2] is None
    assert r.json()["ready"][ids[1]] is True  # bots stay ready after re-arrange
    other.api("POST", f"/rooms/{code}/leave")
    h.api("POST", f"/rooms/{code}/leave")
    assert h.api("GET", f"/rooms/{code}").status_code == 404


def test_host_alone_with_bots_leave_deletes_room(ps):
    h = ps[0]
    code = new_room(h)
    for _ in range(3):
        h.api("POST", f"/rooms/{code}/bots").raise_for_status()
    assert h.api("POST", f"/rooms/{code}/start").status_code == 400  # host not ready
    assert h.api("POST", f"/rooms/{code}/leave").status_code == 200
    assert h.api("GET", f"/rooms/{code}").status_code == 404


# Full practice match: 1 human + 3 bots; human partner is a bot -> human must get Koth/GS prompts
def test_full_practice_match_vs_bots(ps):
    h = ps[2]
    me_before = h.api("GET", "/me").json()
    lb_before = h.api("GET", "/leaderboard").json()
    code = new_room(h, target=2)
    for _ in range(3):
        h.api("POST", f"/rooms/{code}/bots").raise_for_status()
    h.api("POST", f"/rooms/{code}/ready", json={"ready": True}).raise_for_status()
    gid = h.api("POST", f"/rooms/{code}/start").json()["game_id"]
    stats = asyncio.run(_play(h, gid))
    print("match stats", stats)
    assert stats["bot_moves"] > 0 and stats["phase"] == "match_over"
    assert not stats.get("errors"), stats.get("errors")
    time.sleep(1)
    me_after = h.api("GET", "/me").json()
    assert me_after["stats"] == me_before["stats"]
    hist = h.api("GET", "/matches").json()
    assert hist[0]["game_id"] == gid and hist[0]["has_bots"] is True
    lb_after = h.api("GET", "/leaderboard").json()
    assert [(x["user_id"], x["stats"]) for x in lb_after] == [(x["user_id"], x["stats"]) for x in lb_before]
    assert not any(x["user_id"].startswith("bot_") for x in lb_after)


async def _play(h, gid):
    ws = await websockets.connect(f"{WS}?token={h.tok}")
    await ws.send(json.dumps({"type": "sync_game", "game_id": gid}))
    rnd = random.Random(7)
    res = {"bot_moves": 0, "koth_seen_my_team": False, "koth_waited_for_human": False, "phase": None, "bot_online": True}
    last_t, gaps, prev = time.time(), [], None
    while True:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
        if m["type"] == "error":
            res.setdefault("errors", []).append(m.get("message"))
        if m["type"] != "game_state":
            continue
        st = m["state"]
        me = st["my_seat"]
        bots = [p for p in m["players"] if p["is_bot"]]
        assert len(bots) == 3 and all(p["online"] for p in bots)
        res["phase"] = st["phase"]
        if prev and st["phase"] == "playing" and prev["phase"] == "playing" and st["turn"] != me:
            gaps.append(time.time() - last_t)
        last_t, prev = time.time(), st
        if st["phase"] == "playing" and st["turn"] != me:
            res["bot_moves"] += 1
        if st["phase"] == "match_over":
            break
        msg = None
        if st["phase"] == "trump_select" and st["trump_selector"] == me:
            msg = {"action": "select_trump", "suit": "S"}
        elif st["phase"] == "playing" and st["turn"] == me and st["legal"]:
            msg = {"action": "play", "card": rnd.choice(st["legal"])}
        elif st["phase"] == "koth_decision" and st["koth_decision"] == me % 2:
            res["koth_seen_my_team"] = True
            await asyncio.sleep(2.5)  # a bot partner must NOT decide for us
            res["koth_waited_for_human"] = True
            msg = {"action": "koth", "declare": True}
        elif st["phase"] == "gs_decision" and st["gs_eligible"] == me % 2:
            msg = {"action": "grand_slam", "declare": False}
        if msg:
            await ws.send(json.dumps({"type": "game_action", "game_id": gid, **msg}))
    await ws.close()
    res["median_bot_gap"] = sorted(gaps)[len(gaps) // 2] if gaps else None
    res["rounds"] = [(r["winner_team"], r["type"]) for r in st["rounds"]]
    return res


# Unit: bot decision routing (Koth/Grand Slam only auto-decided when the whole team is bots)
def _svc_game(phase, **kw):
    from game_service import GameService
    svc = GameService(None, None)
    players = [{"seat": i, "user_id": f"u{i}" if i == 0 else f"bot_{i}", "is_bot": i != 0} for i in range(4)]
    st = {"phase": phase, "trick": [], "tricks": [], "turn": 0, "trump_selector": 0, "koth_decision": None, "gs_eligible": None, **kw}
    return svc, {"players": players, "state": st}


def test_bot_turn_routing():
    svc, g = _svc_game("koth_decision", koth_decision=0)
    assert svc._bot_turn(g) is None  # human (seat 0) + bot partner (seat 2) -> human decides
    svc, g = _svc_game("koth_decision", koth_decision=1)
    assert svc._bot_turn(g) == ("koth", 1)
    svc, g = _svc_game("gs_decision", gs_eligible=0)
    assert svc._bot_turn(g) is None
    svc, g = _svc_game("gs_decision", gs_eligible=1)
    assert svc._bot_turn(g) == ("grand_slam", 1)
    svc, g = _svc_game("trump_select", trump_selector=3)
    assert svc._bot_turn(g) == ("select_trump", 3)
    svc, g = _svc_game("playing", turn=0)
    assert svc._bot_turn(g) is None
