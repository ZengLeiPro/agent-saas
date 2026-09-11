#!/usr/bin/env bash
# Host-owned, reboot-resumable observation. NEVER signal, stop, or restart an App generation.
set -euo pipefail
payload="${1:?payload required}"
started="$(jq -er .startedAt "$payload/app-retirement-targets.json")"
deadline=$(( $(date -d "$started" +%s) + 7200 ))
exec 9>"$payload/observer.lock"
flock -n 9 || exit 0
while :; do
  if flock -w 35 "$payload/state.lock" timeout --foreground --signal=TERM --kill-after=5 30 node "$payload/app-retirement-evidence.mjs" observe "$payload"; then
    if jq -e '.retirementPhase=="completed"' "$payload/app-retirement-observation.json" >/dev/null; then exit 0; fi
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    jq '{schemaVersion:1,releaseId,manifestDigest,runId,runAttempt,targetDigest,status:"needs_human",reason:"retirement_deadline_or_evidence_gap",action:"preserve_generation_and_inspect_durable_work"}' \
      "$payload/app-retirement-targets.json" > "$payload/app-retirement-alert.json.candidate"
    mv -f "$payload/app-retirement-alert.json.candidate" "$payload/app-retirement-alert.json"
    sync -f "$payload"
    cat "$payload/app-retirement-alert.json" >&2
    exit 1
  fi
  sleep 30
done
