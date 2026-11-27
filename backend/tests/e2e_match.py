"""End-to-end: four real Clerk test users play a complete private match over the live API + WebSockets.
Run from backend/: python tests/e2e_match.py   (needs CLERK_SECRET_KEY in backend/.env and backend running;
E2E_BASE and BACKEND_ENV_FILE override the defaults, see live_env.py)"""
import asyncio
import json
import os
import random
import sys
import urllib.parse
import urllib.request

import requests
from ws_auth import connect_authenticated
from dotenv import load_dotenv
from live_env import backend_env_file

load_dotenv(backend_env_file(), override=False)
SK = os.environ["CLERK_SECRET_KEY"]
BASE = os.environ.get("E2E_BASE", "http://localhost:8001")
RUN = random.randint(1000, 9999)
WS = BASE.replace("http", "ws") + "/api/ws"


def bapi(path, body=None, method="POST"):
    req = urllib.request.Request("https://api.clerk.com/v1" + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": "Bearer " + SK, "Content-Type": "application/json", "User-Agent": "dehla-pakad-test"})
    return json.load(urllib.request.urlopen(req))


def get_user(email):
    found = bapi(f"/users?email_address={urllib.parse.quote(email)}", method="GET")
    return found[0] if found else bapi("/users", {"email_address": [email], "password": "Test-pass-12345!", "skip_password_checks": True})


def token_for(uid):
    sess = bapi("/sessions", {"user_id": uid})
    return lambda: bapi(f"/sessions/{sess['id']}/tokens", {"expires_in_seconds": 3600})["jwt"]


class P:
    def __init__(self, i):
        self.email = f"player{i}_{RUN}+clerk_test@example.com"
        self.uid = get_user(self.email)["id"]
        self.tok = token_for(self.uid)()
        self.name = f"e2e{RUN}_{i}"
        self.state = None
        self.ws = None

    def api(self, method, path, **kw):
        r = requests.request(method, BASE + "/api" + path, headers={"Authorization": f"Bearer {self.tok}"}, timeout=20, **kw)
        return r


async def reader(p, q):
    async for raw in p.ws:
        m = json.loads(raw)
        if m["type"] == "game_state":
            p.state = m
        await q.put((p, m))


async def main():
    ps = [P(i) for i in range(1, 5)]
    for p in ps:
        p.api("GET", "/me").raise_for_status()
        r = p.api("PATCH", "/me", json={"username": p.name})
        assert r.status_code == 200, r.text
    host = ps[0]
    # clean any active state
    for p in ps:
        p.api("POST", "/matchmaking/leave")
    room = host.api("POST", "/rooms", json={"target": 3}).json()
    code = room["code"]
    assert ps[1].api("GET", f"/rooms/{code}").status_code == 404, "non-member must not read room"
    for p in ps[1:]:
        assert p.api("POST", f"/rooms/{code}/join").status_code == 200
    assert ps[1].api("PATCH", f"/rooms/{code}/settings", json={"target": 5}).status_code == 403, "non-host cannot change settings"
    host.api("PATCH", f"/rooms/{code}/settings", json={"dealer_seat": 2}).raise_for_status()
    q = asyncio.Queue()
    for p in ps:
        p.ws = await connect_authenticated(WS, p.tok)
        asyncio.create_task(reader(p, q))
    for p in ps:
        p.api("POST", f"/rooms/{code}/ready", json={"ready": True}).raise_for_status()
    r = host.api("POST", f"/rooms/{code}/start")
    assert r.status_code == 200, r.text
    game_id = r.json()["game_id"]
    await asyncio.sleep(1.5)
    by_seat = {p.state["state"]["my_seat"]: p for p in ps}
    st0 = by_seat[0].state["state"]
    assert st0["dealer"] == 2 and st0["trump_selector"] == 3 and all(len(p.state["state"]["hand"]) == 5 for p in ps)

    # privacy: no other player's cards ever in a player's payload
    def check_privacy():
        if len({p.state["state"]["seq"] for p in ps}) != 1:
            return  # states mid-broadcast; compare only identical snapshots
        hands = {p.state["state"]["my_seat"]: set(p.state["state"]["hand"]) for p in ps}
        for p in ps:
            seat = p.state["state"]["my_seat"]
            payload = json.dumps({k: v for k, v in p.state["state"].items() if k not in ("hand", "legal", "partner_hand")})
            for s, h in hands.items():
                if s != seat:
                    for c in h:
                        assert f'"{c}"' not in payload, f"leak {c} to seat {seat}"

    rng = random.Random(7)
    disconnected_once = False
    actions = 0
    while True:
        await asyncio.sleep(0.05)
        st = by_seat[0].state["state"]
        if st["phase"] == "match_over":
            break
        if st["phase"] == "round_over":
            await asyncio.sleep(0.5)
            continue
        check_privacy()
        if st["phase"] == "trump_select":
            actor = by_seat[st["trump_selector"]]
            msg = {"action": "select_trump", "suit": rng.choice("SHDC")}
        elif st["phase"] == "playing":
            actor = by_seat[st["turn"]]
            mine = actor.state["state"]
            if mine["turn"] != mine["my_seat"] or not mine["legal"]:
                continue
            # out-of-turn attempt must be rejected
            other = by_seat[(st["turn"] + 1) % 4]
            if other.state["state"]["hand"]:
                await other.ws.send(json.dumps({"type": "game_action", "game_id": game_id, "action": "play", "card": other.state["state"]["hand"][0]}))
            msg = {"action": "play", "card": rng.choice(mine["legal"])}
        elif st["phase"] == "koth_decision":
            actor = by_seat[st["koth_decision"]]
            msg = {"action": "koth", "declare": rng.random() < 0.5}
        elif st["phase"] == "gs_decision":
            actor = by_seat[st["gs_eligible"]]
            msg = {"action": "grand_slam", "declare": rng.random() < 0.5}
        else:
            continue
        seq = st["seq"]
        await actor.ws.send(json.dumps({"type": "game_action", "game_id": game_id, **msg}))
        actions += 1
        for _ in range(100):
            await asyncio.sleep(0.05)
            if by_seat[0].state["state"]["seq"] != seq:
                break
        if not disconnected_once and actions == 10:
            # reconnection: drop a socket, verify state is preserved after reconnect
            victim = by_seat[1]
            before = list(victim.state["state"]["hand"])
            await victim.ws.close()
            await asyncio.sleep(1)
            assert by_seat[0].state["players"][1]["online"] is False
            victim.ws = await connect_authenticated(WS, victim.tok)
            asyncio.create_task(reader(victim, q))
            await victim.ws.send(json.dumps({"type": "sync_game", "game_id": game_id}))
            await asyncio.sleep(1)
            assert victim.state["state"]["hand"] == before, "hand preserved after reconnect"
            assert by_seat[0].state["players"][1]["online"] is True
            disconnected_once = True
            print("reconnect ok")
    st = by_seat[0].state["state"]
    print("match over", st["scores"], "rounds", [(r["winner_team"], r["type"]) for r in st["rounds"]])
    assert max(st["scores"]) >= 3
    await asyncio.sleep(1)
    hist = host.api("GET", "/matches").json()
    assert any(m["game_id"] == game_id for m in hist), "match recorded in history"
    lb = host.api("GET", "/leaderboard").json()
    assert lb, "leaderboard populated"
    for p in ps:
        await p.ws.close()
    print("E2E PASSED")


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
