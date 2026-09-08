#!/usr/bin/env bash
set -euo pipefail

# Run as root from the promotion payload. Hold the same host lock as every publisher
# across fresh readback, manifest comparison and pointer replacement.
[ "$#" -eq 3 ] || { echo 'Expected payload directory, run id and attempt' >&2; exit 64; }
payload=$1
run_id=$2
run_attempt=$3
printf '%s:%s' "$run_id" "$run_attempt" | grep -Eq '^[1-9][0-9]*:[1-9][0-9]*$'
lock=/run/lock/agent-saas/promotion.lock
mkdir -p "$(dirname "$lock")"
exec 9>"$lock"
flock -n 9 || { echo 'Another production promotion is active' >&2; exit 1; }
node "$payload/read-production-state.mjs" --output "$payload/state.json" >/dev/null
node "$payload/production-checkpoint.mjs" create \
  --manifest "$payload/manifest.json" --state "$payload/state.json" \
  --attestations "$payload/attestations.jsonl" --run-id "$run_id" --run-attempt "$run_attempt" \
  --output "$payload/checkpoint.json"
install -m 0600 "$payload/checkpoint.json" /etc/agent-saas/last-committed-production.json.next
mv /etc/agent-saas/last-committed-production.json.next /etc/agent-saas/last-committed-production.json
