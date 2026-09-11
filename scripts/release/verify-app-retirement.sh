#!/usr/bin/env bash
# The independent observer owns finalization; never infer an old generation from today's active color.
set -euo pipefail
manifest="${1:?Manifest required}"
if [ "$(jq -r .components.api.action "$manifest")":"$(jq -r .components.runtimeWorker.action "$manifest")" = keep:keep ]; then
  echo '{"schemaVersion":1,"status":"not_required"}'
  exit 0
fi
targets="$(dirname "$manifest")/app-retirement-targets.json"
run="$(jq -er .runId "$targets")"; attempt="$(jq -er .runAttempt "$targets")"
[[ "$run" =~ ^[1-9][0-9]*$ && "$attempt" =~ ^[1-9][0-9]*$ ]]
root="/var/lib/agent-saas-release-recovery/retirements/$run-$attempt"
cmp "$targets" "$root/app-retirement-targets.json"
# Re-query now rather than accepting a stale healthy snapshot. Serialized with the observer.
flock -w 35 "$root/state.lock" timeout --foreground --signal=TERM --kill-after=5 30 \
  node "$root/app-retirement-evidence.mjs" observe "$root" > /dev/null
jq -ce --arg releaseId "$(jq -r .releaseId "$manifest")" --arg digest "$(jq -r .digest "$manifest")" \
  --arg target "$(jq -r .targetDigest "$targets")" \
  'select(.releaseId==$releaseId and .manifestDigest==$digest and .targetDigest==$target and .status=="acknowledged")' \
  "$root/app-retirement-observation.json"
