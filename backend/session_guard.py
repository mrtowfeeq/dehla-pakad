"""One active Clerk session per user account, enforced server-side.

The newest Clerk session (by Clerk's own `created_at`) wins. The active session id per user lives in
the `user_sessions` collection; an in-process cache keeps the common case (the active session making
another request) free of extra database reads and Clerk API calls.

A request from an older session is rejected with `SessionReplaced`. When a newer session takes over,
the previous one is revoked at Clerk (best effort) and `on_replaced` lets the server close its sockets.
"""
import asyncio
import logging
import time
from collections import OrderedDict

from pymongo.errors import DuplicateKeyError

log = logging.getLogger("dehla.sessions")

SESSION_REPLACED_CODE = "session_replaced"
SESSION_REPLACED_MESSAGE = "Your account was logged in on another device."


class SessionReplaced(Exception):
    """The presented Clerk session is no longer this account's active session."""


class SessionInvalid(Exception):
    """Clerk reports the session as unknown, not active, or owned by another user."""


class SessionUnavailable(Exception):
    """The session could not be verified right now (Clerk or the database is unreachable)."""


class SessionGuard:
    def __init__(self, db, env, *, fetch_session, revoke_session, on_replaced=None,
                 clock=time.monotonic, cache_ttl=15.0, info_cache_size=10000, max_attempts=5):
        self.db = db
        self.env = env
        self.fetch_session = fetch_session        # async (sid) -> {"user_id", "status", "created_at"}
        self.revoke_session = revoke_session      # async (sid) -> None
        self.on_replaced = on_replaced            # async (uid, old_sid, new_sid) -> None
        self.clock = clock
        self.cache_ttl = cache_ttl
        self.max_attempts = max_attempts
        self._active = {}                         # uid -> (sid, created_at, cached_at)
        self._info = OrderedDict()                # sid -> session info (created_at never changes)
        self._info_cache_size = info_cache_size
        self._locks = {}
        self._background = set()

    def _query(self, uid):
        query = {"user_id": uid}
        if self.env is not None:
            query["env"] = self.env
        return query

    def _cache(self, uid, sid, created_at):
        self._active[uid] = (sid, created_at, self.clock())

    def _cached(self, uid):
        entry = self._active.get(uid)
        if entry and self.clock() - entry[2] < self.cache_ttl:
            return entry
        return None

    def is_replaced(self, uid, sid):
        """Cheap check from memory only: True when this process knows a different session is active."""
        entry = self._active.get(uid)
        return bool(entry and sid and entry[0] != sid)

    async def _session_info(self, sid):
        if sid in self._info:
            self._info.move_to_end(sid)
            return self._info[sid]
        try:
            info = await self.fetch_session(sid)
        except (SessionInvalid, SessionUnavailable):
            raise
        except Exception as error:  # network errors, unexpected Clerk responses
            raise SessionUnavailable(type(error).__name__) from None
        if not isinstance(info, dict) or not isinstance(info.get("created_at"), (int, float)):
            raise SessionUnavailable("malformed session")
        self._info[sid] = info
        if len(self._info) > self._info_cache_size:
            self._info.popitem(last=False)
        return info

    def _spawn(self, coro):
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    async def _revoke_quietly(self, sid):
        try:
            await self.revoke_session(sid)
        except Exception:
            # Our own check already blocks the session; Clerk revocation only speeds up its sign-out.
            log.warning("could not revoke a replaced Clerk session")

    async def check(self, uid, sid):
        """Allow the request, or raise SessionReplaced / SessionInvalid / SessionUnavailable."""
        if not uid or not sid:
            raise SessionInvalid("token has no session id")
        cached = self._cached(uid)
        if cached and cached[0] == sid:
            return
        lock = self._locks.setdefault(uid, asyncio.Lock())
        async with lock:
            await self._check_locked(uid, sid)

    async def _check_locked(self, uid, sid):
        for _ in range(self.max_attempts):
            try:
                current = await self.db.user_sessions.find_one(self._query(uid), {"_id": 0})
            except Exception as error:
                raise SessionUnavailable(type(error).__name__) from None
            if current and current.get("session_id") == sid:
                self._cache(uid, sid, current.get("session_created_at"))
                return

            info = await self._session_info(sid)
            if info.get("user_id") != uid or info.get("status") != "active":
                raise SessionInvalid("session is not active for this user")
            created_at = info["created_at"]
            record = {**self._query(uid), "session_id": sid, "session_created_at": created_at,
                      "updated_at": time.time()}

            if current is None:
                try:
                    await self.db.user_sessions.insert_one(dict(record))
                except DuplicateKeyError:
                    continue  # another login registered first; re-evaluate against it
                except Exception as error:
                    raise SessionUnavailable(type(error).__name__) from None
                self._cache(uid, sid, created_at)
                return

            old_sid = current.get("session_id")
            old_created = current.get("session_created_at") or 0
            if (created_at, sid) <= (old_created, old_sid or ""):
                # An older session is still being used after a newer login: it loses.
                self._cache(uid, old_sid, old_created)
                self._spawn(self._revoke_quietly(sid))
                raise SessionReplaced(SESSION_REPLACED_MESSAGE)

            try:
                result = await self.db.user_sessions.update_one(
                    {**self._query(uid), "session_id": old_sid}, {"$set": record})
            except Exception as error:
                raise SessionUnavailable(type(error).__name__) from None
            if getattr(result, "matched_count", 0) == 0:
                continue  # a concurrent login changed the record; compare again
            self._cache(uid, sid, created_at)
            if old_sid:
                self._spawn(self._revoke_quietly(old_sid))
                if self.on_replaced:
                    await self.on_replaced(uid, old_sid, sid)
            return
        raise SessionUnavailable("too many concurrent session changes")
