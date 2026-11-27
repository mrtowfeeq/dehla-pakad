"""Ephemeral, environment-scoped WebRTC signaling and presence for room voice."""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit

try:
    from backend.env_scope import scoped_query
    from backend.spectator import SpectatorAccessError, require_spectator_access
except ModuleNotFoundError:
    from env_scope import scoped_query
    from spectator import SpectatorAccessError, require_spectator_access


ROOM_CODE_RE = re.compile(r"^[A-Z0-9_-]{3,24}$")
AVATAR_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
AVATAR_ICONS = {"heart", "diamond", "club", "spade", "crown", "star", "flame", "gem", "bot"}
MAX_SIGNAL_BYTES = 16 * 1024
MAX_SDP_CHARS = 12 * 1024
MAX_CANDIDATE_CHARS = 2 * 1024
RATE_WINDOW_SECONDS = 10.0
RATE_LIMIT = 100
JOIN_RATE_LIMIT = 5
HARD_MAX_PARTICIPANTS = 8
STALE_AFTER_SECONDS = 90.0
logger = logging.getLogger(__name__)


def configured_participant_limit(value=None):
    """Default to four players plus two spectators; never permit an unbounded mesh."""
    raw = value if value is not None else os.environ.get("VOICE_MAX_PARTICIPANTS", "6")
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return 6
    return max(2, min(HARD_MAX_PARTICIPANTS, parsed))


def pair_connection_id(first, second):
    return "|".join(sorted((first, second)))


class VoiceService:
    """Tracks only live membership and forwards validated signaling; audio is never handled here."""

    def __init__(self, db, games, *, env, load_user, has_spectate_permission,
                 participant_limit=None, clock=time.monotonic, wall_clock=time.time,
                 stun_urls=None, turn_urls=None, turn_shared_secret=None, turn_ttl=600):
        self.db = db
        self.games = games
        self.env = env
        self.load_user = load_user
        self.has_spectate_permission = has_spectate_permission
        self.participant_limit = configured_participant_limit(participant_limit)
        self.clock = clock
        self.wall_clock = wall_clock
        self.stun_urls = self._urls(stun_urls if stun_urls is not None else os.environ.get(
            "VOICE_STUN_URLS", "stun:stun.l.google.com:19302"))
        self.turn_urls = self._urls(turn_urls if turn_urls is not None else os.environ.get("VOICE_TURN_URLS", ""))
        self.turn_shared_secret = turn_shared_secret if turn_shared_secret is not None else os.environ.get(
            "VOICE_TURN_SHARED_SECRET", "")
        try:
            self.turn_ttl = max(60, min(3600, int(turn_ttl if turn_ttl is not None else os.environ.get(
                "VOICE_TURN_CREDENTIAL_TTL_SECONDS", "600"))))
        except (TypeError, ValueError):
            self.turn_ttl = 600
        self.sessions = {}
        self.socket_index = {}
        self.user_index = {}
        self.socket_refs = {}
        self.identity_log_key = secrets.token_bytes(32)
        self.hits = defaultdict(list)
        # Join attempts have their own bucket: counting signaling (offers, ICE candidates, mute and
        # speaking updates) against the small join allowance blocked a legitimate leave-and-rejoin.
        self.join_hits = defaultdict(list)
        self.locks = defaultdict(asyncio.Lock)

    def _identity_ref(self, uid):
        """Create a process-local, non-reversible correlation key for lifecycle logs."""
        return hmac.new(self.identity_log_key, str(uid).encode("utf-8"), hashlib.sha256).hexdigest()[:20]

    def _socket_ref(self, ws):
        return self.socket_refs.setdefault(id(ws), str(uuid.uuid4()))

    def _log_member_lifecycle(self, event, session, uid, member, *, reason=None):
        record = {
            "event": event,
            "environment": self.env,
            "room_id": member.get("room_code"),
            "game_id": member.get("game_id"),
            "session_id": session.get("session_id"),
            "peer_id": member.get("peer_id"),
            "identity_ref": self._identity_ref(uid),
            "connection_ref": member.get("connection_ref"),
            "role": member.get("role"),
            "admin_spectator": bool(member.get("admin_spectator")),
            "active_member_count": len(session.get("members", {})),
            "reason": reason,
            "timestamp_ms": int(self.wall_clock() * 1000),
        }
        logger.info("voice_member_lifecycle %s", json.dumps(record, sort_keys=True, separators=(",", ":")))

    def _peer_identity_context(self, room_code, peer_id):
        if not isinstance(room_code, str) or not isinstance(peer_id, str):
            return None, None
        session = self.sessions.get(self._room_key(room_code))
        if not session:
            return None, None
        for uid, member in session["members"].items():
            if member.get("peer_id") == peer_id:
                return self._identity_ref(uid), member.get("connection_ref")
        return None, None

    @staticmethod
    def _urls(value):
        if isinstance(value, str):
            values = value.split(",")
        elif isinstance(value, (list, tuple)):
            values = value
        else:
            return []
        safe = []
        for value in values:
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > 300:
                continue
            url = value.strip()
            try:
                parsed = urlsplit(url)
                query_keys = {key.lower() for key, _ in parse_qsl(parsed.query, keep_blank_values=True)}
            except ValueError:
                continue
            if (parsed.scheme.lower() not in {"stun", "stuns", "turn", "turns"} or
                    "@" in parsed.netloc or "@" in parsed.path or parsed.fragment or
                    query_keys.difference({"transport"})):
                continue
            safe.append(url)
        return safe

    def _room_key(self, room_code):
        return f"{self.env}:{room_code}"

    def _rate_allowed(self, uid, *, joining=False):
        now = self.clock()
        buckets = self.join_hits if joining else self.hits
        recent = [stamp for stamp in buckets[uid] if now - stamp < RATE_WINDOW_SECONDS]
        limit = JOIN_RATE_LIMIT if joining else RATE_LIMIT
        if len(recent) >= limit:
            buckets[uid] = recent
            return False
        recent.append(now)
        buckets[uid] = recent
        if len(buckets) > 10000:
            pruned = defaultdict(list, {
                user: timestamps for user, timestamps in buckets.items()
                if timestamps and now - timestamps[-1] < RATE_WINDOW_SECONDS
            })
            if joining:
                self.join_hits = pruned
            else:
                self.hits = pruned
        return True

    async def _send(self, ws, payload):
        try:
            await ws.send_json(payload)
            return True
        except Exception:
            return False

    async def _error(self, ws, message="Voice request could not be completed", *, signal_id=None,
                     request_id=None):
        payload = {"type": "voice_error", "message": message}
        if isinstance(signal_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", signal_id):
            payload["signal_id"] = signal_id
        if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id):
            payload["request_id"] = request_id
        await self._send(ws, payload)

    def _log_signal(self, *, kind, msg, outcome, reason=None, room_code=None, game_id=None,
                    sender_id=None, recipient_id=None, sender_member_valid=None,
                    recipient_member_valid=None, active_session_id=None):
        """Emit correlation-safe signaling diagnostics without SDP or ICE contents."""
        signal_id = msg.get("signal_id") if isinstance(msg, dict) else None
        if not isinstance(signal_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", signal_id):
            signal_id = None
        created_at_ms = msg.get("created_at_ms") if isinstance(msg, dict) else None
        if not isinstance(created_at_ms, int) or isinstance(created_at_ms, bool) or not 0 <= created_at_ms <= 4_102_444_800_000:
            created_at_ms = None
        candidate_type = None
        candidate = msg.get("candidate") if isinstance(msg, dict) else None
        candidate_value = candidate.get("candidate") if isinstance(candidate, dict) else None
        if isinstance(candidate_value, str):
            if candidate_value == "":
                candidate_type = "end_of_candidates"
            else:
                match = re.search(r"\btyp\s+(host|srflx|relay|prflx)\b", candidate_value)
                candidate_type = match.group(1) if match else "unknown"
        sender_identity_ref, sender_connection_ref = self._peer_identity_context(room_code, sender_id)
        recipient_identity_ref, recipient_connection_ref = self._peer_identity_context(room_code, recipient_id)
        record = {
            "event_type": kind,
            "signal_id": signal_id,
            "room_id": room_code,
            "game_id": game_id,
            "session_id": msg.get("session_id") if isinstance(msg, dict) and
                isinstance(msg.get("session_id"), str) and len(msg["session_id"]) <= 80 else None,
            "active_session_id": active_session_id,
            "sender_id": sender_id,
            "recipient_id": recipient_id if isinstance(recipient_id, str) and len(recipient_id) <= 80 else None,
            "sender_identity_ref": sender_identity_ref,
            "recipient_identity_ref": recipient_identity_ref,
            "sender_connection_ref": sender_connection_ref,
            "recipient_connection_ref": recipient_connection_ref,
            "created_at_ms": created_at_ms,
            "received_at_ms": int(self.wall_clock() * 1000),
            "expires_at_ms": None,
            "candidate_type": candidate_type,
            "sender_membership_valid": sender_member_valid,
            "recipient_membership_valid": recipient_member_valid,
            "outcome": outcome,
            "rejection_reason": reason,
        }
        logger.info("voice_signal %s", json.dumps(record, sort_keys=True, separators=(",", ":")))

    @staticmethod
    def _public_member(member):
        return {
            "peer_id": member["peer_id"],
            "display_name": member["display_name"],
            "avatar_color": member.get("avatar_color"),
            "avatar_icon": member.get("avatar_icon"),
            "role": member["role"],
            "muted": bool(member["muted"]),
            "speaking": bool(member["speaking"]),
        }

    def _presence(self, session):
        return {"type": "voice_presence", "session_id": session["session_id"],
                "participants": [self._public_member(member) for member in session["members"].values()]}

    def _ice_servers(self):
        servers = []
        if self.stun_urls:
            servers.append({"urls": self.stun_urls})
        if self.turn_urls and self.turn_shared_secret:
            expiry = int(self.wall_clock()) + self.turn_ttl
            username = f"{expiry}:{secrets.token_urlsafe(12)}"
            credential = base64.b64encode(hmac.new(
                self.turn_shared_secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1
            ).digest()).decode("ascii")
            servers.append({"urls": self.turn_urls, "username": username, "credential": credential})
        return servers

    async def _room_and_game(self, *, room_code=None, game_id=None):
        if game_id is not None:
            if not isinstance(game_id, str) or not 1 <= len(game_id) <= 80:
                return None, None
            game = await self.games.get(game_id)
            if not game or game.get("status") != "active" or game.get("env") not in (None, self.env):
                return None, None
            room_code = game.get("room_code")
            if not isinstance(room_code, str) or not ROOM_CODE_RE.fullmatch(room_code.upper()):
                return None, None
            room = await self.db.rooms.find_one(scoped_query({"code": room_code.upper()}, self.env), {"_id": 0})
            if not room or room.get("status") != "playing" or room.get("game_id") != game_id:
                return None, None
            return room, game
        if not isinstance(room_code, str) or not ROOM_CODE_RE.fullmatch(room_code.upper()):
            return None, None
        room = await self.db.rooms.find_one(scoped_query({"code": room_code.upper()}, self.env), {"_id": 0})
        if not room or room.get("status") != "lobby":
            return None, None
        return room, None

    async def _authorize_request(self, uid, ws, *, room_code=None, game_id=None):
        user = await self.load_user(uid)
        if not user:
            return None
        room, game = await self._room_and_game(room_code=room_code, game_id=game_id)
        if not room:
            return None
        if uid in (room.get("seats") or []):
            if game is not None and self.games.seat_of(game, uid) is None:
                return None
            return {"room": room, "game": game, "role": "player", "user": user}
        if game is None or self.games.spectators.members.get(game["id"], {}).get(uid) is not ws:
            return None
        is_admin_spectator = self.games.spectators.is_admin(game["id"], uid)
        if is_admin_spectator:
            if not self.has_spectate_permission(user.get("role")):
                return None
            # Privileged spectator views still require the room's existing spectator setting.
            if not room.get("is_public") and not room.get("spectators_enabled"):
                return None
        else:
            try:
                await require_spectator_access(
                    self.db, game, uid, env=self.env,
                    now=datetime.fromtimestamp(self.wall_clock(), timezone.utc),
                    allow_previous_session=True,
                )
            except SpectatorAccessError:
                return None
        return {"room": room, "game": game, "role": "spectator", "user": user,
                "admin_spectator": is_admin_spectator}

    async def _authorize_existing(self, room_key, uid, member):
        user = await self.load_user(uid)
        if not user:
            return False
        room = await self.db.rooms.find_one(
            scoped_query({"code": member["room_code"]}, self.env),
            {"_id": 0, "code": 1, "status": 1, "seats": 1, "game_id": 1,
             "is_public": 1, "spectators_enabled": 1},
        )
        if not room:
            return False
        if member["role"] == "player":
            if uid not in (room.get("seats") or []):
                return False
            if room.get("status") in ("lobby", "starting"):
                return member.get("game_id") is None
            if room.get("status") != "playing" or not room.get("game_id"):
                return False
            game = await self.games.get(room["game_id"])
            return bool(game and game.get("status") == "active" and self.games.seat_of(game, uid) is not None)
        game_id = member.get("game_id")
        if (room.get("status") != "playing" or room.get("game_id") != game_id
                or self.games.spectators.members.get(game_id, {}).get(uid) is not member["ws"]):
            return False
        game = await self.games.get(game_id)
        if not game or game.get("status") != "active":
            return False
        if self.games.spectators.is_admin(game_id, uid):
            return bool(self.has_spectate_permission(user.get("role")) and
                        (room.get("is_public") or room.get("spectators_enabled")))
        try:
            await require_spectator_access(
                self.db, game, uid, env=self.env,
                now=datetime.fromtimestamp(self.wall_clock(), timezone.utc),
                allow_previous_session=True,
            )
            return True
        except SpectatorAccessError:
            return False

    async def _broadcast_presence(self, room_key):
        session = self.sessions.get(room_key)
        if not session:
            return
        payload = self._presence(session)
        await asyncio.gather(*(self._send(member["ws"], payload) for member in session["members"].values()))

    async def _remove_member(self, room_key, uid, expected_ws=None, *, notify=True, message=None,
                             reason="member_removed"):
        session = self.sessions.get(room_key)
        member = session and session["members"].get(uid)
        if not member or (expected_ws is not None and member["ws"] is not expected_ws):
            return False
        self._log_member_lifecycle("left", session, uid, member, reason=reason)
        session["members"].pop(uid, None)
        ws_key = id(member["ws"])
        if self.socket_index.get(ws_key) == (room_key, uid):
            self.socket_index.pop(ws_key, None)
        if self.socket_refs.get(ws_key) == member.get("connection_ref"):
            self.socket_refs.pop(ws_key, None)
        if self.user_index.get(uid) == (room_key, member["ws"]):
            self.user_index.pop(uid, None)
        if message:
            await self._send(member["ws"], {"type": "voice_left", "message": message,
                                            "session_id": session["session_id"],
                                            "peer_id": member["peer_id"]})
        for peer in list(session["members"].values()):
            if notify:
                await self._send(peer["ws"], {"type": "voice_peer_left", "session_id": session["session_id"],
                                               "peer_id": member["peer_id"]})
        if session["members"]:
            await self._broadcast_presence(room_key)
        else:
            self.sessions.pop(room_key, None)
        return True

    async def _remove_member_safely(self, room_key, uid, expected_ws=None, *, notify=True, message=None,
                                    reason="member_removed"):
        async with self.locks[room_key]:
            return await self._remove_member(
                room_key, uid, expected_ws, notify=notify, message=message, reason=reason)

    async def _join(self, uid, ws, msg):
        room_code, game_id = msg.get("room_code"), msg.get("game_id")
        request_id = msg.get("request_id")
        if (room_code is None) == (game_id is None):
            await self._error(ws, "Voice room is unavailable", request_id=request_id)
            return None
        context = await self._authorize_request(uid, ws, room_code=room_code, game_id=game_id)
        if not context:
            await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
            return None
        room = context["room"]
        room_key = self._room_key(room["code"])
        async with self.locks[room_key]:
            user = await self.load_user(uid)
            room = await self.db.rooms.find_one(
                scoped_query({"code": room["code"]}, self.env),
                {"_id": 0, "code": 1, "status": 1, "seats": 1, "game_id": 1,
                 "is_public": 1, "spectators_enabled": 1},
            )
            if not user or not room:
                await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
                return None
            if context["role"] == "player":
                if uid not in (room.get("seats") or []):
                    await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
                    return None
                if game_id is None and room.get("status") != "lobby":
                    await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
                    return None
                if game_id is not None and (room.get("status") != "playing" or room.get("game_id") != game_id):
                    await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
                    return None
            else:
                game = await self.db.games.find_one(
                    scoped_query({"id": game_id, "status": "active"}, self.env), {"_id": 0})
                if (not game or room.get("status") != "playing" or room.get("game_id") != game_id or
                        self.games.spectators.members.get(game_id, {}).get(uid) is not ws):
                    await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
                    return None
                if self.games.spectators.is_admin(game_id, uid):
                    if not self.has_spectate_permission(user.get("role")) or (
                            not room.get("is_public") and not room.get("spectators_enabled")):
                        await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
                        return None
                else:
                    try:
                        await require_spectator_access(
                            self.db, game, uid, env=self.env,
                            now=datetime.fromtimestamp(self.wall_clock(), timezone.utc),
                            allow_previous_session=True,
                        )
                    except SpectatorAccessError:
                        await self._error(ws, "You are not allowed to join voice for this room", request_id=request_id)
                        return None
            context["room"] = room
            context["user"] = user
            existing = self.sessions.get(room_key)
            same = existing and existing["members"].get(uid)
            if same and same["ws"] is ws:
                same["last_seen"] = self.clock()
                self._log_member_lifecycle("rejoined_same_socket", existing, uid, same)
                await self._send(ws, {
                    "type": "voice_joined", "session_id": existing["session_id"],
                    "self_peer_id": same["peer_id"],
                    "participants": [self._public_member(peer) for other_uid, peer in existing["members"].items()
                                     if other_uid != uid],
                    "ice_servers": self._ice_servers(),
                    **({"request_id": request_id} if request_id else {}),
                })
                return None
            if same:
                await self._remove_member(room_key, uid, same["ws"], message="Voice moved to another connection",
                                          reason="same_identity_reconnected_on_new_websocket")
            prior = self.user_index.get(uid)
            if prior and prior[0] != room_key:
                await self._remove_member(prior[0], uid, prior[1], message="Voice moved to another room",
                                          reason="same_identity_joined_another_room")
            session = self.sessions.get(room_key)
            if session and len(session["members"]) >= self.participant_limit:
                await self._error(ws, "This voice channel is full", request_id=request_id)
                return None
            if not session:
                session = {"session_id": str(uuid.uuid4()), "room_code": room["code"], "members": {}}
                self.sessions[room_key] = session
            user = context["user"]
            member = {
                "ws": ws,
                "peer_id": str(uuid.uuid4()),
                "room_code": room["code"],
                "game_id": context["game"].get("id") if context["game"] else None,
                "role": context["role"],
                "admin_spectator": bool(context.get("admin_spectator")),
                "display_name": str(user.get("display_name") or user.get("username") or "Player")[:60],
                "avatar_color": user.get("avatar_color") if isinstance(user.get("avatar_color"), str)
                and AVATAR_COLOR_RE.fullmatch(user["avatar_color"]) else None,
                "avatar_icon": user.get("avatar_icon") if user.get("avatar_icon") in AVATAR_ICONS else None,
                "muted": True,
                "speaking": False,
                "last_seen": self.clock(),
                "connection_ref": self._socket_ref(ws),
            }
            others = list(session["members"].values())
            session["members"][uid] = member
            self.socket_index[id(ws)] = (room_key, uid)
            self.user_index[uid] = (room_key, ws)
            self._log_member_lifecycle("joined", session, uid, member,
                                       reason="authorized_voice_join")
            await self._send(ws, {
                "type": "voice_joined", "session_id": session["session_id"],
                "self_peer_id": member["peer_id"],
                "participants": [self._public_member(peer) for peer in others],
                "ice_servers": self._ice_servers(),
                **({"request_id": request_id} if request_id else {}),
            })
            joined = {"type": "voice_peer_joined", "session_id": session["session_id"],
                      "participant": self._public_member(member)}
            await asyncio.gather(*(self._send(peer["ws"], joined) for peer in others))
            await self._broadcast_presence(room_key)
        return None

    @staticmethod
    def _signal_validation_reason(kind, msg, current_session_id):
        if not isinstance(msg, dict):
            return "message_not_object"
        required_fields = {"type", "session_id", "to_peer_id", "connection_id",
                           "candidate" if kind == "voice_ice_candidate" else "description"}
        optional_fields = {"signal_id", "created_at_ms"}
        if required_fields.difference(msg):
            return "required_field_missing"
        if set(msg).difference(required_fields | optional_fields):
            return "unexpected_fields"
        if "signal_id" in msg and (not isinstance(msg["signal_id"], str) or
                                    not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", msg["signal_id"])):
            return "invalid_signal_id"
        if "created_at_ms" in msg and (not isinstance(msg["created_at_ms"], int) or
                                       isinstance(msg["created_at_ms"], bool) or
                                       not 0 <= msg["created_at_ms"] <= 4_102_444_800_000):
            return "invalid_creation_timestamp"
        if msg.get("session_id") != current_session_id:
            return "session_id_mismatch"
        if not isinstance(msg.get("to_peer_id"), str) or not 1 <= len(msg["to_peer_id"]) <= 80:
            return "invalid_recipient_id"
        if not isinstance(msg.get("connection_id"), str) or not 1 <= len(msg["connection_id"]) <= 170:
            return "invalid_connection_id"
        try:
            if len(json.dumps(msg, separators=(",", ":"), ensure_ascii=True)) > MAX_SIGNAL_BYTES:
                return "signal_payload_too_large"
        except (TypeError, ValueError):
            return "signal_payload_not_serializable"
        if kind in ("voice_offer", "voice_answer"):
            description = msg.get("description")
            if not isinstance(description, dict):
                return "description_not_object"
            if not set(description).issubset({"type", "sdp"}):
                return "description_has_unexpected_fields"
            if description.get("type") != ("offer" if kind == "voice_offer" else "answer"):
                return "description_type_mismatch"
            sdp = description.get("sdp")
            if not isinstance(sdp, str):
                return "sdp_not_string"
            if not sdp:
                return "sdp_empty"
            if len(sdp) > MAX_SDP_CHARS:
                return "sdp_too_large"
            return None
        candidate = msg.get("candidate")
        if not isinstance(candidate, dict):
            return "candidate_not_object"
        if not set(candidate).issubset({"candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"}):
            return "candidate_has_unexpected_fields"
        value = candidate.get("candidate")
        mid = candidate.get("sdpMid")
        line = candidate.get("sdpMLineIndex")
        if not isinstance(value, str):
            return "candidate_value_invalid"
        if len(value) > MAX_CANDIDATE_CHARS:
            return "candidate_too_large"
        if mid is not None and (not isinstance(mid, str) or len(mid) > 128):
            return "candidate_mid_invalid"
        if line is not None and (not isinstance(line, int) or isinstance(line, bool) or not 0 <= line <= 32):
            return "candidate_line_invalid"
        username_fragment = candidate.get("usernameFragment")
        if username_fragment is not None and (not isinstance(username_fragment, str) or len(username_fragment) > 256):
            return "candidate_username_fragment_invalid"
        return None

    @staticmethod
    def _valid_signal(kind, msg):
        # Retained for callers/tests that use the legacy boolean validator.
        return VoiceService._signal_validation_reason(kind, msg, msg.get("session_id") if isinstance(msg, dict) else None) is None

    async def _signal(self, uid, ws, kind, msg):
        indexed = self.socket_index.get(id(ws))
        if not indexed:
            return await self._signal_locked(uid, ws, kind, msg)
        async with self.locks[indexed[0]]:
            return await self._signal_locked(uid, ws, kind, msg)

    async def _signal_locked(self, uid, ws, kind, msg):
        signal_id = msg.get("signal_id") if isinstance(msg, dict) else None
        indexed = self.socket_index.get(id(ws))
        if not indexed or indexed[1] != uid:
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="sender_not_in_voice_session",
                             sender_member_valid=False, recipient_member_valid=None)
            await self._error(ws, "Join voice before signaling", signal_id=signal_id)
            return None
        room_key, _ = indexed
        session = self.sessions.get(room_key)
        member = session and session["members"].get(uid)
        if not session or not member or member["ws"] is not ws:
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="sender_membership_missing",
                             sender_member_valid=False, recipient_member_valid=None)
            await self._error(ws, "Join voice before signaling", signal_id=signal_id)
            return None
        if not await self._authorize_existing(room_key, uid, member):
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="sender_membership_invalid",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member.get("peer_id"), sender_member_valid=False,
                             active_session_id=session.get("session_id"))
            await self._remove_member(room_key, uid, ws, message="Voice access is no longer available",
                                      reason="sender_authorization_revoked")
            return None
        member["last_seen"] = self.clock()
        target_id = msg.get("to_peer_id") if isinstance(msg, dict) else None
        validation_reason = self._signal_validation_reason(kind, msg, session["session_id"])
        if validation_reason:
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason=validation_reason,
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target_id,
                             sender_member_valid=True, recipient_member_valid=None,
                             active_session_id=session["session_id"])
            await self._error(ws, "Invalid or expired voice signal",
                              signal_id=msg.get("signal_id") if isinstance(msg, dict) else None)
            return None
        target_entry = next(((target_uid, peer) for target_uid, peer in session["members"].items()
                             if peer["peer_id"] == target_id), None)
        if not target_entry or target_entry[1]["ws"] is ws or not isinstance(target_id, str):
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="recipient_not_in_same_session",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target_id,
                             sender_member_valid=True, recipient_member_valid=False,
                             active_session_id=session["session_id"])
            await self._error(ws, "Voice recipient is not connected", signal_id=signal_id)
            return None
        target_uid, target = target_entry
        if not await self._authorize_existing(room_key, target_uid, target):
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="recipient_membership_invalid",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target["peer_id"],
                             sender_member_valid=True, recipient_member_valid=False,
                             active_session_id=session["session_id"])
            await self._remove_member(room_key, target_uid, target["ws"],
                                      message="Voice access is no longer available",
                                      reason="recipient_authorization_revoked")
            await self._error(ws, "Voice recipient is no longer connected", signal_id=signal_id)
            return None
        expected_connection_id = pair_connection_id(member["peer_id"], target["peer_id"])
        if msg.get("connection_id") != expected_connection_id:
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="connection_id_mismatch",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target["peer_id"],
                             sender_member_valid=True, recipient_member_valid=True,
                             active_session_id=session["session_id"])
            await self._error(ws, "Invalid or expired voice connection", signal_id=signal_id)
            return None
        if kind == "voice_offer" and member["peer_id"] > target["peer_id"]:
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="offer_from_non_initiator",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target["peer_id"],
                             sender_member_valid=True, recipient_member_valid=True,
                             active_session_id=session["session_id"])
            await self._error(ws, "Invalid voice negotiation order", signal_id=signal_id)
            return None
        if kind == "voice_answer" and member["peer_id"] < target["peer_id"]:
            self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="answer_from_non_responder",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target["peer_id"],
                             sender_member_valid=True, recipient_member_valid=True,
                             active_session_id=session["session_id"])
            await self._error(ws, "Invalid voice negotiation order", signal_id=signal_id)
            return None
        self._log_signal(kind=kind, msg=msg, outcome="accepted", room_code=member.get("room_code"),
                         game_id=member.get("game_id"), sender_id=member["peer_id"],
                         recipient_id=target["peer_id"], sender_member_valid=True,
                         recipient_member_valid=True, active_session_id=session["session_id"])
        signal = {"type": kind, "session_id": session["session_id"],
                  "from_peer_id": member["peer_id"], "connection_id": expected_connection_id}
        if msg.get("signal_id") is not None:
            signal["signal_id"] = msg["signal_id"]
        if msg.get("created_at_ms") is not None:
            signal["created_at_ms"] = msg["created_at_ms"]
        signal["description" if kind != "voice_ice_candidate" else "candidate"] = msg[
            "description" if kind != "voice_ice_candidate" else "candidate"]
        delivered = await self._send(target["ws"], signal)
        if not delivered:
            self._log_signal(kind=kind, msg=msg, outcome="delivery_failed", reason="recipient_socket_send_failed",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target["peer_id"],
                             sender_member_valid=True, recipient_member_valid=True,
                             active_session_id=session["session_id"])
            await self._remove_member(room_key, next(uid2 for uid2, peer in session["members"].items()
                                                     if peer is target), target["ws"],
                                      message="Voice connection was interrupted",
                                      reason="recipient_socket_delivery_failed")
        else:
            self._log_signal(kind=kind, msg=msg, outcome="delivered_to_recipient_socket",
                             room_code=member.get("room_code"), game_id=member.get("game_id"),
                             sender_id=member["peer_id"], recipient_id=target["peer_id"],
                             sender_member_valid=True, recipient_member_valid=True,
                             active_session_id=session["session_id"])
        return None

    async def _presence_change(self, uid, ws, msg, *, muted=None, speaking=None):
        indexed = self.socket_index.get(id(ws))
        if not indexed:
            return await self._presence_change_locked(uid, ws, msg, muted=muted, speaking=speaking)
        async with self.locks[indexed[0]]:
            return await self._presence_change_locked(uid, ws, msg, muted=muted, speaking=speaking)

    async def _presence_change_locked(self, uid, ws, msg, *, muted=None, speaking=None):
        indexed = self.socket_index.get(id(ws))
        if not indexed or indexed[1] != uid:
            await self._error(ws, "Join voice before changing voice presence")
            return None
        room_key = indexed[0]
        session = self.sessions.get(room_key)
        member = session and session["members"].get(uid)
        if not member or member["ws"] is not ws:
            await self._error(ws, "Join voice before changing voice presence")
            return None
        if not await self._authorize_existing(room_key, uid, member):
            await self._remove_member(room_key, uid, ws, message="Voice access is no longer available",
                                      reason="presence_authorization_revoked")
            return None
        member["last_seen"] = self.clock()
        expected_fields = {"type", "session_id", "muted"} if muted is not None else {"type", "session_id", "speaking"}
        if set(msg) != expected_fields:
            await self._error(ws, "Invalid voice presence update")
            return None
        if msg.get("session_id") != session["session_id"]:
            await self._error(ws, "Invalid or expired voice session")
            return None
        if muted is not None:
            member["muted"] = muted
        if speaking is not None:
            member["speaking"] = bool(speaking) and not member["muted"]
        await self._broadcast_presence(room_key)
        return None

    async def handle(self, uid, ws, msg):
        kind = msg.get("type")
        try:
            if len(json.dumps(msg, separators=(",", ":"), ensure_ascii=True)) > MAX_SIGNAL_BYTES:
                signal_id = msg.get("signal_id") if isinstance(msg, dict) else None
                if kind in ("voice_offer", "voice_answer", "voice_ice_candidate"):
                    indexed = self.socket_index.get(id(ws))
                    session = self.sessions.get(indexed[0]) if indexed else None
                    member = session and session["members"].get(uid)
                    self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="signal_payload_too_large",
                                     room_code=member.get("room_code") if member else None,
                                     game_id=member.get("game_id") if member else None,
                                     sender_id=member.get("peer_id") if member else None,
                                     recipient_id=msg.get("to_peer_id") if isinstance(msg, dict) else None,
                                     sender_member_valid=bool(member and member.get("ws") is ws),
                                     recipient_member_valid=None)
                    await self._error(ws, "Invalid or expired voice signal", signal_id=signal_id)
                else:
                    await self._error(ws, "Voice payload is too large")
                return None
        except (TypeError, ValueError):
            await self._error(ws, "Invalid voice request")
            return None
        if kind == "voice_join":
            request_id = msg.get("request_id")
            if request_id is not None and (not isinstance(request_id, str) or
                                           not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id)):
                await self._error(ws, "Invalid voice room")
                return None
            if not self._rate_allowed(uid, joining=True):
                await self._error(ws, "Too many voice join attempts", request_id=request_id)
                return None
            if set(msg) - {"request_id"} not in ({"type", "room_code"}, {"type", "game_id"}):
                await self._error(ws, "Invalid voice room", request_id=request_id)
                return None
            return await self._join(uid, ws, msg)
        if kind == "voice_leave":
            # Leaving only releases state, so it is never refused by the signaling rate limit;
            # otherwise a busy session could leave a stale membership behind on the server.
            return await self._leave(uid, ws, msg)
        if not self._rate_allowed(uid):
            if kind in ("voice_offer", "voice_answer", "voice_ice_candidate"):
                indexed = self.socket_index.get(id(ws))
                session = self.sessions.get(indexed[0]) if indexed else None
                member = session and session["members"].get(uid)
                self._log_signal(kind=kind, msg=msg, outcome="rejected", reason="rate_limit_exceeded",
                                 room_code=member.get("room_code") if member else None,
                                 game_id=member.get("game_id") if member else None,
                                 sender_id=member.get("peer_id") if member else None,
                                 recipient_id=msg.get("to_peer_id"),
                                 sender_member_valid=bool(member and member.get("ws") is ws),
                                 recipient_member_valid=None)
                await self._error(ws, "Voice signaling rate limit exceeded", signal_id=msg.get("signal_id"))
                return None
            await self._error(ws, "Voice signaling rate limit exceeded")
            return None
        if kind in ("voice_offer", "voice_answer", "voice_ice_candidate"):
            return await self._signal(uid, ws, kind, msg)
        if kind == "voice_mute_changed":
            muted = msg.get("muted")
            if not isinstance(muted, bool) or set(msg) != {"type", "session_id", "muted"}:
                await self._error(ws, "Invalid microphone state")
                return None
            return await self._presence_change(uid, ws, msg, muted=muted)
        if kind == "voice_speaking_changed":
            speaking = msg.get("speaking")
            if not isinstance(speaking, bool) or set(msg) != {"type", "session_id", "speaking"}:
                await self._error(ws, "Invalid speaking state")
                return None
            return await self._presence_change(uid, ws, msg, speaking=speaking)
        await self._error(ws, "Unknown voice event")
        return None

    async def _leave(self, uid, ws, msg):
        if set(msg) - {"type", "session_id"}:
            await self._error(ws, "Invalid voice leave request")
            return None
        reply = {"type": "voice_left"}
        indexed = self.socket_index.get(id(ws))
        if indexed and indexed[1] == uid:
            async with self.locks[indexed[0]]:
                session = self.sessions.get(indexed[0])
                if msg.get("session_id") is not None and (
                        not session or msg.get("session_id") != session.get("session_id")):
                    await self._error(ws, "Invalid or expired voice session")
                    return None
                member = session and session["members"].get(uid)
                if member and member["ws"] is ws:
                    # Identify the membership that ended so a client that already started a
                    # new join can recognise this reply as belonging to the old one.
                    reply.update({"session_id": session["session_id"], "peer_id": member["peer_id"]})
                await self._remove_member(indexed[0], uid, ws, reason="explicit_voice_leave")
        await self._send(ws, reply)
        return None

    async def leave_socket(self, ws):
        indexed = self.socket_index.get(id(ws))
        if not indexed:
            return False
        return await self._remove_member_safely(indexed[0], indexed[1], ws, reason="websocket_disconnected")

    async def leave_user(self, uid):
        prior = self.user_index.get(uid)
        if not prior:
            return False
        return await self._remove_member_safely(
            prior[0], uid, prior[1], message="Voice ended because account access changed",
            reason="account_access_changed")

    async def leave_room_user(self, room_code, uid):
        room_key = self._room_key(str(room_code).upper())
        return await self._remove_member_safely(room_key, uid, reason="room_membership_ended")

    async def heartbeat(self, uid, ws):
        indexed = self.socket_index.get(id(ws))
        if indexed and indexed[1] == uid:
            session = self.sessions.get(indexed[0])
            member = session and session["members"].get(uid)
            if member and member["ws"] is ws:
                member["last_seen"] = self.clock()
        now = self.clock()
        for room_key, session in list(self.sessions.items()):
            for member_uid, member in list(session["members"].items()):
                if now - member.get("last_seen", now) > STALE_AFTER_SECONDS:
                    await self._remove_member_safely(
                        room_key, member_uid, member["ws"], message="Voice connection expired; rejoin to continue",
                        reason="voice_heartbeat_timeout")

    async def leave_spectator(self, game_id, uid, ws):
        indexed = self.socket_index.get(id(ws))
        if not indexed or indexed[1] != uid:
            return False
        session = self.sessions.get(indexed[0])
        member = session and session["members"].get(uid)
        if not member or member.get("role") != "spectator" or member.get("game_id") != game_id:
            return False
        return await self._remove_member_safely(indexed[0], uid, ws, reason="spectator_left")

    async def revoke_game_spectators(self, game_id):
        removed = 0
        for room_key, session in list(self.sessions.items()):
            for uid, member in list(session["members"].items()):
                if member.get("role") == "spectator" and member.get("game_id") == game_id:
                    removed += await self._remove_member_safely(
                        room_key, uid, member["ws"], message="Spectator voice access was revoked")
        return removed

    async def revoke_invited_spectators(self, game_id):
        removed = 0
        for room_key, session in list(self.sessions.items()):
            for uid, member in list(session["members"].items()):
                if (member.get("role") == "spectator" and member.get("game_id") == game_id
                        and not self.games.spectators.is_admin(game_id, uid)):
                    removed += await self._remove_member_safely(
                        room_key, uid, member["ws"], message="Spectator voice access was revoked")
        return removed

    async def revoke_admin_user(self, uid):
        removed = 0
        for room_key, session in list(self.sessions.items()):
            member = session["members"].get(uid)
            if member and member.get("admin_spectator"):
                removed += await self._remove_member_safely(
                    room_key, uid, member["ws"], message="Administrator spectator voice access ended")
        return removed

    async def close_room(self, room_code, message="This voice channel has ended", *, reason="room_closed"):
        room_key = self._room_key(str(room_code).upper())
        async with self.locks[room_key]:
            session = self.sessions.get(room_key)
            if not session:
                return 0
            count = len(session["members"])
            for uid, member in list(session["members"].items()):
                await self._remove_member(room_key, uid, member["ws"], notify=False, message=message,
                                          reason=reason)
            self.sessions.pop(room_key, None)
            return count

    async def close_game(self, game_id, room_code):
        # Voice lives for the room/game as one channel and ends when its match ends.
        return await self.close_room(room_code, "Voice ended because the match ended", reason="game_ended")

    async def close_all(self):
        for session in list(self.sessions.values()):
            for uid, member in list(session["members"].items()):
                await self._remove_member(self._room_key(session["room_code"]), uid, member["ws"],
                                          notify=False, message="Voice service is shutting down",
                                          reason="service_shutdown")
        self.sessions.clear()
        self.socket_index.clear()
        self.user_index.clear()
        self.socket_refs.clear()
        self.hits.clear()
        self.join_hits.clear()
