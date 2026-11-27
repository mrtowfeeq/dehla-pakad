#!/usr/bin/env bash
# Switch the live site back to an earlier release (code only; the database is not touched).
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh --list           # show releases
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh                   # newest good one
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh /opt/dehla-pakad/releases/<folder>
#
# Without a folder it picks the newest release that is not current and is not marked FAILED or
# INCOMPLETE (deploy.sh marks releases that failed their build or health check), and shows it before
# asking. Database changes made by newer releases are additive (new fields, collections, indexes), which
# older code ignores, so a code rollback normally needs no database restore. Restore a backup only for
# confirmed data corruption (see deploy/README.md). Avoid rolling back during stake matches.
set -euo pipefail

BASE=/opt/dehla-pakad
SERVICE=dehla-pakad
PORT=8000
SYSTEMCTL=/usr/bin/systemctl
NGINX=/usr/sbin/nginx
CURRENT="$(readlink -e "$BASE/current" 2>/dev/null || true)"

fail() { echo "ERROR: $*" >&2; exit 1; }
usable() { [[ -d "$1/backend" && -d "$1/venv" && -f "$1/frontend/build/index.html" && ! -e "$1/FAILED" && ! -e "$1/INCOMPLETE" ]]; }
releases() { find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-; }
describe() {
  local state="ok"
  [[ -e "$1/INCOMPLETE" ]] && state="INCOMPLETE"
  [[ -e "$1/FAILED" ]] && state="FAILED"
  [[ "$1" == "$CURRENT" ]] && state="$state, CURRENT"
  echo "$1  rev $(cat "$1/REVISION" 2>/dev/null | cut -c1-10 || echo ?)  [$state]"
}

if [[ "${1:-}" == "--list" ]]; then
  releases | while read -r r; do describe "$r"; done
  exit 0
fi

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

echo "Current: $(describe "${CURRENT:-<none>}")"
echo "Target:  $(describe "$TARGET")"
read -r -p "No matches in progress, roll back now? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled."; exit 1; }

ln -sfn "$TARGET" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
sudo -n "$SYSTEMCTL" restart "$SERVICE" || fail "could not restart $SERVICE (sudoers?)"
for _ in $(seq 1 30); do
  pid="$("$SYSTEMCTL" show -p MainPID --value "$SERVICE" 2>/dev/null || echo 0)"
  if "$SYSTEMCTL" is-active --quiet "$SERVICE" && [[ "$pid" != "0" ]] &&
     [[ "$(dirname "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)")" == "$TARGET" ]] &&
     curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/" >/dev/null; then
    sudo -n "$NGINX" -t && sudo -n "$SYSTEMCTL" reload nginx
    echo "Rolled back to $TARGET"
    exit 0
  fi
  sleep 1
done
fail "backend did not come up after rollback; check: journalctl -u $SERVICE -n 100"
