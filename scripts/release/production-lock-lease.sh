#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
token="${2:-}"
lock_timeout="${PRODUCTION_LOCK_TIMEOUT_SECONDS:-1800}"
lock_file="${PRODUCTION_LOCK_FILE:-/run/lock/agent-saas/promotion.lock}"
state_base="${PRODUCTION_LOCK_STATE_ROOT:-/run/agent-saas-locks}"

printf '%s' "$token" | grep -Eq '^[0-9]+-[0-9]+-[a-z0-9-]+$' || {
  echo 'Production lock token is invalid' >&2
  exit 2
}
printf '%s' "$lock_timeout" | grep -Eq '^[1-9][0-9]*$' || {
  echo 'Production lock timeout is invalid' >&2
  exit 2
}

state_root="$state_base/$token"
ready="$state_root/ready"
release="$state_root/release"
pid_file="$state_root/pid"
start_time_file="$state_root/start-time"

assert_lease() {
  test -d "$state_root"
  test ! -L "$state_root"
  test -f "$ready"
  test ! -e "$release"
  pid="$(cat "$pid_file")"
  expected_start_time="$(cat "$start_time_file")"
  printf '%s' "$pid" | grep -Eq '^[1-9][0-9]*$'
  printf '%s' "$expected_start_time" | grep -Eq '^[1-9][0-9]*$'
  kill -0 "$pid"
  test "$(awk '{print $22}' "/proc/$pid/stat")" = "$expected_start_time"
  test "$(readlink -f "/proc/$pid/fd/9")" = "$(readlink -f "$lock_file")"
  exec 8>"$lock_file"
  if flock -n 8; then
    echo 'Production lock lease is not held' >&2
    return 1
  fi
}

case "$mode" in
  hold)
    mkdir -p "$(dirname "$lock_file")" "$state_base"
    exec 9>"$lock_file"
    flock -n 9 || {
      echo 'Another production promotion is active' >&2
      exit 1
    }
    rm -rf "$state_root"
    mkdir -m 0700 "$state_root"
    cleanup() {
      rm -rf "$state_root"
    }
    trap cleanup EXIT
    trap 'exit 130' HUP INT TERM
    printf '%s\n' "$$" > "$pid_file"
    awk '{print $22}' "/proc/$$/stat" > "$start_time_file"
    install -m 0444 /dev/null "$ready"
    deadline=$((SECONDS + lock_timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
      [ ! -e "$release" ] || exit 0
      sleep 1
    done
    echo 'Production lock lease expired before release' >&2
    exit 70
    ;;
  assert)
    assert_lease
    ;;
  release)
    assert_lease
    install -m 0444 /dev/null "$release"
    deadline=$((SECONDS + 30))
    while [ "$SECONDS" -lt "$deadline" ]; do
      [ -e "$state_root" ] || exit 0
      sleep 1
    done
    echo 'Production lock lease did not terminate after release' >&2
    exit 70
    ;;
  *)
    echo 'Usage: production-lock-lease.sh hold|assert|release <token>' >&2
    exit 2
    ;;
esac
