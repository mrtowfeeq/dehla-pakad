"""Print fresh Clerk sign-in tickets keyed by seat for an existing demo game. Usage: python tests/tickets.py <RUN> <game_id>"""
import json
import sys

sys.path.insert(0, "/app/backend/tests")
import e2e_match  # noqa: E402

e2e_match.RUN = int(sys.argv[1])
out = {}
for i in range(1, 5):
    p = e2e_match.P(i)
    seat = p.api("GET", f"/games/{sys.argv[2]}").json()["state"]["my_seat"]
    out[seat] = e2e_match.bapi("/sign_in_tokens", {"user_id": p.uid, "expires_in_seconds": 3600})["token"]
print(json.dumps(out))
