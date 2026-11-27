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
# Never run during active matches: restarting the backend drops matchmaking queues and public lobbies
# (active games resume from the database). Check the admin overview first.
set -euo pipefail

REF="${1:?usage: deploy.sh <git tag or commit>}"
BASE=/opt/dehla-pakad
REPO="$BASE/repo"
SHARED="$BASE/shared"
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE="$BASE/releases/$STAMP-${REF//\//_}"
KEEP=5

[[ -f "$SHARED/backend.env" ]] || { echo "missing $SHARED/backend.env" >&2; exit 1; }

read -r -p "No matches in progress (checked the admin overview)? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "Cancelled."; exit 1; }

echo "== backup before deploy"
if [[ "${SKIP_BACKUP:-0}" != "1" ]]; then
  "$REPO/deploy/scripts/backup.sh"
fi

echo "== fetch $REF"
git -C "$REPO" fetch --tags --prune origin
git -C "$REPO" rev-parse --verify "$REF^{commit}" >/dev/null
mkdir -p "$RELEASE"
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
[[ -f "$SHARED/frontend.env" ]] && cp "$SHARED/frontend.env" .env.production
yarn install --frozen-lockfile --non-interactive
GENERATE_SOURCEMAP=false yarn build
[[ -f build/index.html ]] || { echo "frontend build failed" >&2; exit 1; }

echo "== switch release"
PREVIOUS="$(readlink -f "$BASE/current" || true)"
ln -sfn "$RELEASE" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
sudo systemctl restart dehla-pakad

echo "== health check"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8000/api/ >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ "${healthy:-0}" != "1" ]]; then
  echo "backend did not come up; rolling back to $PREVIOUS" >&2
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    ln -sfn "$PREVIOUS" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current"
    sudo systemctl restart dehla-pakad
  fi
  exit 1
fi
sudo nginx -t && sudo systemctl reload nginx

echo "== prune old releases (keeping $KEEP)"
ls -1dt "$BASE"/releases/* | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ "$(readlink -f "$BASE/current")" == "$old" ]] || rm -rf "$old"
done

echo "Deployed $REF ($(cat "$RELEASE/REVISION")) -> $RELEASE"
echo "Next: open https://dehlapakad.tech, sign in, check Admin > System health (indexes healthy)."
