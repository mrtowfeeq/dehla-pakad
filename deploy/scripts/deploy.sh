#!/usr/bin/env bash
# Deploy one git tag (or commit) of Dehla Pakad as a new release on the VPS.
#
#   # 1. put the server's checkout on the tag, so the scripts that run are the tag's own scripts:
#   sudo -u dehla git -C /opt/dehla-pakad/repo fetch --tags origin
#   sudo -u dehla git -C /opt/dehla-pakad/repo checkout --detach v1.0.0
#   # 2. deploy it:
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/deploy.sh v1.0.0
#
# Layout (see deploy/README.md):
#   /opt/dehla-pakad/repo        git clone used only to fetch releases (checked out at the tag)
#   /opt/dehla-pakad/releases/   one folder per deploy (code + its own Python venv + frontend build)
#   /opt/dehla-pakad/current     symlink to the live release
#   /opt/dehla-pakad/shared/     backend.env (secrets, chmod 600), frontend.env (optional), backups/
#
# Release markers: INCOMPLETE = still being built (or the build failed); FAILED = did not pass the health
# check. rollback.sh never picks either.
#
# Restarting the backend drops every WebSocket for a few seconds, deletes public lobbies and their
# in-memory queue, and auto-plays a turn whose deadline passes during the restart. So the switch is
# refused while matches or public lobbies are in progress (override: ALLOW_ACTIVE=1).
set -euo pipefail

REF="${1:?usage: deploy.sh <git tag or commit>}"
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

# ---------- one deploy or rollback at a time ----------
exec 9>"$BASE/.deploy.lock"
flock -n 9 || fail "another deploy or rollback is running"

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

echo "== matches in progress?"
set +e
"$RELEASE/venv/bin/python" "$SCRIPTS/active_matches.py" "$SHARED/backend.env"
state=$?
set -e
if [[ $state -eq 3 && "${ALLOW_ACTIVE:-0}" != "1" ]]; then
  fail "matches or public lobbies are in progress; the release is built ($RELEASE) — try again later, or set ALLOW_ACTIVE=1"
elif [[ $state -eq 2 && "${ALLOW_ACTIVE:-0}" != "1" ]]; then
  fail "could not check for matches in progress (database unreachable?); set ALLOW_ACTIVE=1 only if you checked yourself"
fi

echo "== backup before switching"
if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  "$SCRIPTS/backup.sh"
fi

read -r -p "Switch the live site to $REF now? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled. The built release stays in $RELEASE."; exit 1; }

echo "== switch release"
PREVIOUS="$(readlink -e "$BASE/current" 2>/dev/null || true)"
switch_to "$RELEASE"
if ! sudo -n "$SYSTEMCTL" restart "$SERVICE"; then
  # Never leave "current" pointing at a release that is not running.
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then switch_to "$PREVIOUS"; else rm -f "$BASE/current"; fi
  touch "$RELEASE/FAILED"
  fail "could not restart $SERVICE; 'current' was switched back"
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
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    switch_to "$PREVIOUS"
    sudo -n "$SYSTEMCTL" restart "$SERVICE" || true
    back=0
    for _ in $(seq 1 45); do healthy "$PREVIOUS" && { back=1; break; }; sleep 1; done
    [[ $back -eq 1 ]] && echo "previous release is running again" >&2 ||
      echo "WARNING: the previous release did not come back either; check: journalctl -u $SERVICE -n 200" >&2
  else
    rm -f "$BASE/current"
    sudo -n "$SYSTEMCTL" stop "$SERVICE" || true
  fi
  fail "deploy of $REF failed health check (see: journalctl -u $SERVICE -n 200)"
fi
# Graceful reload; refuses to touch Nginx if any site's configuration is invalid.
if sudo -n "$NGINX" -t; then sudo -n "$SYSTEMCTL" reload nginx; else echo "WARNING: nginx -t failed; Nginx was not reloaded" >&2; fi

echo "== prune old releases (keeping $KEEP)"
CURRENT="$(readlink -e "$BASE/current" || true)"
find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2- |
  tail -n +$((KEEP + 1)) | while read -r old; do
    [[ "$old" == "$CURRENT" || "$old" == "$PREVIOUS" ]] || rm -rf -- "$old"
  done

echo "Deployed $REF ($COMMIT) -> $RELEASE"
echo "Next: open https://dehlapakad.tech, sign in, check Admin > System health (indexes healthy)."
