"""Iteration 2 regression: public lobby dissolve/requeue, ready timeout, WS-disconnect dequeue, duplicate invite 409.
Run: cd /app/backend && pytest tests/test_matchmaking_fixes.py -n 0 -v -s   (takes ~90s because of the 60s ready timeout)"""
import asyncio
import json
import os
import random
import sys

import pytest
import websockets

sys.path.insert(0, "/app/backend/tests")
from dotenv import dotenv_values  # noqa: E402

PUBLIC = dotenv_values("/app/frontend/.env")["REACT_APP_BACKEND_URL"].rstrip("/")
os.environ["E2E_BASE"] = PUBLIC
import e2e_match  # noqa: E402

e2e_match.BASE = PUBLIC
e2e_match.RUN = random.randint(10000, 99999)
WS = PUBLIC.replace("https", "wss") + "/api/ws"
ST = {}


def mk(i):
    p = e2e_match.P(i)
    p.api("GET", "/me").raise_for_status()
    assert p.api("PATCH", "/me", json={"username": f"mm{e2e_match.RUN}_{i}"}).status_code == 200
    p.api("POST", "/matchmaking/leave")
    p.msgs = []
    return p


@pytest.fixture(scope="module")
def ps():
    if "ps" not in ST:
        ST["ps"] = [mk(i) for i in range(1, 6)]
    return ST["ps"]


async def open_ws(ps):
    socks = []
    for p in ps:
        p.msgs = []
        ws = await websockets.connect(f"{WS}?token={p.tok}")
        socks.append(ws)

        async def rd(p=p, ws=ws):
            try:
                async for raw in ws:
                    p.msgs.append(json.loads(raw))
            except Exception:
                pass
        asyncio.create_task(rd())
    await asyncio.sleep(1)
    return socks


async def call(p, method, path, **kw):
    return await asyncio.to_thread(p.api, method, path, **kw)


def types(p, t):
    return [m for m in p.msgs if m.get("type") == t]


async def cleanup(ps):
    for p in ps:
        st = (await call(p, "GET", "/matchmaking/status")).json()
        if st.get("room_code"):
            await call(p, "POST", f"/rooms/{st['room_code']}/leave")
    for p in ps:
        await call(p, "POST", "/matchmaking/leave")


async def match4(group):
    res = [(await call(p, "POST", "/matchmaking/join")).json() for p in group]
    code = next((r["room_code"] for r in res if r.get("room_code")), None)
    assert code, res
    await asyncio.sleep(1.5)
    return code


# FIX 1: leaving a matched public lobby dissolves it, others requeued at the front; 5th player forms a new room
def test_leave_dissolves_and_requeues(ps):
    async def go():
        socks = await open_ws(ps)
        try:
            await cleanup(ps)
            group, fifth = ps[:4], ps[4]
            code = await match4(group)
            for p in group:
                mf = [m for m in types(p, "match_found") if m["code"] == code]
                assert mf and mf[0]["ready_timeout"] == 60, p.msgs
            leaver, rest = group[0], group[1:]
            r = await call(leaver, "POST", f"/rooms/{code}/leave")
            assert r.status_code == 200, r.text
            await asyncio.sleep(1.5)
            for p in rest:
                assert any(m["code"] == code for m in types(p, "requeued")), p.msgs[-3:]
                assert (await call(p, "GET", f"/rooms/{code}")).status_code == 404
            assert any(m["code"] == code for m in types(leaver, "room_left"))
            positions = sorted([(await call(p, "GET", "/matchmaking/status")).json().get("position") for p in rest])
            print("requeued positions:", positions)
            assert positions == [1, 2, 3]
            ls = (await call(leaver, "GET", "/matchmaking/status")).json()
            assert ls["queued"] is False and ls["room_code"] is None, ls
            # 5th player forms a new room with the 3 requeued
            j = (await call(fifth, "POST", "/matchmaking/join")).json()
            assert j.get("queued") is False and j.get("room_code") and j["room_code"] != code, j
            new = j["room_code"]
            room = (await call(fifth, "GET", f"/rooms/{new}")).json()
            ids = {s["user_id"] for s in room["seats"]}
            assert ids == {p.uid for p in rest + [fifth]}, room["seats"]
            assert room["is_public"] and room["host_id"] is None
        finally:
            await cleanup(ps)
            for s in socks:
                await s.close()
    asyncio.run(go())


# FIX 1b: re-joining the queue or creating a private room while in a public lobby also dissolves it
@pytest.mark.parametrize("how", ["rejoin_queue", "create_private"])
def test_other_exits_dissolve(ps, how):
    async def go():
        socks = await open_ws(ps)
        try:
            await cleanup(ps)
            group = ps[:4]
            code = await match4(group)
            leaver, rest = group[1], [group[0], group[2], group[3]]
            if how == "rejoin_queue":
                r = (await call(leaver, "POST", "/matchmaking/join")).json()
            else:
                r = (await call(leaver, "POST", "/rooms", json={"target": 7})).json()
                ST["priv"] = r["code"]
            print(how, "->", r)
            await asyncio.sleep(1.5)
            assert (await call(rest[0], "GET", f"/rooms/{code}")).status_code == 404
            for p in rest:
                assert any(m["code"] == code for m in types(p, "requeued")), p.msgs[-3:]
            sts = [(await call(p, "GET", "/matchmaking/status")).json() for p in rest]
            print(how, "statuses of remaining:", sts)
            if how == "create_private":
                assert all(s["queued"] for s in sts)
                await call(leaver, "POST", f"/rooms/{ST['priv']}/leave")
        finally:
            await cleanup(ps)
            for s in socks:
                await s.close()
    asyncio.run(go())


# FIX 2: 60s ready timeout removes unready players and requeues ready ones
def test_ready_timeout(ps):
    async def go():
        socks = await open_ws(ps)
        try:
            await cleanup(ps)
            group = ps[:4]
            code = await match4(group)
            ready, idle = group[:2], group[2:]
            for p in ready:
                assert (await call(p, "POST", f"/rooms/{code}/ready", json={"ready": True})).status_code == 200
            await asyncio.sleep(30)
            assert (await call(ready[0], "GET", f"/rooms/{code}")).status_code == 200, "dissolved too early"
            await asyncio.sleep(33)
            assert (await call(ready[0], "GET", f"/rooms/{code}")).status_code == 404, "room not dissolved after 60s"
            for p in ready:
                assert any(m["code"] == code for m in types(p, "requeued"))
                assert (await call(p, "GET", "/matchmaking/status")).json()["queued"] is True
            for p in idle:
                assert any(m["code"] == code for m in types(p, "room_left"))
                st = (await call(p, "GET", "/matchmaking/status")).json()
                assert st["queued"] is False and st["room_code"] is None, st
        finally:
            await cleanup(ps)
            for s in socks:
                await s.close()
    asyncio.run(go())


# FIX 6: closing the last WebSocket removes the user from the queue
def test_ws_disconnect_dequeues(ps):
    async def go():
        p = ps[4]
        await cleanup([p])
        ws1 = await websockets.connect(f"{WS}?token={p.tok}")
        ws2 = await websockets.connect(f"{WS}?token={p.tok}")
        await asyncio.sleep(1)
        assert (await call(p, "POST", "/matchmaking/join")).json()["queued"] is True
        await ws1.close()
        await asyncio.sleep(1.5)
        assert (await call(p, "GET", "/matchmaking/status")).json()["queued"] is True, "still has another socket"
        await ws2.close()
        await asyncio.sleep(1.5)
        st = (await call(p, "GET", "/matchmaking/status")).json()
        assert st["queued"] is False, st
    asyncio.run(go())


# FIX 3: inviting the same friend to the same room twice -> 409
def test_duplicate_invite_409(ps):
    a, b = ps[0], ps[1]
    r = a.api("POST", "/friends/requests", json={"username": f"mm{e2e_match.RUN}_2"})
    assert r.status_code in (200, 409), r.text
    req = next(x for x in b.api("GET", "/friends/requests").json()["incoming"] if x["user"]["username"] == f"mm{e2e_match.RUN}_1")
    assert b.api("POST", f"/friends/requests/{req['id']}/accept").status_code == 200
    code = a.api("POST", "/rooms", json={"target": 7}).json()["code"]
    try:
        r1 = a.api("POST", f"/rooms/{code}/invite", json={"user_id": b.uid})
        assert r1.status_code == 200, r1.text
        r2 = a.api("POST", f"/rooms/{code}/invite", json={"user_id": b.uid})
        assert r2.status_code == 409 and r2.json()["detail"] == "Already invited", r2.text
        invs = [i for i in b.api("GET", "/invitations").json() if i["room_code"] == code]
        assert len(invs) == 1
        # after decline, re-inviting is allowed again
        b.api("POST", f"/invitations/{invs[0]['id']}/decline")
        assert a.api("POST", f"/rooms/{code}/invite", json={"user_id": b.uid}).status_code == 200
    finally:
        a.api("POST", f"/rooms/{code}/leave")
