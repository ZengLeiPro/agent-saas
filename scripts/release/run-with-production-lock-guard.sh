#!/usr/bin/env bash
set -euo pipefail

: "${ECS_USER:?ECS_USER is required}"
: "${ECS_HOST:?ECS_HOST is required}"
: "${PRODUCTION_LOCK_SCRIPT:?PRODUCTION_LOCK_SCRIPT is required}"
: "${PRODUCTION_LOCK_TOKEN:?PRODUCTION_LOCK_TOKEN is required}"
: "${PRODUCTION_LOCK_SSH_KEY:?PRODUCTION_LOCK_SSH_KEY is required}"
[ "$#" -gt 0 ] || { echo 'a guarded command is required' >&2; exit 64; }

guarded_pid=''
launcher_pid=''
pid_file="${RUNNER_TEMP:-/tmp}/production-lock-guard-${BASHPID}.pid"
assert_lock() {
  timeout --signal=TERM --kill-after=2 10 ssh -i "$PRODUCTION_LOCK_SSH_KEY" \
    -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 \
    "$ECS_USER@$ECS_HOST" \
    "sudo bash '$PRODUCTION_LOCK_SCRIPT' assert '$PRODUCTION_LOCK_TOKEN'"
}
terminate_guarded() {
  [ -n "$launcher_pid" ] || return 0
  if [ -n "$guarded_pid" ]; then
    kill -- "-$guarded_pid" 2>/dev/null || true
    # Give cooperative children a short TERM grace period before forcing the whole group down.
    for _ in $(seq 1 10); do
      kill -0 "$guarded_pid" 2>/dev/null || break
      state="$(ps -o stat= -p "$guarded_pid" 2>/dev/null || true)"
      [[ "$state" == Z* ]] && break
      sleep 0.2
    done
    if kill -0 "$guarded_pid" 2>/dev/null; then
      state="$(ps -o stat= -p "$guarded_pid" 2>/dev/null || true)"
      if [[ "$state" != Z* ]]; then
        kill -KILL -- "-$guarded_pid" 2>/dev/null || true
      fi
    fi
  fi
  wait "$launcher_pid" 2>/dev/null || true
  guarded_pid=''
  launcher_pid=''
}
cleanup() {
  status=$?
  trap - EXIT
  terminate_guarded
  rm -f -- "$pid_file"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

assert_lock
rm -f -- "$pid_file"
setsid --wait bash -c 'printf "%s\n" "$$" > "$1"; shift; exec "$@"' \
  production-lock-guard "$pid_file" "$@" &
launcher_pid=$!
for _ in $(seq 1 50); do
  [ -s "$pid_file" ] && break
  kill -0 "$launcher_pid" 2>/dev/null || break
  sleep 0.02
done
[ -s "$pid_file" ] || { echo 'guarded process group did not start' >&2; exit 70; }
read -r guarded_pid < "$pid_file"
[[ "$guarded_pid" =~ ^[1-9][0-9]*$ ]] || { echo 'invalid guarded process group id' >&2; exit 70; }

next_owner_check=$SECONDS
while kill -0 "$launcher_pid" 2>/dev/null; do
  if [ "$SECONDS" -ge "$next_owner_check" ]; then
    if ! assert_lock; then
      terminate_guarded
      echo 'Production host lock owner proof was lost; guarded mutation process group was terminated' >&2
      exit 70
    fi
    next_owner_check=$((SECONDS + 1))
  fi
  sleep 0.2
done
status=0
wait "$launcher_pid" || status=$?
guarded_pid=''
launcher_pid=''
[ "$status" -eq 0 ] || exit "$status"
assert_lock
