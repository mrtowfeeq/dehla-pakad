"""Read-only check used by deploy.sh and rollback.sh before restarting the backend.

Counts what a restart would disturb, in the live/preview scope the server uses:

* matches in progress: games with status "active" (the same query the server resumes on startup);
* public lobbies ("lobby"/"starting"): a restart deletes them and their in-memory queue;
* rooms of any kind in "starting": a restart resets them to the lobby and refunds stake holds;
* players waiting in (or moving between) the in-memory matchmaking queues and live games, asked from the
  running backend on loopback (GET http://127.0.0.1:<port>/api/internal/activity), before and after the
  database is read; nothing else can see the queue.

Prints only counts, never connection details.

    <release>/venv/bin/python deploy/scripts/active_matches.py /opt/dehla-pakad/shared/backend.env [port]

Exit codes:
  0 = nothing in progress;
  3 = something in progress (any count above zero; the database counts always decide this, even when the
      queue cannot be read);
  4 = the database shows nothing in progress, but the running backend cannot report its queue (for example
      the release before the deploy kit, which has no activity endpoint): players waiting in its queue
      would be dropped;
  2 = could not check the database (treat as "do not restart").
A backend that is not running has no queue (nothing listens, so no process can hold one).
"""
import json
import sys
import urllib.error
import urllib.request

from dotenv import dotenv_values
from pymongo import MongoClient

TIMEOUTS = {"serverSelectionTimeoutMS": 10000, "connectTimeoutMS": 10000, "socketTimeoutMS": 15000}
QUERY_MS = 10000


def database_counts(cfg):
    url, db_name = cfg.get("MONGO_URL"), cfg.get("DB_NAME")
    if not url or not db_name:
        raise LookupError("MONGO_URL / DB_NAME missing")
    env = "live" if str(cfg.get("CLERK_PUBLISHABLE_KEY", "")).startswith("pk_live_") else "preview"
    with MongoClient(url, appname="dehla-pakad-deploy-check", **TIMEOUTS) as client:
        db = client[db_name]
        # Rooms before games: a starting room becomes "playing" only after its game is stored as active,
        # so a start that completes between the two queries is seen by one of them.
        lobbies = db.rooms.count_documents({"env": env, "status": {"$in": ["lobby", "starting"]}, "is_public": True},
                                           maxTimeMS=QUERY_MS)
        starting = db.rooms.count_documents({"env": env, "status": "starting"}, maxTimeMS=QUERY_MS)
        games = db.games.count_documents({"env": env, "status": "active"}, maxTimeMS=QUERY_MS)
    return env, games, lobbies, starting


def backend_activity(port):
    """In-memory activity of the running backend: queued (or in-transit) players plus live games.
    0 if the backend is not running, None if unknown."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/internal/activity", timeout=5) as resp:
            body = json.load(resp)
            return int(body.get("queued_players", 0)) + int(body.get("active_games", 0))
    except urllib.error.HTTPError:
        return None  # running, but no answer from the endpoint (e.g. an older release): unknown
    except (urllib.error.URLError, ConnectionError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, ConnectionRefusedError) or isinstance(exc, ConnectionRefusedError):
            return 0  # nothing listening: no backend, no queue
        return None
    except (ValueError, TypeError):
        return None


def main(env_file, port=8000):
    # The backend is read before AND after the database. Players only move between the two (a queue becomes
    # a public lobby, a dissolved lobby goes back to a queue) with an in-memory transit count covering the
    # gap, so anything that moves while the database is being read is seen by one of the three reads.
    before = backend_activity(port)
    try:
        env, games, lobbies, starting = database_counts(dotenv_values(env_file, interpolate=False))
    except Exception as exc:  # never print the exception text: it can contain the connection string
        print(f"could not check the database: {type(exc).__name__}", file=sys.stderr)
        return 2
    after = backend_activity(port)
    queued = None if before is None or after is None else max(before, after)
    shown = "unknown" if queued is None else queued
    print(f"scope={env} active_matches={games} public_lobbies={lobbies} starting_rooms={starting} backend_in_memory={shown}")
    if games or lobbies or starting or queued:
        return 3
    if queued is None:
        print("could not read the matchmaking queue from the running backend", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    sys.exit(main(args[0] if args else "/opt/dehla-pakad/shared/backend.env", int(args[1]) if len(args) > 1 else 8000))
