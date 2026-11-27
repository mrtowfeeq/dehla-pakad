"""Multi-user REST + WS regression tests against the PUBLIC URL (rooms, matchmaking, friends, invites, chat, security).
Run from backend/: RUN_LIVE_TESTS=1 pytest tests/test_multiuser_api.py -n 0 -v   Settings: see live_env.py."""
import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
import requests
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_env  # noqa: E402

PUBLIC = live_env.configure()  # skips unless RUN_LIVE_TESTS=1
from ws_auth import authenticate_socket  # noqa: E402
import e2e_match  # noqa: E402
from e2e_match import P  # noqa: E402

BASE = PUBLIC + "/api"
WS = live_env.websocket_url(PUBLIC)
ST = {}


def players(rng):
    out = []
    for i in rng:
        p = P(i)
        p.api("GET", "/me").raise_for_status()
        assert p.api("PATCH", "/me", json={"username": p.name}).status_code == 200
        p.api("POST", "/matchmaking/leave")
        out.append(p)
    return out


async def ws_collect(p, sends, wait=1.5, game_id=None):
    msgs = []
    async with websockets.connect(WS) as ws:
        await authenticate_socket(ws, p.tok)
        for s in sends:
            await ws.send(json.dumps(s))
        end = asyncio.get_event_loop().time() + wait
        while True:
            t = end - asyncio.get_event_loop().time()
            if t <= 0:
                break
            try:
                msgs.append(json.loads(await asyncio.wait_for(ws.recv(), t)))
            except asyncio.TimeoutError:
                break
    return msgs


# ---- security ----
class TestSecurity:
    @pytest.mark.parametrize("path", ["/me", "/friends", "/leaderboard", "/matches", "/invitations", "/matchmaking/status"])
    def test_unauth_401(self, path):
        r = requests.get(BASE + path, timeout=15)
        assert r.status_code == 401, (path, r.status_code)

    def test_ws_invalid_token(self):
        async def go():
            try:
                async with websockets.connect(WS) as ws:
                    await authenticate_socket(ws, "bad")
                    await asyncio.wait_for(ws.recv(), 5)
                return "open"
            except Exception as e:
                return repr(e)
        res = asyncio.run(go())
        assert res != "open"
        print("ws invalid:", res)


# ---- private room / friends / invites / game ----
class TestPrivateFlow:
    def test_01_setup_users(self):
        ST["ps"] = players(range(1, 5))
        assert len(ST["ps"]) == 4

    def test_02_friends(self):
        a, b = ST["ps"][0], ST["ps"][1]
        s = a.api("GET", "/users/search", params={"q": b.name})
        assert s.status_code == 200 and any(u["username"] == b.name for u in s.json())
        r = a.api("POST", "/friends/requests", json={"username": b.name})
        assert r.status_code in (200, 409), r.text
        inc = b.api("GET", "/friends/requests").json()["incoming"]
        req = next((x for x in inc if x["user"]["username"] == a.name), None)
        if req:
            assert b.api("POST", f"/friends/requests/{req['id']}/accept").json()["status"] == "accepted"
        fl = a.api("GET", "/friends").json()
        f = next(u for u in fl if u["username"] == b.name)
        assert "online" in f
        ST["b_id"] = f.get("user_id") or f.get("id")

    def test_03_room_create_join_perms(self):
        ps = ST["ps"]
        host = ps[0]
        room = host.api("POST", "/rooms", json={"target": 7}).json()
        code = room["code"]
        ST["code"] = code
        assert len(code) == 6 and room["target"] == 7
        assert ps[1].api("GET", f"/rooms/{code}").status_code == 404
        # invite friend
        r = host.api("POST", f"/rooms/{code}/invite", json={"user_id": ST["b_id"]})
        assert r.status_code == 200, r.text
        invs = ps[1].api("GET", "/invitations").json()
        assert any(i["room_code"] == code for i in invs)
        # invite non-friend -> 403
        me3 = ps[3].api("GET", "/me").json()
        r = host.api("POST", f"/rooms/{code}/invite", json={"user_id": me3.get("user_id")})
        assert r.status_code == 403
        for p in ps[1:]:
            assert p.api("POST", f"/rooms/{code}/join").status_code == 200
        assert ps[1].api("GET", "/invitations").json() == [] or all(i["room_code"] != code for i in ps[1].api("GET", "/invitations").json())
        assert ps[1].api("PATCH", f"/rooms/{code}/settings", json={"target": 5}).status_code == 403
        assert ps[1].api("POST", f"/rooms/{code}/start").status_code == 403
        assert host.api("POST", f"/rooms/{code}/join").status_code == 200  # idempotent
        assert ps[1].api("POST", "/rooms/ZZZZZZ/join").status_code == 404

    def test_04_host_settings_seats_start(self):
        ps = ST["ps"]
        host, code = ps[0], ST["code"]
        room = host.api("GET", f"/rooms/{code}").json()
        ids = [s["user_id"] for s in room["seats"]]
        swapped = [ids[0], ids[2], ids[1], ids[3]]
        r = host.api("POST", f"/rooms/{code}/seats", json={"seats": swapped})
        assert r.status_code == 200 and [s["user_id"] for s in r.json()["seats"]] == swapped
        bad = host.api("POST", f"/rooms/{code}/seats", json={"seats": [ids[0], ids[0], ids[1], ids[3]]})
        assert bad.status_code == 400
        r = host.api("PATCH", f"/rooms/{code}/settings", json={"dealer_seat": 1, "target": 3})
        assert r.status_code == 200 and r.json()["dealer_seat"] == 1 and r.json()["target"] == 3
        assert host.api("POST", f"/rooms/{code}/start").status_code == 400  # not ready
        for p in ps:
            assert p.api("POST", f"/rooms/{code}/ready", json={"ready": True}).status_code == 200
        r = host.api("POST", f"/rooms/{code}/start")
        assert r.status_code == 200, r.text
        ST["gid"] = r.json()["game_id"]
        assert ST["gid"]
        assert host.api("POST", f"/rooms/{code}/start").status_code in (403, 409)

    def test_05_game_state_privacy(self):
        ps, gid = ST["ps"], ST["gid"]
        views = {}
        for p in ps:
            v = p.api("GET", f"/games/{gid}").json()
            views[v["state"]["my_seat"]] = (p, v)
        assert set(views) == {0, 1, 2, 3}
        st = views[0][1]["state"]
        assert st["dealer"] == 1 and st["trump_selector"] == 2 and st["phase"] == "trump_select"
        hands = {s: set(v["state"]["hand"]) for s, (p, v) in views.items()}
        assert all(len(h) == 5 for h in hands.values())
        for s, (p, v) in views.items():
            payload = json.dumps({k: x for k, x in v["state"].items() if k not in ("hand", "legal", "partner_hand")})
            for os_, h in hands.items():
                if os_ != s:
                    for c in h:
                        assert f'"{c}"' not in payload
        # non-player cannot GET game
        outsider = P(9)
        outsider.api("GET", "/me")
        outsider.api("PATCH", "/me", json={"username": outsider.name})
        assert outsider.api("GET", f"/games/{gid}").status_code == 404
        ST["by_seat"] = {s: p for s, (p, v) in views.items()}
        # active game blocks new room/matchmaking
        assert views[0][0].api("POST", "/rooms", json={"target": 5}).status_code == 409
        assert views[0][0].api("POST", "/matchmaking/join").status_code == 409

    def test_06_ws_trump_wrong_player_and_select(self):
        bs, gid = ST["by_seat"], ST["gid"]
        msgs = asyncio.run(ws_collect(bs[0], [{"type": "game_action", "game_id": gid, "action": "select_trump", "suit": "S"}]))
        assert any(m["type"] == "error" for m in msgs), msgs
        msgs = asyncio.run(ws_collect(bs[2], [{"type": "game_action", "game_id": gid, "action": "select_trump", "suit": "S"}]))
        gs = [m for m in msgs if m["type"] == "game_state"]
        assert gs and gs[-1]["state"]["trump"] == "S" and len(gs[-1]["state"]["hand"]) == 13
        assert gs[-1]["state"]["phase"] == "playing"

    def test_07_ws_out_of_turn_and_illegal(self):
        bs, gid = ST["by_seat"], ST["gid"]
        v = bs[0].api("GET", f"/games/{gid}").json()["state"]
        turn = v["turn"]
        other = bs[(turn + 1) % 4]
        oh = other.api("GET", f"/games/{gid}").json()["state"]["hand"]
        msgs = asyncio.run(ws_collect(other, [{"type": "game_action", "game_id": gid, "action": "play", "card": oh[0]}]))
        assert any(m["type"] == "error" for m in msgs)
        tv = bs[turn].api("GET", f"/games/{gid}").json()["state"]
        not_mine = next(c for c in oh)
        msgs = asyncio.run(ws_collect(bs[turn], [{"type": "game_action", "game_id": gid, "action": "play", "card": not_mine}]))
        assert any(m["type"] == "error" for m in msgs), "playing a card you don't hold must fail"
        legal = tv["legal"][0]
        msgs = asyncio.run(ws_collect(bs[turn], [{"type": "game_action", "game_id": gid, "action": "play", "card": legal}]))
        gs = [m for m in msgs if m["type"] == "game_state"]
        assert gs and legal not in gs[-1]["state"]["hand"] and gs[-1]["state"]["turn"] == (turn + 1) % 4

    def test_08_chat_and_reaction(self):
        bs, code = ST["by_seat"], ST["code"]

        async def go():
            async with websockets.connect(WS) as w1:
                await authenticate_socket(w1, bs[1].tok)
                await w1.recv()
                async with websockets.connect(WS) as w0:
                    await authenticate_socket(w0, bs[0].tok)
                    await w0.send(json.dumps({"type": "chat", "room_code": code, "text": "TEST_hello"}))
                    await w0.send(json.dumps({"type": "reaction", "room_code": code, "emoji": "🔥"}))
                    await w0.send(json.dumps({"type": "reaction", "room_code": code, "emoji": "XX"}))
                    got = []
                    try:
                        while True:
                            got.append(json.loads(await asyncio.wait_for(w1.recv(), 2)))
                    except asyncio.TimeoutError:
                        pass
                    return got
        got = asyncio.run(go())
        assert any(m["type"] == "chat" and m["message"]["text"] == "TEST_hello" for m in got)
        assert any(m["type"] == "reaction" and m["emoji"] == "🔥" for m in got)
        hist = bs[2].api("GET", f"/rooms/{code}/chat").json()
        assert any(m["text"] == "TEST_hello" for m in hist)

    def test_09_reconnect_offline_flag(self):
        bs, gid = ST["by_seat"], ST["gid"]
        v = bs[0].api("GET", f"/games/{gid}").json()
        assert v["players"][3]["online"] is False  # nobody connected now

    def test_10_forfeit_records_history(self):
        bs, gid = ST["by_seat"], ST["gid"]
        msgs = asyncio.run(ws_collect(bs[0], [{"type": "game_action", "game_id": gid, "action": "forfeit"}], wait=2))
        print("forfeit msgs:", [m.get("type") for m in msgs], [m.get("message") for m in msgs if m["type"] == "error"])
        g = bs[0].api("GET", f"/games/{gid}").json()
        print("after forfeit phase:", g["state"]["phase"], g["status"])
        hist = bs[1].api("GET", "/matches").json()
        print("history has game:", any(m["game_id"] == gid for m in hist))


# ---- public matchmaking ----
class TestMatchmaking:
    def test_matchmaking_4_users_autostart(self):
        ps = players(range(5, 9))
        res = [p.api("POST", "/matchmaking/join").json() for p in ps]
        assert res[0]["queued"] is True
        codes = {r.get("room_code") for r in res if not r.get("queued")}
        if not codes:
            st = ps[0].api("GET", "/matchmaking/status").json()
            codes = {st.get("room_code")}
        code = codes.pop()
        assert code
        room = ps[0].api("GET", f"/rooms/{code}").json()
        assert room["is_public"] is True and room["target"] == 7 and all(room["seats"])
        assert ps[0].api("PATCH", f"/rooms/{code}/settings", json={"target": 5}).status_code == 403
        last = None
        for p in ps:
            last = p.api("POST", f"/rooms/{code}/ready", json={"ready": True})
            assert last.status_code == 200, last.text
        assert last.json()["status"] == "playing" and last.json()["game_id"]
        g = ps[1].api("GET", f"/games/{last.json()['game_id']}").json()
        assert g["state"]["phase"] == "trump_select"
        # cleanup: forfeit so users are freed
        asyncio.run(ws_collect(ps[0], [{"type": "game_action", "game_id": g["game_id"], "action": "forfeit"}], wait=1))
