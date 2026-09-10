#!/usr/bin/env bash
# Read-only finalization proof. Called under the existing production lock lease.
set -euo pipefail
manifest="${1:?Manifest required}"
run_root="${APP_RETIREMENT_RUN_ROOT:-/run}"
config_root="${APP_RETIREMENT_CONFIG_ROOT:-/etc/agent-saas}"
api_action="$(jq -r .components.api.action "$manifest")"
worker_action="$(jq -r .components.runtimeWorker.action "$manifest")"
if [ "$api_action:$worker_action" = keep:keep ]; then
  echo '{"schemaVersion":1,"status":"not_required"}'
  exit 0
fi
[ "$api_action:$worker_action" = deploy:deploy ] || { echo 'App retirement requires one App action' >&2; exit 1; }
observations=()
verify_retired() {
  local role="$1" active_file="$2" active retired unit state pid main_pid marker
  active="$(tr -d '[:space:]' < "$config_root/$active_file")"
  case "$active" in blue) retired=green ;; green) retired=blue ;; *) return 1 ;; esac
  unit="agent-saas-$role@$retired"
  if systemctl is-enabled --quiet "$unit"; then
    echo "Retired unit remains enabled: $unit" >&2; return 1
  fi
  state="$(systemctl show "$unit" --property=ActiveState --value)" || return 1
  main_pid="$(systemctl show "$unit" --property=MainPID --value)" || return 1
  marker="$run_root/agent-saas-$role-$retired.draining"
  if [ "$state:$main_pid" = inactive:0 ]; then
    local phase=terminal_unverified
    if [ -f "$marker" ]; then
      # A failed/timed-out quiesce must not turn into a clean retirement because its PID exited.
      jq -e 'type=="object" and (.drainState!="failed" and .drainState!="timed_out")' "$marker" >/dev/null || return 1
      if jq -e '.drainState=="completed" and .runtimeQuiesced==true and .activeStreams==0 and .activeUploads==0 and (.registeredRuns // 0)==0' "$marker" >/dev/null; then
        [ "$(systemctl show "$unit" --property=ExecMainPID --value)" = "$(jq -r .pid "$marker")" ] || return 1
        [ "$(systemctl show "$unit" --property=Result --value)" = success ] || return 1
        phase=completed
      fi
    fi
    observations+=("$(jq -nc --arg role "$role" --arg color "$retired" --arg phase "$phase" '{role:$role,color:$color,phase:$phase}')")
    return 0
  fi
  [ "$state" = active ] || { echo "Retired unit lacks a safe terminal state: $unit" >&2; return 1; }
  pid="$(cat "$run_root/agent-saas-$role-$retired.pid")" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" = "$main_pid" ] || return 1
  marker="$run_root/agent-saas-$role-$retired.draining"
  jq -se --argjson pid "$pid" \
    'length==1 and (.[0] | type=="object" and .pid==$pid and (.runtimeQuiesced|type)=="boolean" and (.activeStreams|type)=="number" and (.activeUploads|type)=="number")' \
    "$marker" >/dev/null || return 1
  jq -e '.drainState!="failed" and .drainState!="timed_out"' "$marker" >/dev/null || return 1
  observations+=("$(jq -c --arg role "$role" --arg color "$retired" '{role:$role,color:$color,phase:"draining",pid,activeStreams,activeUploads,runtimeQuiesced,registeredRuns,cancelledAwaitingFinalization,handoffRequested,oldestRunAgeMs}' "$marker")")
}
verify_retired runtime-worker runtime-worker-active-color
verify_retired server active-color
jq -n --arg releaseId "$(jq -r .releaseId "$manifest")" --arg manifestDigest "$(jq -r .digest "$manifest")" \
  --argjson components "$(printf '%s\n' "${observations[@]}" | jq -s .)" \
  '{schemaVersion:1,releaseId:$releaseId,manifestDigest:$manifestDigest,status:"acknowledged",retirementPhase:(if all($components[];.phase=="completed") then "completed" else "draining_or_unverified" end),components:$components}'
