"""Read-only check used by deploy.sh and rollback.sh before restarting the backend.

Counts, in the live/preview scope the server would use, the matches in progress and the public lobbies
(a restart deletes public lobbies and their in-memory queue; an active game resumes, but a turn whose
deadline passes during the restart is auto-played). Prints only counts, never connection details.

    <release>/venv/bin/python deploy/scripts/active_matches.py /opt/dehla-pakad/shared/backend.env

Exit codes: 0 = nothing in progress, 3 = matches or public lobbies in progress, 2 = could not check.
"""
import sys

from dotenv import dotenv_values
from pymongo import MongoClient


def main(env_file):
    try:
        cfg = dotenv_values(env_file)
        url, db_name = cfg.get("MONGO_URL"), cfg.get("DB_NAME")
        if not url or not db_name:
            print("could not check: MONGO_URL / DB_NAME missing", file=sys.stderr)
            return 2
        env = "live" if str(cfg.get("CLERK_PUBLISHABLE_KEY", "")).startswith("pk_live_") else "preview"
        with MongoClient(url, serverSelectionTimeoutMS=10000, appname="dehla-pakad-deploy-check") as client:
            db = client[db_name]
            games = db.games.count_documents({"env": env, "status": "active"})
            lobbies = db.rooms.count_documents({"env": env, "status": {"$in": ["lobby", "starting"]}, "is_public": True})
    except Exception as exc:  # never print the exception text: it can contain the connection string
        print(f"could not check: {type(exc).__name__}", file=sys.stderr)
        return 2
    print(f"scope={env} active_matches={games} public_lobbies={lobbies}")
    return 3 if games or lobbies else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "/opt/dehla-pakad/shared/backend.env"))
