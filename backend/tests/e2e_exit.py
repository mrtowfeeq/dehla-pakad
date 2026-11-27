"""Live Exit Match checks. Run: cd /app/backend && python tests/e2e_exit.py"""
import asyncio
import json
import os
import sys

from ws_auth import connect_authenticated
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, "/app/backend/tests")
from e2e_match import P, WS  # noqa: E402

load_dotenv("/app/backend/.env")
db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
ENV = "live" if os.environ.get("CLERK_PUBLISHABLE_KEY", "").startswith("pk_live_") else "preview"


async def collect(p, bucket):
    try:
        async for raw in p.ws:
            m = json.loads(raw)
            bucket.append(m)
    except Exception:
        pass


async def start_private(ps, bots=0):
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


async def main():
    ps = [P(i) for i in range(1, 5)]
    for p in ps:
        p.api("GET", "/me").raise_for_status()
        p.api("PATCH", "/me", json={"username": p.name}).raise_for_status()
    stats_before = [p.api("GET", "/me").json()["stats"] for p in ps]
    code, gid = await start_private(ps)
    msgs = {p.name: [] for p in ps}
    for p in ps:
        p.ws = await connect_authenticated(WS, p.tok)
        asyncio.create_task(collect(p, msgs[p.name]))
    await asyncio.sleep(1)

    # temporary disconnect must NOT cancel
    await ps[2].ws.close()
    await asyncio.sleep(1.5)
    assert ps[0].api("GET", f"/games/{gid}").json()["status"] == "active", "disconnect must not cancel"
    ps[2].ws = await connect_authenticated(WS, ps[2].tok)
    asyncio.create_task(collect(ps[2], msgs[ps[2].name]))
    await asyncio.sleep(1)
    print("disconnect does not cancel: ok")

    # simultaneous exits by two players (one via WS, one via REST, one more via WS)
    await asyncio.gather(
        ps[1].ws.send(json.dumps({"type": "game_action", "game_id": gid, "action": "exit"})),
        ps[3].ws.send(json.dumps({"type": "game_action", "game_id": gid, "action": "exit"})),
        asyncio.to_thread(ps[0].api, "POST", f"/games/{gid}/exit"),
    )
    await asyncio.sleep(2)
    for p in ps:
        got = [m for m in msgs[p.name] if m["type"] == "match_cancelled"]
        assert len(got) == 1, (p.name, len(got))
        assert got[0]["message"] == "The match has ended because a player exited."
    print("single cancellation notice to all 4: ok")
    g = ps[0].api("GET", f"/games/{gid}").json()
    assert g["status"] == "cancelled" and g["state"]["phase"] == "cancelled" and g["state"]["scores"] == [0, 0]
    mark = len(msgs[ps[1].name])
    await ps[1].ws.send(json.dumps({"type": "game_action", "game_id": gid, "action": "select_trump", "suit": "S"}))
    await asyncio.sleep(0.8)
    after = msgs[ps[1].name][mark:]
    assert after and after[0]["type"] == "error" and not any(m["type"] == "game_state" for m in after), after
    for p, before in zip(ps, stats_before):
        me = p.api("GET", "/me").json()
        assert me["stats"] == before and me["active_game_id"] is None and me["lobby_code"] is None
    assert not any(m["game_id"] == gid for m in ps[0].api("GET", "/matches").json())
    print("no points/stats/history, seats released: ok")

    # everyone can immediately start something new
    new_code = ps[0].api("POST", "/rooms", json={"target": 5}).json()["code"]
    assert ps[1].api("POST", f"/rooms/{new_code}/join").status_code == 200
    assert ps[2].api("POST", "/matchmaking/join").status_code == 200
    ps[2].api("POST", "/matchmaking/leave")
    ps[0].api("POST", f"/rooms/{new_code}/leave")
    ps[1].api("POST", f"/rooms/{new_code}/leave")
    print("immediate new matches: ok")
    for p in ps:
        await p.ws.close()

    # bots: exit mid-game; no bot actions afterwards
    solo = ps[3]
    code2, gid2 = await start_private([solo], bots=3)
    await asyncio.sleep(4)
    r = solo.api("POST", f"/games/{gid2}/exit")
    assert r.status_code == 200
    n1 = await db.game_events.count_documents({"game_id": gid2, "env": ENV})
    await asyncio.sleep(4)
    n2 = await db.game_events.count_documents({"game_id": gid2, "env": ENV})
    assert n1 == n2, "bot acted after cancellation"
    assert solo.api("GET", "/me").json()["active_game_id"] is None
    print("bots stop after exit: ok")
    print("EXIT E2E PASSED")


asyncio.run(main())
