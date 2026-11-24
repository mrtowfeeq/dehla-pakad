"""T1 helper: create a game with N humans (fixed RUN users, reused) + bots; print JSON {gid, tickets:[...], uids:[...]}.
Usage: python tests/t1_mkgame.py <humans 1-4> [target]"""
import json
import sys

sys.path.insert(0, "/app/backend/tests")
import e2e_match  # noqa: E402

e2e_match.RUN = 7311
humans = int(sys.argv[1])
target = int(sys.argv[2]) if len(sys.argv) > 2 else 5
ps = [e2e_match.P(i) for i in range(1, humans + 1)]
for p in ps:
    me = p.api("GET", "/me").json()
    p.api("PATCH", "/me", json={"username": f"TEST_t1_{p.name[-1]}"})
    if me.get("active_game_id"):
        p.api("POST", f"/games/{me['active_game_id']}/exit")
host = ps[0]
code = host.api("POST", "/rooms", json={"target": target}).json()["code"]
for p in ps[1:]:
    assert p.api("POST", f"/rooms/{code}/join").status_code == 200
for _ in range(4 - humans):
    host.api("POST", f"/rooms/{code}/bots").raise_for_status()
for p in ps:
    p.api("POST", f"/rooms/{code}/ready", json={"ready": True}).raise_for_status()
r = host.api("POST", f"/rooms/{code}/start")
assert r.status_code == 200, r.text
gid = r.json()["game_id"]
tickets = [e2e_match.bapi("/sign_in_tokens", {"user_id": p.uid, "expires_in_seconds": 3600})["token"] for p in ps]
stats = [p.api("GET", "/me").json().get("stats") for p in ps]
print(json.dumps({"gid": gid, "code": code, "tickets": tickets, "uids": [p.uid for p in ps], "stats": stats}))
