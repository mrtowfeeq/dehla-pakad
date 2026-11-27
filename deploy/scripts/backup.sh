#!/usr/bin/env bash
# Dump the production database to /opt/dehla-pakad/shared/backups (gzip archive), keeping the newest 14.
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/backup.sh
#
# Needs MongoDB Database Tools (mongodump, mongorestore). Reads MONGO_URL and DB_NAME from the server's
# backend.env without printing them; the connection string is passed through a private temp config file,
# never on the command line (where other users could see it in `ps`).
#
# Consistency: mongodump of one database is NOT a point-in-time snapshot (--oplog cannot be used with
# --db), so documents written while the dump runs can be out of step between collections (for example a
# coin balance and its ledger). deploy.sh only dumps when no matches are in progress; the daily cron
# should run in the quietest hour. Atlas cluster snapshots are point-in-time and are the primary backup.
#
# Every archive is written to a .part file, checked (gzip integrity + mongorestore --dryRun), and only
# then renamed; a failed or unverified dump never replaces or counts as a backup.
#
# Restore (test on a SEPARATE database first, never straight over production):
#   mongorestore --config=<file with uri> --gzip --archive=<file> --nsInclude "<db>.*" --nsFrom "<db>.*" --nsTo "<scratch_db>.*"
set -euo pipefail

SHARED=/opt/dehla-pakad/shared
ENV_FILE="$SHARED/backend.env"
OUT="$SHARED/backups"
KEEP=14

fail() { echo "ERROR: $*" >&2; exit 1; }
# First NAME=value line, without surrounding quotes; empty if absent (never fails on a missing name).
value() { { grep -E "^$1=" "$ENV_FILE" || true; } | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }

[[ -r "$ENV_FILE" ]] || fail "cannot read $ENV_FILE"
for tool in mongodump mongorestore gzip; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
MONGO_URL="$(value MONGO_URL)"
DB_NAME="$(value DB_NAME)"
[[ -n "$MONGO_URL" && -n "$DB_NAME" ]] || fail "MONGO_URL / DB_NAME missing in $ENV_FILE"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || fail "DB_NAME has unexpected characters"

umask 077
mkdir -p "$OUT"
CONF="$(mktemp)"
FILE="$OUT/$DB_NAME-$(date +%Y%m%d-%H%M%S).archive.gz"
PART="$FILE.part"
trap 'rm -f "$CONF" "$PART"' EXIT
# YAML single-quoted scalar: only a single quote needs escaping (doubled); backslashes stay literal.
printf "uri: '%s'\n" "${MONGO_URL//\'/\'\'}" > "$CONF"

mongodump --config="$CONF" --db="$DB_NAME" --gzip --archive="$PART" --quiet || fail "mongodump failed"
gzip -t "$PART" || fail "backup archive is corrupt"
mongorestore --config="$CONF" --gzip --archive="$PART" --dryRun --quiet ||
  fail "backup archive could not be read back by mongorestore"
mv -f "$PART" "$FILE"
echo "Backup written and verified: $FILE ($(du -h "$FILE" | cut -f1))"

ls -1t "$OUT"/*.archive.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f --
