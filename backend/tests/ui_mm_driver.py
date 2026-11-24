"""UI helper for public-lobby requeue: `setup` creates 5 players and prints a ticket for player 1; `drive` waits until player 1
(in the browser) is queued, then players 2-4 join, player 2 leaves after 15s, player 5 joins 15s later.
Usage: python tests/ui_mm_driver.py setup <RUN> | python tests/ui_mm_driver.py drive <RUN>"""
import sys
import time

sys.path.insert(0, "/app/backend/tests")
from dotenv import dotenv_values  # noqa: E402

import e2e_match  # noqa: E402

e2e_match.BASE = dotenv_values("/app/frontend/.env")["REACT_APP_BACKEND_URL"].rstrip("/")
e2e_match.RUN = int(sys.argv[2])
ps = [e2e_match.P(i) for i in range(1, 6)]
if sys.argv[1] == "setup":
    for i, p in enumerate(ps, 1):
        p.api("GET", "/me")
        p.api("PATCH", "/me", json={"username": f"ui{e2e_match.RUN}_{i}"})
    print(e2e_match.bapi("/sign_in_tokens", {"user_id": ps[0].uid, "expires_in_seconds": 3600})["token"])
    sys.exit()
for _ in range(180):
    if ps[0].api("GET", "/matchmaking/status").json().get("queued"):
        break
    time.sleep(1)
print("p1 queued", flush=True)
code = None
for p in ps[1:4]:
    r = p.api("POST", "/matchmaking/join").json()
    code = r.get("room_code") or code
print("matched", code, flush=True)
time.sleep(15)
print("p2 leaves", ps[1].api("POST", f"/rooms/{code}/leave").status_code, flush=True)
time.sleep(15)
r = ps[4].api("POST", "/matchmaking/join").json()
print("p5 joins", r, flush=True)
time.sleep(25)
for p in ps[1:]:
    st = p.api("GET", "/matchmaking/status").json()
    if st.get("room_code"):
        p.api("POST", f"/rooms/{st['room_code']}/leave")
    p.api("POST", "/matchmaking/leave")
print("cleanup done", flush=True)
