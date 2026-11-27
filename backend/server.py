import asyncio
import logging
import math
import os
import random
import re
import secrets
import time
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Literal, Optional

import requests
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, IndexModel, ReturnDocument
from pymongo.errors import DuplicateKeyError, PyMongoError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

try:
    from backend.clerk_auth import (clerk_router, fetch_clerk_session, require_user, revoke_clerk_session,
                                    verify_session_token)
    from backend.session_guard import (SESSION_REPLACED_CODE, SESSION_REPLACED_MESSAGE, SessionGuard,
                                       SessionInvalid, SessionReplaced, SessionUnavailable)
    from backend.game_service import (Hub, GameService, EMOJIS, now_iso, DEFAULT_TURN_DURATION,
                                      PUBLIC_TURN_DURATION, TurnDuration, SpectatorHub)
    from backend.spectator import spectator_invite_hash, public_game_card, SpectatorAccessError
    from backend.progression import achievement_cards, ensure_streak_history, public_progression
    from backend.lobby_chat import (
        LobbyChatAccessError,
        LobbyChatRateLimiter,
        existing_room_chat_filter,
        load_private_lobby_history,
        send_private_lobby_message,
    )
    from backend.bots import BOT_NAMES
    from backend.admin_ops import (ROLES, ROLE_RANK, admin_audit_activity_visible, has_admin_permission,
                                   admin_lobby_projection, is_bootstrap_admin, role_change_denial)
    from backend.env_scope import scoped_query
    from backend.request_ip import client_ip, trusted_proxy_header
    from backend.voice import VoiceService
    from backend.wallet import STAKE_TIERS, InsufficientCoins, Wallet, WalletError, tier_view
    from backend.medals import MEDALS_PER_TEN, MEDALS_PER_TRICK, VICTORY_MEDALS, Medals, private_view
    from backend import leagues
except ModuleNotFoundError:
    from bots import BOT_NAMES
    from clerk_auth import (clerk_router, fetch_clerk_session, require_user, revoke_clerk_session,
                            verify_session_token)
    from session_guard import (SESSION_REPLACED_CODE, SESSION_REPLACED_MESSAGE, SessionGuard,
                               SessionInvalid, SessionReplaced, SessionUnavailable)
    from game_service import (Hub, GameService, EMOJIS, now_iso, DEFAULT_TURN_DURATION,
                              PUBLIC_TURN_DURATION, TurnDuration, SpectatorHub)
    from spectator import spectator_invite_hash, public_game_card, SpectatorAccessError
    from progression import achievement_cards, ensure_streak_history, public_progression
    from admin_ops import (ROLES, ROLE_RANK, admin_audit_activity_visible, has_admin_permission,
                           admin_lobby_projection, is_bootstrap_admin, role_change_denial)
    from env_scope import scoped_query
    from request_ip import client_ip, trusted_proxy_header
    from voice import VoiceService
    from wallet import STAKE_TIERS, InsufficientCoins, Wallet, WalletError, tier_view
    from medals import MEDALS_PER_TEN, MEDALS_PER_TRICK, VICTORY_MEDALS, Medals, private_view
    import leagues
    from lobby_chat import (
        LobbyChatAccessError,
        LobbyChatRateLimiter,
        existing_room_chat_filter,
        load_private_lobby_history,
        send_private_lobby_message,
    )

client = AsyncIOMotorClient(os.environ['MONGO_URL'])
db = client[os.environ['DB_NAME']]
ENV = "live" if os.environ.get("CLERK_PUBLISHABLE_KEY", "").startswith("pk_live_") else "preview"
IN_ENV = {"env": ENV}
PROCESS_STARTED_AT = time.monotonic()
INDEX_INITIALIZATION_STATE = {
    "status": "pending",
    "started_at": None,
    "completed_at": None,
    "attempted": 0,
    "failures": [],
}
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

INDEXES: dict[str, list[IndexModel]] = {
    # Keep uniqueness inside each Clerk environment. Existing installations keep
    # their old global indexes until an operator explicitly migrates them.
    "users": [IndexModel([("env", ASCENDING), ("user_id", ASCENDING)], name="env_user_id_unique", unique=True),
              IndexModel([("env", ASCENDING), ("username_lower", ASCENDING)], name="env_username_lower_unique", unique=True,
                         partialFilterExpression={"username_lower": {"$type": "string"}}),
              IndexModel([("env", ASCENDING), ("created_at", DESCENDING)], name="env_created_at_desc"),
              IndexModel([("env", ASCENDING), ("stats.wins", DESCENDING), ("stats.games_played", ASCENDING)],
                         name="env_leaderboard"),
              IndexModel([("env", ASCENDING), ("account_status", ASCENDING), ("created_at", DESCENDING)],
                         name="env_account_status_created"),
              IndexModel([("env", ASCENDING), ("last_seen", DESCENDING)], name="env_last_seen_desc"),
              IndexModel([("env", ASCENDING), ("stats.games_played", DESCENDING)], name="env_games_played_desc"),
              IndexModel([("env", ASCENDING), ("stats.wins", DESCENDING)], name="env_wins_desc"),
              # Medal leaderboard (lifetime medals, see medals.py).
              IndexModel([("env", ASCENDING), ("medals", DESCENDING), ("stats.wins", DESCENDING)], name="env_medals_desc")],
    "friends": [IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("friend_id", ASCENDING)], name="env_pair_unique", unique=True)],
    "friend_requests": [IndexModel([("env", ASCENDING), ("to_id", ASCENDING), ("status", ASCENDING)], name="env_to_status"),
                        IndexModel([("env", ASCENDING), ("from_id", ASCENDING), ("status", ASCENDING)], name="env_from_status"),
                        IndexModel([("env", ASCENDING), ("id", ASCENDING)], name="env_id_unique", unique=True)],
    "rooms": [IndexModel([("env", ASCENDING), ("code", ASCENDING)], name="env_code_unique", unique=True),
              IndexModel([("env", ASCENDING), ("seats", ASCENDING)], name="env_seats"),
              IndexModel([("env", ASCENDING), ("created_at", DESCENDING)], name="env_created_at_desc"),
              IndexModel([("env", ASCENDING), ("status", ASCENDING), ("is_public", ASCENDING), ("created_at", DESCENDING)], name="env_status_visibility_created"),
              IndexModel([("env", ASCENDING), ("status", ASCENDING), ("created_at", DESCENDING)], name="env_status_created")],
    "games": [IndexModel([("env", ASCENDING), ("id", ASCENDING)], name="env_id_unique", unique=True),
              IndexModel([("env", ASCENDING), ("status", ASCENDING)], name="env_status"),
              IndexModel([("env", ASCENDING), ("created_at", DESCENDING)], name="env_created_at_desc"),
              IndexModel([("env", ASCENDING), ("room_code", ASCENDING)], name="env_room_code"),
              IndexModel([("env", ASCENDING), ("is_public", ASCENDING), ("status", ASCENDING), ("updated_at", DESCENDING)], name="env_public_active_updated"),
              IndexModel([("env", ASCENDING), ("status", ASCENDING), ("updated_at", DESCENDING)], name="env_status_updated")],
    "admin_audit_logs": [IndexModel([("env", ASCENDING), ("timestamp", DESCENDING)], name="env_timestamp_desc"),
                         IndexModel([("env", ASCENDING), ("admin_id", ASCENDING), ("timestamp", DESCENDING)], name="env_admin_timestamp")],
    "spectator_sessions": [IndexModel([("env", ASCENDING), ("game_id", ASCENDING), ("user_id", ASCENDING)], name="env_game_user_unique", unique=True),
                           # MongoDB TTL indexes must be single-field. Expiry applies to each session independently.
                           IndexModel([("expires_at", ASCENDING)], name="expires_ttl", expireAfterSeconds=0)],
    "game_events": [IndexModel([("env", ASCENDING), ("game_id", ASCENDING), ("ts", ASCENDING)], name="env_game_ts")],
    "matches": [IndexModel([("env", ASCENDING), ("player_ids", ASCENDING), ("finished_at", DESCENDING)], name="env_player_finished"),
                IndexModel([("env", ASCENDING), ("finished_at", DESCENDING)], name="env_finished_at_desc"),
                IndexModel([("env", ASCENDING), ("game_id", ASCENDING)], name="env_game_id_unique", unique=True)],
    "chat_messages": [
        IndexModel([("env", ASCENDING), ("room_code", ASCENDING), ("ts", DESCENDING)], name="env_room_ts"),
        IndexModel(
            [("env", ASCENDING), ("room_code", ASCENDING), ("channel", ASCENDING), ("ts", DESCENDING)],
            name="env_room_channel_ts",
        ),
    ],
    "invitations": [IndexModel([("env", ASCENDING), ("to_id", ASCENDING), ("status", ASCENDING), ("created_at", DESCENDING)], name="env_to_status_created"),
                    IndexModel([("env", ASCENDING), ("to_id", ASCENDING), ("room_code", ASCENDING)], name="env_to_room"),
                    IndexModel([("env", ASCENDING), ("id", ASCENDING)], name="env_id_unique", unique=True)],
    "admin_player_notes": [IndexModel([("env", ASCENDING), ("id", ASCENDING)], name="env_id_unique", unique=True),
                           IndexModel([("env", ASCENDING), ("target_user_id", ASCENDING), ("created_at", DESCENDING)],
                                      name="env_player_notes_created")],
    # One active Clerk session per account (see session_guard.py).
    "user_sessions": [IndexModel([("env", ASCENDING), ("user_id", ASCENDING)], name="env_user_id_unique", unique=True)],
    # Coin history (see wallet.py): one entry per applied change, newest first per player.
    "coin_ledger": [IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("key", ASCENDING)], name="env_user_key_unique", unique=True),
                    IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("ts", DESCENDING)], name="env_user_ts_desc")],
    # Medal history (see medals.py): one entry per player per awarded round, newest first per player.
    "medal_awards": [IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("key", ASCENDING)], name="env_user_key_unique", unique=True),
                     IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("ts", DESCENDING)], name="env_user_ts_desc")],
    # League / level transitions and medal changes to present (see medals.py), one per id per player.
    "progression_events": [IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("id", ASCENDING)], name="env_user_event_unique", unique=True),
                           IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("acknowledged_at", ASCENDING), ("created_at", ASCENDING)],
                                      name="env_user_pending"),
                           IndexModel([("env", ASCENDING), ("user_id", ASCENDING), ("kind", ASCENDING), ("created_at", DESCENDING)],
                                      name="env_user_kind_recent")],
}


async def ensure_indexes() -> None:
    INDEX_INITIALIZATION_STATE.update({
        "status": "running",
        "started_at": now_iso(),
        "completed_at": None,
        "attempted": 0,
        "failures": [],
    })
    for collection, models in INDEXES.items():
        for model in models:
            INDEX_INITIALIZATION_STATE["attempted"] += 1
            try:
                await db[collection].create_indexes([model])
            except Exception as exc:
                logger.error("ensure_indexes(%s.%s) failed (%s)", collection, model.document["name"], type(exc).__name__)
                INDEX_INITIALIZATION_STATE["failures"].append({
                    "collection": collection,
                    "index": model.document["name"],
                    "error_type": type(exc).__name__,
                })
    INDEX_INITIALIZATION_STATE["status"] = "critical" if INDEX_INITIALIZATION_STATE["failures"] else "healthy"
    INDEX_INITIALIZATION_STATE["completed_at"] = now_iso()


def _index_document(model):
    document = model.document
    return {
        "name": document.get("name"),
        "key_pattern": [[key, direction] for key, direction in document["key"].items()],
        "unique": bool(document.get("unique", False)),
        "partial_filter_expression": document.get("partialFilterExpression"),
        "expire_after_seconds": document.get("expireAfterSeconds"),
    }


def _safe_database_name(value):
    # Only return a conventional database identifier. Never echo arbitrary DB_NAME
    # configuration, which could contain a URI or another accidentally secret value.
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,63}", value):
        return value
    return None


def _safe_index_name(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", value) else None


def _canonical_filter(value):
    if isinstance(value, dict):
        return tuple((key, _canonical_filter(item)) for key, item in sorted(value.items()))
    if isinstance(value, (list, tuple)):
        return tuple(_canonical_filter(item) for item in value)
    return value


def _actual_index_document(document):
    key = document.get("key", {})
    return {
        "name": _safe_index_name(document.get("name")),
        "key_pattern": [[field, direction] for field, direction in key.items()],
        "unique": bool(document.get("unique", False)),
        "partial_filter_expression": document.get("partialFilterExpression"),
        "expire_after_seconds": document.get("expireAfterSeconds"),
    }


def _index_comparison(declared, actual_indexes, metadata_available=True):
    if not metadata_available:
        return {"status": "unknown", "verified": False, "actual": None, "issues": ["metadata_unavailable"]}

    expected_name = declared["name"]
    named = next((item for item in actual_indexes if item.get("name") == expected_name), None)
    expected_key = declared["key_pattern"]
    candidates = [item for item in actual_indexes if item["key_pattern"] == expected_key]
    actual = named or (candidates[0] if candidates else None)
    if actual is None:
        return {"status": "critical", "verified": False, "actual": None, "issues": ["missing"]}

    mismatches = []
    if actual["key_pattern"] != expected_key:
        mismatches.append("key_pattern_mismatch")
    if actual["unique"] != declared["unique"]:
        mismatches.append("unique_mismatch")
    if _canonical_filter(actual["partial_filter_expression"]) != _canonical_filter(declared["partial_filter_expression"]):
        mismatches.append("partial_filter_mismatch")
    if actual["expire_after_seconds"] != declared["expire_after_seconds"]:
        mismatches.append("ttl_mismatch")
    if mismatches:
        return {"status": "critical", "verified": False, "actual": actual, "issues": mismatches}

    if actual["name"] != expected_name:
        return {"status": "warning", "verified": True, "actual": actual, "issues": ["equivalent_definition_different_name"]}
    return {"status": "healthy", "verified": True, "actual": actual, "issues": []}


async def _load_index_metadata(collection):
    cursor = db[collection].list_indexes()
    return await asyncio.wait_for(cursor.to_list(length=None), timeout=3)


async def _verify_declared_indexes(database_available):
    if not database_available:
        unavailable = {collection: None for collection in INDEXES}
    else:
        collections = list(INDEXES)
        results = await asyncio.gather(*(_load_index_metadata(name) for name in collections), return_exceptions=True)
        unavailable = {}
        for collection, result in zip(collections, results):
            if isinstance(result, BaseException):
                logger.warning("System health index metadata unavailable for %s (%s)", collection, type(result).__name__)
                unavailable[collection] = None
            else:
                unavailable[collection] = [_actual_index_document(index) for index in result]

    items = []
    for collection, models in INDEXES.items():
        actual_indexes = unavailable[collection]
        for model in models:
            declared = _index_document(model)
            comparison = _index_comparison(declared, actual_indexes or [], actual_indexes is not None)
            items.append({"collection": collection, "declared": declared, "verification": comparison})

    counts = {
        "declared_count": len(items),
        "verified_count": sum(item["verification"]["verified"] for item in items),
        "missing_count": sum("missing" in item["verification"]["issues"] for item in items),
        "incompatible_count": sum(item["verification"]["status"] == "critical" and "missing" not in item["verification"]["issues"] for item in items),
        "unknown_count": sum(item["verification"]["status"] == "unknown" for item in items),
    }
    if counts["missing_count"] or counts["incompatible_count"]:
        status = "critical"
    elif counts["unknown_count"]:
        status = "unknown"
    elif any(item["verification"]["status"] == "warning" for item in items):
        status = "warning"
    else:
        status = "healthy"
    return {"status": status, **counts, "items": items}


def api_docs_enabled(env=None, flag=None) -> bool:
    """Interactive API docs (/docs, /redoc, /openapi.json): on for preview, off for live unless API_DOCS=true."""
    env = ENV if env is None else env
    flag = os.environ.get("API_DOCS", "") if flag is None else flag
    if str(flag).strip().lower() in ("1", "true", "yes"):
        return True
    if str(flag).strip().lower() in ("0", "false", "no"):
        return False
    return env != "live"


def cors_settings(raw=None):
    """Allowed browser origins from CORS_ORIGINS (comma-separated). Unset means no cross-origin access,
    which is right when the site and /api share one domain; "*" never comes with credentials."""
    raw = os.environ.get("CORS_ORIGINS", "") if raw is None else raw
    origins = [o.strip().rstrip("/") for o in str(raw).split(",") if o.strip()]
    return {"allow_origins": origins, "allow_credentials": "*" not in origins}


_DOCS = api_docs_enabled()
app = FastAPI(title="Dehla Pakad", docs_url="/docs" if _DOCS else None, redoc_url="/redoc" if _DOCS else None,
              openapi_url="/openapi.json" if _DOCS else None)
api_router = APIRouter(prefix="/api")
hub = Hub()
try:
    SPECTATOR_LIMIT = max(1, int(os.environ.get("SPECTATOR_LIMIT", "100")))
except ValueError:
    SPECTATOR_LIMIT = 100
spectator_hub = SpectatorHub(max_per_game=SPECTATOR_LIMIT)
games = GameService(db, hub, spectator_hub=spectator_hub, env=ENV)
wallet = Wallet(db, hub, env=ENV)
games.wallet = wallet
medals = Medals(db, hub, env=ENV)
games.medals = medals
lobby_chat_limiter = LobbyChatRateLimiter()


async def _voice_load_user(user_id):
    """Return only the profile fields needed for presence after rechecking account access."""
    user = await db.users.find_one({"user_id": user_id, **IN_ENV}, {
        "_id": 0, "username": 1, "display_name": 1, "avatar_color": 1, "avatar_icon": 1,
        "role": 1, "account_status": 1, "account_restriction": 1,
    })
    if not user or not user.get("username"):
        return None
    if await _active_account_restriction(user_id, _stored_account_restriction(user)):
        return None
    return user


voice_service = VoiceService(
    db, games, env=ENV, load_user=_voice_load_user,
    has_spectate_permission=lambda role: has_admin_permission(role, "admin:spectate"),
)
games.on_game_end = voice_service.close_game

# ---------------- one active session per account ----------------
WS_SESSION_REPLACED_CLOSE = 4409
# Authenticated sockets -> (user id, Clerk session id); lets a newer login close the older session's sockets.
socket_sessions: dict[WebSocket, tuple[str, str]] = {}


def session_replaced_message():
    return {"type": SESSION_REPLACED_CODE, "message": SESSION_REPLACED_MESSAGE}


async def _close_replaced_socket(ws):
    with suppress(Exception):
        await ws.send_json(session_replaced_message())
    with suppress(Exception):
        await ws.close(code=WS_SESSION_REPLACED_CLOSE)


async def close_replaced_sessions(uid, old_sid, new_sid):
    """Close only this account's sockets that belong to a session other than the new one."""
    stale = [ws for ws, (owner, sid) in list(socket_sessions.items()) if owner == uid and sid != new_sid]
    for ws in stale:
        await _close_replaced_socket(ws)


session_guard = SessionGuard(
    db, ENV,
    fetch_session=lambda sid: run_in_threadpool(fetch_clerk_session, sid),
    revoke_session=lambda sid: run_in_threadpool(revoke_clerk_session, sid),
    on_replaced=close_replaced_sessions,
)


def session_replaced_http_error():
    return HTTPException(status_code=401, detail={"code": SESSION_REPLACED_CODE, "message": SESSION_REPLACED_MESSAGE})


async def enforce_active_session(uid, sid):
    try:
        await session_guard.check(uid, sid)
    except SessionReplaced:
        raise session_replaced_http_error() from None
    except SessionInvalid:
        raise HTTPException(status_code=401, detail="Invalid or expired session") from None
    except SessionUnavailable:
        raise HTTPException(status_code=503, detail="Could not verify your session. Try again shortly.") from None


async def require_active_session(user: dict = Depends(require_user)) -> dict:
    """require_user plus the one-active-session-per-account policy."""
    await enforce_active_session(user["user_id"], user.get("session_id"))
    return user

# ---------------- rate limiting ----------------
_hits: dict[str, list[float]] = defaultdict(list)
_profile_update_hits: dict[str, list[float]] = defaultdict(list)
_admin_lobby_audit_at: dict[str, float] = {}
_admin_request_hits: dict[tuple[str, str], list[float]] = defaultdict(list)
# Allows the health route to remain readable briefly during a Mongo outage, based
# only on an admin role verified from Mongo during a recent authenticated request.
_health_admin_role_cache: dict[str, float] = {}
HEALTH_ADMIN_ROLE_CACHE_TTL = 15


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/__clerk"):
        ip = client_ip(request)
        t = time.monotonic()
        recent = [x for x in _hits[ip] if t - x < 60]
        recent.append(t)
        _hits[ip] = recent
        if len(recent) > 300:
            return JSONResponse({"detail": "Too many requests, slow down"}, status_code=429)
    return await call_next(request)


def _is_admin_api_path(path: str) -> bool:
    return (path == "/api/admin" or path.startswith("/api/admin/") or path == "/api/users"
            or re.fullmatch(r"/api/users/[^/]+/role", path) is not None)


async def audit_admin_denial(request: Request, actor_id=None, *, target_type="admin_api", target_id=None,
                            reason="Access denied", action="authorization_denied"):
    # Keep this record path-only: never capture headers, query strings, request
    # bodies, Clerk tokens, or submitted game/card data.
    request.state.admin_access_audited = True
    try:
        await games.audit_admin(actor_id, action, target_type=target_type,
                                target_id=target_id or request.url.path, success=False, reason=reason)
    except Exception:
        logger.warning("failed to record denied admin request")


def allow_admin_request(actor_id: str, bucket="read", *, limit=120, window=60.0, now=None):
    current = time.monotonic() if now is None else now
    key = (actor_id, bucket)
    recent = [hit for hit in _admin_request_hits[key] if current - hit < window]
    if len(recent) >= limit:
        _admin_request_hits[key] = recent
        return False
    recent.append(current)
    _admin_request_hits[key] = recent
    return True


@asynccontextmanager
async def admin_role_update_lock(lock_name="staff-role-mutations", busy_message="Role management is busy; retry shortly"):
    """Serialize administrative mutations with a recoverable environment-scoped Mongo lease."""
    owner = str(uuid.uuid4())
    collection = db.admin_role_locks
    lease_seconds = 120
    acquired = False
    for _ in range(100):
        now = datetime.now(timezone.utc)
        try:
            lock = await collection.find_one_and_update(
                {"_id": f"{ENV}:{lock_name}", "lease_until": {"$lte": now}},
                {"$set": {"env": ENV, "owner": owner, "lease_until": now + timedelta(seconds=lease_seconds)}},
                upsert=True, return_document=ReturnDocument.AFTER,
            )
            acquired = bool(lock and lock.get("owner") == owner)
        except DuplicateKeyError:
            # A different worker owns the unexpired singleton lock document.
            acquired = False
        if acquired:
            break
        await asyncio.sleep(0.05)
    if not acquired:
        raise HTTPException(status_code=503, detail=busy_message)
    try:
        yield
    finally:
        try:
            await collection.update_one(
                {"_id": f"{ENV}:{lock_name}", "owner": owner},
                {"$set": {"lease_until": datetime.fromtimestamp(0, timezone.utc)}},
            )
        except Exception:
            logger.warning("failed to release administrative role lock; its lease will expire")


@app.middleware("http")
async def audit_denied_admin_access(request: Request, call_next):
    response = await call_next(request)
    player_action = re.fullmatch(r"/api/admin/players/([^/]+)/(suspend|ban|unban|notes)", request.url.path)
    if (player_action and 400 <= response.status_code < 500
            and not getattr(request.state, "admin_access_audited", False)):
        target_id, operation = player_action.groups()
        target_id = target_id if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", target_id) else "invalid_target"
        action = "player_note_denied" if operation == "notes" else "player_moderation_denied"
        await audit_admin_denial(
            request, getattr(request.state, "authenticated_user_id", None), target_type="player",
            target_id=target_id, reason=f"Player-management request rejected (HTTP {response.status_code})",
            action=action,
        )
    elif (_is_admin_api_path(request.url.path) and response.status_code in (401, 403)
          and not getattr(request.state, "admin_access_audited", False)):
        await audit_admin_denial(
            request, getattr(request.state, "authenticated_user_id", None),
            reason="Authentication required" if response.status_code == 401 else "Access denied",
        )
    return response


# ---------------- users & roles ----------------
ROLES = list(ROLES)
DEFAULT_ROLE = "member"
RETIRED_ROLES = {}
RANK = ROLE_RANK
AVATAR_COLORS = ["#38bdf8", "#f59e0b", "#10b981", "#f43f5e", "#a78bfa", "#eab308", "#14b8a6", "#fb7185"]
AVATAR_ICONS = ["spade", "heart", "diamond", "club", "crown", "star", "flame", "gem"]
EMPTY_STATS = {"games_played": 0, "wins": 0, "losses": 0, "draws": 0, "rounds_won": 0,
               "normal_wins": 0, "koth_wins": 0, "grand_slam_wins": 0}


def effective_role(role) -> str:
    role = RETIRED_ROLES.get(role, role)
    return role if role in ROLES else DEFAULT_ROLE


def _clerk_identity(user_id: str):
    r = requests.get(f"https://api.clerk.com/v1/users/{user_id}", timeout=10,
                     headers={"Authorization": f"Bearer {os.environ['CLERK_SECRET_KEY']}", "User-Agent": "dehla-pakad"})
    r.raise_for_status()
    emails = r.json()["email_addresses"]
    verified = [e["email_address"].lower() for e in emails if (e.get("verification") or {}).get("status") == "verified"]
    email = verified[0] if verified else (emails[0]["email_address"].lower() if emails else "")
    return email, is_bootstrap_admin(verified, os.environ.get("ADMIN_EMAIL", ""))


def _as_utc_datetime(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
        except ValueError:
            return None
    return None


def _restriction_message(restriction):
    reason = str(restriction.get("reason") or "")[:500]
    if restriction.get("type") == "suspended":
        expires_at = restriction.get("expires_at")
        message = f"Your account is temporarily suspended until {expires_at}."
    else:
        message = "Your account is permanently banned."
    return f"{message} Reason: {reason}" if reason else message


def _stored_account_restriction(user):
    restriction = user.get("account_restriction")
    status = user.get("account_status")
    if status == "banned":
        if isinstance(restriction, dict) and restriction.get("type") == "banned":
            return restriction
        return {"type": "banned", "reason": "Account access is restricted", "expires_at": None}
    if status == "suspended":
        if isinstance(restriction, dict) and restriction.get("type") == "suspended":
            return restriction
        return {"type": status, "reason": "Account access is restricted", "expires_at": None}
    return restriction if isinstance(restriction, dict) else None


async def _active_account_restriction(user_id, restriction, *, retries=1):
    if not isinstance(restriction, dict):
        return None
    restriction_type = restriction.get("type")
    if restriction_type == "banned":
        return restriction
    if restriction_type != "suspended":
        # Unknown persisted restrictions fail closed rather than silently allowing access.
        return {"type": "banned", "reason": "Account access is restricted"}

    expires_at = _as_utc_datetime((restriction or {}).get("expires_at"))
    if expires_at is None or expires_at > datetime.now(timezone.utc):
        return restriction

    expired_at = now_iso()
    event = {
        "id": str(uuid.uuid4()), "env": ENV, "action": "suspension_expired",
        "actor_id": "system", "target_user_id": user_id,
        "reason": "Temporary suspension expired automatically", "timestamp": expired_at,
        "previous_status": "suspended", "new_status": "active",
        "expires_at": restriction.get("expires_at"),
    }
    result = await db.users.update_one(
        {"user_id": user_id, **IN_ENV, "account_restriction": restriction},
        {"$set": {"account_status": "active"}, "$unset": {"account_restriction": ""},
         "$push": {"moderation_history": event}},
    )
    if result.matched_count:
        try:
            await games.audit_admin(None, "player_suspension_expired", target_type="player", target_id=user_id,
                                    reason=event["reason"], previous_value={"status": "suspended"},
                                    new_value={"status": "active", "expires_at": event["expires_at"]})
        except Exception as exc:
            logger.warning("Automatic suspension expiry audit unavailable (%s)", type(exc).__name__)
        return None

    # A moderator may have changed the record while this request was expiring it.
    if retries:
        latest = await db.users.find_one({"user_id": user_id, **IN_ENV}, {"_id": 0, "account_restriction": 1})
        latest_restriction = latest.get("account_restriction") if latest else None
        if latest_restriction != restriction:
            return await _active_account_restriction(user_id, latest_restriction, retries=retries - 1)
    return restriction


async def current_member(request: Request, user: dict = Depends(require_active_session)) -> dict:
    uid = user["user_id"]
    request.state.authenticated_user_id = uid
    member = await db.users.find_one({"user_id": uid, **IN_ENV}, {"_id": 0})
    if member is None or not member.get("role"):
        email, is_admin = await run_in_threadpool(_clerk_identity, uid)
        role = "admin" if is_admin else DEFAULT_ROLE
        await db.users.update_one({"user_id": uid, **IN_ENV, "role": {"$in": [None, ""]}},
                                   {"$set": {"role": role}})
        member = await db.users.find_one_and_update(
            {"user_id": uid, **IN_ENV},
            {"$setOnInsert": {"user_id": uid, "env": ENV, "role": role, "email": email, "stats": dict(EMPTY_STATS),
                              "avatar_color": random.choice(AVATAR_COLORS), "avatar_icon": random.choice(AVATAR_ICONS),
                              "created_at": now_iso()}},
            upsert=True, projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    restriction = await _active_account_restriction(uid, _stored_account_restriction(member))
    if restriction:
        _health_admin_role_cache.pop(uid, None)
        raise HTTPException(status_code=403, detail=_restriction_message(restriction))
    role = effective_role(member["role"])
    if role == "admin":
        _health_admin_role_cache[uid] = time.monotonic() + HEALTH_ADMIN_ROLE_CACHE_TTL
    else:
        _health_admin_role_cache.pop(uid, None)
    return {**member, "env": ENV, "role": role}


def require_system_health_admin():
    async def check(request: Request, user: dict = Depends(require_active_session)) -> dict:
        uid = user["user_id"]
        if not allow_admin_request(uid):
            raise HTTPException(status_code=429, detail="Too many administrative requests")
        try:
            member = await current_member(request, user)
        except PyMongoError as exc:
            cached_until = _health_admin_role_cache.get(uid, 0)
            if cached_until > time.monotonic():
                return {"user_id": uid, "env": ENV, "role": "admin"}
            logger.warning("System health request denied for user %s because admin role cannot be verified (%s)",
                           uid, type(exc).__name__)
            raise HTTPException(status_code=503, detail="System diagnostics are unavailable") from None

        if not has_admin_permission(member.get("role"), "admin:system-health:read"):
            await audit_admin_denial(request, uid, reason="Missing required permission")
            raise HTTPException(status_code=403, detail="Not allowed")
        return member
    return check


async def player(member: dict = Depends(current_member)) -> dict:
    if not member.get("username"):
        raise HTTPException(status_code=428, detail="Choose a username first")
    return member


def require_role(*roles: str):
    async def check(request: Request, member: dict = Depends(current_member)) -> dict:
        changing_role = request.method == "PATCH" and request.url.path.endswith("/role")
        if not allow_admin_request(member["user_id"], "role-change" if changing_role else "role-read",
                                  limit=10 if changing_role else 120):
            raise HTTPException(status_code=429, detail="Too many administrative requests")
        if member["role"] not in roles:
            await audit_admin_denial(request, member["user_id"], reason="Insufficient role")
            raise HTTPException(status_code=403, detail="Not allowed")
        return member
    return check


def require_permission(*permissions: str):
    async def check(request: Request, member: dict = Depends(current_member)) -> dict:
        if not allow_admin_request(member["user_id"]):
            raise HTTPException(status_code=429, detail="Too many administrative requests")
        if not all(has_admin_permission(member.get("role"), permission) for permission in permissions):
            await audit_admin_denial(request, member["user_id"], reason="Missing required permission")
            raise HTTPException(status_code=403, detail="Not allowed")
        return member
    return check


def require_player_permission(permission: str):
    async def check(request: Request, member: dict = Depends(current_member)) -> dict:
        is_moderation = permission in {"player:moderate", "player:ban", "player:notes:write"}
        if not allow_admin_request(member["user_id"]):
            if is_moderation:
                await audit_admin_denial(
                    request, member["user_id"], target_type="player",
                    target_id=request.path_params.get("player_id"), reason="Player-management rate limit exceeded",
                    action="player_moderation_denied",
                )
            raise HTTPException(status_code=429, detail="Too many administrative requests")
        if not has_admin_permission(member.get("role"), permission):
            await audit_admin_denial(
                request, member["user_id"], target_type="player",
                target_id=request.path_params.get("player_id"), reason="Missing required player permission",
                action="player_moderation_denied" if is_moderation else "player_access_denied",
            )
            raise HTTPException(status_code=403, detail="Not allowed")
        return member
    return check


def public_user(u: dict) -> dict:
    return {"user_id": u["user_id"], "username": u.get("username"), "avatar_color": u.get("avatar_color"),
            "avatar_icon": u.get("avatar_icon"), "online": hub.online(u["user_id"]), "last_seen": u.get("last_seen"),
            "display_name": u.get("display_name") or u.get("username"), "bio": u.get("bio") or "",
            "progression": public_progression(u),
            "stats": {**EMPTY_STATS, **(u.get("stats") or {})}, "created_at": u.get("created_at"),
            # Lifetime medals: only ever changed by the server (medals.py), never by a client.
            "medals": int(u.get("medals") or 0),
            # Current league and level, derived on the server from the public medal total (leagues.py).
            "league": leagues.public_league(u.get("medals") or 0)}


async def users_by_ids(ids) -> dict:
    ids = [i for i in ids if i]
    docs = await db.users.find({"user_id": {"$in": ids}, **IN_ENV}, {"_id": 0}).to_list(len(ids) + 1)
    return {d["user_id"]: d for d in docs}


class ProfileIn(BaseModel):
    model_config = {"extra": "forbid"}

    username: Optional[str] = Field(None, min_length=3, max_length=20)
    display_name: Optional[str] = Field(None, max_length=40)
    bio: Optional[str] = Field(None, max_length=240)
    avatar_color: Optional[str] = None
    avatar_icon: Optional[str] = None


@api_router.get("/me")
async def me(member: dict = Depends(current_member)):
    g = games.active_game_for(member["user_id"])
    room = await db.rooms.find_one(scoped_query({"seats": member["user_id"], "status": "lobby"}, ENV),
                                   {"_id": 0, "code": 1})
    # Every signed-in player gets a numeric medal balance (0 if none yet), which keeps ranking exact.
    await medals.ensure(member["user_id"])
    return {**public_user(member), "email": member.get("email"), "role": member["role"],
            "active_game_id": g["id"] if g else None, "lobby_code": room["code"] if room else None,
            "coins": await wallet.ensure(member["user_id"]),
            # Your own full league progress (with the highest league ever reached).
            "league_progress": leagues.progress(member.get("medals") or 0, member.get("highest_league_rank")),
            "avatar_colors": AVATAR_COLORS, "avatar_icons": AVATAR_ICONS}


# ---------------- coins (see wallet.py) ----------------
def player_level(member) -> int:
    return public_progression(member)["level"]


@api_router.get("/wallet")
async def wallet_state(member: dict = Depends(player)):
    return await wallet.state(member["user_id"], level=player_level(member))


@api_router.get("/wallet/history")
async def wallet_history(member: dict = Depends(player)):
    return {"entries": await wallet.history(member["user_id"])}


@api_router.post("/wallet/daily")
async def wallet_daily(member: dict = Depends(player)):
    try:
        return await wallet.claim_daily(member["user_id"])
    except WalletError as error:
        raise HTTPException(409, str(error))


@api_router.post("/wallet/topup")
async def wallet_topup(member: dict = Depends(player)):
    try:
        return await wallet.claim_topup(member["user_id"])
    except WalletError as error:
        raise HTTPException(409, str(error))


# ---------------- leagues and progression (see leagues.py, medals.py) ----------------
@api_router.get("/leagues")
async def league_config(member: dict = Depends(player)):
    return leagues.config()


@api_router.get("/progression")
async def my_progression(member: dict = Depends(player)):
    """Your own league progress and recent promotions / demotions (private)."""
    uid = member["user_id"]
    return {"progress": await medals.progress(uid), "transitions": await medals.transitions(uid)}


@api_router.get("/progression/events")
async def pending_progression_events(member: dict = Depends(player)):
    """Your events not yet presented (oldest first), for showing after a refresh or reconnect."""
    return {"events": await medals.pending_events(member["user_id"])}


class EventAckIn(BaseModel):
    model_config = {"extra": "forbid"}
    ids: List[str] = Field(default_factory=list, max_length=50)


@api_router.post("/progression/events/ack")
async def acknowledge_progression_events(body: EventAckIn, member: dict = Depends(player)):
    return {"acknowledged": await medals.acknowledge(member["user_id"], body.ids)}


# ---------------- medals (see medals.py) ----------------
@api_router.get("/medals")
async def medal_state(member: dict = Depends(player)):
    uid = member["user_id"]
    return {"medals": await medals.total(uid), "per_trick": MEDALS_PER_TRICK, "per_ten": MEDALS_PER_TEN,
            "victory": VICTORY_MEDALS,
            "history": await medals.history(uid)}


async def _require_stake_seat(member, tier_id):
    """A player may sit at a stake table only at the tier's level and with the entry in their wallet."""
    tier = tier_view(tier_id)
    if not tier:
        raise HTTPException(400, "Unknown table")
    if player_level(member) < tier["min_level"]:
        raise HTTPException(403, f"The {tier['name']} unlocks at level {tier['min_level']}")
    if await wallet.ensure(member["user_id"]) < tier["entry"]:
        raise HTTPException(409, f"You need {tier['entry']} coins for the {tier['name']}")
    return tier


@api_router.patch("/me")
async def update_me(body: ProfileIn, member: dict = Depends(current_member)):
    now = time.monotonic()
    recent_updates = [hit for hit in _profile_update_hits[member["user_id"]] if now - hit < 60]
    if len(recent_updates) >= 10:
        raise HTTPException(429, "Profile updates are limited to 10 per minute")
    recent_updates.append(now)
    _profile_update_hits[member["user_id"]] = recent_updates

    upd = {}
    if body.username is not None:
        if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", body.username):
            raise HTTPException(400, "Username may use letters, numbers and underscore (3-20)")
        clash = await db.users.find_one({"username_lower": {"$eq": body.username.lower(), "$type": "string"},
                                         "user_id": {"$ne": member["user_id"]}, **IN_ENV})
        if clash:
            raise HTTPException(409, "That username is taken")
        upd.update(username=body.username, username_lower=body.username.lower())
    if body.display_name is not None:
        display_name = body.display_name.strip()
        if len(display_name) > 40:
            raise HTTPException(400, "Display name must be 40 characters or fewer")
        upd["display_name"] = display_name or None
    if body.bio is not None:
        bio = body.bio.strip()
        if len(bio) > 240:
            raise HTTPException(400, "Bio must be 240 characters or fewer")
        upd["bio"] = bio
    if body.avatar_color is not None:
        if body.avatar_color not in AVATAR_COLORS:
            raise HTTPException(400, "Invalid colour")
        upd["avatar_color"] = body.avatar_color
    if body.avatar_icon is not None:
        if body.avatar_icon not in AVATAR_ICONS:
            raise HTTPException(400, "Invalid avatar")
        upd["avatar_icon"] = body.avatar_icon
    if upd:
        await db.users.update_one({"user_id": member["user_id"], **IN_ENV}, {"$set": upd})
    return await me(await current_member_by_id(member["user_id"]))


async def current_member_by_id(uid):
    m = await db.users.find_one({"user_id": uid, **IN_ENV}, {"_id": 0})
    return {**m, "role": effective_role(m.get("role"))}


@api_router.get("/users/search")
async def search_users(q: str = Query(..., min_length=1, max_length=20), member: dict = Depends(player)):
    docs = await db.users.find({"username_lower": {"$regex": "^" + re.escape(q.lower()), "$type": "string"},
                                "user_id": {"$ne": member["user_id"]}, **IN_ENV},
                               {"_id": 0}).limit(10).to_list(10)
    return [public_user(d) for d in docs]


@api_router.get("/users/{username}")
async def profile(username: str, member: dict = Depends(player)):
    u = await db.users.find_one({"username_lower": {"$eq": username.lower(), "$type": "string"}, **IN_ENV}, {"_id": 0})
    if not u:
        raise HTTPException(404, "Player not found")
    uid = u["user_id"]
    u = await ensure_streak_history(db, uid, u, env=ENV)
    friend = await db.friends.find_one({"user_id": member["user_id"], "friend_id": uid, **IN_ENV})
    pending = await db.friend_requests.find_one({"status": "pending", **IN_ENV, "$or": [
        {"from_id": member["user_id"], "to_id": uid}, {"from_id": uid, "to_id": member["user_id"]}]}, {"_id": 0})
    recent = await db.matches.find({"player_ids": uid, **IN_ENV}, {"_id": 0}).sort("finished_at", -1).limit(5).to_list(5)
    recent = [hide_medal_balances(row, member["user_id"]) for row in recent]
    progression = u.get("progression") or {}
    duration_count = progression.get("match_duration_count") or 0
    profile_stats = {
        "total_team_tricks_won": progression.get("team_tricks_won"),
        "average_match_duration_seconds": (
            progression.get("match_duration_seconds_total", 0) / duration_count if duration_count else None
        ),
        "current_win_streak": progression.get("current_win_streak"),
        "best_win_streak": progression.get("best_win_streak"),
    }
    return {**public_user(u), "is_me": uid == member["user_id"], "is_friend": bool(friend),
            "pending_request": bool(pending), "profile_stats": profile_stats,
            "achievements": achievement_cards({**EMPTY_STATS, **(u.get("stats") or {})}, progression, u.get("achievement_unlocks")),
            "recent_matches": recent}


# ---------------- friends ----------------
class FriendRequestIn(BaseModel):
    username: str = Field(..., min_length=3, max_length=20)


@api_router.get("/friends")
async def list_friends(member: dict = Depends(player)):
    ids = [f["friend_id"] async for f in db.friends.find({"user_id": member["user_id"], **IN_ENV}, {"_id": 0})]
    users = await users_by_ids(ids)
    out = [public_user(u) for u in users.values()]
    return sorted(out, key=lambda u: (not u["online"], (u["username"] or "").lower()))


@api_router.get("/friends/requests")
async def friend_requests(member: dict = Depends(player)):
    uid = member["user_id"]
    incoming = await db.friend_requests.find({"to_id": uid, "status": "pending", **IN_ENV}, {"_id": 0}).to_list(100)
    outgoing = await db.friend_requests.find({"from_id": uid, "status": "pending", **IN_ENV}, {"_id": 0}).to_list(100)
    users = await users_by_ids([r["from_id"] for r in incoming] + [r["to_id"] for r in outgoing])
    return {"incoming": [{**r, "user": public_user(users[r["from_id"]])} for r in incoming if r["from_id"] in users],
            "outgoing": [{**r, "user": public_user(users[r["to_id"]])} for r in outgoing if r["to_id"] in users]}


@api_router.post("/friends/requests")
async def send_friend_request(body: FriendRequestIn, member: dict = Depends(player)):
    uid = member["user_id"]
    target = await db.users.find_one({"username_lower": {"$eq": body.username.lower(), "$type": "string"}, **IN_ENV}, {"_id": 0})
    if not target or target["user_id"] == uid:
        raise HTTPException(404, "Player not found")
    tid = target["user_id"]
    if await db.friends.find_one({"user_id": uid, "friend_id": tid, **IN_ENV}):
        raise HTTPException(409, "Already friends")
    reverse = await db.friend_requests.find_one({"from_id": tid, "to_id": uid, "status": "pending", **IN_ENV}, {"_id": 0})
    if reverse:
        return await respond_request(reverse["id"], "accept", member)
    if await db.friend_requests.find_one({"from_id": uid, "to_id": tid, "status": "pending", **IN_ENV}):
        raise HTTPException(409, "Request already sent")
    req = {"id": str(uuid.uuid4()), "env": ENV, "from_id": uid, "to_id": tid, "status": "pending", "created_at": now_iso()}
    await db.friend_requests.insert_one(dict(req))
    await hub.send(tid, {"type": "friend_request", "from": member["username"]})
    return {"ok": True, "status": "sent"}


@api_router.post("/friends/requests/{req_id}/{action}")
async def respond_request(req_id: str, action: str, member: dict = Depends(player)):
    if action not in ("accept", "decline"):
        raise HTTPException(400, "Invalid action")
    req = await db.friend_requests.find_one({"id": req_id, "to_id": member["user_id"], "status": "pending", **IN_ENV}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    await db.friend_requests.update_one({"id": req_id, "to_id": member["user_id"], "status": "pending", **IN_ENV},
                                        {"$set": {"status": "accepted" if action == "accept" else "declined"}})
    if action == "accept":
        for a, b in ((req["from_id"], req["to_id"]), (req["to_id"], req["from_id"])):
            await db.friends.update_one({"user_id": a, "friend_id": b, **IN_ENV},
                                        {"$setOnInsert": {"env": ENV, "user_id": a, "friend_id": b, "since": now_iso()}}, upsert=True)
        await hub.send(req["from_id"], {"type": "friend_accepted", "by": member["username"]})
    return {"ok": True, "status": "accepted" if action == "accept" else "declined"}


@api_router.delete("/friends/{friend_id}")
async def remove_friend(friend_id: str, member: dict = Depends(player)):
    await db.friends.delete_many({"env": ENV, "$or": [{"user_id": member["user_id"], "friend_id": friend_id},
                                                        {"user_id": friend_id, "friend_id": member["user_id"]}]})
    return {"ok": True}


# ---------------- rooms ----------------
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class RoomCreateIn(BaseModel):
    target: int = Field(7, ge=1, le=99)
    turn_duration: TurnDuration = DEFAULT_TURN_DURATION


StakeTierIn = Literal["free", "chai", "city", "royal", "maharaja"]


class RoomSettingsIn(BaseModel):
    target: Optional[int] = Field(None, ge=1, le=99)
    dealer_seat: Optional[int] = Field(None, ge=0, le=3)
    turn_duration: Optional[TurnDuration] = None
    spectators_enabled: Optional[bool] = None
    # "free" removes the stake; any other value makes the private room a stake table.
    stake_tier: Optional[StakeTierIn] = None


class MatchmakingJoinIn(BaseModel):
    tier: Optional[StakeTierIn] = None


class SeatsIn(BaseModel):
    seats: List[Optional[str]] = Field(..., min_length=4, max_length=4)


class ReadyIn(BaseModel):
    ready: bool


class InviteIn(BaseModel):
    user_id: str


class SpectatorAccessIn(BaseModel):
    enabled: bool


class SpectatorStateIn(BaseModel):
    invite: Optional[str] = Field(None, max_length=160)


async def new_code():
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if not await db.rooms.find_one(scoped_query({"code": code}, ENV)):
            return code


def bot_user(bid, b):
    return {"user_id": bid, "username": b["username"], "avatar_color": b["avatar_color"], "avatar_icon": b["avatar_icon"],
            "online": True, "is_bot": True, "last_seen": None, "stats": dict(EMPTY_STATS), "created_at": None}


async def room_view(room):
    users = await users_by_ids(room["seats"])
    bots = room.get("bots") or {}
    return {"code": room["code"], "host_id": room.get("host_id"), "is_public": room.get("is_public", False),
            "status": room["status"], "target": room["target"], "dealer_seat": room["dealer_seat"],
            "spectators_enabled": bool(room.get("is_public") or room.get("spectators_enabled")),
            "turn_duration": room.get("turn_duration", PUBLIC_TURN_DURATION if room.get("is_public") else DEFAULT_TURN_DURATION),
            "game_id": room.get("game_id"), "ready": {**room.get("ready", {}), **{b: True for b in bots}},
            "stake": tier_view(room.get("stake_tier")) if room.get("stake_tier") else None,
            "seats": [bot_user(u, bots[u]) if u in bots else public_user(users[u]) if u in users else None for u in room["seats"]]}


async def broadcast_room(room):
    view = await room_view(room)
    await hub.send_many(room["seats"], {"type": "room_update", "room": view})
    return view


async def get_member_room(code, uid):
    room = await db.rooms.find_one(scoped_query({"code": code.upper()}, ENV), {"_id": 0})
    if not room or uid not in room["seats"]:
        raise HTTPException(404, "Room not found")
    return room


async def ensure_free(uid):
    if games.active_game_for(uid):
        raise HTTPException(409, "You are already in an active game")
    _remove_from_queues(uid)


@api_router.post("/rooms")
async def create_room(body: RoomCreateIn, member: dict = Depends(player)):
    uid = member["user_id"]
    await ensure_free(uid)
    await leave_all_lobbies(uid)
    room = {"env": ENV, "code": await new_code(), "host_id": uid, "is_public": False, "status": "lobby", "target": body.target,
            "turn_duration": body.turn_duration,
            "dealer_seat": 0, "seats": [uid, None, None, None], "ready": {}, "created_at": now_iso()}
    await db.rooms.insert_one(dict(room))
    return await room_view(room)


@api_router.get("/rooms/{code}")
async def get_room(code: str, member: dict = Depends(player)):
    return await room_view(await get_member_room(code, member["user_id"]))


@api_router.post("/rooms/{code}/join")
async def join_room(code: str, member: dict = Depends(player)):
    uid = member["user_id"]
    room = await db.rooms.find_one(scoped_query({"code": code.upper()}, ENV), {"_id": 0})
    if not room or room.get("is_public"):
        raise HTTPException(404, "No room with that invite code")
    if uid in room["seats"]:
        return await room_view(room)
    if room["status"] != "lobby":
        raise HTTPException(409, "That game has already started")
    await ensure_free(uid)
    await leave_all_lobbies(uid)
    room = await db.rooms.find_one_and_update(
        scoped_query({"code": room["code"], "status": "lobby", "seats": None}, ENV),
        {"$set": {"seats.$": uid}}, projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if not room:
        raise HTTPException(409, "Room is full")
    await db.invitations.update_many({"to_id": uid, "room_code": room["code"], **IN_ENV}, {"$set": {"status": "accepted"}})
    return await broadcast_room(room)


async def leave_all_lobbies(uid):
    async for room in db.rooms.find(scoped_query({"seats": uid, "status": "lobby"}, ENV), {"_id": 0}):
        await _leave(room, uid)


async def _dissolve_public(room, removed):
    """A public lobby never runs short-handed: remaining players go back to the front of the queue."""
    res = await db.rooms.delete_one(scoped_query({"code": room["code"], "status": "lobby"}, ENV))
    if res.deleted_count == 0:
        return
    await voice_service.close_room(room["code"], "The room was closed")
    keep = [s for s in room["seats"] if s and s not in removed and hub.online(s)]
    tier = room.get("stake_tier") or "free"
    queue = _queue_for(tier)
    for u in reversed(keep):
        if _queued_tier(u) is None:
            queue.insert(0, u)
    await hub.send_many(keep, {"type": "requeued", "code": room["code"]})
    await hub.send_many(list(removed), {"type": "room_left", "code": room["code"]})
    await _try_match(tier=tier)


async def _leave(room, uid):
    """Remove uid from a lobby. Returns False when the room left the lobby (a start won the race)."""
    if room.get("is_public"):
        return await _dissolve_public(room, {uid})
    if uid not in room["seats"]:
        return False
    index = room["seats"].index(uid)
    seats = [None if s == uid else s for s in room["seats"]]
    ready = {k: v for k, v in room.get("ready", {}).items() if k != uid}
    humans = [s for s in seats if s and s not in (room.get("bots") or {})]
    if not humans:
        res = await db.rooms.delete_one(scoped_query({"code": room["code"], "status": "lobby"}, ENV))
        if res.deleted_count == 0:
            return False
        await db.chat_messages.delete_many({"room_code": room["code"], "channel": "private_lobby", **IN_ENV})
        await voice_service.close_room(room["code"], "The room was closed")
        await hub.send(uid, {"type": "room_left", "code": room["code"]})
        return True
    host = room.get("host_id")
    if host == uid and not room.get("is_public"):
        host = humans[0]
    # Clear only this player's seat, and only while the room is still a lobby, so a concurrent join
    # is not overwritten and a game that has already claimed the room keeps its seating.
    res = await db.rooms.update_one(
        scoped_query({"code": room["code"], "status": "lobby", f"seats.{index}": uid}, ENV),
        {"$set": {f"seats.{index}": None, "host_id": host}, "$unset": {f"ready.{uid}": ""}})
    if res.matched_count == 0:
        return False
    fresh = await db.rooms.find_one(scoped_query({"code": room["code"]}, ENV), {"_id": 0})
    if fresh:
        room.clear()
        room.update(fresh)
    else:
        room.update(seats=seats, ready=ready, host_id=host)
    await voice_service.leave_room_user(room["code"], uid)
    await broadcast_room(room)
    await hub.send(uid, {"type": "room_left", "code": room["code"]})
    return True


@api_router.post("/rooms/{code}/leave")
async def leave_room(code: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room["status"] != "lobby":
        raise HTTPException(409, "The game has started")
    if await _leave(room, member["user_id"]) is False:
        raise HTTPException(409, "The game has started")
    return {"ok": True}


def _host_only(room, uid):
    if room.get("is_public") or room.get("host_id") != uid:
        raise HTTPException(403, "Only the host can do that")
    if room["status"] != "lobby":
        raise HTTPException(409, "The game has started")


@api_router.patch("/rooms/{code}/settings")
async def room_settings(code: str, body: RoomSettingsIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    _host_only(room, member["user_id"])
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    unset = {"spectator_invite_hash": ""} if upd.get("spectators_enabled") is False else {}
    stake_tier = upd.pop("stake_tier", None)
    if stake_tier == "free":
        unset["stake_tier"] = ""
        upd["ready"] = {}
    elif stake_tier:
        if room.get("bots"):
            raise HTTPException(409, "Remove the bots first: stake tables are for four players")
        await _require_stake_seat(member, stake_tier)
        # A new stake clears every Ready, so each player confirms the stake by readying again.
        upd.update(stake_tier=stake_tier, ready={})
    if any(key in upd for key in ("target", "dealer_seat", "turn_duration")):
        upd["ready"] = {}
    update = {"$set": upd} if upd else {}
    if unset:
        update["$unset"] = unset
    if not update:
        return await broadcast_room(room)
    result = await db.rooms.update_one(scoped_query({"code": room["code"], "status": "lobby"}, ENV), update)
    if result.matched_count == 0:
        raise HTTPException(409, "The game is starting or has already started")
    room.update(upd)
    for key in unset:
        room.pop(key, None)
    return await broadcast_room(room)


@api_router.patch("/rooms/{code}/spectator-access")
async def set_spectator_access(code: str, body: SpectatorAccessIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room.get("is_public") or room.get("host_id") != member["user_id"]:
        raise HTTPException(403, "Only a private-room host can change spectator access")
    if room.get("status") not in ("lobby", "playing"):
        raise HTTPException(409, "Spectator access is unavailable for this room")
    update = {"$set": {"spectators_enabled": body.enabled}}
    if not body.enabled:
        update["$unset"] = {"spectator_invite_hash": ""}
    result = await db.rooms.update_one(
        scoped_query({"code": room["code"], "host_id": member["user_id"], "status": room["status"]}, ENV), update,
    )
    if result.matched_count == 0:
        raise HTTPException(409, "Room state changed; refresh and try again")
    room["spectators_enabled"] = body.enabled
    if not body.enabled:
        room.pop("spectator_invite_hash", None)
    game_id = room.get("game_id")
    if not body.enabled and game_id:
        await games.revoke_spectators(game_id)
        await voice_service.revoke_game_spectators(game_id)
    game = games.games.get(game_id) if game_id else None
    if game:
        game["spectators_enabled"] = body.enabled
        await db.games.update_one(scoped_query({"id": game_id, "status": "active"}, ENV),
                                  {"$set": {"spectators_enabled": body.enabled}})
    return {"enabled": body.enabled}


@api_router.post("/rooms/{code}/spectator-invite")
async def create_spectator_invite(code: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room.get("is_public") or room.get("host_id") != member["user_id"]:
        raise HTTPException(403, "Only the private-room host can create a spectator invitation")
    if room.get("status") != "playing" or not room.get("spectators_enabled"):
        raise HTTPException(409, "Enable spectator access before creating an invitation")
    game = await games.get(room.get("game_id")) if room.get("game_id") else None
    if not game or game.get("status") != "active":
        raise HTTPException(409, "Only ongoing matches can be watched")
    invite = secrets.token_urlsafe(32)
    invite_hash = spectator_invite_hash(invite)
    result = await db.rooms.update_one(
        scoped_query({"code": room["code"], "host_id": member["user_id"], "status": "playing", "spectators_enabled": True}, ENV),
        {"$set": {"spectator_invite_hash": invite_hash}},
    )
    if result.matched_count == 0:
        raise HTTPException(409, "Spectator access changed; refresh and try again")
    # Invite rotation invalidates existing bearer grants as well as reconnects.
    await games.revoke_invited_spectators(game["id"])
    await voice_service.revoke_invited_spectators(game["id"])
    return {"game_id": game["id"], "invite": invite}


@api_router.post("/rooms/{code}/seats")
async def arrange_seats(code: str, body: SeatsIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    _host_only(room, member["user_id"])
    if sorted(filter(None, body.seats)) != sorted(filter(None, room["seats"])):
        raise HTTPException(400, "Seats must contain exactly the players in the room")
    await db.rooms.update_one(scoped_query({"code": room["code"]}, ENV), {"$set": {"seats": body.seats, "ready": {}}})
    room.update(seats=body.seats, ready={})
    return await broadcast_room(room)


@api_router.post("/rooms/{code}/ready")
async def set_ready(code: str, body: ReadyIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room["status"] != "lobby":
        raise HTTPException(409, "The game has started")
    if body.ready and room.get("stake_tier"):
        await _require_stake_seat(member, room["stake_tier"])
    room = await db.rooms.find_one_and_update(scoped_query({"code": room["code"]}, ENV), {"$set": {f"ready.{member['user_id']}": body.ready}},
                                              projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if room.get("is_public") and _all_ready(room):
        return await _start(room)
    return await broadcast_room(room)


def _all_ready(room):
    bots = room.get("bots") or {}
    return all(room["seats"]) and all(u in bots or room.get("ready", {}).get(u) for u in room["seats"])


async def _release_start_claim(code):
    await db.rooms.update_one(scoped_query({"code": code, "status": "starting"}, ENV), {"$set": {"status": "lobby"}})


async def _start(room):
    claimed = await db.rooms.find_one_and_update(
        scoped_query({"code": room["code"], "status": "lobby"}, ENV), {"$set": {"status": "starting"}},
        projection={"_id": 0}, return_document=ReturnDocument.BEFORE,
    )
    if not claimed:
        raise HTTPException(409, "Game already starting")
    room = claimed
    # The readiness check before the claim can be stale: a player may have left or a bot may have been
    # removed in between. Re-validate the claimed snapshot, which no lobby edit can change any more.
    if not _all_ready(room):
        await _release_start_claim(room["code"])
        raise HTTPException(409, "All four seats must be filled and every player ready")
    stake = await _collect_stakes(room) if room.get("stake_tier") else None
    try:
        game = await games.create(room, stake=stake)
    except Exception:
        if stake:
            await wallet.refund(room["seats"], stake["tier"], stake["ref"])
        await _release_start_claim(room["code"])
        raise
    room_update = {"$set": {"status": "playing", "game_id": game["id"]}}
    if stake:
        room_update["$unset"] = {"stake_hold": ""}
    await db.rooms.update_one(scoped_query({"code": room["code"]}, ENV), room_update)
    room.update(status="playing", game_id=game["id"])
    view = await broadcast_room(room)
    await hub.send_many(room["seats"], {"type": "game_started", "game_id": game["id"], "room_code": room["code"]})
    await games.broadcast(game)
    games.kick_bots(game["id"])
    return view


async def _collect_stakes(room):
    """Take every player's entry, all or nothing, for a claimed (``starting``) stake room.

    The hold is written on the room first, so if the process stops part-way the startup recovery refunds
    exactly the entries that were taken. A player who can no longer pay blocks the start: a private room
    stays a lobby (409 naming the player); a public room is dissolved without them and the others requeue.
    """
    tier = tier_view(room["stake_tier"])
    if not tier or room.get("bots"):
        await _release_start_claim(room["code"])
        raise HTTPException(409, "Stake tables are for four players and no bots")
    ref = f"{room['code']}-{secrets.token_hex(6)}"
    await db.rooms.update_one(scoped_query({"code": room["code"], "status": "starting"}, ENV),
                              {"$set": {"stake_hold": {"tier": tier["id"], "ref": ref}}})
    try:
        await wallet.collect_entries(room["seats"], tier["id"], ref)
    except InsufficientCoins as short:
        await db.rooms.update_one(scoped_query({"code": room["code"]}, ENV), {"$unset": {"stake_hold": ""}})
        await _release_start_claim(room["code"])
        name = ((await users_by_ids([short.user_id])).get(short.user_id) or {}).get("username") or "A player"
        if room.get("is_public"):
            fresh = await db.rooms.find_one(scoped_query({"code": room["code"], "status": "lobby"}, ENV), {"_id": 0})
            if fresh:
                await _dissolve_public(fresh, {short.user_id})
        raise HTTPException(409, f"{name} doesn't have the {tier['entry']} coins for the {tier['name']}")
    return {"tier": tier["id"], "name": tier["name"], "entry": tier["entry"], "payout": tier["payout"], "ref": ref}


async def recover_stake_holds():
    """Startup: refund entries taken for stake rooms that never became a game (the process stopped)."""
    async for room in db.rooms.find(scoped_query({"status": "starting", "stake_hold": {"$exists": True}}, ENV), {"_id": 0}):
        hold = room["stake_hold"]
        if not await db.games.find_one(scoped_query({"stake.ref": hold["ref"]}, ENV), {"_id": 1}):
            await wallet.refund_if_charged(room["seats"], hold["tier"], hold["ref"])
        await db.rooms.update_one(scoped_query({"code": room["code"]}, ENV), {"$unset": {"stake_hold": ""}})


@api_router.post("/rooms/{code}/start")
async def start_game(code: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    _host_only(room, member["user_id"])
    if not _all_ready(room):
        raise HTTPException(400, "All four seats must be filled and every player ready")
    return await _start(room)


@api_router.post("/rooms/{code}/bots")
async def add_bot(code: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    _host_only(room, member["user_id"])
    if room.get("stake_tier"):
        raise HTTPException(409, "Bots can't join stake tables")
    if None not in room["seats"]:
        raise HTTPException(409, "Room is full")
    bots = room.get("bots") or {}
    taken = {b["username"] for b in bots.values()}
    name = next(f"Bot {n}" for n in BOT_NAMES if f"Bot {n}" not in taken)
    bid = f"bot_{uuid.uuid4().hex[:12]}"
    bot = {"username": name, "avatar_color": random.choice(AVATAR_COLORS), "avatar_icon": "bot"}
    room = await db.rooms.find_one_and_update(
        scoped_query({"code": room["code"], "status": "lobby", "seats": None}, ENV),
        {"$set": {"seats.$": bid, f"bots.{bid}": bot}}, projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if not room:
        raise HTTPException(409, "Room is full")
    return await broadcast_room(room)


@api_router.delete("/rooms/{code}/bots/{bot_id}")
async def remove_bot(code: str, bot_id: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    _host_only(room, member["user_id"])
    bots = room.get("bots") or {}
    if bot_id not in bots:
        raise HTTPException(404, "Bot not found")
    room = await db.rooms.find_one_and_update(
        scoped_query({"code": room["code"], "status": "lobby", "seats": bot_id}, ENV),
        {"$set": {"seats.$": None}, "$unset": {f"bots.{bot_id}": ""}}, projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if not room:
        raise HTTPException(409, "The game has started")
    return await broadcast_room(room)


@api_router.post("/rooms/{code}/invite")
async def invite(code: str, body: InviteIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room.get("is_public") or room["status"] != "lobby":
        raise HTTPException(409, "Invitations are only for private lobbies")
    if not await db.friends.find_one({"user_id": member["user_id"], "friend_id": body.user_id, **IN_ENV}):
        raise HTTPException(403, "You can only invite friends")
    if await db.invitations.find_one({"from_id": member["user_id"], "to_id": body.user_id, "room_code": room["code"], "status": "pending", **IN_ENV}):
        raise HTTPException(409, "Already invited")
    inv = {"id": str(uuid.uuid4()), "env": ENV, "from_id": member["user_id"], "from_username": member["username"],
           "to_id": body.user_id, "room_code": room["code"], "status": "pending", "created_at": now_iso()}
    await db.invitations.insert_one(dict(inv))
    await hub.send(body.user_id, {"type": "invitation", "invitation": {k: v for k, v in inv.items() if k != "_id"}})
    return {"ok": True}


@api_router.get("/invitations")
async def list_invitations(member: dict = Depends(player)):
    invs = await db.invitations.find({"to_id": member["user_id"], "status": "pending", **IN_ENV}, {"_id": 0}).sort("created_at", -1).to_list(20)
    out = []
    for inv in invs:
        room = await db.rooms.find_one(scoped_query({"code": inv["room_code"], "status": "lobby"}, ENV),
                                       {"_id": 0, "seats": 1})
        if room:
            out.append({**inv, "open_seats": room["seats"].count(None)})
    return out


@api_router.post("/invitations/{inv_id}/decline")
async def decline_invitation(inv_id: str, member: dict = Depends(player)):
    await db.invitations.update_one({"id": inv_id, "to_id": member["user_id"], **IN_ENV}, {"$set": {"status": "declined"}})
    return {"ok": True}


@api_router.get("/rooms/{code}/chat")
async def room_chat(code: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    msgs = await db.chat_messages.find(
        existing_room_chat_filter(room["code"], ENV), {"_id": 0}
    ).sort("ts", -1).limit(60).to_list(60)
    return list(reversed(msgs))


@api_router.get("/rooms/{code}/lobby-chat")
async def private_lobby_chat(code: str, member: dict = Depends(player)):
    try:
        return await load_private_lobby_history(db, code, member["user_id"], ENV)
    except LobbyChatAccessError:
        raise HTTPException(404, "Private lobby not found")


# ---------------- matchmaking ----------------
# Free tables use mm_queue; each stake table has its own queue. A player is in at most one queue.
mm_queue: list[str] = []
mm_stake_queues: dict[str, list[str]] = {tier: [] for tier in STAKE_TIERS}
mm_lock = asyncio.Lock()


def _queue_for(tier):
    return mm_stake_queues[tier] if tier in mm_stake_queues else mm_queue


def _queued_tier(uid):
    if uid in mm_queue:
        return "free"
    return next((tier for tier, queue in mm_stake_queues.items() if uid in queue), None)


def _remove_from_queues(uid):
    for queue in (mm_queue, *mm_stake_queues.values()):
        if uid in queue:
            queue.remove(uid)


def _queue_status(uid):
    tier = _queued_tier(uid)
    queue = _queue_for(tier)
    return {"queued": True, "position": queue.index(uid) + 1, "waiting": len(queue), "tier": tier,
            "stake": tier_view(tier) if tier != "free" else None}


@api_router.post("/matchmaking/join")
async def mm_join(body: Optional[MatchmakingJoinIn] = None, member: dict = Depends(player)):
    uid = member["user_id"]
    tier = (body.tier if body else None) or "free"
    if games.active_game_for(uid):
        raise HTTPException(409, "You are already in an active game")
    if tier != "free":
        await _require_stake_seat(member, tier)
    await leave_all_lobbies(uid)
    async with mm_lock:
        if _queued_tier(uid) != tier:
            _remove_from_queues(uid)
            _queue_for(tier).append(uid)
    code = await _try_match(uid, tier)
    if code:
        return {"queued": False, "room_code": code}
    if _queued_tier(uid) is None:
        return await mm_status(member)
    return _queue_status(uid)


READY_TIMEOUT = 60


async def _try_match(uid=None, tier="free"):
    queue = _queue_for(tier)
    async with mm_lock:
        if len(queue) < 4:
            return None
        group = [queue.pop(0) for _ in range(4)]
    random.SystemRandom().shuffle(group)
    room = {"env": ENV, "code": await new_code(), "host_id": None, "is_public": True, "status": "lobby", "target": 7,
            "turn_duration": PUBLIC_TURN_DURATION,
            "dealer_seat": secrets.randbelow(4), "seats": group, "ready": {}, "created_at": now_iso()}
    if tier in mm_stake_queues:
        room["stake_tier"] = tier
    await db.rooms.insert_one(dict(room))
    await hub.send_many(group, {"type": "match_found", "code": room["code"], "ready_timeout": READY_TIMEOUT})
    asyncio.create_task(_ready_deadline(room["code"]))
    return room["code"] if uid in group else None


async def _ready_deadline(code):
    await asyncio.sleep(READY_TIMEOUT)
    room = await db.rooms.find_one(scoped_query({"code": code, "status": "lobby"}, ENV), {"_id": 0})
    if room:
        idle = {u for u in room["seats"] if u and not room.get("ready", {}).get(u)}
        await _dissolve_public(room, idle)


@api_router.get("/matchmaking/status")
async def mm_status(member: dict = Depends(player)):
    uid = member["user_id"]
    if _queued_tier(uid):
        return _queue_status(uid)
    room = await db.rooms.find_one(scoped_query({"seats": uid, "status": "lobby", "is_public": True}, ENV),
                                   {"_id": 0, "code": 1})
    return {"queued": False, "room_code": room["code"] if room else None, "waiting": len(mm_queue)}


@api_router.post("/matchmaking/leave")
async def mm_leave(member: dict = Depends(player)):
    async with mm_lock:
        _remove_from_queues(member["user_id"])
    return {"ok": True}


# ---------------- games, history, leaderboard ----------------
@api_router.get("/spectator/games")
async def spectator_games(member: dict = Depends(player)):
    projection = {
        "_id": 0, "id": 1, "is_public": 1, "status": 1, "created_at": 1,
        "players.user_id": 1, "players.seat": 1, "players.username": 1, "players.display_name": 1,
        "players.avatar_color": 1, "players.avatar_icon": 1, "players.is_bot": 1,
        "state.phase": 1, "state.round_no": 1, "state.turn": 1, "state.scores": 1,
        "state.target": 1, "state.tricks_won": 1,
    }
    cursor = db.games.find(scoped_query({"is_public": True, "status": "active"}, ENV), projection).sort("updated_at", -1).limit(50)
    documents = await cursor.to_list(50)
    cards = []
    for game in documents:
        if games.seat_of(game, member["user_id"]) is not None:
            continue
        game["players"] = [{**p, "online": p.get("is_bot") or hub.online(p.get("user_id"))}
                            for p in game.get("players", ())]
        cards.append(public_game_card(game, games.spectators.count(game["id"])))
    return cards


@api_router.post("/spectator/games/{game_id}/state")
async def spectator_game_state(game_id: str, body: SpectatorStateIn, member: dict = Depends(player)):
    try:
        return await games.spectator_snapshot(member["user_id"], game_id, body.invite)
    except SpectatorAccessError:
        raise HTTPException(404, "Match unavailable or spectator access denied") from None


@api_router.get("/games/{game_id}")
async def get_game(game_id: str, member: dict = Depends(player)):
    game = await games.get(game_id)
    if not game or games.seat_of(game, member["user_id"]) is None:
        raise HTTPException(404, "Game not found")
    return games.view_for(game, member["user_id"])


@api_router.post("/games/{game_id}/exit")
async def exit_game(game_id: str, member: dict = Depends(player)):
    game = await games.get(game_id)
    if not game or games.seat_of(game, member["user_id"]) is None:
        raise HTTPException(404, "Game not found")
    await games.cancel(game_id, member["user_id"])
    return {"ok": True, "status": "cancelled"}


@api_router.get("/matches")
async def match_history(username: Optional[str] = None, member: dict = Depends(player)):
    uid = member["user_id"]
    if username:
        u = await db.users.find_one({"username_lower": {"$eq": username.lower(), "$type": "string"}, **IN_ENV},
                                    {"_id": 0, "user_id": 1})
        if not u:
            raise HTTPException(404, "Player not found")
        uid = u["user_id"]
    rows = await db.matches.find({"player_ids": uid, **IN_ENV}, {"_id": 0}).sort("finished_at", -1).limit(50).to_list(50)
    return [hide_medal_balances(row, member["user_id"]) for row in rows]


def hide_medal_balances(row, viewer_id):
    """Match rows show every player's medal changes but only the viewer's own lifetime balance."""
    if isinstance(row.get("medals"), dict):
        row = {**row, "medals": private_view(row["medals"], viewer_id)}
    return row


@api_router.get("/leaderboard")
async def leaderboard(by: Literal["wins", "medals"] = "wins", page: int = 1, page_size: int = 20,
                      league: Optional[str] = None, member: dict = Depends(player)):
    if by == "medals":
        return await medal_leaderboard(member, page, page_size, league)
    return await wins_leaderboard(member)


# Human accounts that may be ranked: bots never have accounts; restricted accounts are left out.
def _ranked_players():
    return {"username": {"$ne": None}, "account_status": {"$nin": ["banned", "suspended"]}, **IN_ENV}


async def medal_leaderboard(member, page=1, page_size=20, league=None):
    """Lifetime-medal ranking with server-side pagination and an optional league filter. Ranks are
    global (a league filter shows that league's slice of the global order)."""
    page = max(1, min(int(page or 1), 1000))
    page_size = max(5, min(int(page_size or 20), 50))
    query = _ranked_players()
    offset = 0
    if league:
        if league not in leagues.LEAGUE_RANK:
            raise HTTPException(400, "Unknown league")
        low, high = leagues.league_range(league)
        bounds = {"$gte": low, **({"$lte": high} if high is not None else {})}
        if low == 0:  # Bronze also holds players with no medals field yet
            query["$or"] = [{"medals": bounds}, {"medals": None}]
        else:
            query["medals"] = bounds
        if high is not None:  # everyone above this league ranks ahead of it
            offset = await db.users.count_documents({**_ranked_players(), "medals": {"$gt": high}})
    total = await db.users.count_documents(query)
    docs = await (db.users.find(query, {"_id": 0}).sort([("medals", -1), ("stats.wins", -1), ("user_id", 1)])
                  .skip((page - 1) * page_size).limit(page_size).to_list(page_size))
    rows = []
    for i, d in enumerate(docs):
        p = public_user(d)
        st = p["stats"]
        rows.append({**p, "rank": offset + (page - 1) * page_size + i + 1,
                     "win_rate": round(100 * st["wins"] / st["games_played"]) if st["games_played"] else 0})
    # Your own global rank: everyone ahead of you in exactly the order above (medals, then wins, then
    # user id; like MongoDB, a missing value sorts below every number), counted on the server.
    await medals.ensure(member["user_id"])
    me = await db.users.find_one({"user_id": member["user_id"], **IN_ENV}, {"_id": 0}) or {}
    mine = int(me.get("medals") or 0)
    raw_wins = (me.get("stats") or {}).get("wins")
    same = {**_ranked_players(), "medals": mine}
    ahead = await db.users.count_documents({**_ranked_players(), "medals": {"$gt": mine}})
    if raw_wins is None:
        ahead += await db.users.count_documents({**same, "stats.wins": {"$ne": None}})
        ahead += await db.users.count_documents({**same, "stats.wins": None, "user_id": {"$lt": member["user_id"]}})
    else:
        ahead += await db.users.count_documents({**same, "stats.wins": {"$gt": int(raw_wins)}})
        ahead += await db.users.count_documents({**same, "stats.wins": int(raw_wins), "user_id": {"$lt": member["user_id"]}})
    my_rank = ahead + 1
    my_league = leagues.public_league(mine)
    in_view = not league or league == my_league["id"]
    return {"by": "medals", "league": league, "page": page, "page_size": page_size, "total": total,
            "pages": max(1, -(-total // page_size)), "rows": rows,
            "me": {"rank": my_rank, "medals": mine, "league": my_league,
                   "page": ((my_rank - offset - 1) // page_size + 1) if in_view else None}}


async def wins_leaderboard(member: dict):
    """Top 50 by match wins. Every row also carries lifetime medals and the league."""
    query = {"username": {"$ne": None}, **IN_ENV}
    order = [("stats.wins", -1), ("stats.games_played", 1)]
    docs = await db.users.find(query, {"_id": 0}).sort(order).limit(50).to_list(50)
    out = []
    for i, d in enumerate(docs):
        p = public_user(d)
        st = p["stats"]
        out.append({**p, "rank": i + 1, "win_rate": round(100 * st["wins"] / st["games_played"]) if st["games_played"] else 0})
    return out


# ---------------- admin ----------------
class RoleIn(BaseModel):
    model_config = {"extra": "forbid"}
    role: str = Field(min_length=1, max_length=20)


@api_router.get("/users")
async def list_users(admin: dict = Depends(require_role("admin"))):
    people = await db.users.find(IN_ENV, {"_id": 0}).to_list(1000)
    return {"roles": [r for r in ROLES if RANK[r] <= RANK[admin["role"]]],
            "users": [{**public_user(p), "role": effective_role(p.get("role"))} for p in people]}


@api_router.patch("/users/{user_id}/role")
async def set_role(user_id: str, body: RoleIn, request: Request, admin: dict = Depends(require_role("admin"))):
    async with admin_role_update_lock():
        return await _set_role_locked(user_id, body, request, admin)


async def _set_role_locked(user_id: str, body: RoleIn, request: Request, admin: dict):
    target = await db.users.find_one({"user_id": user_id, **IN_ENV}, {"_id": 0})
    if target is None:
        await audit_admin_denial(request, admin["user_id"], target_type="player", target_id=user_id,
                                 reason="Role target not found", action="role_change_denied")
        raise HTTPException(status_code=404, detail="Not found")
    current_role = effective_role(target.get("role"))
    admin_count = (await db.users.count_documents({"role": "admin", **IN_ENV})
                   if current_role == "admin" and body.role != "admin" else 0)
    denial = role_change_denial(admin["user_id"], user_id, admin["role"], current_role, body.role, admin_count)
    if denial:
        await audit_admin_denial(request, admin["user_id"], target_type="player", target_id=user_id,
                                 reason=denial, action="role_change_denied")
        raise HTTPException(status_code=409 if denial == "Keep at least one admin" else 403, detail=denial)
    result = await db.users.update_one({"user_id": user_id, **IN_ENV}, {"$set": {"role": body.role}})
    if result.matched_count == 0:
        await audit_admin_denial(request, admin["user_id"], target_type="player", target_id=user_id,
                                 reason="Role target not found", action="role_change_denied")
        raise HTTPException(status_code=404, detail="Not found")
    _health_admin_role_cache.pop(user_id, None)
    if (has_admin_permission(current_role, "admin:spectate")
            and not has_admin_permission(body.role, "admin:spectate")):
        await games.revoke_admin_spectators(user_id)
        await voice_service.revoke_admin_user(user_id)
    await games.audit_admin(admin["user_id"], "role_changed", target_type="player", target_id=user_id,
                            reason="Administrative role update", previous_value=current_role,
                            new_value=body.role)
    return {"user_id": user_id, "role": body.role}


class SuspendPlayerIn(BaseModel):
    model_config = {"extra": "forbid"}
    duration_hours: Literal[1, 6, 24, 72, 168, 720]
    reason: str = Field(min_length=1, max_length=500)


class PlayerReasonIn(BaseModel):
    model_config = {"extra": "forbid"}
    reason: str = Field(min_length=1, max_length=500)


class PlayerNoteIn(BaseModel):
    model_config = {"extra": "forbid"}
    content: str = Field(min_length=1, max_length=2000)


PLAYER_SORTS = {
    "registered_desc": [("created_at", -1), ("user_id", 1)],
    "registered_asc": [("created_at", 1), ("user_id", 1)],
    "username_asc": [("username_lower", 1), ("user_id", 1)],
    "games_desc": [("stats.games_played", -1), ("user_id", 1)],
    "wins_desc": [("stats.wins", -1), ("user_id", 1)],
    "last_active_desc": [("last_seen", -1), ("user_id", 1)],
    "last_active_asc": [("last_seen", 1), ("user_id", 1)],
}


def _validate_player_id(player_id):
    if not isinstance(player_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", player_id):
        raise HTTPException(status_code=422, detail="Invalid player ID")
    return player_id


def _player_status_filter(status, now_iso_value):
    if status == "banned":
        return {"account_status": "banned"}
    if status == "suspended":
        return {"account_status": "suspended", "$or": [
            {"account_restriction.expires_at": {"$gt": now_iso_value}},
            {"account_restriction.expires_at": {"$exists": False}},
            {"account_restriction.expires_at": None},
        ]}
    if status == "active":
        return {"$or": [
            {"account_status": {"$exists": False}},
            {"account_status": None},
            {"account_status": "active"},
            {"account_status": "suspended", "account_restriction.expires_at": {"$lte": now_iso_value}},
        ]}
    return None


def _nonnegative_count(value):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0):
        return None
    return int(value)


def _admin_progression(user):
    stored = user.get("progression") if isinstance(user.get("progression"), dict) else {}
    xp = stored.get("xp")
    stats = user.get("stats") if isinstance(user.get("stats"), dict) else {}
    has_source_counters = all(
        key in stats and isinstance(stats[key], (int, float)) and not isinstance(stats[key], bool)
        and math.isfinite(stats[key]) and stats[key] >= 0
        for key in ("games_played", "wins")
    )
    if isinstance(xp, int) and not isinstance(xp, bool) and xp >= 0:
        return public_progression(user)
    if has_source_counters:
        return public_progression(user)
    return {
        "level": None, "xp": None, "xp_in_level": None, "xp_to_next_level": None,
        "progress_percent": None, "current_win_streak": stored.get("current_win_streak"),
        "best_win_streak": stored.get("best_win_streak"),
    }


def _admin_player_row(user, *, now=None):
    raw_stats = user.get("stats") if isinstance(user.get("stats"), dict) else {}
    stats = {key: _nonnegative_count(raw_stats[key]) if key in raw_stats else None for key in EMPTY_STATS}
    progression = _admin_progression(user)
    restriction = _stored_account_restriction(user)
    status = "active"
    if restriction:
        restriction_type = restriction.get("type")
        if restriction_type == "suspended":
            status = "suspended"
        else:
            status = "banned"
    expires_at = _as_utc_datetime((restriction or {}).get("expires_at"))
    if status == "suspended" and expires_at and expires_at <= (now or datetime.now(timezone.utc)):
        status = "active"
    return {
        "user_id": user["user_id"], "username": user.get("username"),
        "display_name": user.get("display_name") or user.get("username"),
        "avatar_color": user.get("avatar_color"), "avatar_icon": user.get("avatar_icon"),
        "created_at": user.get("created_at"), "account_status": status,
        "level": progression["level"], "xp": progression["xp"],
        "games_played": stats.get("games_played"), "wins": stats.get("wins"),
        "losses": stats.get("losses"), "draws": stats.get("draws"),
        "last_active_at": user.get("last_seen"), "online": hub.online(user["user_id"]),
    }


def _safe_moderation_reason(value):
    reason = str(value or "").strip()
    reason = re.sub(r"(?i)\bmongodb(?:\+srv)?://\S+", "[redacted connection string]", reason)
    reason = re.sub(r"(?i)\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9_-]+", "[redacted credential]", reason)
    reason = re.sub(r"(?i)\bbearer\s+[A-Za-z0-9._~-]+", "Bearer [redacted]", reason)
    reason = re.sub(r"(?i)\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+", "[redacted credential]", reason)
    return reason[:500]


async def _admin_player_or_404(player_id):
    _validate_player_id(player_id)
    user = await db.users.find_one({"user_id": player_id, **IN_ENV}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="Player not found")
    return user


async def _player_audit_event(admin, player_id, action, reason, previous_status, new_status, *, expires_at=None):
    timestamp = now_iso()
    event = {
        "id": str(uuid.uuid4()), "env": ENV, "action": action,
        "actor_id": admin["user_id"], "actor_name": admin.get("display_name") or admin.get("username"),
        "target_user_id": player_id, "reason": reason, "timestamp": timestamp,
        "previous_status": previous_status, "new_status": new_status,
        "expires_at": expires_at,
    }
    update = {"$set": {"account_status": new_status}, "$push": {"moderation_history": event}}
    if new_status == "active":
        update["$unset"] = {"account_restriction": ""}
    else:
        update["$set"]["account_restriction"] = {
            "type": new_status, "reason": reason, "actor_id": admin["user_id"],
            "started_at": timestamp, "expires_at": expires_at,
        }
    result = await db.users.update_one({"user_id": player_id, **IN_ENV}, update)
    if result.matched_count != 1:
        raise HTTPException(status_code=404, detail="Player not found")

    try:
        await games.audit_admin(
            admin["user_id"], f"player_{action}", target_type="player", target_id=player_id,
            reason=reason, previous_value={"status": previous_status},
            new_value={"status": new_status, "expires_at": expires_at},
        )
    except Exception as exc:
        # The player document contains the durable moderation event as well, so
        # history is preserved if the general audit collection is unavailable.
        logger.error("Player moderation audit persistence failed (%s)", type(exc).__name__)
    return event


async def _deny_player_moderation(request, admin, player_id, reason, *, status_code=403):
    await audit_admin_denial(request, admin["user_id"], target_type="player", target_id=player_id,
                             reason=reason, action="player_moderation_denied")
    raise HTTPException(status_code=status_code, detail=reason)


async def _player_target_or_deny(request, admin, player_id, *, action="player_moderation_denied"):
    try:
        return await _admin_player_or_404(player_id)
    except HTTPException as exc:
        if exc.status_code == 404:
            await audit_admin_denial(request, admin["user_id"], target_type="player", target_id=player_id,
                                     reason="Player not found in the active environment", action=action)
        raise


async def _close_player_sockets(player_id, restriction):
    await voice_service.leave_user(player_id)
    payload = {
        "type": "account_restricted", "message": _restriction_message(restriction),
        "expires_at": restriction.get("expires_at"),
    }
    for socket in list(hub.sockets.get(player_id, ())):
        try:
            await socket.send_json(payload)
        except Exception:
            logger.warning("Could not close a restricted player's WebSocket")
        try:
            await socket.close(code=4423)
        except Exception:
            pass


@api_router.get("/admin/players")
async def admin_player_directory(
    q: Optional[str] = Query(None, max_length=80),
    status: Optional[str] = Query(None),
    registered_after: Optional[datetime] = Query(None),
    registered_before: Optional[datetime] = Query(None),
    sort: str = Query("registered_desc"),
    offset: int = Query(0, ge=0, le=1_000_000),
    limit: int = Query(25, ge=1, le=100),
    admin: dict = Depends(require_player_permission("player:read")),
):
    if status not in (None, "active", "suspended", "banned"):
        raise HTTPException(status_code=422, detail="Invalid account status filter")
    if sort not in PLAYER_SORTS:
        raise HTTPException(status_code=422, detail="Invalid player sort")
    after = _as_utc_datetime(registered_after)
    before = _as_utc_datetime(registered_before)
    if after and before and after > before:
        raise HTTPException(status_code=422, detail="Registration start must be before the end")

    clauses = [dict(IN_ENV)]
    if q and q.strip():
        term = re.escape(q.strip())
        clauses.append({"$or": [
            {"username_lower": {"$regex": f"^{term.lower()}", "$type": "string"}},
            {"username": {"$regex": f"^{term}", "$options": "i"}},
            {"user_id": {"$regex": f"^{term}"}},
        ]})
    if status:
        clauses.append(_player_status_filter(status, now_iso()))
    if after or before:
        created_range = {}
        if after:
            created_range["$gte"] = _iso_utc(after)
        if before:
            created_range["$lte"] = _iso_utc(before)
        clauses.append({"created_at": created_range})
    query = {"$and": clauses}
    projection = {
        "_id": 0, "user_id": 1, "username": 1, "username_lower": 1,
        "display_name": 1, "avatar_color": 1, "avatar_icon": 1,
        "created_at": 1, "last_seen": 1, "stats": 1, "progression": 1,
        "account_status": 1, "account_restriction.type": 1, "account_restriction.expires_at": 1,
    }
    total = await db.users.count_documents(query)
    users = await db.users.find(query, projection).sort(PLAYER_SORTS[sort]).skip(offset).limit(limit).to_list(limit)
    now = datetime.now(timezone.utc)
    return {"items": [_admin_player_row(user, now=now) for user in users],
            "total": total, "offset": offset, "limit": limit, "sort": sort}


@api_router.get("/admin/players/{player_id}")
async def admin_player_detail(player_id: str, admin: dict = Depends(require_player_permission("player:read"))):
    user = await _admin_player_or_404(player_id)
    restriction = await _active_account_restriction(player_id, _stored_account_restriction(user))
    status = restriction.get("type") if restriction else "active"
    projection = {
        "_id": 0, "id": 1, "game_id": 1, "is_public": 1, "has_bots": 1,
        "scores": 1, "target": 1, "winner_team": 1, "finished_at": 1,
        "started_at": 1, "duration_seconds": 1,
        "players.user_id": 1, "players.username": 1, "players.display_name": 1,
        "players.team": 1, "players.seat": 1, "players.is_bot": 1,
    }
    match_docs = await db.matches.find({"player_ids": player_id, **IN_ENV}, projection).sort(
        "finished_at", -1).limit(25).to_list(25)
    matches = []
    for match in match_docs:
        own_player = next((player for player in match.get("players", ()) if player.get("user_id") == player_id), None)
        team = own_player.get("team") if own_player else None
        winner = match.get("winner_team")
        valid_winner = isinstance(winner, int) and not isinstance(winner, bool) and winner in (0, 1)
        outcome = ("unknown" if "winner_team" not in match else "draw") if not valid_winner else (
            "unknown" if team not in (0, 1) else "win" if team == winner else "loss"
        )
        matches.append({
            "id": match.get("id") or match.get("game_id"), "finished_at": match.get("finished_at"),
            "started_at": match.get("started_at"), "duration_seconds": match.get("duration_seconds"),
            "is_public": bool(match.get("is_public")), "has_bots": bool(match.get("has_bots")),
            "scores": match.get("scores") if isinstance(match.get("scores"), list) else None,
            "target": match.get("target"), "winner_team": winner, "player_team": team,
            "outcome": outcome, "players": [
                {"username": player.get("username"), "display_name": player.get("display_name"),
                 "team": player.get("team"), "is_bot": bool(player.get("is_bot"))}
                for player in match.get("players", ())
            ],
        })

    raw_stats = user.get("stats") if isinstance(user.get("stats"), dict) else {}
    stats = {key: _nonnegative_count(raw_stats[key]) if key in raw_stats else None for key in EMPTY_STATS}
    games_played = stats["games_played"]
    progression = user.get("progression") or {}
    duration_count = _nonnegative_count(progression.get("match_duration_count"))
    duration_total = progression.get("match_duration_seconds_total")
    average_duration = None
    if (duration_count and isinstance(duration_total, (int, float)) and not isinstance(duration_total, bool)
            and math.isfinite(duration_total) and duration_total >= 0):
        average_duration = duration_total / duration_count

    can_view_moderation = has_admin_permission(admin.get("role"), "player:moderate")
    moderation_history = [
        event for event in user.get("moderation_history", ())
        if can_view_moderation and isinstance(event, dict) and event.get("env") == ENV
    ]
    moderation_history.sort(key=lambda event: event.get("timestamp") or "", reverse=True)
    notes = []
    if has_admin_permission(admin.get("role"), "player:notes:write"):
        notes = await db.admin_player_notes.find(
            {"target_user_id": player_id, **IN_ENV}, {"_id": 0, "id": 1, "target_user_id": 1,
             "author_id": 1, "content": 1, "created_at": 1, "env": 1},
        ).sort("created_at", -1).limit(100).to_list(100)
    author_ids = {note.get("author_id") for note in notes if note.get("author_id")}
    author_users = await users_by_ids(author_ids)
    safe_notes = [{
        "id": note.get("id"), "author_id": note.get("author_id"),
        "author_name": (author_users.get(note.get("author_id")) or {}).get("display_name")
                       or (author_users.get(note.get("author_id")) or {}).get("username") or "Staff member",
        "created_at": note.get("created_at"), "content": note.get("content"), "env": note.get("env"),
    } for note in notes]

    actor_ids = {event.get("actor_id") for event in moderation_history
                 if event.get("actor_id") and event.get("actor_id") != "system"}
    actor_users = await users_by_ids(actor_ids)
    safe_moderation_history = [{
        "id": event.get("id"), "action": event.get("action"),
        "actor_id": event.get("actor_id"),
        "actor_name": event.get("actor_name") or (actor_users.get(event.get("actor_id")) or {}).get("username") or "System",
        "reason": event.get("reason"), "timestamp": event.get("timestamp"),
        "expires_at": event.get("expires_at"), "previous_status": event.get("previous_status"),
        "new_status": event.get("new_status"),
    } for event in moderation_history]

    activity = ([{"kind": "registration", "timestamp": user.get("created_at"), "summary": "Player registered"}]
                if user.get("created_at") else [])
    activity.extend({"kind": "match", "timestamp": match.get("finished_at"),
                     "summary": f"Completed a match · {match['outcome']}"} for match in matches)
    activity.extend({"kind": "moderation", "timestamp": event.get("timestamp"),
                     "summary": f"Account {event.get('new_status') or event.get('action')}"}
                    for event in safe_moderation_history)
    activity.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
    recent_performance = [match["outcome"] for match in matches[:5]]
    win_percent = (round(100 * stats["wins"] / games_played, 1)
                   if games_played and stats["wins"] is not None else None)
    return {
        "player": {
            "user_id": user["user_id"], "username": user.get("username"),
            "display_name": user.get("display_name") or user.get("username"),
            "avatar_color": user.get("avatar_color"), "avatar_icon": user.get("avatar_icon"),
            "created_at": user.get("created_at"), "last_active_at": user.get("last_seen"),
            "account_status": status,
        },
        "statistics": {
            "games_played": games_played, "wins": stats.get("wins"), "losses": stats.get("losses"),
            "draws": stats.get("draws"), "win_percent": win_percent,
            "average_match_duration_seconds": average_duration,
            "team_tricks_won": progression.get("team_tricks_won"),
        },
        "progression": _admin_progression(user),
        "achievements": achievement_cards(stats, progression, user.get("achievement_unlocks")),
        "recent_performance": recent_performance, "recent_activity": activity[:20],
        "match_history": matches, "moderation_history": safe_moderation_history,
        "internal_notes": safe_notes,
    }


@api_router.post("/admin/players/{player_id}/notes")
async def admin_add_player_note(player_id: str, body: PlayerNoteIn, request: Request,
                                admin: dict = Depends(require_player_permission("player:notes:write"))):
    player_id = _validate_player_id(player_id)
    user = await _player_target_or_deny(request=request, admin=admin, player_id=player_id,
                                        action="player_note_denied")
    if not user:
        raise HTTPException(status_code=404, detail="Player not found")
    content = body.content.strip()
    if not content:
        await audit_admin_denial(request, admin["user_id"], target_type="player", target_id=player_id,
                                 reason="Internal note content is required", action="player_note_denied")
        raise HTTPException(status_code=422, detail="Note content is required")
    if not allow_admin_request(admin["user_id"], "player-notes", limit=20):
        await audit_admin_denial(request, admin["user_id"], target_type="player", target_id=player_id,
                                 reason="Player note rate limit exceeded", action="player_note_denied")
        raise HTTPException(status_code=429, detail="Too many player notes")
    note = {
        "id": str(uuid.uuid4()), "env": ENV, "target_user_id": player_id,
        "author_id": admin["user_id"], "content": content, "created_at": now_iso(),
    }
    await db.admin_player_notes.insert_one(dict(note))
    try:
        await games.audit_admin(admin["user_id"], "player_note_added", target_type="player", target_id=player_id,
                                reason="Internal administrator note added")
    except Exception as exc:
        logger.error("Player note audit persistence failed (%s)", type(exc).__name__)
    return {"id": note["id"], "author_id": note["author_id"], "author_name": admin.get("display_name") or admin.get("username") or "Staff member",
            "content": note["content"], "created_at": note["created_at"], "env": ENV}


@api_router.post("/admin/players/{player_id}/suspend")
async def admin_suspend_player(player_id: str, body: SuspendPlayerIn, request: Request,
                               admin: dict = Depends(require_player_permission("player:moderate"))):
    player_id = _validate_player_id(player_id)
    reason = _safe_moderation_reason(body.reason)
    if not reason:
        await _deny_player_moderation(request, admin, player_id, "A suspension reason is required", status_code=422)
    if player_id == admin["user_id"]:
        await _deny_player_moderation(request, admin, player_id, "Staff cannot suspend their own account")
    if not allow_admin_request(admin["user_id"], "player-moderation", limit=10):
        raise HTTPException(status_code=429, detail="Too many player moderation actions")
    async with admin_role_update_lock(f"player-moderation:{player_id}", "Player moderation is busy; retry shortly"):
        user = await _player_target_or_deny(request, admin, player_id)
        restriction = await _active_account_restriction(player_id, _stored_account_restriction(user))
        if restriction:
            await _deny_player_moderation(request, admin, player_id, "Player already has an active restriction", status_code=409)
        now = datetime.now(timezone.utc)
        expires_at = _iso_utc(now + timedelta(hours=body.duration_hours))
        event = await _player_audit_event(admin, player_id, "suspended", reason, "active", "suspended", expires_at=expires_at)
    await _close_player_sockets(player_id, {"type": "suspended", "reason": reason, "expires_at": expires_at})
    return {"ok": True, "account_status": "suspended", "expires_at": expires_at, "event_id": event["id"]}


@api_router.post("/admin/players/{player_id}/ban")
async def admin_ban_player(player_id: str, body: PlayerReasonIn, request: Request,
                           admin: dict = Depends(require_player_permission("player:ban"))):
    player_id = _validate_player_id(player_id)
    reason = _safe_moderation_reason(body.reason)
    if not reason:
        await _deny_player_moderation(request, admin, player_id, "A ban reason is required", status_code=422)
    if player_id == admin["user_id"]:
        await _deny_player_moderation(request, admin, player_id, "Staff cannot ban their own account")
    if not allow_admin_request(admin["user_id"], "player-moderation", limit=10):
        raise HTTPException(status_code=429, detail="Too many player moderation actions")
    async with admin_role_update_lock(f"player-moderation:{player_id}", "Player moderation is busy; retry shortly"):
        user = await _player_target_or_deny(request, admin, player_id)
        restriction = await _active_account_restriction(player_id, _stored_account_restriction(user))
        if restriction:
            await _deny_player_moderation(request, admin, player_id, "Player already has an active restriction", status_code=409)
        event = await _player_audit_event(admin, player_id, "banned", reason, "active", "banned")
    await _close_player_sockets(player_id, {"type": "banned", "reason": reason, "expires_at": None})
    return {"ok": True, "account_status": "banned", "event_id": event["id"]}


@api_router.post("/admin/players/{player_id}/unban")
async def admin_unban_player(player_id: str, body: PlayerReasonIn, request: Request,
                             admin: dict = Depends(require_player_permission("player:ban"))):
    player_id = _validate_player_id(player_id)
    reason = _safe_moderation_reason(body.reason)
    if not reason:
        await _deny_player_moderation(request, admin, player_id, "An unban reason is required", status_code=422)
    if player_id == admin["user_id"]:
        await _deny_player_moderation(request, admin, player_id, "Staff cannot change their own restriction")
    if not allow_admin_request(admin["user_id"], "player-moderation", limit=10):
        raise HTTPException(status_code=429, detail="Too many player moderation actions")
    async with admin_role_update_lock(f"player-moderation:{player_id}", "Player moderation is busy; retry shortly"):
        user = await _player_target_or_deny(request, admin, player_id)
        restriction = await _active_account_restriction(player_id, _stored_account_restriction(user))
        if not restriction:
            await _deny_player_moderation(request, admin, player_id, "Player has no active restriction", status_code=409)
        previous_status = restriction.get("type")
        event = await _player_audit_event(admin, player_id, "unbanned", reason, previous_status, "active")
    return {"ok": True, "account_status": "active", "event_id": event["id"]}


def _iso_utc(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def _admin_daily_counts(collection, date_field, start, end, extra_filter=None):
    match = {date_field: {"$gte": _iso_utc(start), "$lt": _iso_utc(end)}}
    if extra_filter:
        match.update(extra_filter)
    pipeline = [
        {"$match": match},
        {"$project": {"day": {"$substrCP": [f"${date_field}", 0, 10]}}},
        {"$group": {"_id": "$day", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ]
    return await collection.aggregate(pipeline).to_list(32)


@api_router.get("/admin/system-health")
async def admin_system_health(
    admin: dict = Depends(require_system_health_admin()),
):
    """Return secret-free, read-only diagnostics for explicitly authorized admins."""
    try:
        await asyncio.wait_for(
            games.audit_admin(admin["user_id"], "system_health_viewed", target_type="system_health"),
            timeout=1,
        )
    except Exception as exc:
        # Diagnostics remain useful while Mongo is unavailable; never return its
        # exception text because drivers may include hosts or connection details.
        logger.warning("System health access by admin %s could not be persisted (%s)",
                       admin.get("user_id"), type(exc).__name__)

    try:
        await asyncio.wait_for(db.command("ping"), timeout=3)
        database_status = "healthy"
        database_available = True
    except Exception as exc:
        logger.warning("System health MongoDB ping failed (%s)", type(exc).__name__)
        database_status = "critical"
        database_available = False

    indexes = await _verify_declared_indexes(database_available)
    spectator_index = next(
        item for item in indexes["items"] if item["declared"]["name"] == "expires_ttl"
    )
    index_initialization = {
        **INDEX_INITIALIZATION_STATE,
        "failures": [dict(failure) for failure in INDEX_INITIALIZATION_STATE["failures"]],
    }
    if database_status == "critical" or index_initialization["status"] == "critical" or indexes["status"] == "critical":
        overall_status = "critical"
    elif (indexes["status"] == "unknown" or index_initialization["status"] == "unknown"
          or not isinstance(getattr(hub, "sockets", None), dict)):
        overall_status = "unknown"
    elif indexes["status"] == "warning" or index_initialization["status"] in {"pending", "running"}:
        overall_status = "warning"
    else:
        overall_status = "healthy"

    websocket_ready = isinstance(getattr(hub, "sockets", None), dict)
    connected_clients = sum(len(sockets) for sockets in hub.sockets.values()) if websocket_ready else None
    last_verified_at = now_iso()
    return {
        "status": overall_status,
        "last_verified_at": last_verified_at,
        "environment": ENV,
        "database": {"status": database_status, "name": _safe_database_name(os.environ.get("DB_NAME"))},
        "uptime_seconds": max(0, int(time.monotonic() - PROCESS_STARTED_AT)),
        "index_initialization": index_initialization,
        "indexes": indexes,
        "spectator_ttl": {
            "status": spectator_index["verification"]["status"],
            "declared": spectator_index["declared"],
            "verification": spectator_index["verification"],
        },
        "websocket": {
            "status": "healthy" if websocket_ready else "unknown",
            "implementation": "in_process_hub",
            "connected_clients": connected_clients,
        },
    }


@api_router.get("/admin/overview")
async def admin_overview(admin: dict = Depends(require_permission("admin:overview:read"))):
    now = datetime.now(timezone.utc)
    await games.audit_admin(admin["user_id"], "dashboard_viewed", target_type="admin_dashboard")
    today_start = datetime.combine(now.date(), datetime.min.time(), timezone.utc)
    chart_start = today_start - timedelta(days=13)
    chart_end = today_start + timedelta(days=1)
    today_iso = _iso_utc(today_start)
    counts = await asyncio.gather(
        db.users.count_documents(IN_ENV),
        db.users.count_documents({"created_at": {"$gte": today_iso}, **IN_ENV}),
        db.rooms.count_documents(scoped_query({"status": "lobby", "is_public": True}, ENV)),
        db.rooms.count_documents(scoped_query({"status": "lobby", "is_public": {"$ne": True}}, ENV)),
        db.games.count_documents(scoped_query({"status": "active"}, ENV)),
        db.matches.count_documents(scoped_query({"finished_at": {"$gte": today_iso}}, ENV)),
        db.matches.count_documents(IN_ENV),
        db.games.count_documents(scoped_query({"created_at": {"$gte": _iso_utc(chart_start), "$lt": _iso_utc(chart_end)}}, ENV)),
        db.games.count_documents(scoped_query({"created_at": {"$gte": _iso_utc(chart_start), "$lt": _iso_utc(chart_end)}, "status": "finished"}, ENV)),
    )
    total_users, new_today, public_lobbies, private_lobbies, active_matches, completed_today, total_matches, started_14d, finished_14d = counts
    active_games = [game for game in games.games.values() if game.get("status") == "active"]
    players_in_games = len({p.get("user_id") for game in active_games for p in game.get("players", ())
                            if p.get("user_id") and not p.get("is_bot")})
    active_spectators = sum(games.spectators.count(game["id"]) for game in active_games)

    registration_rows, match_rows, public_match_rows, private_match_rows, activity_users, activity_matches, activity_rooms, audit_rows = await asyncio.gather(
        _admin_daily_counts(db.users, "created_at", chart_start, chart_end, IN_ENV),
        _admin_daily_counts(db.matches, "finished_at", chart_start, chart_end, IN_ENV),
        _admin_daily_counts(db.matches, "finished_at", chart_start, chart_end, {"is_public": True, **IN_ENV}),
        _admin_daily_counts(db.matches, "finished_at", chart_start, chart_end, {"is_public": {"$ne": True}, **IN_ENV}),
        db.users.find(IN_ENV,
                      {"_id": 0, "username": 1, "display_name": 1, "created_at": 1}).sort("created_at", -1).limit(5).to_list(5),
        db.matches.find(IN_ENV, {"_id": 0, "finished_at": 1, "players.username": 1, "players.display_name": 1,
                             "scores": 1, "winner_team": 1, "is_public": 1}).sort("finished_at", -1).limit(5).to_list(5),
        db.rooms.find(IN_ENV, {"_id": 0, "is_public": 1, "status": 1, "created_at": 1}).sort("created_at", -1).limit(5).to_list(5),
        (db.admin_audit_logs.find(IN_ENV, {"_id": 0, "action": 1, "target_type": 1, "target_id": 1,
                                       "timestamp": 1, "success": 1, "reason": 1}).sort("timestamp", -1).limit(5).to_list(5)
         if admin_audit_activity_visible(admin.get("role")) else asyncio.sleep(0, result=[])),
    )
    days = [(chart_start.date() + timedelta(days=i)).isoformat() for i in range(14)]
    registrations = {row["_id"]: row["count"] for row in registration_rows}
    match_counts = {row["_id"]: row["count"] for row in match_rows}
    public_match_counts = {row["_id"]: row["count"] for row in public_match_rows}
    private_match_counts = {row["_id"]: row["count"] for row in private_match_rows}
    activity = []
    for user in activity_users:
        activity.append({"kind": "registration", "timestamp": user.get("created_at"),
                         "summary": f"{user.get('display_name') or user.get('username') or 'A player'} registered"})
    for match in activity_matches:
        names = [p.get("display_name") or p.get("username") for p in match.get("players", ()) if p.get("username")]
        scores = match.get("scores") if isinstance(match.get("scores"), list) and len(match.get("scores")) >= 2 else [0, 0]
        activity.append({"kind": "match", "timestamp": match.get("finished_at"),
                         "summary": f"Match completed · {' vs '.join(names[:2]) or 'Players'} · {scores[0]}–{scores[1]}"})
    for room in activity_rooms:
        activity.append({"kind": "room", "timestamp": room.get("created_at"),
                         "summary": f"{('Public' if room.get('is_public') else 'Private')} room created"})
    for item in audit_rows:
        activity.append({"kind": "admin", "timestamp": item.get("timestamp"),
                         "summary": f"Admin action: {item.get('action')}", "success": item.get("success", True)})
    activity.sort(key=lambda item: item.get("timestamp") or "", reverse=True)
    completion_rate = round(100 * finished_14d / started_14d, 1) if started_14d else None
    return {
        "metrics": {
            "registered_players": total_users,
            "online_players": len(hub.sockets),
            "players_in_games": players_in_games,
            "active_public_lobbies": public_lobbies,
            "active_private_lobbies": private_lobbies,
            "active_matches": active_matches,
            "active_spectators": active_spectators,
            "games_completed_today": completed_today,
            "new_registrations_today": new_today,
            "completed_matches": total_matches,
            "match_completion_rate_14d": completion_rate,
        },
        "charts": {
            "registrations": [{"day": day, "count": registrations.get(day, 0)} for day in days],
            "completed_matches": [{"day": day, "count": match_counts.get(day, 0)} for day in days],
            "public_matches": [{"day": day, "count": public_match_counts.get(day, 0)} for day in days],
            "private_matches": [{"day": day, "count": private_match_counts.get(day, 0)} for day in days],
        },
        "recent_activity": activity[:12],
    }


@api_router.get("/admin/lobbies")
async def admin_lobbies(
    q: Optional[str] = Query(None, max_length=80),
    room_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    disconnected: bool = False,
    sort: str = Query("created_at_desc"),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    admin: dict = Depends(require_permission("admin:lobbies:read")),
):
    type_values = {"public": True, "private": False}
    status_values = {"waiting": "lobby", "playing": "playing", "completed": "finished", "cancelled": "cancelled"}
    sort_values = {"created_at_desc", "created_at_asc", "duration_desc", "duration_asc", "spectators_desc"}
    if room_type and room_type not in type_values:
        raise HTTPException(422, "Invalid room type filter")
    if status and status not in status_values:
        raise HTTPException(422, "Invalid room status filter")
    if sort not in sort_values:
        raise HTTPException(422, "Invalid lobby sort")

    audit_now = time.monotonic()
    if audit_now - _admin_lobby_audit_at.get(admin["user_id"], audit_now - 300) >= 300:
        await games.audit_admin(admin["user_id"], "lobby_monitor_viewed", target_type="lobby_list")
        _admin_lobby_audit_at[admin["user_id"]] = audit_now

    room_filter = {"status": status_values[status] if status else {"$in": ["lobby", "playing"]}}
    if room_type:
        room_filter["is_public"] = True if type_values[room_type] else {"$ne": True}
    room_projection = {"_id": 0, "code": 1, "is_public": 1, "host_id": 1, "status": 1, "seats": 1,
                       "bots": 1, "created_at": 1, "target": 1, "dealer_seat": 1, "turn_duration": 1,
                       "spectators_enabled": 1, "game_id": 1}
    rooms = await db.rooms.find(scoped_query(room_filter, ENV), room_projection).sort("created_at", -1).limit(2001).to_list(2001)
    truncated = len(rooms) > 2000
    rooms = rooms[:2000]
    codes = [room["code"] for room in rooms if room.get("code")]
    game_ids = [room["game_id"] for room in rooms if room.get("game_id")]
    game_projection = {"_id": 0, "id": 1, "room_code": 1, "status": 1, "created_at": 1, "finished_at": 1,
                       "result_summary.duration_seconds": 1, "players.user_id": 1, "players.seat": 1,
                       "players.username": 1, "players.display_name": 1, "players.avatar_color": 1,
                       "players.avatar_icon": 1, "players.is_bot": 1, "state.phase": 1,
                       "state.round_no": 1, "state.turn": 1, "state.scores": 1, "state.tricks_won": 1}
    game_filter = scoped_query({"$or": ([{"id": {"$in": game_ids}}] if game_ids else []) + ([{"room_code": {"$in": codes}}] if codes else [])}, ENV)
    game_docs = await db.games.find(game_filter, game_projection).to_list(2001) if game_filter["$or"] else []
    game_by_room = {game.get("room_code"): game for game in game_docs if game.get("room_code")}
    user_ids = {uid for room in rooms for uid in room.get("seats", ()) if uid and uid not in (room.get("bots") or {})}
    user_docs = await db.users.find({"user_id": {"$in": list(user_ids)}, **IN_ENV},
                                    {"_id": 0, "user_id": 1, "username": 1, "display_name": 1,
                                     "avatar_color": 1, "avatar_icon": 1}).to_list(len(user_ids) + 1) if user_ids else []
    users_map = {user["user_id"]: user for user in user_docs}
    now = datetime.now(timezone.utc)
    items = []
    for room in rooms:
        game = game_by_room.get(room.get("code"))
        item = admin_lobby_projection(room, game, users_map, {uid: hub.online(uid) for uid in user_ids},
                                      games.spectators.count(game.get("id")) if game and game.get("id") else 0, now=now)
        if q:
            q_lower = q.casefold()
            # Search private invite codes server-side without returning them to staff.
            terms = [room.get("code", ""), item.get("owner", "")]
            terms.extend(player.get("username") or "" for player in item["players"])
            terms.extend(player.get("display_name") or "" for player in item["players"])
            if not any(q_lower in term.casefold() for term in terms):
                continue
        if disconnected and not item["disconnected_players"]:
            continue
        items.append(item)

    if sort == "created_at_asc":
        items.sort(key=lambda item: item.get("created_at") or "")
    elif sort == "duration_desc":
        items.sort(key=lambda item: item["match_duration_seconds"], reverse=True)
    elif sort == "duration_asc":
        items.sort(key=lambda item: item["match_duration_seconds"])
    elif sort == "spectators_desc":
        items.sort(key=lambda item: item["spectator_count"], reverse=True)
    else:
        items.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return {"items": items[offset:offset + limit], "total": len(items), "offset": offset, "limit": limit,
            "truncated": truncated,
            "can_spectate": has_admin_permission(admin.get("role"), "admin:spectate")}


@api_router.post("/admin/games/{game_id}/spectator-state")
async def admin_spectator_game_state(game_id: str, admin: dict = Depends(require_permission("admin:spectate"))):
    try:
        return await games.admin_spectator_snapshot(admin["user_id"], game_id)
    except SpectatorAccessError:
        raise HTTPException(404, "Match unavailable or spectator access denied") from None


@api_router.get("/admin/stats")
async def admin_stats(admin: dict = Depends(require_permission("admin:overview:read"))):
    return {"users": await db.users.count_documents(IN_ENV), "online": len(hub.sockets),
            "active_games": len(games.games), "matches": await db.matches.count_documents(IN_ENV),
            "queue": len(mm_queue) + sum(len(q) for q in mm_stake_queues.values()), "open_lobbies": await db.rooms.count_documents(scoped_query({"status": "lobby"}, ENV))}


@api_router.get("/")
async def root():
    return {"message": "Dehla Pakad API"}


# ---------------- websocket ----------------
async def notify_presence(uid):
    friends = [f["friend_id"] async for f in db.friends.find({"user_id": uid, **IN_ENV}, {"_id": 0})]
    await hub.send_many(friends, {"type": "presence", "user_id": uid, "online": hub.online(uid)})
    g = games.active_game_for(uid)
    if g:
        await games.broadcast(g)


async def handle_social(uid, msg):
    code = str(msg.get("room_code", "")).upper()
    room = await db.rooms.find_one(scoped_query({"code": code, "seats": uid}, ENV), {"_id": 0, "seats": 1})
    if not room:
        return {"type": "error", "message": "Room not found"}
    u = await db.users.find_one({"user_id": uid, **IN_ENV}, {"_id": 0, "username": 1})
    if msg["type"] == "chat":
        text = str(msg.get("text", "")).strip()[:300]
        if not text:
            return None
        doc = {"id": str(uuid.uuid4()), "env": ENV, "room_code": code, "user_id": uid, "username": u["username"], "text": text, "ts": now_iso()}
        await db.chat_messages.insert_one(dict(doc))
        await hub.send_many(room["seats"], {"type": "chat", "message": doc})
    else:
        emoji = str(msg.get("emoji", ""))
        if emoji not in EMOJIS:
            return {"type": "error", "message": "Unknown reaction"}
        await hub.send_many(room["seats"], {"type": "reaction", "room_code": code, "user_id": uid, "emoji": emoji})
    return None


@app.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket):
    # All checked-in clients send the token in the first message, keeping it out of access logs.
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
        token = first.get("token") if isinstance(first, dict) and first.get("type") == "auth" else None
        if not isinstance(token, str) or not token:
            raise ValueError("invalid websocket authentication message")
        claims = await run_in_threadpool(verify_session_token, token)
    except (HTTPException, asyncio.TimeoutError, WebSocketDisconnect, ValueError, RuntimeError):
        with suppress(Exception):
            await ws.close(code=4401)
        return
    uid = claims["sub"]
    user = await db.users.find_one({"user_id": uid, **IN_ENV}, {
        "_id": 0, "username": 1, "role": 1, "account_status": 1, "account_restriction": 1,
    })
    if not user or not user.get("username"):
        await ws.close(code=4428)
        return
    restriction = await _active_account_restriction(uid, _stored_account_restriction(user))
    if restriction:
        await ws.send_json({"type": "account_restricted", "message": _restriction_message(restriction),
                            "expires_at": restriction.get("expires_at")})
        await ws.close(code=4423)
        return
    sid = claims.get("sid")
    # Register before checking, so a newer login that lands meanwhile still finds and closes this socket.
    socket_sessions[ws] = (uid, sid)
    try:
        await session_guard.check(uid, sid)
    except SessionReplaced:
        socket_sessions.pop(ws, None)
        await _close_replaced_socket(ws)
        return
    except (SessionInvalid, SessionUnavailable) as error:
        socket_sessions.pop(ws, None)
        with suppress(Exception):
            await ws.close(code=4401 if isinstance(error, SessionInvalid) else 1013)
        return
    admin_socket = has_admin_permission(user.get("role"), "admin:overview:read")
    if hub.add(uid, ws):
        await db.users.update_one({"user_id": uid, **IN_ENV}, {"$set": {"last_seen": now_iso()}})
        await notify_presence(uid)
    if admin_socket:
        try:
            await games.audit_admin(uid, "admin_session_connected", target_type="websocket")
        except Exception:
            logger.exception("failed to record admin WebSocket connection")
    try:
        g = games.active_game_for(uid)
        await ws.send_json({"type": "hello", "active_game_id": g["id"] if g else None})
        while True:
            msg = await ws.receive_json()
            if session_guard.is_replaced(uid, sid):
                # A newer login already took over; never act on messages from the older session.
                await _close_replaced_socket(ws)
                break
            if not isinstance(msg, dict):
                continue
            kind = msg.get("type")
            if isinstance(kind, str) and kind.startswith("voice_"):
                try:
                    await voice_service.handle(uid, ws, msg)
                except Exception:
                    logger.warning("Voice signaling request failed")
                    await voice_service._error(ws, "Voice service is temporarily unavailable")
                continue
            if kind == "spectator_leave":
                await voice_service.leave_spectator(str(msg.get("game_id", "")), uid, ws)
                await games.leave_spectator(uid, str(msg.get("game_id", "")), ws)
                continue
            if not hub.allow(uid):
                await ws.send_json({"type": "error", "message": "Slow down"})
                continue
            reply = None
            if kind == "ping":
                await voice_service.heartbeat(uid, ws)
                reply = {"type": "pong"}
            elif kind == "sync_game":
                game = await games.get(str(msg.get("game_id", "")))
                reply = games.view_for(game, uid) if game and games.seat_of(game, uid) is not None else {"type": "error", "message": "Game not found"}
            elif kind == "game_action":
                reply = await games.handle(uid, msg)
            elif kind == "private_lobby_chat":
                reply = await send_private_lobby_message(db, hub, lobby_chat_limiter, uid, msg, ENV)
            elif kind == "spectator_join":
                try:
                    await games.join_spectator(uid, str(msg.get("game_id", "")), ws, msg.get("invite"))
                except SpectatorAccessError:
                    reply = {"type": "spectator_error", "game_id": msg.get("game_id"),
                             "message": "Match unavailable or spectator access denied"}
            elif kind == "admin_spectator_join":
                game_id = str(msg.get("game_id", ""))
                role_doc = await db.users.find_one({"user_id": uid, **IN_ENV}, {"_id": 0, "role": 1})
                if not role_doc or not has_admin_permission(role_doc.get("role"), "admin:spectate"):
                    try:
                        await games.audit_admin(uid, "authorization_denied", target_type="admin_spectator",
                                                target_id=game_id, success=False, reason="Missing spectator permission")
                    except Exception:
                        logger.exception("failed to record denied admin spectator subscription")
                    reply = {"type": "spectator_error", "game_id": game_id,
                             "message": "Match unavailable or spectator access denied"}
                else:
                    try:
                        await games.join_admin_spectator(uid, game_id, ws)
                    except SpectatorAccessError:
                        reply = {"type": "spectator_error", "game_id": game_id,
                                 "message": "Match unavailable or spectator access denied"}
            elif kind in ("chat", "reaction"):
                reply = await handle_social(uid, msg)
            if reply:
                await ws.send_json(reply)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        socket_sessions.pop(ws, None)
        await voice_service.leave_socket(ws)
        await games.disconnect_spectator(ws, uid)
        if admin_socket:
            try:
                await games.audit_admin(uid, "admin_session_disconnected", target_type="websocket")
            except Exception:
                logger.exception("failed to record admin WebSocket disconnection")
        if hub.remove(uid, ws):
            _remove_from_queues(uid)
            await db.users.update_one({"user_id": uid, **IN_ENV}, {"$set": {"last_seen": now_iso()}})
            await notify_presence(uid)


app.include_router(api_router)
app.include_router(clerk_router)

_CORS = cors_settings()
if not _CORS["allow_origins"]:
    logger.info("CORS_ORIGINS is not set: only same-origin browser requests are accepted")
app.add_middleware(
    CORSMiddleware,
    allow_credentials=_CORS["allow_credentials"],
    allow_origins=_CORS["allow_origins"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    for old, new in RETIRED_ROLES.items():
        await db.users.update_many({"role": old, **IN_ENV}, {"$set": {"role": new}})
    app.state.index_task = asyncio.create_task(ensure_indexes())
    await recover_stake_holds()
    await db.rooms.update_many(scoped_query({"status": "starting"}, ENV), {"$set": {"status": "lobby"}})
    await db.rooms.delete_many(scoped_query({"status": "lobby", "is_public": True}, ENV))  # queue is in-memory; stale public lobbies cannot recover
    await games.load_active()


@app.on_event("shutdown")
async def shutdown_db_client():
    await voice_service.close_all()
    app.state.index_task.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.index_task
    client.close()
