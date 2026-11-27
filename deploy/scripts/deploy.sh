#!/usr/bin/env bash
# Deploy one git ref (tag or commit) of Dehla Pakad as a new release on the VPS.
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/deploy.sh v1.0.0
#
# Layout (see deploy/README.md):
#   /opt/dehla-pakad/repo        git clone used only to fetch releases
#   /opt/dehla-pakad/releases/   one folder per deploy (code + its own Python venv + frontend build)
#   /opt/dehla-pakad/current     symlink to the live release
#   /opt/dehla-pakad/shared/     backend.env (secrets, chmod 600), frontend.env (optional), backups/
#
# Release markers: a folder with INCOMPLETE is still being built (or its build failed); a folder with
# FAILED did not pass the health check. rollback.sh never picks either.
#
# Never run during active matches: restarting the backend drops matchmaking queues and public lobbies
# (active games resume from the database). Check the admin overview first.
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

# ---------- pre-flight checks (nothing is changed before these pass) ----------
[[ -f "$SHARED/backend.env" ]] || fail "missing $SHARED/backend.env"
[[ -e "$BASE/current" && ! -L "$BASE/current" ]] && fail "$BASE/current exists and is not a symlink (an older deployment?)"
for tool in git python3.12 yarn curl; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
sudo -n -l "$SYSTEMCTL" restart "$SERVICE" >/dev/null 2>&1 || fail "the dehla user may not run 'sudo $SYSTEMCTL restart $SERVICE' without a password (see deploy/README.md, sudoers)"
# Port 8000 must be free, or held by this service itself (an old backend there would fool the health check).
if ss -ltnH "sport = :$PORT" | grep -q . && ! "$SYSTEMCTL" is-active --quiet "$SERVICE"; then
  fail "port $PORT is in use by something other than $SERVICE; stop it first (ss -ltnp 'sport = :$PORT')"
fi

read -r -p "No matches in progress (checked the admin overview)? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled."; exit 1; }

echo "== backup before deploy"
if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  "$REPO/deploy/scripts/backup.sh"
fi

echo "== fetch $REF"
git -C "$REPO" fetch --tags origin
git -C "$REPO" rev-parse --verify "$REF^{commit}" >/dev/null
mkdir -p "$RELEASE"
touch "$RELEASE/INCOMPLETE"
git -C "$REPO" archive "$REF" | tar -x -C "$RELEASE"
git -C "$REPO" rev-parse "$REF^{commit}" > "$RELEASE/REVISION"

echo "== backend dependencies"
python3.12 -m venv "$RELEASE/venv"
"$RELEASE/venv/bin/pip" install --quiet --upgrade pip
"$RELEASE/venv/bin/pip" install --quiet -r "$RELEASE/backend/requirements.txt"
ln -s "$SHARED/backend.env" "$RELEASE/backend/.env"

echo "== frontend build"
cd "$RELEASE/frontend"
# Optional overrides (e.g. REACT_APP_BACKEND_URL); without it the site uses its own origin for /api.
if [[ -f "$SHARED/frontend.env" ]]; then cp "$SHARED/frontend.env" .env.production; fi
yarn install --frozen-lockfile --non-interactive
GENERATE_SOURCEMAP=false yarn build
[[ -f build/index.html ]] || fail "frontend build failed (release left marked INCOMPLETE: $RELEASE)"
rm -f "$RELEASE/INCOMPLETE"

echo "== switch release"
PREVIOUS="$(readlink -e "$BASE/current" 2>/dev/null || true)"
switch_to "$RELEASE"
if ! sudo -n "$SYSTEMCTL" restart "$SERVICE"; then
  # Never leave "current" pointing at a release that is not running.
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then switch_to "$PREVIOUS"; else rm -f "$BASE/current"; fi
  touch "$RELEASE/FAILED"
  fail "could not restart $SERVICE; 'current' was switched back, nothing changed"
fi

echo "== health check"
ok=0
for _ in $(seq 1 30); do
  if healthy "$RELEASE"; then ok=1; break; fi
  sleep 1
done
if [[ "$ok" != "1" ]]; then
  touch "$RELEASE/FAILED"
  echo "new release is not healthy; switching back to ${PREVIOUS:-<none>}" >&2
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    switch_to "$PREVIOUS"
    sudo -n "$SYSTEMCTL" restart "$SERVICE" || true
    for _ in $(seq 1 30); do healthy "$PREVIOUS" && { echo "previous release is running again" >&2; break; }; sleep 1; done
  else
    rm -f "$BASE/current"
    sudo -n "$SYSTEMCTL" stop "$SERVICE" || true
  fi
  fail "deploy of $REF failed health check (see: journalctl -u $SERVICE -n 200)"
fi
# Graceful reload; refuses to touch Nginx if any site's configuration is invalid.
sudo -n "$NGINX" -t && sudo -n "$SYSTEMCTL" reload nginx

echo "== prune old releases (keeping $KEEP good ones)"
CURRENT="$(readlink -e "$BASE/current" || true)"
find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2- |
  tail -n +$((KEEP + 1)) | while read -r old; do
    [[ "$old" == "$CURRENT" || "$old" == "$PREVIOUS" ]] || rm -rf -- "$old"
  done

echo "Deployed $REF ($(cat "$RELEASE/REVISION")) -> $RELEASE"
echo "Next: open https://dehlapakad.tech, sign in, check Admin > System health (indexes healthy)."
