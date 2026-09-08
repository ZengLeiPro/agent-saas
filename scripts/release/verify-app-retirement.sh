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
  if [ "$state:$main_pid" = inactive:0 ]; then return 0; fi
  [ "$state" = active ] || { echo "Retired unit lacks a safe terminal state: $unit" >&2; return 1; }
  pid="$(cat "$run_root/agent-saas-$role-$retired.pid")" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [ "$pid" = "$main_pid" ] || return 1
  marker="$run_root/agent-saas-$role-$retired.draining"
  jq -se --argjson pid "$pid" \
    'length==1 and (.[0] | type=="object" and .pid==$pid and (.runtimeQuiesced|type)=="boolean" and (.activeStreams|type)=="number" and (.activeUploads|type)=="number")' \
    "$marker" >/dev/null || return 1
}
verify_retired runtime-worker runtime-worker-active-color
verify_retired server active-color
jq -n --arg releaseId "$(jq -r .releaseId "$manifest")" --arg manifestDigest "$(jq -r .digest "$manifest")" \
  '{schemaVersion:1,releaseId:$releaseId,manifestDigest:$manifestDigest,status:"acknowledged"}'
