"""Forfeit a game as player <i> of RUN. Usage: python tests/forfeit.py <RUN> <i> <game_id>"""
import asyncio
import json
import sys

import websockets
from ws_auth import authenticate_socket

sys.path.insert(0, "/app/backend/tests")
import e2e_match  # noqa: E402

e2e_match.RUN = int(sys.argv[1])
p = e2e_match.P(int(sys.argv[2]))


async def go():
    async with websockets.connect(e2e_match.WS) as ws:
        await authenticate_socket(ws, p.tok)
        await ws.send(json.dumps({"type": "game_action", "game_id": sys.argv[3], "action": "forfeit"}))
        await asyncio.sleep(2)
asyncio.run(go())
g = p.api("GET", f"/games/{sys.argv[3]}").json()
print(g["status"], g["state"]["phase"], g["state"]["scores"], g["state"].get("forfeited_by"))
