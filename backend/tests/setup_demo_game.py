"""Creates 4 test players, starts a private game, selects trump, prints sign-in tickets + game id.
Run: cd /app/backend && python tests/setup_demo_game.py"""
import asyncio
import json
import sys

import websockets

sys.path.insert(0, "/app/backend/tests")
from e2e_match import P, WS, bapi  # noqa: E402


async def main():
    ps = [P(i) for i in range(1, 5)]
    for p in ps:
        p.api("GET", "/me").raise_for_status()
        p.api("PATCH", "/me", json={"username": p.name}).raise_for_status()
    code = ps[0].api("POST", "/rooms", json={"target": 5}).json()["code"]
    for p in ps[1:]:
        p.api("POST", f"/rooms/{code}/join").raise_for_status()
    for p in ps:
        p.api("POST", f"/rooms/{code}/ready", json={"ready": True}).raise_for_status()
    game_id = ps[0].api("POST", f"/rooms/{code}/start").json()["game_id"]
    if "--no-trump" not in sys.argv:
        g = ps[0].api("GET", f"/games/{game_id}").json()
        sel = g["state"]["trump_selector"]
        selector = next(p for p in ps if p.api("GET", f"/games/{game_id}").json()["state"]["my_seat"] == sel)
        ws = await websockets.connect(f"{WS}?token={selector.tok}")
        await ws.recv()
        await ws.send(json.dumps({"type": "game_action", "game_id": game_id, "action": "select_trump", "suit": "H"}))
        await asyncio.sleep(1)
        await ws.close()
    out = {"game_id": game_id, "room_code": code, "players": []}
    for p in ps:
        seat = p.api("GET", f"/games/{game_id}").json()["state"]["my_seat"]
        ticket = bapi("/sign_in_tokens", {"user_id": p.uid, "expires_in_seconds": 3600})["token"]
        out["players"].append({"email": p.email, "username": p.name, "seat": seat, "ticket": ticket})
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
