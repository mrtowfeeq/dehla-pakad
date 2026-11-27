#!/usr/bin/env bash
# Switch the live site back to an earlier release (code only; the database is not touched).
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh --list                 # show releases
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh [--allow-active]         # newest earlier live one
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh /opt/dehla-pakad/releases/<folder> [--allow-active]
#
# Only releases that were live before (marked DEPLOYED by deploy.sh) can be rolled back to; a release that
# was built but never switched to, or that failed, is refused (to go forward, use deploy.sh). If the target
# does not come up healthy it is marked FAILED and the release that was running is restored. Database
# changes made by newer releases are additive (new fields, collections, indexes), which older code ignores.
# Refused while matches, lobbies or queued players are in progress, unless --allow-active is given and
# confirmed by typing; environment variables are ignored.
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
warn() { echo "!!! WARNING: $*" >&2; }
usable() {  # was live before, complete, and not marked failed
  [[ -d "$1/backend" && -d "$1/venv" && -f "$1/frontend/build/index.html" && -f "$1/DEPLOYED" &&
     ! -e "$1/FAILED" && ! -e "$1/INCOMPLETE" ]]
}
releases() { find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-; }
describe() {
  local state="never live"
  [[ -f "$1/DEPLOYED" ]] && state="was live"
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

LIST=0; ALLOW_ACTIVE_FLAG=0; ARG=""
for a in "$@"; do
  case "$a" in
    --list) LIST=1 ;;
    --allow-active) ALLOW_ACTIVE_FLAG=1 ;;
    -*) fail "unknown option $a" ;;
    *) [[ -z "$ARG" ]] || fail "only one release folder may be given"; ARG="$a" ;;
  esac
done

if [[ $LIST -eq 1 ]]; then
  releases | while read -r r; do describe "$r"; done
  exit 0
fi

exec 9>"$BASE/.deploy.lock"
flock -n 9 || fail "another deploy or rollback is running"
[[ -n "${ALLOW_ACTIVE:-}" ]] && warn "the ALLOW_ACTIVE environment variable is ignored; use --allow-active"
for cmd in "$SYSTEMCTL restart $SERVICE" "$SYSTEMCTL reload nginx" "$NGINX -t"; do
  # shellcheck disable=SC2086
  sudo -n -l $cmd >/dev/null 2>&1 || fail "the dehla user may not run 'sudo $cmd' without a password (see deploy/README.md, sudoers)"
done

if [[ -n "$ARG" ]]; then
  TARGET="$(readlink -e "$ARG" || true)"
else
  TARGET=""
  while read -r r; do
    if [[ "$r" != "$CURRENT" ]] && usable "$r"; then TARGET="$r"; break; fi
  done < <(releases)
fi
[[ -n "$TARGET" ]] || { releases | while read -r r; do describe "$r"; done >&2; fail "no earlier live release to roll back to"; }
usable "$TARGET" || { describe "$TARGET" >&2; fail "that release was never live, is incomplete or failed; pick one marked 'was live' (--list)"; }
[[ "$TARGET" != "$CURRENT" ]] || fail "that release is already current"

activity_gate() {
  local state
  set +e
  "$TARGET/venv/bin/python" "$SCRIPTS/active_matches.py" "$SHARED/backend.env" "$PORT"
  state=$?
  set -e
  [[ $state -eq 0 ]] && return 0
  [[ $ALLOW_ACTIVE_FLAG -eq 1 ]] || fail "matches, lobbies or queued players are in progress (or the check failed); try again later"
  warn "--allow-active was given: rolling back will interrupt play in progress."
  local answer
  read -r -p "Type 'RESTART DURING PLAY' to continue: " answer
  [[ "$answer" == "RESTART DURING PLAY" ]] || fail "not confirmed; nothing was switched"
}

echo "== matches in progress?"
activity_gate
echo "Current: $(describe "${CURRENT:-<none>}")"
echo "Target:  $(describe "$TARGET")"
read -r -p "Roll back now? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled."; exit 1; }
echo "== matches in progress? (right before switching)"
activity_gate

switch_to "$TARGET"
if sudo -n "$SYSTEMCTL" restart "$SERVICE" && wait_healthy "$TARGET"; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$TARGET/DEPLOYED"
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
