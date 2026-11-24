import asyncio
import logging
import os
import random
import re
import secrets
import time
import uuid
from collections import defaultdict
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import requests
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from pymongo import ASCENDING, DESCENDING, IndexModel, ReturnDocument
from starlette.concurrency import run_in_threadpool
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

try:
    from backend.clerk_auth import clerk_router, require_user, verify_session_token
    from backend.game_service import Hub, GameService, EMOJIS, now_iso
    from backend.bots import BOT_NAMES
except ModuleNotFoundError:
    from bots import BOT_NAMES
    from clerk_auth import clerk_router, require_user, verify_session_token
    from game_service import Hub, GameService, EMOJIS, now_iso

client = AsyncIOMotorClient(os.environ['MONGO_URL'])
db = client[os.environ['DB_NAME']]
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

INDEXES: dict[str, list[IndexModel]] = {
    "users": [IndexModel([("user_id", ASCENDING)], name="user_id", unique=True),
              IndexModel([("username_lower", ASCENDING)], name="username_lower", unique=True, sparse=True),
              IndexModel([("stats.wins", DESCENDING)], name="wins_desc")],
    "friends": [IndexModel([("user_id", ASCENDING), ("friend_id", ASCENDING)], name="pair", unique=True)],
    "friend_requests": [IndexModel([("to_id", ASCENDING), ("status", ASCENDING)], name="to_status"),
                        IndexModel([("from_id", ASCENDING), ("status", ASCENDING)], name="from_status"),
                        IndexModel([("id", ASCENDING)], name="id", unique=True)],
    "rooms": [IndexModel([("code", ASCENDING)], name="code", unique=True), IndexModel([("seats", ASCENDING)], name="seats")],
    "games": [IndexModel([("id", ASCENDING)], name="id", unique=True), IndexModel([("status", ASCENDING)], name="status")],
    "game_events": [IndexModel([("game_id", ASCENDING), ("ts", ASCENDING)], name="game_ts")],
    "matches": [IndexModel([("player_ids", ASCENDING), ("finished_at", DESCENDING)], name="player_finished")],
    "chat_messages": [IndexModel([("room_code", ASCENDING), ("ts", DESCENDING)], name="room_ts")],
    "invitations": [IndexModel([("to_id", ASCENDING), ("status", ASCENDING)], name="to_status"),
                    IndexModel([("id", ASCENDING)], name="id", unique=True)],
}


async def ensure_indexes() -> None:
    for collection, models in INDEXES.items():
        for model in models:
            try:
                await db[collection].create_indexes([model])
            except Exception as exc:
                logger.error("ensure_indexes(%s.%s): %s", collection, model.document["name"], exc)


app = FastAPI(title="Dehla Pakad")
api_router = APIRouter(prefix="/api")
hub = Hub()
games = GameService(db, hub)

# ---------------- rate limiting ----------------
_hits: dict[str, list[float]] = defaultdict(list)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/__clerk"):
        ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "")).split(",")[0].strip()
        t = time.monotonic()
        recent = [x for x in _hits[ip] if t - x < 60]
        recent.append(t)
        _hits[ip] = recent
        if len(recent) > 300:
            return JSONResponse({"detail": "Too many requests, slow down"}, status_code=429)
    return await call_next(request)


# ---------------- users & roles ----------------
ROLES = ["admin", "member"]
DEFAULT_ROLE = "member"
RETIRED_ROLES = {}
RANK = {r: len(ROLES) - i for i, r in enumerate(ROLES)}
ENV = "live" if os.environ.get("CLERK_PUBLISHABLE_KEY", "").startswith("pk_live_") else "preview"
IN_ENV = {"env": {"$in": [ENV, None]}}
AVATAR_COLORS = ["#38bdf8", "#f59e0b", "#10b981", "#f43f5e", "#a78bfa", "#eab308", "#14b8a6", "#fb7185"]
AVATAR_ICONS = ["spade", "heart", "diamond", "club", "crown", "star", "flame", "gem"]
EMPTY_STATS = {"games_played": 0, "wins": 0, "losses": 0, "rounds_won": 0, "normal_wins": 0, "koth_wins": 0, "grand_slam_wins": 0}


def effective_role(role) -> str:
    role = RETIRED_ROLES.get(role, role)
    return role if role in ROLES else DEFAULT_ROLE


def _clerk_identity(user_id: str):
    admins = {e.strip().lower() for e in os.environ.get("ADMIN_EMAIL", "").split(",") if e.strip()}
    r = requests.get(f"https://api.clerk.com/v1/users/{user_id}", timeout=10,
                     headers={"Authorization": f"Bearer {os.environ['CLERK_SECRET_KEY']}", "User-Agent": "emergent-app"})
    r.raise_for_status()
    emails = r.json()["email_addresses"]
    verified = [e["email_address"].lower() for e in emails if (e.get("verification") or {}).get("status") == "verified"]
    email = verified[0] if verified else (emails[0]["email_address"].lower() if emails else "")
    return email, any(e in admins for e in verified)


async def current_member(user: dict = Depends(require_user)) -> dict:
    uid = user["user_id"]
    member = await db.users.find_one({"user_id": uid}, {"_id": 0})
    if member is None or not member.get("role"):
        email, is_admin = await run_in_threadpool(_clerk_identity, uid)
        role = "admin" if is_admin else DEFAULT_ROLE
        await db.users.update_one({"user_id": uid, "role": {"$in": [None, ""]}}, {"$set": {"role": role}})
        member = await db.users.find_one_and_update(
            {"user_id": uid},
            {"$setOnInsert": {"user_id": uid, "role": role, "email": email, "stats": dict(EMPTY_STATS),
                              "avatar_color": random.choice(AVATAR_COLORS), "avatar_icon": random.choice(AVATAR_ICONS),
                              "created_at": now_iso()}},
            upsert=True, projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if member.get("env") != ENV:
        await db.users.update_one({"user_id": uid}, {"$set": {"env": ENV}})
    return {**member, "env": ENV, "role": effective_role(member["role"])}


async def player(member: dict = Depends(current_member)) -> dict:
    if not member.get("username"):
        raise HTTPException(status_code=428, detail="Choose a username first")
    return member


def require_role(*roles: str):
    async def check(member: dict = Depends(current_member)) -> dict:
        if member["role"] not in roles:
            raise HTTPException(status_code=403, detail="Not allowed")
        return member
    return check


def public_user(u: dict) -> dict:
    return {"user_id": u["user_id"], "username": u.get("username"), "avatar_color": u.get("avatar_color"),
            "avatar_icon": u.get("avatar_icon"), "online": hub.online(u["user_id"]), "last_seen": u.get("last_seen"),
            "stats": {**EMPTY_STATS, **(u.get("stats") or {})}, "created_at": u.get("created_at")}


async def users_by_ids(ids) -> dict:
    ids = [i for i in ids if i]
    docs = await db.users.find({"user_id": {"$in": ids}}, {"_id": 0}).to_list(len(ids) + 1)
    return {d["user_id"]: d for d in docs}


class ProfileIn(BaseModel):
    username: Optional[str] = Field(None, min_length=3, max_length=20)
    avatar_color: Optional[str] = None
    avatar_icon: Optional[str] = None


@api_router.get("/me")
async def me(member: dict = Depends(current_member)):
    g = games.active_game_for(member["user_id"])
    room = await db.rooms.find_one({"seats": member["user_id"], "status": "lobby"}, {"_id": 0, "code": 1})
    return {**public_user(member), "email": member.get("email"), "role": member["role"],
            "active_game_id": g["id"] if g else None, "lobby_code": room["code"] if room else None,
            "avatar_colors": AVATAR_COLORS, "avatar_icons": AVATAR_ICONS}


@api_router.patch("/me")
async def update_me(body: ProfileIn, member: dict = Depends(current_member)):
    upd = {}
    if body.username is not None:
        if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", body.username):
            raise HTTPException(400, "Username may use letters, numbers and underscore (3-20)")
        clash = await db.users.find_one({"username_lower": body.username.lower(), "user_id": {"$ne": member["user_id"]}})
        if clash:
            raise HTTPException(409, "That username is taken")
        upd.update(username=body.username, username_lower=body.username.lower())
    if body.avatar_color is not None:
        if body.avatar_color not in AVATAR_COLORS:
            raise HTTPException(400, "Invalid colour")
        upd["avatar_color"] = body.avatar_color
    if body.avatar_icon is not None:
        if body.avatar_icon not in AVATAR_ICONS:
            raise HTTPException(400, "Invalid avatar")
        upd["avatar_icon"] = body.avatar_icon
    if upd:
        await db.users.update_one({"user_id": member["user_id"]}, {"$set": upd})
    return await me(await current_member_by_id(member["user_id"]))


async def current_member_by_id(uid):
    m = await db.users.find_one({"user_id": uid}, {"_id": 0})
    return {**m, "role": effective_role(m.get("role"))}


@api_router.get("/users/search")
async def search_users(q: str = Query(..., min_length=1, max_length=20), member: dict = Depends(player)):
    docs = await db.users.find({"username_lower": {"$regex": "^" + re.escape(q.lower())}, "user_id": {"$ne": member["user_id"]}},
                               {"_id": 0}).limit(10).to_list(10)
    return [public_user(d) for d in docs]


@api_router.get("/users/{username}")
async def profile(username: str, member: dict = Depends(player)):
    u = await db.users.find_one({"username_lower": username.lower()}, {"_id": 0})
    if not u:
        raise HTTPException(404, "Player not found")
    uid = u["user_id"]
    friend = await db.friends.find_one({"user_id": member["user_id"], "friend_id": uid})
    pending = await db.friend_requests.find_one({"status": "pending", "$or": [
        {"from_id": member["user_id"], "to_id": uid}, {"from_id": uid, "to_id": member["user_id"]}]}, {"_id": 0})
    recent = await db.matches.find({"player_ids": uid}, {"_id": 0}).sort("finished_at", -1).limit(5).to_list(5)
    return {**public_user(u), "is_me": uid == member["user_id"], "is_friend": bool(friend),
            "pending_request": pending, "recent_matches": recent}


# ---------------- friends ----------------
class FriendRequestIn(BaseModel):
    username: str = Field(..., min_length=3, max_length=20)


@api_router.get("/friends")
async def list_friends(member: dict = Depends(player)):
    ids = [f["friend_id"] async for f in db.friends.find({"user_id": member["user_id"]}, {"_id": 0})]
    users = await users_by_ids(ids)
    out = [public_user(u) for u in users.values()]
    return sorted(out, key=lambda u: (not u["online"], (u["username"] or "").lower()))


@api_router.get("/friends/requests")
async def friend_requests(member: dict = Depends(player)):
    uid = member["user_id"]
    incoming = await db.friend_requests.find({"to_id": uid, "status": "pending"}, {"_id": 0}).to_list(100)
    outgoing = await db.friend_requests.find({"from_id": uid, "status": "pending"}, {"_id": 0}).to_list(100)
    users = await users_by_ids([r["from_id"] for r in incoming] + [r["to_id"] for r in outgoing])
    return {"incoming": [{**r, "user": public_user(users[r["from_id"]])} for r in incoming if r["from_id"] in users],
            "outgoing": [{**r, "user": public_user(users[r["to_id"]])} for r in outgoing if r["to_id"] in users]}


@api_router.post("/friends/requests")
async def send_friend_request(body: FriendRequestIn, member: dict = Depends(player)):
    uid = member["user_id"]
    target = await db.users.find_one({"username_lower": body.username.lower()}, {"_id": 0})
    if not target or target["user_id"] == uid:
        raise HTTPException(404, "Player not found")
    tid = target["user_id"]
    if await db.friends.find_one({"user_id": uid, "friend_id": tid}):
        raise HTTPException(409, "Already friends")
    reverse = await db.friend_requests.find_one({"from_id": tid, "to_id": uid, "status": "pending"}, {"_id": 0})
    if reverse:
        return await respond_request(reverse["id"], "accept", member)
    if await db.friend_requests.find_one({"from_id": uid, "to_id": tid, "status": "pending"}):
        raise HTTPException(409, "Request already sent")
    req = {"id": str(uuid.uuid4()), "from_id": uid, "to_id": tid, "status": "pending", "created_at": now_iso()}
    await db.friend_requests.insert_one(dict(req))
    await hub.send(tid, {"type": "friend_request", "from": member["username"]})
    return {"ok": True, "status": "sent"}


@api_router.post("/friends/requests/{req_id}/{action}")
async def respond_request(req_id: str, action: str, member: dict = Depends(player)):
    if action not in ("accept", "decline"):
        raise HTTPException(400, "Invalid action")
    req = await db.friend_requests.find_one({"id": req_id, "to_id": member["user_id"], "status": "pending"}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    await db.friend_requests.update_one({"id": req_id}, {"$set": {"status": "accepted" if action == "accept" else "declined"}})
    if action == "accept":
        for a, b in ((req["from_id"], req["to_id"]), (req["to_id"], req["from_id"])):
            await db.friends.update_one({"user_id": a, "friend_id": b}, {"$setOnInsert": {"user_id": a, "friend_id": b, "since": now_iso()}}, upsert=True)
        await hub.send(req["from_id"], {"type": "friend_accepted", "by": member["username"]})
    return {"ok": True, "status": "accepted" if action == "accept" else "declined"}


@api_router.delete("/friends/{friend_id}")
async def remove_friend(friend_id: str, member: dict = Depends(player)):
    await db.friends.delete_many({"$or": [{"user_id": member["user_id"], "friend_id": friend_id},
                                          {"user_id": friend_id, "friend_id": member["user_id"]}]})
    return {"ok": True}


# ---------------- rooms ----------------
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class RoomCreateIn(BaseModel):
    target: int = Field(7, ge=1, le=99)


class RoomSettingsIn(BaseModel):
    target: Optional[int] = Field(None, ge=1, le=99)
    dealer_seat: Optional[int] = Field(None, ge=0, le=3)


class SeatsIn(BaseModel):
    seats: List[Optional[str]] = Field(..., min_length=4, max_length=4)


class ReadyIn(BaseModel):
    ready: bool


class InviteIn(BaseModel):
    user_id: str


async def new_code():
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if not await db.rooms.find_one({"code": code}):
            return code


def bot_user(bid, b):
    return {"user_id": bid, "username": b["username"], "avatar_color": b["avatar_color"], "avatar_icon": b["avatar_icon"],
            "online": True, "is_bot": True, "last_seen": None, "stats": dict(EMPTY_STATS), "created_at": None}


async def room_view(room):
    users = await users_by_ids(room["seats"])
    bots = room.get("bots") or {}
    return {"code": room["code"], "host_id": room.get("host_id"), "is_public": room.get("is_public", False),
            "status": room["status"], "target": room["target"], "dealer_seat": room["dealer_seat"],
            "game_id": room.get("game_id"), "ready": {**room.get("ready", {}), **{b: True for b in bots}},
            "seats": [bot_user(u, bots[u]) if u in bots else public_user(users[u]) if u in users else None for u in room["seats"]]}


async def broadcast_room(room):
    view = await room_view(room)
    await hub.send_many(room["seats"], {"type": "room_update", "room": view})
    return view


async def get_member_room(code, uid):
    room = await db.rooms.find_one({"code": code.upper()}, {"_id": 0})
    if not room or uid not in room["seats"]:
        raise HTTPException(404, "Room not found")
    return room


async def ensure_free(uid):
    if games.active_game_for(uid):
        raise HTTPException(409, "You are already in an active game")
    if uid in mm_queue:
        mm_queue.remove(uid)


@api_router.post("/rooms")
async def create_room(body: RoomCreateIn, member: dict = Depends(player)):
    uid = member["user_id"]
    await ensure_free(uid)
    await leave_all_lobbies(uid)
    room = {"code": await new_code(), "host_id": uid, "is_public": False, "status": "lobby", "target": body.target,
            "dealer_seat": 0, "seats": [uid, None, None, None], "ready": {}, "created_at": now_iso()}
    await db.rooms.insert_one(dict(room))
    return await room_view(room)


@api_router.get("/rooms/{code}")
async def get_room(code: str, member: dict = Depends(player)):
    return await room_view(await get_member_room(code, member["user_id"]))


@api_router.post("/rooms/{code}/join")
async def join_room(code: str, member: dict = Depends(player)):
    uid = member["user_id"]
    room = await db.rooms.find_one({"code": code.upper()}, {"_id": 0})
    if not room or room.get("is_public"):
        raise HTTPException(404, "No room with that invite code")
    if uid in room["seats"]:
        return await room_view(room)
    if room["status"] != "lobby":
        raise HTTPException(409, "That game has already started")
    await ensure_free(uid)
    await leave_all_lobbies(uid)
    room = await db.rooms.find_one_and_update(
        {"code": room["code"], "status": "lobby", "seats": None},
        {"$set": {"seats.$": uid}}, projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if not room:
        raise HTTPException(409, "Room is full")
    await db.invitations.update_many({"to_id": uid, "room_code": room["code"]}, {"$set": {"status": "accepted"}})
    return await broadcast_room(room)


async def leave_all_lobbies(uid):
    async for room in db.rooms.find({"seats": uid, "status": "lobby"}, {"_id": 0}):
        await _leave(room, uid)


async def _dissolve_public(room, removed):
    """A public lobby never runs short-handed: remaining players go back to the front of the queue."""
    res = await db.rooms.delete_one({"code": room["code"], "status": "lobby"})
    if res.deleted_count == 0:
        return
    keep = [s for s in room["seats"] if s and s not in removed and hub.online(s)]
    for u in reversed(keep):
        if u not in mm_queue:
            mm_queue.insert(0, u)
    await hub.send_many(keep, {"type": "requeued", "code": room["code"]})
    await hub.send_many(list(removed), {"type": "room_left", "code": room["code"]})
    await _try_match()


async def _leave(room, uid):
    if room.get("is_public"):
        return await _dissolve_public(room, {uid})
    seats = [None if s == uid else s for s in room["seats"]]
    ready = {k: v for k, v in room.get("ready", {}).items() if k != uid}
    humans = [s for s in seats if s and s not in (room.get("bots") or {})]
    if not humans:
        await db.rooms.delete_one({"code": room["code"]})
        await hub.send(uid, {"type": "room_left", "code": room["code"]})
        return
    host = room.get("host_id")
    if host == uid and not room.get("is_public"):
        host = humans[0]
    await db.rooms.update_one({"code": room["code"]}, {"$set": {"seats": seats, "ready": ready, "host_id": host}})
    room.update(seats=seats, ready=ready, host_id=host)
    await broadcast_room(room)
    await hub.send(uid, {"type": "room_left", "code": room["code"]})


@api_router.post("/rooms/{code}/leave")
async def leave_room(code: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room["status"] != "lobby":
        raise HTTPException(409, "The game has started")
    await _leave(room, member["user_id"])
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
    upd["ready"] = {}
    await db.rooms.update_one({"code": room["code"]}, {"$set": upd})
    room.update(upd)
    return await broadcast_room(room)


@api_router.post("/rooms/{code}/seats")
async def arrange_seats(code: str, body: SeatsIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    _host_only(room, member["user_id"])
    if sorted(filter(None, body.seats)) != sorted(filter(None, room["seats"])):
        raise HTTPException(400, "Seats must contain exactly the players in the room")
    await db.rooms.update_one({"code": room["code"]}, {"$set": {"seats": body.seats, "ready": {}}})
    room.update(seats=body.seats, ready={})
    return await broadcast_room(room)


@api_router.post("/rooms/{code}/ready")
async def set_ready(code: str, body: ReadyIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room["status"] != "lobby":
        raise HTTPException(409, "The game has started")
    room = await db.rooms.find_one_and_update({"code": room["code"]}, {"$set": {f"ready.{member['user_id']}": body.ready}},
                                              projection={"_id": 0}, return_document=ReturnDocument.AFTER)
    if room.get("is_public") and _all_ready(room):
        return await _start(room)
    return await broadcast_room(room)


def _all_ready(room):
    bots = room.get("bots") or {}
    return all(room["seats"]) and all(u in bots or room.get("ready", {}).get(u) for u in room["seats"])


async def _start(room):
    claimed = await db.rooms.find_one_and_update({"code": room["code"], "status": "lobby"}, {"$set": {"status": "starting"}})
    if not claimed:
        raise HTTPException(409, "Game already starting")
    game = await games.create(room)
    await db.rooms.update_one({"code": room["code"]}, {"$set": {"status": "playing", "game_id": game["id"]}})
    room.update(status="playing", game_id=game["id"])
    view = await broadcast_room(room)
    await hub.send_many(room["seats"], {"type": "game_started", "game_id": game["id"], "room_code": room["code"]})
    await games.broadcast(game)
    games.kick_bots(game["id"])
    return view


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
    if None not in room["seats"]:
        raise HTTPException(409, "Room is full")
    bots = room.get("bots") or {}
    taken = {b["username"] for b in bots.values()}
    name = next(f"Bot {n}" for n in BOT_NAMES if f"Bot {n}" not in taken)
    bid = f"bot_{uuid.uuid4().hex[:12]}"
    seats = list(room["seats"])
    seats[seats.index(None)] = bid
    bots[bid] = {"username": name, "avatar_color": random.choice(AVATAR_COLORS), "avatar_icon": "bot"}
    await db.rooms.update_one({"code": room["code"], "status": "lobby"}, {"$set": {"seats": seats, "bots": bots}})
    room.update(seats=seats, bots=bots)
    return await broadcast_room(room)


@api_router.delete("/rooms/{code}/bots/{bot_id}")
async def remove_bot(code: str, bot_id: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    _host_only(room, member["user_id"])
    bots = room.get("bots") or {}
    if bot_id not in bots:
        raise HTTPException(404, "Bot not found")
    bots.pop(bot_id)
    seats = [None if s == bot_id else s for s in room["seats"]]
    await db.rooms.update_one({"code": room["code"]}, {"$set": {"seats": seats, "bots": bots}})
    room.update(seats=seats, bots=bots)
    return await broadcast_room(room)


@api_router.post("/rooms/{code}/invite")
async def invite(code: str, body: InviteIn, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    if room.get("is_public") or room["status"] != "lobby":
        raise HTTPException(409, "Invitations are only for private lobbies")
    if not await db.friends.find_one({"user_id": member["user_id"], "friend_id": body.user_id}):
        raise HTTPException(403, "You can only invite friends")
    if await db.invitations.find_one({"from_id": member["user_id"], "to_id": body.user_id, "room_code": room["code"], "status": "pending"}):
        raise HTTPException(409, "Already invited")
    inv = {"id": str(uuid.uuid4()), "from_id": member["user_id"], "from_username": member["username"],
           "to_id": body.user_id, "room_code": room["code"], "status": "pending", "created_at": now_iso()}
    await db.invitations.insert_one(dict(inv))
    await hub.send(body.user_id, {"type": "invitation", "invitation": {k: v for k, v in inv.items() if k != "_id"}})
    return {"ok": True}


@api_router.get("/invitations")
async def list_invitations(member: dict = Depends(player)):
    invs = await db.invitations.find({"to_id": member["user_id"], "status": "pending"}, {"_id": 0}).sort("created_at", -1).to_list(20)
    out = []
    for inv in invs:
        room = await db.rooms.find_one({"code": inv["room_code"], "status": "lobby"}, {"_id": 0, "seats": 1})
        if room:
            out.append({**inv, "open_seats": room["seats"].count(None)})
    return out


@api_router.post("/invitations/{inv_id}/decline")
async def decline_invitation(inv_id: str, member: dict = Depends(player)):
    await db.invitations.update_one({"id": inv_id, "to_id": member["user_id"]}, {"$set": {"status": "declined"}})
    return {"ok": True}


@api_router.get("/rooms/{code}/chat")
async def room_chat(code: str, member: dict = Depends(player)):
    room = await get_member_room(code, member["user_id"])
    msgs = await db.chat_messages.find({"room_code": room["code"]}, {"_id": 0}).sort("ts", -1).limit(60).to_list(60)
    return list(reversed(msgs))


# ---------------- matchmaking ----------------
mm_queue: list[str] = []
mm_lock = asyncio.Lock()


@api_router.post("/matchmaking/join")
async def mm_join(member: dict = Depends(player)):
    uid = member["user_id"]
    if games.active_game_for(uid):
        raise HTTPException(409, "You are already in an active game")
    await leave_all_lobbies(uid)
    async with mm_lock:
        if uid not in mm_queue:
            mm_queue.append(uid)
    code = await _try_match(uid)
    if code:
        return {"queued": False, "room_code": code}
    if uid not in mm_queue:
        return await mm_status(member)
    return {"queued": True, "position": mm_queue.index(uid) + 1, "waiting": len(mm_queue)}


READY_TIMEOUT = 60


async def _try_match(uid=None):
    async with mm_lock:
        if len(mm_queue) < 4:
            return None
        group = [mm_queue.pop(0) for _ in range(4)]
    random.SystemRandom().shuffle(group)
    room = {"code": await new_code(), "host_id": None, "is_public": True, "status": "lobby", "target": 7,
            "dealer_seat": secrets.randbelow(4), "seats": group, "ready": {}, "created_at": now_iso()}
    await db.rooms.insert_one(dict(room))
    await hub.send_many(group, {"type": "match_found", "code": room["code"], "ready_timeout": READY_TIMEOUT})
    asyncio.create_task(_ready_deadline(room["code"]))
    return room["code"] if uid in group else None


async def _ready_deadline(code):
    await asyncio.sleep(READY_TIMEOUT)
    room = await db.rooms.find_one({"code": code, "status": "lobby"}, {"_id": 0})
    if room:
        idle = {u for u in room["seats"] if u and not room.get("ready", {}).get(u)}
        await _dissolve_public(room, idle)


@api_router.get("/matchmaking/status")
async def mm_status(member: dict = Depends(player)):
    uid = member["user_id"]
    if uid in mm_queue:
        return {"queued": True, "position": mm_queue.index(uid) + 1, "waiting": len(mm_queue)}
    room = await db.rooms.find_one({"seats": uid, "status": "lobby", "is_public": True}, {"_id": 0, "code": 1})
    return {"queued": False, "room_code": room["code"] if room else None, "waiting": len(mm_queue)}


@api_router.post("/matchmaking/leave")
async def mm_leave(member: dict = Depends(player)):
    async with mm_lock:
        if member["user_id"] in mm_queue:
            mm_queue.remove(member["user_id"])
    return {"ok": True}


# ---------------- games, history, leaderboard ----------------
@api_router.get("/games/{game_id}")
async def get_game(game_id: str, member: dict = Depends(player)):
    game = await games.get(game_id)
    if not game or games.seat_of(game, member["user_id"]) is None:
        raise HTTPException(404, "Game not found")
    return games.view_for(game, member["user_id"])


@api_router.get("/matches")
async def match_history(username: Optional[str] = None, member: dict = Depends(player)):
    uid = member["user_id"]
    if username:
        u = await db.users.find_one({"username_lower": username.lower()}, {"_id": 0, "user_id": 1})
        if not u:
            raise HTTPException(404, "Player not found")
        uid = u["user_id"]
    return await db.matches.find({"player_ids": uid}, {"_id": 0}).sort("finished_at", -1).limit(50).to_list(50)


@api_router.get("/leaderboard")
async def leaderboard(member: dict = Depends(player)):
    docs = await db.users.find({"username": {"$ne": None}, **IN_ENV}, {"_id": 0}).sort(
        [("stats.wins", -1), ("stats.games_played", 1)]).limit(50).to_list(50)
    out = []
    for i, d in enumerate(docs):
        p = public_user(d)
        st = p["stats"]
        out.append({**p, "rank": i + 1, "win_rate": round(100 * st["wins"] / st["games_played"]) if st["games_played"] else 0})
    return out


# ---------------- admin ----------------
class RoleIn(BaseModel):
    role: str


@api_router.get("/users")
async def list_users(admin: dict = Depends(require_role("admin"))):
    people = await db.users.find(IN_ENV, {"_id": 0}).to_list(1000)
    return {"roles": [r for r in ROLES if RANK[r] <= RANK[admin["role"]]],
            "users": [{**public_user(p), "email": p.get("email"), "role": effective_role(p.get("role"))} for p in people]}


@api_router.patch("/users/{user_id}/role")
async def set_role(user_id: str, body: RoleIn, admin: dict = Depends(require_role("admin"))):
    if body.role not in ROLES or RANK[body.role] > RANK[admin["role"]]:
        raise HTTPException(status_code=403, detail="Not allowed")
    target = await db.users.find_one({"user_id": user_id, **IN_ENV}, {"_id": 0})
    if target is None:
        raise HTTPException(status_code=404, detail="Not found")
    if (effective_role(target.get("role")) == "admin" and body.role != "admin"
            and await db.users.count_documents({"role": "admin", **IN_ENV}) <= 1):
        raise HTTPException(status_code=409, detail="Keep at least one admin")
    await db.users.update_one({"user_id": user_id}, {"$set": {"role": body.role}})
    return {"user_id": user_id, "role": body.role}


@api_router.get("/admin/stats")
async def admin_stats(admin: dict = Depends(require_role("admin"))):
    return {"users": await db.users.count_documents(IN_ENV), "online": len(hub.sockets),
            "active_games": len(games.games), "matches": await db.matches.count_documents({}),
            "queue": len(mm_queue), "open_lobbies": await db.rooms.count_documents({"status": "lobby"})}


@api_router.get("/")
async def root():
    return {"message": "Dehla Pakad API"}


# ---------------- websocket ----------------
async def notify_presence(uid):
    friends = [f["friend_id"] async for f in db.friends.find({"user_id": uid}, {"_id": 0})]
    await hub.send_many(friends, {"type": "presence", "user_id": uid, "online": hub.online(uid)})
    g = games.active_game_for(uid)
    if g:
        await games.broadcast(g)


async def handle_social(uid, msg):
    code = str(msg.get("room_code", "")).upper()
    room = await db.rooms.find_one({"code": code, "seats": uid}, {"_id": 0, "seats": 1})
    if not room:
        return {"type": "error", "message": "Room not found"}
    u = await db.users.find_one({"user_id": uid}, {"_id": 0, "username": 1})
    if msg["type"] == "chat":
        text = str(msg.get("text", "")).strip()[:300]
        if not text:
            return None
        doc = {"id": str(uuid.uuid4()), "room_code": code, "user_id": uid, "username": u["username"], "text": text, "ts": now_iso()}
        await db.chat_messages.insert_one(dict(doc))
        await hub.send_many(room["seats"], {"type": "chat", "message": doc})
    else:
        emoji = str(msg.get("emoji", ""))
        if emoji not in EMOJIS:
            return {"type": "error", "message": "Unknown reaction"}
        await hub.send_many(room["seats"], {"type": "reaction", "room_code": code, "user_id": uid, "emoji": emoji})
    return None


@app.websocket("/api/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    # The app sends its token in the first message (kept out of access logs); ?token= is accepted for scripts.
    await ws.accept()
    try:
        if not token:
            first = await asyncio.wait_for(ws.receive_json(), timeout=10)
            token = str(first.get("token", "")) if isinstance(first, dict) else ""
        claims = await run_in_threadpool(verify_session_token, token)
    except (HTTPException, asyncio.TimeoutError, WebSocketDisconnect, ValueError, RuntimeError):
        with suppress(Exception):
            await ws.close(code=4401)
        return
    uid = claims["sub"]
    user = await db.users.find_one({"user_id": uid}, {"_id": 0, "username": 1})
    if not user or not user.get("username"):
        await ws.close(code=4428)
        return
    if hub.add(uid, ws):
        await db.users.update_one({"user_id": uid}, {"$set": {"last_seen": now_iso()}})
        await notify_presence(uid)
    try:
        g = games.active_game_for(uid)
        await ws.send_json({"type": "hello", "active_game_id": g["id"] if g else None})
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            if not hub.allow(uid):
                await ws.send_json({"type": "error", "message": "Slow down"})
                continue
            kind = msg.get("type")
            reply = None
            if kind == "ping":
                reply = {"type": "pong"}
            elif kind == "sync_game":
                game = await games.get(str(msg.get("game_id", "")))
                reply = games.view_for(game, uid) if game and games.seat_of(game, uid) is not None else {"type": "error", "message": "Game not found"}
            elif kind == "game_action":
                reply = await games.handle(uid, msg)
            elif kind in ("chat", "reaction"):
                reply = await handle_social(uid, msg)
            if reply:
                await ws.send_json(reply)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        if hub.remove(uid, ws):
            if uid in mm_queue:
                mm_queue.remove(uid)
            await db.users.update_one({"user_id": uid}, {"$set": {"last_seen": now_iso()}})
            await notify_presence(uid)


app.include_router(api_router)
app.include_router(clerk_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    for old, new in RETIRED_ROLES.items():
        await db.users.update_many({"role": old}, {"$set": {"role": new}})
    app.state.index_task = asyncio.create_task(ensure_indexes())
    await db.rooms.update_many({"status": "starting"}, {"$set": {"status": "lobby"}})
    await db.rooms.delete_many({"status": "lobby", "is_public": True})  # queue is in-memory; stale public lobbies cannot recover
    await games.load_active()


@app.on_event("shutdown")
async def shutdown_db_client():
    app.state.index_task.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.index_task
    client.close()
