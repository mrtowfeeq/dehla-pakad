#!/usr/bin/env bash
# Switch the live site back to an earlier release (code only; the database is not touched).
#
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh --list                 # show releases
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh [--allow-active] [--queue-unknown]   # newest earlier live one
#   sudo -u dehla /opt/dehla-pakad/repo/deploy/scripts/rollback.sh /opt/dehla-pakad/releases/<folder> [--allow-active] [--queue-unknown]
#
# Only releases that were live before (marked DEPLOYED by deploy.sh) can be rolled back to; a release that
# was built but never switched to, or that failed, is refused (to go forward, use deploy.sh). If the target
# does not come up healthy it is marked FAILED and the release that was running is restored. Database
# changes made by newer releases are additive (new fields, collections, indexes), which older code ignores.
# Refused while matches, lobbies or queued players are in progress, unless --allow-active is given and
# confirmed by typing. If the database shows nothing in progress but the running backend cannot report or
# drain its queue, --queue-unknown (typed confirmation) is needed instead; it never overrides matches or
# lobbies found in the database. A failed database check is never overridden. Environment variables are
# ignored.
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
# Every confirmation is read from the controlling terminal (/dev/tty), never from stdin: piped input,
# here-documents, `yes`, environment variables or inherited shell state cannot answer it. Without a
# terminal (cron, CI, ssh without -t) the script refuses.
ask_tty() {  # $1 = prompt; sets TTY_REPLY to the line a person typed
  TTY_REPLY=""
  { exec 8</dev/tty; } 2>/dev/null || fail "this step needs a person at an interactive terminal (no /dev/tty); nothing was switched"
  printf '%s' "$1" >/dev/tty
  IFS= read -r TTY_REPLY <&8 || TTY_REPLY=""
  exec 8<&-
}

# Every restart first clears a "failed" state left by systemd's start limit (StartLimitBurst in the unit:
# repeated crashes or restarts within 120 s); otherwise `systemctl restart` is refused and a recovery
# restart could never bring the previous release back. Needs the reset-failed sudoers entry (checked in
# the pre-flight, before anything is switched).
restart_service() {
  sudo -n "$SYSTEMCTL" reset-failed "$SERVICE" 2>/dev/null || warn "could not clear the failed state of $SERVICE (sudo reset-failed refused)"
  sudo -n "$SYSTEMCTL" restart "$SERVICE"
}

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

LIST=0; ALLOW_ACTIVE_FLAG=0; QUEUE_UNKNOWN_FLAG=0; ARG=""
for a in "$@"; do
  case "$a" in
    --list) LIST=1 ;;
    --allow-active) ALLOW_ACTIVE_FLAG=1 ;;
    --queue-unknown) QUEUE_UNKNOWN_FLAG=1 ;;
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
# A person must confirm the switch: refuse now, before building anything, when there is no terminal.
{ exec 8</dev/tty; } 2>/dev/null || fail "run this from an interactive terminal (no /dev/tty: cron, CI and 'ssh host cmd' without -t cannot confirm)"
exec 8<&-
for cmd in "$SYSTEMCTL restart $SERVICE" "$SYSTEMCTL reset-failed $SERVICE" "$SYSTEMCTL reload nginx" "$NGINX -t"; do
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
  "$TARGET/venv/bin/python" "$SCRIPTS/active_matches.py" "$SHARED/backend.env" "$PORT" ${DRAIN_ID:+--expect-drain "$DRAIN_ID"}
  state=$?
  set -e
  local phrase
  case $state in
    0) return 0 ;;
    3)
      [[ $ALLOW_ACTIVE_FLAG -eq 1 ]] || fail "matches, lobbies or queued players are in progress; try again later (or see --allow-active)"
      warn "--allow-active was given: rolling back will interrupt play in progress."
      phrase="RESTART DURING PLAY" ;;
    4)
      [[ $QUEUE_UNKNOWN_FLAG -eq 1 ]] ||
        fail "the database shows nothing in progress, but the running backend cannot report its matchmaking queue; see --queue-unknown"
      warn "the running backend cannot report its matchmaking queue: players waiting in it will be dropped by the restart."
      phrase="QUEUE UNKNOWN" ;;
    5) fail "the restart drain lapsed or the backend restarted during the final check; nothing was switched. Run it again." ;;
    *) fail "it could not be checked whether matches are in progress (database check failed); fix the check and try again" ;;
  esac
  ask_tty "Type '$phrase' to continue: "
  [[ "$TTY_REPLY" == "$phrase" ]] || fail "not confirmed; nothing was switched"
}

# Restart drain: the running backend refuses new queue joins, game starts and public-lobby creation until
# it restarts, so nothing can begin between the final activity check and the restart.
#   * Lease: each drain lasts DRAIN_SECONDS; a background heartbeat renews it every DRAIN_RENEW_SECONDS
#     while this script runs, so it cannot lapse during a typed confirmation. The heartbeat checks every
#     second that this script is still alive, so after a kill -9 it stops within a second and the drain
#     lapses within DRAIN_SECONDS.
#   * Proof: the backend names each continuous drain (drain_id; a lapse or a restarted backend gives a new
#     or no id). The final activity check and a last renewal right before switching must both see the id
#     this script started, or nothing is switched.
#   * The heartbeat is stopped (and waited for, so no renewal is in flight) before the restart, so the new
#     process is never drained; every other exit lifts the drain at once.
DRAIN_SECONDS=300
DRAIN_RENEW_SECONDS=60
DRAINED=0
DRAIN_ID=""
HEARTBEAT_PID=""
HEARTBEAT_STOP="$BASE/.drain-heartbeat.stop"
drain_request() {  # $1 = seconds (0 lifts the drain), $2 = drain id to renew (renew only); prints the reply
  curl -fsS --max-time 5 -X POST "http://127.0.0.1:$PORT/api/internal/drain?seconds=$1${2:+&renew=$2}"
}
process_start() { [[ -r "/proc/$1/stat" ]] && sed 's/^.*) //' "/proc/$1/stat" | cut -d' ' -f20; }
drain_id_of() { sed -n 's/.*"drain_id":"\([0-9a-f]\{1,64\}\)".*/\1/p'; }
start_drain_heartbeat() {
  # The script is identified by its PID and its start time, so a reused PID never keeps the heartbeat going.
  local parent=$$ parent_start
  parent_start="$(process_start $$ 2>/dev/null || true)"
  rm -f "$HEARTBEAT_STOP"
  (
    parent_alive() {
      if [[ -n "$parent_start" ]]; then [[ "$(process_start "$parent" 2>/dev/null)" == "$parent_start" ]]
      else kill -0 "$parent" 2>/dev/null; fi
    }
    n=0
    while [[ ! -e "$HEARTBEAT_STOP" ]] && parent_alive; do
      sleep 1
      n=$((n + 1))
      # Re-check right before renewing: never renew for a script that was stopped or killed meanwhile.
      if [[ $n -ge $DRAIN_RENEW_SECONDS && ! -e "$HEARTBEAT_STOP" ]] && parent_alive; then
        n=0
        # Renew only: if this drain is no longer in force the backend refuses (409) and starts nothing.
        drain_request "$DRAIN_SECONDS" "$DRAIN_ID" >/dev/null 2>&1 || true
      fi
    done
  ) </dev/null >/dev/null 2>&1 &
  HEARTBEAT_PID=$!
}
stop_drain_heartbeat() {  # returns once the heartbeat has exited (no renewal can still be in flight)
  [[ -n "$HEARTBEAT_PID" ]] || return 0
  touch "$HEARTBEAT_STOP"
  wait "$HEARTBEAT_PID" 2>/dev/null || true
  rm -f "$HEARTBEAT_STOP"
  HEARTBEAT_PID=""
}
drain_backend() {
  local code=0 reply=""
  reply="$(drain_request "$DRAIN_SECONDS" 2>/dev/null)" || code=$?
  if [[ $code -eq 0 ]]; then
    DRAIN_ID="$(printf '%s' "$reply" | drain_id_of)"
    [[ -n "$DRAIN_ID" ]] || fail "the running backend accepted the drain but reported no drain id; nothing was switched."
    DRAINED=1
    start_drain_heartbeat
    sleep 2  # lets requests already running finish
    return 0
  fi
  [[ $code -eq 7 ]] && return 0  # nothing listening on the port: no backend, nothing can start
  if [[ $QUEUE_UNKNOWN_FLAG -eq 1 ]]; then
    warn "the running backend could not be drained (an older release?): a match could still start in the seconds before the restart (it would resume from the database afterwards)"
    return 0
  fi
  fail "the running backend could not be drained before the restart; nothing was switched. Try again later (an older release without the drain: see --queue-unknown in deploy/README.md)."
}
confirm_drain_held() {  # right before switching: the drain started by this script has held without a gap
  [[ $DRAINED -eq 1 ]] || return 0
  stop_drain_heartbeat
  local reply
  # Renew only: refused (409) if the drain lapsed or the backend restarted since it began.
  reply="$(drain_request "$DRAIN_SECONDS" "$DRAIN_ID" 2>/dev/null)" || fail "the restart drain could not be renewed right before switching (it lapsed, or the backend restarted); nothing was switched."
  [[ "$(printf '%s' "$reply" | drain_id_of)" == "$DRAIN_ID" ]] ||
    fail "the restart drain lapsed or the backend restarted since the final check (new players could have started); nothing was switched. Run it again."
}
undrain_backend() {  # an aborted run lifts the drain at once (it would also expire by itself)
  stop_drain_heartbeat
  [[ $DRAINED -eq 1 ]] || return 0
  drain_request 0 >/dev/null 2>&1 || true
  DRAINED=0
}
trap undrain_backend EXIT

echo "== matches in progress?"
activity_gate
echo "Current: $(describe "${CURRENT:-<none>}")"
echo "Target:  $(describe "$TARGET")"
ask_tty "Roll back now? [y/N] "
[[ "$TTY_REPLY" == "y" || "$TTY_REPLY" == "Y" ]] || { echo "Cancelled."; exit 1; }
echo "== draining: new queue joins and game starts are refused until the restart"
drain_backend
echo "== matches in progress? (right before switching)"
activity_gate

confirm_drain_held
switch_to "$TARGET"
DRAINED=0  # from here the restart ends the drain (a new process always starts undrained)
if restart_service && wait_healthy "$TARGET"; then
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
  restart_service || true
  wait_healthy "$CURRENT" && fail "rollback failed; the previous release ($CURRENT) is running again" ||
    fail "rollback failed and the previous release did not come back; check: journalctl -u $SERVICE -n 200"
fi
fail "rollback failed and there was no previous release to restore; check: journalctl -u $SERVICE -n 200"
