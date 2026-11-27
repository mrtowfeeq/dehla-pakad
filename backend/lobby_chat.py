import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone


PRIVATE_LOBBY_CHANNEL = "private_lobby"
MAX_MESSAGE_LENGTH = 300
HISTORY_LIMIT = 60


class LobbyChatAccessError(Exception):
    pass


class LobbyChatRateLimiter:
    def __init__(self, limit=5, window=10.0, clock=time.monotonic):
        self.limit = limit
        self.window = window
        self.clock = clock
        self.message_times = defaultdict(list)

    def allow(self, user_id):
        now = self.clock()
        recent = [sent_at for sent_at in self.message_times[user_id] if now - sent_at < self.window]
        if len(recent) >= self.limit:
            self.message_times[user_id] = recent
            return False
        recent.append(now)
        self.message_times[user_id] = recent
        return True


def _room_code(value):
    return value.strip().upper() if isinstance(value, str) else ""


def existing_room_chat_filter(room_code, env=None):
    query = {"room_code": room_code, "channel": {"$ne": PRIVATE_LOBBY_CHANNEL}}
    if env is not None:
        query["env"] = env
    return query


async def _private_lobby_room(db, code, user_id, env=None):
    code = _room_code(code)
    if not code:
        return None
    room = await db.rooms.find_one(
        {"code": code, "status": "lobby", "seats": user_id, **({"env": env} if env is not None else {})},
        {"_id": 0},
    )
    if not room or room.get("is_public", False) is not False:
        return None
    return room


async def load_private_lobby_history(db, code, user_id, env=None):
    room = await _private_lobby_room(db, code, user_id, env)
    if not room:
        raise LobbyChatAccessError("Private lobby not found")

    cursor = db.chat_messages.find(
        {"room_code": room["code"], "channel": PRIVATE_LOBBY_CHANNEL,
         **({"env": env} if env is not None else {})},
        {"_id": 0},
    ).sort("ts", -1).limit(HISTORY_LIMIT)
    messages = await cursor.to_list(HISTORY_LIMIT)
    return list(reversed(messages))


def _chat_error(message):
    return {"type": "private_lobby_chat_error", "message": message}


async def send_private_lobby_message(db, hub, limiter, user_id, msg, env=None):
    room = await _private_lobby_room(db, msg.get("room_code"), user_id, env)
    if not room:
        return _chat_error("Private lobby not found")

    raw_text = msg.get("text")
    if not isinstance(raw_text, str):
        return _chat_error("Message must be text")
    if len(raw_text) > MAX_MESSAGE_LENGTH:
        return _chat_error(f"Messages are limited to {MAX_MESSAGE_LENGTH} characters")
    text = raw_text.strip()
    if not text:
        return None
    if not limiter.allow(user_id):
        return _chat_error("You're sending messages too quickly")

    user = await db.users.find_one({"user_id": user_id, **({"env": env} if env is not None else {})},
                                   {"_id": 0, "username": 1})
    if not user or not user.get("username"):
        return _chat_error("Unable to send message")

    message = {
        "id": str(uuid.uuid4()),
        "env": env,
        "room_code": room["code"],
        "channel": PRIVATE_LOBBY_CHANNEL,
        "user_id": user_id,
        "username": user["username"],
        "text": text,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    await db.chat_messages.insert_one(dict(message))
    await hub.send_many(room["seats"], {"type": "private_lobby_chat_message", "message": message})
    return None
