"""Helper: after a delay, put players 2..4 of RUN into the public queue, then mark them ready. Usage: python tests/mm_helper.py <RUN> <delay>"""
import sys
import time

sys.path.insert(0, "/app/backend/tests")
import e2e_match  # noqa: E402

e2e_match.RUN = int(sys.argv[1])
time.sleep(float(sys.argv[2]))
ps = [e2e_match.P(i) for i in range(2, 5)]
code = None
for p in ps:
    r = p.api("POST", "/matchmaking/join").json()
    print("join", r)
    code = r.get("room_code") or code
time.sleep(8)
for p in ps:
    print("ready", p.api("POST", f"/rooms/{code}/ready", json={"ready": True}).status_code)
