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
gate="$(dirname "$0")/app-retirement-verify-gate.mjs"
[ -f "$gate" ] || { echo "app-retirement verify gate is missing" >&2; exit 1; }

collect_live() {
  local observation="$1" live="$2"
  python3 - "$observation" "$live" <<'PY'
import json, os, subprocess, sys
observation = json.loads(open(sys.argv[1], encoding='utf-8').read())
units = {
    'api': 'agent-saas-server',
    'runtimeWorker': 'agent-saas-runtime-worker',
}
live = {'runtimeWorker': {}, 'markers': {}}
for item in observation.get('components') or []:
    prefix = units.get(item.get('role'))
    color = item.get('color')
    if not prefix or color not in ('blue', 'green'):
        continue
    unit = f'{prefix}@{color}'
    props = subprocess.check_output(
        ['systemctl', 'show', unit, '--property=ActiveState,UnitFileState,MainPID,Result'],
        text=True,
    )
    parsed = {}
    for line in props.splitlines():
        key, _, value = line.partition('=')
        parsed[key] = value
    pid = str(item.get('pid') or '')
    live_key = 'runtimeWorker' if item.get('role') == 'runtimeWorker' else item.get('role')
    live[live_key] = {
        'activeState': parsed.get('ActiveState', ''),
        'unitFileState': parsed.get('UnitFileState', ''),
        'mainPid': int(parsed.get('MainPID') or 0),
        'result': parsed.get('Result', ''),
        'processGone': not (pid.isdigit() and os.path.isdir(f'/proc/{pid}')),
    }
    marker_path = f'/run/{prefix}-{color}.draining'
    if os.path.isfile(marker_path):
        live.setdefault('markers', {})[live_key] = json.loads(open(marker_path, encoding='utf-8').read())
json.dump(live, open(sys.argv[2], 'w', encoding='utf-8'))
PY
}

retry_seconds="${VERIFY_APP_RETIREMENT_RETRY_SECONDS:-600}"
retry_sleep="${VERIFY_APP_RETIREMENT_RETRY_SLEEP:-15}"
deadline=$((SECONDS + retry_seconds))
while :; do
  flock -w 35 "$root/state.lock" timeout --foreground --signal=TERM --kill-after=5 30 \
    node "$root/app-retirement-evidence.mjs" observe "$root" > /dev/null
  live="$root/app-retirement-live.json"
  collect_live "$root/app-retirement-observation.json" "$live"
  set +e
  node "$gate" \
    --observation "$root/app-retirement-observation.json" \
    --manifest "$manifest" \
    --targets "$targets" \
    --live "$live" \
    > "$root/app-retirement-gate.json"
  status=$?
  set -e
  cat "$root/app-retirement-gate.json" >&2 || true
  if [ "$status" -eq 0 ]; then
    jq -c --arg releaseId "$(jq -r .releaseId "$manifest")" --arg digest "$(jq -r .digest "$manifest")" \
      --arg target "$(jq -r .targetDigest "$targets")" \
      'select(.releaseId==$releaseId and .manifestDigest==$digest and .targetDigest==$target)' \
      "$root/app-retirement-observation.json"
    exit 0
  fi
  if [ "$status" -eq 75 ] && [ "$SECONDS" -lt "$deadline" ]; then
    echo "app-retirement still draining; retrying" >&2
    sleep "$retry_sleep"
    continue
  fi
  echo "app-retirement verify failed (status=$status)" >&2
  jq -c '{status,retirementPhase,components}' "$root/app-retirement-observation.json" >&2 || true
  exit 1
done
