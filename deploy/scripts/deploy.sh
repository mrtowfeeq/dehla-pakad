#!/usr/bin/env bash
# Deploy one git tag (or commit) of Dehla Pakad as a new release on the VPS.
#
#   # 1. put the server's checkout on the tag, so the scripts that run are the tag's own scripts:
#   sudo -u dehla git -C /opt/dehla-pakad/repo fetch --tags origin
#   sudo -u dehla git -C /opt/dehla-pakad/repo checkout --detach v1.0.0
#   # 2. deploy it:
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/deploy.sh v1.0.0 [--first-deploy] [--allow-active] [--queue-unknown] [--skip-backup]
#
# Layout (see deploy/README.md):
#   /opt/dehla-pakad/repo        git clone used only to fetch releases (checked out at the tag)
#   /opt/dehla-pakad/releases/   one folder per deploy (code + its own Python venv + frontend build)
#   /opt/dehla-pakad/current     symlink to the live release
#   /opt/dehla-pakad/shared/     backend.env (secrets, chmod 600), frontend.env (optional), backups/
#
# Release markers: INCOMPLETE = still being built (or the build failed); FAILED = did not pass the health
# check; DEPLOYED = was live and passed the health check. rollback.sh only goes back to DEPLOYED releases.
#
# Restarting the backend drops every WebSocket for a few seconds, deletes public lobbies and the in-memory
# matchmaking queue, resets rooms that are starting, and auto-plays a turn whose deadline passes during the
# restart. So the switch is refused while any of these is in progress (checked twice: before the backup,
# and again right before switching). Overrides are command-line flags only (environment variables are
# ignored) and each one needs a typed confirmation:
#   --allow-active   restart although matches, lobbies or queued players are in progress;
#   --queue-unknown  the database shows nothing in progress but the running backend cannot report (or
#                    drain) its matchmaking queue (a running release older than those endpoints).
#                    It never overrides matches or lobbies found in the database;
#   --skip-backup    no backup before switching;
#   --first-deploy   required (only) when no release has been live on this server yet: confirms that every
#                    older backend of the site (another service, port or host using this database) is
#                    stopped, which this script cannot see.
# A failed database check is never overridden.
set -euo pipefail

usage() { echo "usage: deploy.sh <git tag or commit> [--first-deploy] [--allow-active] [--queue-unknown] [--skip-backup]" >&2; exit 2; }
REF=""; FIRST_DEPLOY_FLAG=0; ALLOW_ACTIVE_FLAG=0; QUEUE_UNKNOWN_FLAG=0; SKIP_BACKUP_FLAG=0
for arg in "$@"; do
  case "$arg" in
    --first-deploy) FIRST_DEPLOY_FLAG=1 ;;
    --allow-active) ALLOW_ACTIVE_FLAG=1 ;;
    --queue-unknown) QUEUE_UNKNOWN_FLAG=1 ;;
    --skip-backup) SKIP_BACKUP_FLAG=1 ;;
    -*) usage ;;
    *) [[ -z "$REF" ]] || usage; REF="$arg" ;;
  esac
done
[[ -n "$REF" ]] || usage

BASE=/opt/dehla-pakad
REPO="$BASE/repo"
SHARED="$BASE/shared"
SERVICE=dehla-pakad
PORT=8000
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE="$BASE/releases/$STAMP-${REF//\//_}"
KEEP=5
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Commands that need root are run with `sudo -n` (never prompt): see the sudoers line in deploy/README.md.
SYSTEMCTL=/usr/bin/systemctl
NGINX=/usr/sbin/nginx

fail() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "!!! WARNING: $*" >&2; }

# Every confirmation is read from the controlling terminal (/dev/tty), never from stdin: piped input,
# here-documents, `yes`, environment variables or inherited shell state cannot answer it. Without a
# terminal (cron, CI, ssh without -t) the script refuses.
ask_tty() {  # $1 = prompt; sets TTY_REPLY to the line a person typed
  TTY_REPLY=""
  { exec 8</dev/tty; } 2>/dev/null || fail "this step needs a person at an interactive terminal (no /dev/tty); nothing was switched"
  printf '%s' "$1" >/dev/tty
  IFS= read -r TTY_REPLY <&8 || TTY_REPLY=""
  exec 8<&-
}

# Every restart first clears a "failed" state left by systemd's start limit (StartLimitBurst in the unit:
# repeated crashes or restarts within 120 s); otherwise `systemctl restart` is refused and a recovery
# restart could never bring the previous release back. Needs the reset-failed sudoers entry (checked in
# the pre-flight, before anything is switched).
restart_service() {
  sudo -n "$SYSTEMCTL" reset-failed "$SERVICE" 2>/dev/null || warn "could not clear the failed state of $SERVICE (sudo reset-failed refused)"
  sudo -n "$SYSTEMCTL" restart "$SERVICE"
}

confirm_exact() {  # $1 = prompt, $2 = the exact text the operator must type
  ask_tty "$1 Type '$2' to continue: "
  [[ "$TTY_REPLY" == "$2" ]] || fail "not confirmed; nothing was switched"
}

switch_to() {  # atomically point "current" at a release folder
  ln -sfn "$1" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
}

running_release() {  # the release folder the service's main process actually runs from (empty if none)
  local pid
  pid="$("$SYSTEMCTL" show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  [[ -n "$pid" && "$pid" != "0" && -e "/proc/$pid/cwd" ]] || return 0
  dirname "$(readlink -f "/proc/$pid/cwd")"
}

healthy() {  # the service is active, runs from $1, and answers on the API
  "$SYSTEMCTL" is-active --quiet "$SERVICE" || return 1
  [[ "$(running_release)" == "$1" ]] || return 1
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/" >/dev/null
}

activity_gate() {  # refuse to restart while anything is in progress (see the overrides above)
  local state
  set +e
  "$RELEASE/venv/bin/python" "$SCRIPTS/active_matches.py" "$SHARED/backend.env" "$PORT" ${DRAIN_ID:+--expect-drain "$DRAIN_ID"}
  state=$?
  set -e
  case $state in
    0) return 0 ;;
    3)
      [[ $ALLOW_ACTIVE_FLAG -eq 1 ]] ||
        fail "matches, lobbies or queued players are in progress; the release is built ($RELEASE). Try again later (or see --allow-active in deploy/README.md)."
      warn "matches, lobbies or queued players are in progress. --allow-active was given: restarting will interrupt them."
      confirm_exact "Restart anyway?" "RESTART DURING PLAY" ;;
    4)
      [[ $QUEUE_UNKNOWN_FLAG -eq 1 ]] ||
        fail "the database shows nothing in progress, but the running backend cannot report its matchmaking queue (an older release?); the release is built ($RELEASE). See --queue-unknown in deploy/README.md."
      warn "the running backend cannot report its matchmaking queue: players waiting in it will be dropped by the restart."
      confirm_exact "Restart without knowing the queue?" "QUEUE UNKNOWN" ;;
    5)
      fail "the restart drain lapsed or the backend restarted during the final check; the release is built ($RELEASE). Run it again; this is never overridden." ;;
    *)
      fail "it could not be checked whether matches are in progress (database check failed); the release is built ($RELEASE). Fix the check and try again; this is never overridden." ;;
  esac
}

# Restart drain: the running backend refuses new queue joins, game starts and public-lobby creation until
# it restarts, so nothing can begin between the final activity check and the restart.
#   * Lease: each drain lasts DRAIN_SECONDS; a background heartbeat renews it every DRAIN_RENEW_SECONDS
#     while this script runs, so it cannot lapse during a typed confirmation. The heartbeat checks every
#     second that this script is still alive, so after a kill -9 it stops within a second and the drain
#     lapses within DRAIN_SECONDS.
#   * Proof: the backend names each continuous drain (drain_id; a lapse or a restarted backend gives a new
#     or no id). The final activity check and a last renewal right before switching must both see the id
#     this script started, or nothing is switched.
#   * The heartbeat is stopped (and waited for, so no renewal is in flight) before the restart, so the new
#     process is never drained; every other exit lifts the drain at once.
DRAIN_SECONDS=300
DRAIN_RENEW_SECONDS=60
DRAINED=0
DRAIN_ID=""
HEARTBEAT_PID=""
HEARTBEAT_STOP="$BASE/.drain-heartbeat.stop"
drain_request() {  # $1 = seconds (0 lifts the drain); prints the JSON reply
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:$PORT/api/internal/drain?seconds=$1"
}
drain_id_of() { sed -n 's/.*"drain_id":"\([0-9a-f]\{1,64\}\)".*/\1/p'; }
start_drain_heartbeat() {
  local parent=$$
  rm -f "$HEARTBEAT_STOP"
  (
    n=0
    while [[ ! -e "$HEARTBEAT_STOP" ]] && kill -0 "$parent" 2>/dev/null; do
      sleep 1
      n=$((n + 1))
      # Re-check right before renewing: never renew for a script that was stopped or killed meanwhile.
      if [[ $n -ge $DRAIN_RENEW_SECONDS && ! -e "$HEARTBEAT_STOP" ]] && kill -0 "$parent" 2>/dev/null; then
        n=0
        drain_request "$DRAIN_SECONDS" >/dev/null 2>&1 || true
      fi
    done
  ) </dev/null >/dev/null 2>&1 &
  HEARTBEAT_PID=$!
}
stop_drain_heartbeat() {  # returns once the heartbeat has exited (no renewal can still be in flight)
  [[ -n "$HEARTBEAT_PID" ]] || return 0
  touch "$HEARTBEAT_STOP"
  wait "$HEARTBEAT_PID" 2>/dev/null || true
  rm -f "$HEARTBEAT_STOP"
  HEARTBEAT_PID=""
}
drain_backend() {
  local code=0 reply=""
  reply="$(drain_request "$DRAIN_SECONDS" 2>/dev/null)" || code=$?
  if [[ $code -eq 0 ]]; then
    DRAIN_ID="$(printf '%s' "$reply" | drain_id_of)"
    [[ -n "$DRAIN_ID" ]] || fail "the running backend accepted the drain but reported no drain id; the release is built ($RELEASE)."
    DRAINED=1
    start_drain_heartbeat
    sleep 2  # lets requests already running finish
    return 0
  fi
  [[ $code -eq 7 ]] && return 0  # nothing listening on the port: no backend, nothing can start
  if [[ $QUEUE_UNKNOWN_FLAG -eq 1 ]]; then
    warn "the running backend could not be drained (an older release?): a match could still start in the seconds before the restart (it would resume from the database afterwards)"
    return 0
  fi
  fail "the running backend could not be drained before the restart; the release is built ($RELEASE). Try again later (an older release without the drain: see --queue-unknown in deploy/README.md)."
}
confirm_drain_held() {  # right before switching: the drain started by this script has held without a gap
  [[ $DRAINED -eq 1 ]] || return 0
  stop_drain_heartbeat
  local reply
  reply="$(drain_request "$DRAIN_SECONDS" 2>/dev/null)" || fail "could not renew the restart drain right before switching; the release is built ($RELEASE)."
  [[ "$(printf '%s' "$reply" | drain_id_of)" == "$DRAIN_ID" ]] ||
    fail "the restart drain lapsed or the backend restarted since the final check (new players could have started); the release is built ($RELEASE). Run it again."
}
undrain_backend() {  # an aborted run lifts the drain at once (it would also expire by itself)
  stop_drain_heartbeat
  [[ $DRAINED -eq 1 ]] || return 0
  drain_request 0 >/dev/null 2>&1 || true
  DRAINED=0
}
trap undrain_backend EXIT

# Point "current" back at the release that was live and start it again (used when the new release cannot
# be started or is unhealthy). On a first deploy there is nothing to go back to: stop the service.
restore_previous() {
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    switch_to "$PREVIOUS"
    restart_service || true
    local back=0
    for _ in $(seq 1 45); do healthy "$PREVIOUS" && { back=1; break; }; sleep 1; done
    if [[ $back -eq 1 ]]; then echo "previous release is running again" >&2
    else echo "WARNING: the previous release did not come back either; check: journalctl -u $SERVICE -n 200" >&2; fi
  else
    # First deploy: its start limit also stops retries at boot.
    rm -f "$BASE/current"
    sudo -n "$SYSTEMCTL" stop "$SERVICE" || true
  fi
}

# ---------- one deploy or rollback at a time ----------
exec 9>"$BASE/.deploy.lock"
flock -n 9 || fail "another deploy or rollback is running"

# Old environment-variable overrides are ignored on purpose (they can be inherited by accident).
[[ -n "${ALLOW_ACTIVE:-}" || -n "${SKIP_BACKUP:-}" ]] && warn "ALLOW_ACTIVE / SKIP_BACKUP environment variables are ignored; use --allow-active / --skip-backup"

# ---------- pre-flight checks (nothing on the live site changes before these pass) ----------
[[ -f "$SHARED/backend.env" ]] || fail "missing $SHARED/backend.env"
[[ -e "$BASE/current" && ! -L "$BASE/current" ]] && fail "$BASE/current exists and is not a symlink (an older deployment?)"
for tool in git python3.12 yarn curl ss flock mongodump pgrep; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
# A person must confirm the switch: refuse now, before building anything, when there is no terminal.
{ exec 8</dev/tty; } 2>/dev/null || fail "run this from an interactive terminal (no /dev/tty: cron, CI and 'ssh host cmd' without -t cannot confirm)"
exec 8<&-
for cmd in "$SYSTEMCTL restart $SERVICE" "$SYSTEMCTL reset-failed $SERVICE" "$SYSTEMCTL stop $SERVICE" "$SYSTEMCTL reload nginx" "$NGINX -t"; do
  # shellcheck disable=SC2086
  sudo -n -l $cmd >/dev/null 2>&1 || fail "the dehla user may not run 'sudo $cmd' without a password (see deploy/README.md, sudoers)"
done
# First deploy on this server (no release was ever live): an older backend of the site may still run
# elsewhere (another service or port, or another host on this database). This script cannot see it, and
# two backends on one database would both drive the same active games (and the new one deletes the old
# one's public lobbies at startup). The operator must confirm it is stopped.
if [[ ! -L "$BASE/current" ]] && ! compgen -G "$BASE/releases/*/DEPLOYED" >/dev/null; then
  [[ $FIRST_DEPLOY_FLAG -eq 1 ]] ||
    fail "no release has been live on this server yet: this is the first deploy. Stop every older backend of the site first, then run again with --first-deploy (see deploy/README.md)."
  echo "== processes that could be another copy of the backend (all users; check each one):"
  pgrep -af 'uvicorn|gunicorn|hypercorn|server:app' || echo "   (none found)"
  warn "first deploy: every older Dehla Pakad backend (on this server and on any other host using this database) must be stopped."
  confirm_exact "Are all older backends stopped?" "OLD BACKEND STOPPED"
elif [[ $FIRST_DEPLOY_FLAG -eq 1 ]]; then
  fail "--first-deploy is only for the first deploy on this server; a release has already been live here"
fi
# Port 8000 must be free, or held by this service itself (an old backend there would fool the health check).
if ss -ltnH "sport = :$PORT" | grep -q . && ! "$SYSTEMCTL" is-active --quiet "$SERVICE"; then
  fail "port $PORT is in use by something other than $SERVICE; stop it first (ss -ltnp 'sport = :$PORT')"
fi

echo "== fetch $REF"
git -C "$REPO" fetch --tags origin
COMMIT="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")" || fail "unknown ref $REF"
# The scripts running now must be the release's own scripts (a stale checkout would run old logic).
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$COMMIT" ]] ||
  fail "the server checkout is not at $REF; run: git -C $REPO checkout --detach $REF  (then run this script again)"
[[ -z "$(git -C "$REPO" status --porcelain)" ]] || fail "$REPO has local changes; it must be a clean checkout of $REF"

echo "== build release $RELEASE"
mkdir -p "$RELEASE"
touch "$RELEASE/INCOMPLETE"
git -C "$REPO" archive "$COMMIT" | tar -x -C "$RELEASE"
echo "$COMMIT" > "$RELEASE/REVISION"

echo "== backend dependencies"
python3.12 -m venv "$RELEASE/venv"
"$RELEASE/venv/bin/pip" install --quiet --upgrade pip
REQS="$RELEASE/backend/requirements-prod.txt"
[[ -f "$REQS" ]] || REQS="$RELEASE/backend/requirements.txt"
"$RELEASE/venv/bin/pip" install --quiet -r "$REQS"
ln -s "$SHARED/backend.env" "$RELEASE/backend/.env"

echo "== frontend build"
cd "$RELEASE/frontend"
# Optional overrides (e.g. REACT_APP_BACKEND_URL); without it the site uses its own origin for /api.
if [[ -f "$SHARED/frontend.env" ]]; then cp "$SHARED/frontend.env" .env.production; fi
yarn install --frozen-lockfile --non-interactive
GENERATE_SOURCEMAP=false yarn build
[[ -f build/index.html ]] || fail "frontend build failed (release left marked INCOMPLETE: $RELEASE)"
rm -f "$RELEASE/INCOMPLETE"
# Built, never live yet: no DEPLOYED marker, so rollback.sh will never pick this folder.

echo "== matches in progress? (first check)"
activity_gate

echo "== backup before switching"
if [[ $SKIP_BACKUP_FLAG -eq 1 ]]; then
  warn "--skip-backup was given: no database backup will be taken before this deploy."
  confirm_exact "Continue without a backup?" "NO BACKUP"
else
  "$SCRIPTS/backup.sh" predeploy
fi

ask_tty "Switch the live site to $REF now? [y/N] "
[[ "$TTY_REPLY" == "y" || "$TTY_REPLY" == "Y" ]] || { echo "Cancelled. The built release stays in $RELEASE (never live)."; exit 1; }

# The backup and the prompt can take minutes: stop anything new from starting, then check again
# immediately before switching.
echo "== draining: new queue joins and game starts are refused until the restart"
drain_backend
echo "== matches in progress? (final check, right before switching)"
activity_gate

echo "== switch release"
PREVIOUS="$(readlink -e "$BASE/current" 2>/dev/null || true)"
confirm_drain_held
switch_to "$RELEASE"
DRAINED=0  # from here the restart ends the drain (a new process always starts undrained)
if ! restart_service; then
  # Never leave "current" pointing at a release that is not running, nor the site without a backend.
  touch "$RELEASE/FAILED"
  echo "could not restart $SERVICE with the new release; switching back to ${PREVIOUS:-<none>}" >&2
  restore_previous
  fail "could not restart $SERVICE with $REF (see: journalctl -u $SERVICE -n 200)"
fi

echo "== health check"
ok=0
for _ in $(seq 1 45); do
  if healthy "$RELEASE"; then ok=1; break; fi
  sleep 1
done
if [[ "$ok" != "1" ]]; then
  touch "$RELEASE/FAILED"
  echo "new release is not healthy; switching back to ${PREVIOUS:-<none>}" >&2
  restore_previous
  fail "deploy of $REF failed health check (see: journalctl -u $SERVICE -n 200)"
fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$RELEASE/DEPLOYED"
# Graceful reload; refuses to touch Nginx if any site's configuration is invalid.
if sudo -n "$NGINX" -t; then sudo -n "$SYSTEMCTL" reload nginx; else warn "nginx -t failed; Nginx was not reloaded"; fi

echo "== prune old releases (keeping $KEEP)"
CURRENT="$(readlink -e "$BASE/current" || true)"
find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2- |
  tail -n +$((KEEP + 1)) | while read -r old; do
    [[ "$old" == "$CURRENT" || "$old" == "$PREVIOUS" ]] || rm -rf -- "$old"
  done

echo "Deployed $REF ($COMMIT) -> $RELEASE"
echo "Next: open https://dehlapakad.tech, sign in, check Admin > System health (indexes healthy)."
