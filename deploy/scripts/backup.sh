#!/usr/bin/env bash
# Dump the production database to /opt/dehla-pakad/shared/backups (gzip archive), keeping 14.
# Needs MongoDB Database Tools (mongodump). Reads MONGO_URL and DB_NAME from the server's backend.env
# without printing them; the connection string is passed through a private temp config file, never on
# the command line (where other users could see it in `ps`).
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/backup.sh
#
# Restore (test on a SEPARATE database first, never straight over production):
#   mongorestore --uri "<uri>" --gzip --archive=<file> --nsFrom "<db>.*" --nsTo "<scratch_db>.*"
set -euo pipefail

SHARED=/opt/dehla-pakad/shared
ENV_FILE="$SHARED/backend.env"
OUT="$SHARED/backups"
KEEP=14

value() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
MONGO_URL="$(value MONGO_URL)"
DB_NAME="$(value DB_NAME)"
[[ -n "$MONGO_URL" && -n "$DB_NAME" ]] || { echo "MONGO_URL / DB_NAME missing in $ENV_FILE" >&2; exit 1; }

mkdir -p "$OUT"
umask 077
CONF="$(mktemp)"
trap 'rm -f "$CONF"' EXIT
printf 'uri: "%s"\n' "$MONGO_URL" > "$CONF"

FILE="$OUT/$DB_NAME-$(date +%Y%m%d-%H%M%S).archive.gz"
mongodump --config="$CONF" --db="$DB_NAME" --gzip --archive="$FILE" --quiet
echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"

ls -1t "$OUT"/*.archive.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
