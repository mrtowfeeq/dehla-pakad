#!/usr/bin/env bash
# Switch the live site back to an earlier release (code only; the database is not touched).
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh            # previous release
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh <folder>   # a specific one
#
# Database changes made by newer releases are additive (new fields, collections, indexes), which older
# code ignores, so a code rollback normally needs no database restore. Restore a backup only for
# confirmed data corruption (see deploy/README.md). Avoid rolling back during stake matches.
set -euo pipefail

BASE=/opt/dehla-pakad
CURRENT="$(readlink -f "$BASE/current")"

if [[ $# -ge 1 ]]; then
  TARGET="$(readlink -f "$1")"
else
  TARGET="$(ls -1dt "$BASE"/releases/* | grep -vx "$CURRENT" | head -n 1 || true)"
fi
[[ -n "$TARGET" && -d "$TARGET/backend" && -f "$TARGET/frontend/build/index.html" ]] || {
  echo "no usable release to roll back to" >&2; ls -1dt "$BASE"/releases/* >&2; exit 1; }

echo "Current: $CURRENT ($(cat "$CURRENT/REVISION" 2>/dev/null || echo ?))"
echo "Target:  $TARGET ($(cat "$TARGET/REVISION" 2>/dev/null || echo ?))"
read -r -p "No matches in progress, roll back now? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled."; exit 1; }

ln -sfn "$TARGET" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
sudo systemctl restart dehla-pakad
for _ in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8000/api/ >/dev/null && { sudo nginx -t && sudo systemctl reload nginx; echo "Rolled back to $TARGET"; exit 0; }
  sleep 1
done
echo "backend did not come up after rollback; check: journalctl -u dehla-pakad -n 100" >&2
exit 1
