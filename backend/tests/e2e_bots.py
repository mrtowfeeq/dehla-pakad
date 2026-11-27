"""Live check: one human + three bots finish a full match; stats untouched. Run: python tests/e2e_bots.py"""
import asyncio
import json
import random
import sys

from ws_auth import connect_authenticated

sys.path.insert(0, "/app/backend/tests")
from e2e_match import P, WS  # noqa: E402


async def main():
    h = P(1)
    h.api("GET", "/me").raise_for_status()
    h.api("PATCH", "/me", json={"username": h.name}).raise_for_status()
    before = h.api("GET", "/me").json()["stats"]
    code = h.api("POST", "/rooms", json={"target": 2}).json()["code"]
    for _ in range(3):
        assert h.api("POST", f"/rooms/{code}/bots").status_code == 200
    assert h.api("POST", f"/rooms/{code}/bots").status_code == 409, "room full"
    room = h.api("GET", f"/rooms/{code}").json()
    assert sum(1 for s in room["seats"] if s.get("is_bot")) == 3
    h.api("POST", f"/rooms/{code}/ready", json={"ready": True}).raise_for_status()
    gid = h.api("POST", f"/rooms/{code}/start").json()["game_id"]
    ws = await connect_authenticated(WS, h.tok)
    await ws.send(json.dumps({"type": "sync_game", "game_id": gid}))
    rnd = random.Random(3)
    while True:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
        if m["type"] != "game_state":
            continue
        st = m["state"]
        me = st["my_seat"]
        if st["phase"] == "match_over":
            break
        msg = None
        if st["phase"] == "trump_select" and st["trump_selector"] == me:
            msg = {"action": "select_trump", "suit": "S"}
        elif st["phase"] == "playing" and st["turn"] == me and st["legal"]:
            msg = {"action": "play", "card": rnd.choice(st["legal"])}
        elif st["phase"] == "koth_decision" and st["koth_decision"] == me % 2:
            msg = {"action": "koth", "declare": True}
        elif st["phase"] == "gs_decision" and st["gs_eligible"] == me % 2:
            msg = {"action": "grand_slam", "declare": False}
        if msg:
            await ws.send(json.dumps({"type": "game_action", "game_id": gid, **msg}))
    print("final", st["scores"], [(r["winner_team"], r["type"]) for r in st["rounds"]])
    await ws.close()
    await asyncio.sleep(1)
    assert h.api("GET", "/me").json()["stats"] == before, "bot games must not change stats"
    hist = h.api("GET", "/matches").json()
    assert hist and hist[0]["has_bots"] is True
    print("BOTS E2E PASSED")


asyncio.run(main())
