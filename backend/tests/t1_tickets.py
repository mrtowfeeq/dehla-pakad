"""T1 helper: fresh sign-in tickets for reusable TEST users RUN=7311 players 1..4 -> /tmp/tk.json"""
import json
import sys

sys.path.insert(0, "/app/backend/tests")
import e2e_match as e  # noqa: E402

e.RUN = 7311
out = []
for i in (1, 2, 3, 4):
    uid = e.get_user(f"player{i}_{e.RUN}+clerk_test@example.com")["id"]
    out.append(e.bapi("/sign_in_tokens", {"user_id": uid, "expires_in_seconds": 3600})["token"])
json.dump(out, open("/tmp/tk.json", "w"))
print("ok")
