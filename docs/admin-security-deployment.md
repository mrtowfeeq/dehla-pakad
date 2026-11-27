# Admin security deployment checks

This document records settings that must be verified by an operator before a
deployment. No production environment, VPS, or database was inspected for this
change.

## Environment and MongoDB

The backend selects its database with `AsyncIOMotorClient(MONGO_URL)[DB_NAME]`.
It derives the record label `ENV` from Clerk configuration: a publishable key
starting with `pk_live_` labels records `live`; other Clerk keys label records
`preview`. `DB_NAME` is selected directly from configuration and is not checked
against `ENV`; a development or preview process can therefore point to the same
Mongo database as another Clerk environment if it is misconfigured. `IN_ENV`
and `scoped_query` use an exact `{"env": ENV}` filter. There is no fallback for
records with a missing or null environment.

### Collection and record scope

| Collection / record type | Scope and lifecycle |
| --- | --- |
| `users` and profiles | User documents, profile updates, roles, progression, statistics, leaderboards, and account lookups carry `env`. Profile/progression data is embedded in the user document. |
| `friends` | Directed relationship records carry `env`; list, lookup, upsert, presence, and delete paths filter by it. |
| `friend_requests` | Requests carry `env`; profile/list/duplicate/accept/decline paths filter by it. |
| `invitations` | Room invitations carry `env`; create, list, accept-on-join, duplicate, and decline paths filter by it. |
| `rooms` | Private/public lobby records carry `env`; room lookup and updates/deletes use it. Startup cleanup is scoped. |
| `games` | Active, finished, and cancelled authoritative snapshots carry `env`; service recovery, action, admin lobby, spectator discovery, and state lookups use it. |
| `matches` | Completed match history carries `env`; match history, progression backfill, recovery/upsert, and admin metrics use it. |
| `chat_messages` | Public-room/in-game and private-lobby messages carry `env`; reads, private-history loads, and room-close cleanup use it. |
| `spectator_sessions` | Reconnect grants carry `env`; access validation, creation, revocation, and deletion use it. The TTL index expires each session by `expires_at`; MongoDB's TTL worker is database-wide and removes only expired session documents. |
| `game_events` | Turn/game event records carry `env`; game service writes are tagged. The checked-in exit E2E helper also scopes its event counts by the configured Clerk environment. |
| `admin_audit_logs` | Admin actions and access-denial records carry `env`; dashboard reads and retention queries use it. |
| `admin_role_locks` | Short-lived staff-role lease `_id` is prefixed with `ENV`; the current lease write also stores the label. It is not a user/game record and has no migration value. |

The production app passes its derived `ENV` into `GameService` and the
progression, spectator, and private-lobby-chat helpers. Those internal helpers
retain optional environment parameters for isolated unit tests; calling them
without an environment bypasses scoping and must not be done by application
entry points.

Before deployment, verify separately for every Clerk environment that:

- `DB_NAME` points to the intended development, preview, or production database.
- Preview and production database names are intentionally configured; the app
  does not infer or enforce that they are separate.
- Current index definitions use compound environment keys for user IDs and
  usernames, friend pairs, request/invitation IDs, room codes, game IDs,
  spectator grants, and match game IDs. Search/sort indexes for scoped
  collections also start with `env` where MongoDB permits it.
- Existing databases may still have the older global unique indexes named
  `user_id`, `username_lower`, `pair`, `id` (on `friend_requests` and
  `invitations`), `code`, `id` (on `games`), `game_user`, and `game_id_unique`.
  Startup only creates declared indexes; it does not drop or rewrite old ones.
  Until an operator explicitly removes obsolete global indexes, identical
  identifiers or usernames in two environments sharing one database can still
  conflict even though reads and writes are environment-filtered.
- `ensure_indexes` logs index-creation errors and continues startup. Verify the
  actual indexes after deployment; a conflicting old index can prevent a new
  compound index from being created.
- Untagged legacy records are inaccessible to the application. Never assign
  them to an environment based on `DB_NAME`, current Clerk configuration, or
  neighboring records alone. The helper
  `env_scope.assign_explicit_legacy_environment` accepts only reviewed `_id` to
  `preview`/`live` assignments, defaults to dry-run, refuses already-conflicting
  records, and can safely be rerun. It is not called at startup. A migration
  operator must back up the database, establish ownership from authoritative
  records, prepare and review an explicit manifest per collection, dry-run it,
  then deliberately apply it. Leave ambiguous records untagged. Preflight
  duplicate keys within each environment before removing old global unique
  indexes; build and verify the new compound indexes first.
- Migration must be rehearsed on an isolated database copy. No migration is
  run automatically or by the application startup path.

## Rate limits and reverse proxy

IP-based HTTP rate limits and the Clerk proxy use `X-Forwarded-For` only when
the immediate request peer matches a network in `TRUSTED_PROXY_CIDRS`. The
default is empty, so forwarding headers are ignored. Invalid CIDR entries do
not expand the trusted set.

For a single Nginx proxy on the same host, the expected arrangement is:

1. Bind Uvicorn to loopback and prevent external access to its port.
2. Configure Nginx to overwrite the forwarded address, not append a
   client-supplied header:

   ```nginx
   proxy_http_version 1.1;
   proxy_set_header X-Forwarded-For $remote_addr;
   proxy_set_header X-Forwarded-Host $host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header Host $host;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   ```

3. Set `TRUSTED_PROXY_CIDRS` to the exact address or CIDR from which Nginx
   connects to Uvicorn (for example, the loopback address only when that is
   actually the peer, such as `127.0.0.1/32`).
4. Keep Uvicorn's proxy-header trust list limited to the same proxy, or disable
   Uvicorn proxy-header rewriting and let the application's configured trust
   list resolve the forwarded chain. Do not use `*` as a trusted proxy list.
5. Preserve the existing WebSocket upgrade headers in the Nginx WebSocket
   location.

The limiter stores counters in process memory. It protects a single backend
process, resets on restart, and does not coordinate limits across workers or
multiple instances. This change keeps the current single-process arrangement;
Redis or a distributed limiter is not configured.

## WebSocket authentication migration

WebSocket clients must send their first frame as JSON:

```json
{"type":"auth","token":"<Clerk session token>"}
```

The token is no longer accepted from a query parameter. All WebSocket clients
and scripts checked into this repository have been migrated. Before deployment,
verify any external, mobile, or operator-maintained clients also use the first
message protocol. Authentication failures close the socket without echoing the
token or returning credential details.

## Admin bootstrap

`ADMIN_EMAIL` is a comma-separated allowlist of email addresses that may receive
the initial `admin` role when their account is first provisioned. A match only
counts when Clerk marks that exact address verified. Leave the setting empty to
disable email-based bootstrap; an existing authorized administrator can then
assign staff roles through the protected role-management API. Configure this
setting independently for each Clerk environment and do not put secret values
in this document or source control.
