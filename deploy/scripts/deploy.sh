#!/usr/bin/env bash
# Deploy one git tag (or commit) of Dehla Pakad as a new release on the VPS.
#
#   # 1. put the server's checkout on the tag, so the scripts that run are the tag's own scripts:
#   sudo -u dehla git -C /opt/dehla-pakad/repo fetch --tags origin
#   sudo -u dehla git -C /opt/dehla-pakad/repo checkout --detach v1.0.0
#   # 2. deploy it:
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/deploy.sh v1.0.0 [--allow-active] [--queue-unknown] [--skip-backup]
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
#                    drain) its matchmaking queue, e.g. the first deploy over a release without the
#                    activity endpoint. It never overrides matches or lobbies found in the database;
#   --skip-backup    no backup before switching.
# A failed database check is never overridden.
set -euo pipefail

usage() { echo "usage: deploy.sh <git tag or commit> [--allow-active] [--queue-unknown] [--skip-backup]" >&2; exit 2; }
REF=""; ALLOW_ACTIVE_FLAG=0; QUEUE_UNKNOWN_FLAG=0; SKIP_BACKUP_FLAG=0
for arg in "$@"; do
  case "$arg" in
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
# How long the restart drain lasts if the script never gets to the restart (it is lifted at once on a
# normal abort, and ends with the restart). Long enough for a typed --allow-active confirmation.
DRAIN_SECONDS=300
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Commands that need root are run with `sudo -n` (never prompt): see the sudoers line in deploy/README.md.
SYSTEMCTL=/usr/bin/systemctl
NGINX=/usr/sbin/nginx

fail() { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "!!! WARNING: $*" >&2; }

confirm_exact() {  # $1 = prompt, $2 = the exact text the operator must type
  local answer
  read -r -p "$1 Type '$2' to continue: " answer
  [[ "$answer" == "$2" ]] || fail "not confirmed; nothing was switched"
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
  "$RELEASE/venv/bin/python" "$SCRIPTS/active_matches.py" "$SHARED/backend.env" "$PORT"
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
    *)
      fail "it could not be checked whether matches are in progress (database check failed); the release is built ($RELEASE). Fix the check and try again; this is never overridden." ;;
  esac
}

# Restart drain: the running backend refuses new queue joins and game starts until it restarts (or the
# drain expires), so nothing can begin between the final activity check and the restart.
DRAINED=0
drain_backend() {
  local code=0
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:$PORT/api/internal/drain?seconds=$DRAIN_SECONDS" >/dev/null 2>&1 || code=$?
  if [[ $code -eq 0 ]]; then DRAINED=1; sleep 2; return 0; fi  # the pause lets requests already running finish
  [[ $code -eq 7 ]] && return 0  # nothing listening on the port: no backend, nothing can start
  if [[ $QUEUE_UNKNOWN_FLAG -eq 1 ]]; then
    warn "the running backend could not be drained (an older release?): a match could still start in the seconds before the restart (it would resume from the database afterwards)"
    return 0
  fi
  fail "the running backend could not be drained before the restart; the release is built ($RELEASE). Try again later (an older release without the drain: see --queue-unknown in deploy/README.md)."
}
undrain_backend() {  # an aborted deploy lifts the drain at once (it would also expire by itself)
  [[ $DRAINED -eq 1 ]] || return 0
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:$PORT/api/internal/drain?seconds=0" >/dev/null 2>&1 || true
  DRAINED=0
}
trap undrain_backend EXIT

# Point "current" back at the release that was live and start it again (used when the new release cannot
# be started or is unhealthy). On a first deploy there is nothing to go back to: stop the service.
restore_previous() {
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    switch_to "$PREVIOUS"
    sudo -n "$SYSTEMCTL" restart "$SERVICE" || true
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
for tool in git python3.12 yarn curl ss flock mongodump; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
for cmd in "$SYSTEMCTL restart $SERVICE" "$SYSTEMCTL stop $SERVICE" "$SYSTEMCTL reload nginx" "$NGINX -t"; do
  # shellcheck disable=SC2086
  sudo -n -l $cmd >/dev/null 2>&1 || fail "the dehla user may not run 'sudo $cmd' without a password (see deploy/README.md, sudoers)"
done
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

read -r -p "Switch the live site to $REF now? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled. The built release stays in $RELEASE (never live)."; exit 1; }

# The backup and the prompt can take minutes: stop anything new from starting, then check again
# immediately before switching.
echo "== draining: new queue joins and game starts are refused until the restart"
drain_backend
echo "== matches in progress? (final check, right before switching)"
activity_gate

echo "== switch release"
PREVIOUS="$(readlink -e "$BASE/current" 2>/dev/null || true)"
switch_to "$RELEASE"
DRAINED=0  # from here the restart ends the drain (a new process always starts undrained)
if ! sudo -n "$SYSTEMCTL" restart "$SERVICE"; then
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
