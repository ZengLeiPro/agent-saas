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
arm_file="${pid_file}.armed"
assert_lock() {
  timeout --signal=TERM --kill-after=2 10 ssh -i "$PRODUCTION_LOCK_SSH_KEY" \
    -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 \
    "$ECS_USER@$ECS_HOST" \
    "sudo bash '$PRODUCTION_LOCK_SCRIPT' assert '$PRODUCTION_LOCK_TOKEN'"
}
capture_guarded_pid() {
  [ -z "$guarded_pid" ] || return 0
  [ -s "$pid_file" ] || return 1
  read -r guarded_pid < "$pid_file"
  [[ "$guarded_pid" =~ ^[1-9][0-9]*$ ]] || {
    echo 'invalid guarded process group id' >&2
    guarded_pid=''
    return 70
  }
}
process_group_exists() {
  [ -n "$guarded_pid" ] && kill -0 -- "-$guarded_pid" 2>/dev/null
}
terminate_process_group() {
  process_group_exists || return 0
  kill -- "-$guarded_pid" 2>/dev/null || true
  # Give cooperative children a short TERM grace period before forcing the whole group down.
  for _ in $(seq 1 10); do
    process_group_exists || break
    sleep 0.2
  done
  process_group_exists && kill -KILL -- "-$guarded_pid" 2>/dev/null || true
}
confirm_process_group_stopped() {
  for _ in $(seq 1 50); do
    process_group_exists || return 0
    sleep 0.1
  done
  echo 'guarded mutation process group survived TERM/KILL' >&2
  return 70
}
terminate_guarded() {
  if [ -z "$guarded_pid" ] && [ -n "$launcher_pid" ]; then
    # The child cannot exec the mutation until arm_file exists. During startup cancellation,
    # wait for its PGID handshake so cleanup can terminate the correct session, not just setsid.
    for _ in $(seq 1 50); do
      capture_guarded_pid && break
      kill -0 "$launcher_pid" 2>/dev/null || break
      sleep 0.02
    done
  fi
  if [ -n "$guarded_pid" ]; then
    terminate_process_group
  elif [ -n "$launcher_pid" ]; then
    kill "$launcher_pid" 2>/dev/null || true
  fi
  if [ -n "$launcher_pid" ]; then
    wait "$launcher_pid" 2>/dev/null || true
    launcher_pid=''
  fi
  [ -z "$guarded_pid" ] || confirm_process_group_stopped
}
cleanup() {
  status=$?
  trap - EXIT
  if ! terminate_guarded; then status=70; fi
  rm -f -- "$pid_file" "$arm_file"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

assert_lock
rm -f -- "$pid_file" "$arm_file"
setsid --wait bash -c '
  pid_file=$1
  arm_file=$2
  shift 2
  printf "%s\n" "$$" > "$pid_file"
  while [ ! -e "$arm_file" ]; do sleep 0.02; done
  exec "$@"
' production-lock-guard "$pid_file" "$arm_file" "$@" &
launcher_pid=$!
for _ in $(seq 1 50); do
  capture_guarded_pid && break
  kill -0 "$launcher_pid" 2>/dev/null || break
  sleep 0.02
done
[ -n "$guarded_pid" ] || { echo 'guarded process group did not start' >&2; exit 70; }
: > "$arm_file"

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
launcher_pid=''
# A command may exit while background children in its process group continue mutating.
terminate_guarded
guarded_pid=''
[ "$status" -eq 0 ] || exit "$status"
assert_lock
