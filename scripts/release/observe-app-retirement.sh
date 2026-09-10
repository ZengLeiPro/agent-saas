#!/usr/bin/env bash
# Host-owned observation survives the GitHub runner. It NEVER signals or stops a generation.
set -euo pipefail
payload="${1:?payload required}"
output="$payload/app-retirement-observation.json"
deadline=$((SECONDS + 7200))
while :; do
  if bash "$payload/verify-app-retirement.sh" "$payload/manifest.json" > "$output.candidate"; then
    mv -f "$output.candidate" "$output"
    cat "$output" # bounded, content-free journald evidence
    if jq -e '.status=="not_required" or .retirementPhase=="completed"' "$output" >/dev/null; then exit 0; fi
  else
    rm -f "$output.candidate"
    jq -nc '{schemaVersion:1,status:"needs_human",reason:"retirement_observation_failed",action:"preserve_retired_generation"}' > "$output"
    cat "$output" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo 'Retired generation remains draining or unverified after two hours; operator inspection is required, no forced stop was performed' >&2
    exit 1
  fi
  sleep 30
done
