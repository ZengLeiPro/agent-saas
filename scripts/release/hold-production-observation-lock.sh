#!/usr/bin/env bash
set -euo pipefail

# This entrypoint only leases the same host lock used by all production writers.
# It MUST NOT require a forward phase matrix, clear rollback receipts, check a
# pending Web journal, deploy a component, or publish a trusted identity.
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${OBSERVATION_LOCK_READY:?OBSERVATION_LOCK_READY is required}"
: "${OBSERVATION_LOCK_RELEASE:?OBSERVATION_LOCK_RELEASE is required}"
[[ "$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]] || exit 2
prefix="/tmp/agent-saas-promotion-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-identity-lock"
[ "$OBSERVATION_LOCK_READY" = "$prefix.ready" ] || exit 2
[ "$OBSERVATION_LOCK_RELEASE" = "$prefix.release" ] || exit 2
wait_seconds="${OBSERVATION_LOCK_TIMEOUT_SECONDS:-900}"
[[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] && [ "$wait_seconds" -le 900 ] || exit 2

# PRODUCTION_LOCK_FILE is also used by the isolated lock tests. The workflow does
# not forward it, so the production entry always uses the fixed shared host lock.
lock="${PRODUCTION_LOCK_FILE:-/run/lock/agent-saas/promotion.lock}"
mkdir -p "$(dirname "$lock")"
exec 9>"$lock"
flock -n 9 || { echo 'Another production promotion is active' >&2; exit 1; }
rm -f -- "$OBSERVATION_LOCK_READY" "$OBSERVATION_LOCK_RELEASE"
cleanup() { rm -f -- "$OBSERVATION_LOCK_READY" "$OBSERVATION_LOCK_RELEASE"; }
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
install -m 0600 /dev/null "$OBSERVATION_LOCK_READY"
deadline=$((SECONDS + wait_seconds))
while [ ! -f "$OBSERVATION_LOCK_RELEASE" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo 'Production observation lock expired before release' >&2
    exit 70
  fi
  sleep 1
done
