"""T1 driver: plays for player1 (RUN=7311) in game <gid> over WS until match over. Usage: python tests/t1_driver.py <gid> [move_delay]"""
import asyncio
import json
import random
import sys

from ws_auth import connect_authenticated

sys.path.insert(0, "/app/backend/tests")
import e2e_match as e  # noqa: E402

e.RUN = 7311
GID = sys.argv[1]
DELAY = float(sys.argv[2]) if len(sys.argv) > 2 else 1.5
BASE = "wss://" + __import__("os").environ["PUB"].split("://")[1] + "/api/ws"


async def main():
    p = e.P(1)
    ws = await connect_authenticated(BASE, p.tok)
    await ws.send(json.dumps({"type": "sync_game", "game_id": GID}))
    rnd = random.Random(5)
    while True:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout=120))
        if m.get("type") == "match_cancelled":
            print("cancelled"); return
        if m.get("type") != "game_state":
            continue
        st = m["state"]; me = st["my_seat"]
        if st["phase"] == "match_over":
            print("match over", st["scores"]); return
        msg = None
        if st["phase"] == "trump_select" and st["trump_selector"] == me:
            msg = {"action": "select_trump", "suit": "S"}
        elif st["phase"] == "playing" and st["turn"] == me and st["legal"]:
            tens = [c for c in st["legal"] if c.startswith("10")]
            msg = {"action": "play", "card": tens[0] if tens else rnd.choice(st["legal"])}
        elif st["phase"] == "koth_decision" and st["koth_decision"] == me % 2:
            msg = {"action": "koth", "declare": True}
        elif st["phase"] == "gs_decision" and st["gs_eligible"] == me % 2:
            msg = {"action": "grand_slam", "declare": False}
        if msg:
            await asyncio.sleep(DELAY)
            await ws.send(json.dumps({"type": "game_action", "game_id": GID, **msg}))
            print("sent", msg, flush=True)


asyncio.run(main())
