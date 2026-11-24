"""Bot driver: plays legal moves for all 4 seats of an existing game until N rounds are done (or match over).
Usage: E2E_BASE=<url> python tests/bot_play.py <RUN> <game_id> <rounds> [start_delay_s]"""
import asyncio
import json
import random
import sys

import websockets

sys.path.insert(0, "/app/backend/tests")
import e2e_match  # noqa: E402

e2e_match.RUN = int(sys.argv[1])
GID, ROUNDS = sys.argv[2], int(sys.argv[3])
DELAY = float(sys.argv[4]) if len(sys.argv) > 4 else 0
STOP_AT = sys.argv[5].split(",") if len(sys.argv) > 5 else []  # e.g. koth_decision,gs_decision


async def main():
    await asyncio.sleep(DELAY)
    ps = [e2e_match.P(i) for i in range(1, 5)]
    by = {}
    for p in ps:
        p.ws = await websockets.connect(f"{e2e_match.WS}?token={p.tok}")
        await p.ws.send(json.dumps({"type": "sync_game", "game_id": GID}))

        async def rd(p=p):
            async for raw in p.ws:
                m = json.loads(raw)
                if m["type"] == "game_state":
                    p.state = m["state"]
        asyncio.create_task(rd())
    await asyncio.sleep(2)
    for p in ps:
        by[p.state["my_seat"]] = p
    rng = random.Random(3)
    while True:
        await asyncio.sleep(0.6)
        st = by[0].state
        if st["phase"] == "match_over" or len(st["rounds"]) >= ROUNDS:
            break
        if STOP_AT and st["phase"] in STOP_AT:
            break
        ph = st["phase"]
        if ph == "trump_select":
            a, msg = by[st["trump_selector"]], {"action": "select_trump", "suit": "H"}
        elif ph == "playing":
            a = by[st["turn"]]
            if not a.state["legal"]:
                continue
            msg = {"action": "play", "card": rng.choice(a.state["legal"])}
        elif ph == "koth_decision":
            a, msg = next(p for s, p in by.items() if s % 2 == st["koth_decision"]), {"action": "koth", "declare": False}
        elif ph == "gs_decision":
            a, msg = next(p for s, p in by.items() if s % 2 == st["gs_eligible"]), {"action": "grand_slam", "declare": False}
        else:
            continue
        await a.ws.send(json.dumps({"type": "game_action", "game_id": GID, **msg}))
    print("bot done", by[0].state["phase"], by[0].state["scores"], len(by[0].state["rounds"]))
    for p in ps:
        await p.ws.close()


asyncio.run(main())
