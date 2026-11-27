#!/usr/bin/env bash
# Switch the live site back to an earlier release (code only; the database is not touched).
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh --list           # show releases
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh                   # newest good one
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh /opt/dehla-pakad/releases/<folder>
#
# Without a folder it picks the newest release that is not current and is not marked FAILED or
# INCOMPLETE, and shows it before asking. If the target does not come up healthy it is marked FAILED and
# the release that was running is restored. Database changes made by newer releases are additive (new
# fields, collections, indexes), which older code ignores, so a code rollback normally needs no database
# restore. Restore a backup only for confirmed data corruption (see deploy/README.md).
# Refused while matches or public lobbies are in progress (override: ALLOW_ACTIVE=1).
set -euo pipefail

BASE=/opt/dehla-pakad
SHARED="$BASE/shared"
SERVICE=dehla-pakad
PORT=8000
SYSTEMCTL=/usr/bin/systemctl
NGINX=/usr/sbin/nginx
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT="$(readlink -e "$BASE/current" 2>/dev/null || true)"

fail() { echo "ERROR: $*" >&2; exit 1; }
usable() { [[ -d "$1/backend" && -d "$1/venv" && -f "$1/frontend/build/index.html" && ! -e "$1/FAILED" && ! -e "$1/INCOMPLETE" ]]; }
releases() { find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-; }
describe() {
  local state="ok"
  [[ -e "$1/INCOMPLETE" ]] && state="INCOMPLETE"
  [[ -e "$1/FAILED" ]] && state="FAILED"
  [[ "$1" == "$CURRENT" ]] && state="$state, CURRENT"
  echo "$1  rev $(cut -c1-10 "$1/REVISION" 2>/dev/null || echo ?)  [$state]"
}
switch_to() { ln -sfn "$1" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"; }
healthy() {  # the service is active, runs from $1, and answers on the API
  local pid
  "$SYSTEMCTL" is-active --quiet "$SERVICE" || return 1
  pid="$("$SYSTEMCTL" show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  [[ -n "$pid" && "$pid" != "0" ]] || return 1
  [[ "$(dirname "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)")" == "$1" ]] || return 1
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/" >/dev/null
}
wait_healthy() { for _ in $(seq 1 45); do healthy "$1" && return 0; sleep 1; done; return 1; }

if [[ "${1:-}" == "--list" ]]; then
  releases | while read -r r; do describe "$r"; done
  exit 0
fi

exec 9>"$BASE/.deploy.lock"
flock -n 9 || fail "another deploy or rollback is running"

if [[ $# -ge 1 ]]; then
  TARGET="$(readlink -e "$1" || true)"
else
  TARGET=""
  while read -r r; do
    if [[ "$r" != "$CURRENT" ]] && usable "$r"; then TARGET="$r"; break; fi
  done < <(releases)
fi
[[ -n "$TARGET" ]] || { releases | while read -r r; do describe "$r"; done >&2; fail "no usable release to roll back to"; }
usable "$TARGET" || { describe "$TARGET" >&2; fail "that release is incomplete or marked FAILED; pick another (--list)"; }
[[ "$TARGET" != "$CURRENT" ]] || fail "that release is already current"

echo "== matches in progress?"
set +e
"$TARGET/venv/bin/python" "$SCRIPTS/active_matches.py" "$SHARED/backend.env"
state=$?
set -e
if [[ $state -ne 0 && "${ALLOW_ACTIVE:-0}" != "1" ]]; then
  fail "matches or public lobbies are in progress (or the check failed); try again later, or set ALLOW_ACTIVE=1"
fi

echo "Current: $(describe "${CURRENT:-<none>}")"
echo "Target:  $(describe "$TARGET")"
read -r -p "Roll back now? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled."; exit 1; }

switch_to "$TARGET"
if sudo -n "$SYSTEMCTL" restart "$SERVICE" && wait_healthy "$TARGET"; then
  if sudo -n "$NGINX" -t; then sudo -n "$SYSTEMCTL" reload nginx; fi
  echo "Rolled back to $TARGET"
  exit 0
fi

# The target did not come up: mark it and restore what was running before.
touch "$TARGET/FAILED"
echo "target release is not healthy; restoring ${CURRENT:-<none>}" >&2
if [[ -n "$CURRENT" && -d "$CURRENT" ]]; then
  switch_to "$CURRENT"
  sudo -n "$SYSTEMCTL" restart "$SERVICE" || true
  wait_healthy "$CURRENT" && fail "rollback failed; the previous release ($CURRENT) is running again" ||
    fail "rollback failed and the previous release did not come back; check: journalctl -u $SERVICE -n 200"
fi
fail "rollback failed and there was no previous release to restore; check: journalctl -u $SERVICE -n 200"
