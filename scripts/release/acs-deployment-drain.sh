#!/usr/bin/env bash
# Sourced under the production host lock. Runtime override prevents systemd from
# replacing the observed old PID before its terminal outcome can be verified.
ACS_DRAIN_PID=''
ACS_DRAIN_PROTOCOL=''
ACS_DRAIN_DROPIN=''

release_acs_drain_guard() {
  [ -n "$ACS_DRAIN_DROPIN" ] || return 0
  rm -f "$ACS_DRAIN_DROPIN" || return 1
  systemctl daemon-reload || return 1
  ACS_DRAIN_DROPIN=''
}

cancel_acs_deployment_drain() {
  [ -n "$ACS_DRAIN_PID" ] || return 0
  release_acs_drain_guard || return 1
  [ "${acs_mutation_started:-false}" != true ] || return 0
  if systemctl is-active --quiet "$ACS_SERVICE_NAME"; then
    [ "$(systemctl show "$ACS_SERVICE_NAME" --property=MainPID --value)" = "$ACS_DRAIN_PID" ] || return 1
    [ "$ACS_DRAIN_PROTOCOL" = 1 ] || {
      echo 'Legacy ACS is still draining; preserving accepted work for manual recovery' >&2
      return 1
    }
    kill -USR1 "$ACS_DRAIN_PID" || return 1
    for _ in $(seq 1 10); do
      if curl -fsS --max-time 3 "${ACS_HEALTH_URL:-http://127.0.0.1:3400/health}" \
        | jq -e --argjson pid "$ACS_DRAIN_PID" '.deploymentDrain.pid==$pid and .draining==false' >/dev/null; then
        return 0
      fi
      sleep 1
    done
    return 1
  fi
  # No current/env mutation has happened: a stopped old process can be restored.
  systemctl start "$ACS_SERVICE_NAME"
}

drain_acs_before_cutover() {
  local health state status code result deadline proof current_pid terminal_pid next_progress
  systemctl is-active --quiet "$ACS_SERVICE_NAME" || {
    echo 'ACS must be healthy before starting its generation handoff' >&2; return 1;
  }
  ACS_DRAIN_PID="$(systemctl show "$ACS_SERVICE_NAME" --property=MainPID --value)"
  [[ "$ACS_DRAIN_PID" =~ ^[1-9][0-9]*$ ]] || return 1
  health="$(curl -fsS --max-time 10 "${ACS_HEALTH_URL:-http://127.0.0.1:3400/health}")" || return 1
  ACS_DRAIN_PROTOCOL="$(printf '%s' "$health" | jq -r '.deploymentDrain.protocolVersion // 0')"
  if [ "$ACS_DRAIN_PROTOCOL" = 1 ]; then
    printf '%s' "$health" | jq -e --argjson pid "$ACS_DRAIN_PID" '.deploymentDrain.pid==$pid and .draining==false' >/dev/null || return 1
  elif [ "$ACS_DRAIN_PROTOCOL" = 0 ]; then
    # Compatibility handoff: stop admission first, then wait for accepted work.
    # The old binary still owns its timeout; an abnormal exit must never count
    # as a successful drain or trigger a forced candidate restart.
    printf '%s' "$health" | jq -e '.draining==false and (.inflight | type=="number" and .>=0 and floor==.)' >/dev/null || {
      ACS_DRAIN_PID=''
      echo 'Legacy ACS must report valid inflight work and must not already be draining' >&2
      return 75
    }
    printf 'Legacy ACS: stopping admission and waiting for accepted work: %s\n' \
      "$(printf '%s' "$health" | jq -c '{inflight,draining,drainDeadlineMs:.lifecycle.drainDeadlineMs}')" >&2
    echo 'WARNING: legacy runtime may exit on its own drain timeout; abnormal exit will fail this promotion, not force a candidate restart' >&2
  else
    ACS_DRAIN_PID=''
    echo 'Unsupported ACS deployment drain protocol; refusing to signal the process' >&2
    return 1
  fi
  local unit="${ACS_SERVICE_NAME%.service}.service"
  local dropin_root="${ACS_SYSTEMD_RUNTIME_ROOT:-/run/systemd/system}/$unit.d"
  mkdir -p "$dropin_root"
  ACS_DRAIN_DROPIN="$dropin_root/90-agent-saas-promotion-drain.conf"
  [ ! -e "$ACS_DRAIN_DROPIN" ] || { ACS_DRAIN_DROPIN=''; ACS_DRAIN_PID=''; echo 'Existing ACS drain guard requires recovery' >&2; return 1; }
  (set -o noclobber; printf '[Service]\nRestart=no\n' > "$ACS_DRAIN_DROPIN") || return 1
  systemctl daemon-reload || return 1
  kill -USR2 "$ACS_DRAIN_PID" || return 1
  deadline=$((SECONDS + 660))
  next_progress=$SECONDS
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(systemctl show "$ACS_SERVICE_NAME" --property=ActiveState --value)" || return 1
    if [ "$SECONDS" -ge "$next_progress" ]; then
      printf 'Waiting for ACS drain: pid=%s protocol=%s state=%s remainingSeconds=%s\n' \
        "$ACS_DRAIN_PID" "$ACS_DRAIN_PROTOCOL" "$state" "$((deadline - SECONDS))" >&2
      next_progress=$((SECONDS + 15))
    fi
    if [ "$state" = inactive ] || [ "$state" = failed ]; then
      terminal_pid="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainPID --value)" || return 1
      status="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainStatus --value)" || return 1
      code="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainCode --value)" || return 1
      result="$(systemctl show "$ACS_SERVICE_NAME" --property=Result --value)" || return 1
      [ "$state:$status:$code:$result:$terminal_pid" = "inactive:0:1:success:$ACS_DRAIN_PID" ] || {
        echo "ACS did not exit cleanly (expectedPid=$ACS_DRAIN_PID terminalPid=$terminal_pid state=$state status=$status code=$code result=$result)" >&2; return 1;
      }
      proof="$(dirname "$MANIFEST_PATH")/acs-drain-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json"
      if [ "$ACS_DRAIN_PROTOCOL" = 1 ]; then
        jq -e --argjson pid "$ACS_DRAIN_PID" '.protocolVersion==1 and .pid==$pid and .state=="completed" and .inflight==0' \
          "${ACS_DRAIN_STATE_PATH:-/run/agent-saas-acs-drain.json}" >/dev/null || return 1
      fi
      jq -n --argjson pid "$ACS_DRAIN_PID" --argjson protocol "$ACS_DRAIN_PROTOCOL" \
        --arg releaseId "$release_id" --arg manifestDigest "$manifest_digest" \
        '{schemaVersion:1,releaseId:$releaseId,manifestDigest:$manifestDigest,pid:$pid,protocolVersion:$protocol,state:"completed",exitStatus:0}' > "$proof" || return 1
      chmod 0444 "$proof"
      return 0
    fi
    case "$state" in active|deactivating) ;; *) echo "Unexpected ACS drain state: $state" >&2; return 1 ;; esac
    current_pid="$(systemctl show "$ACS_SERVICE_NAME" --property=MainPID --value)" || return 1
    # The process can exit between these separate systemd reads. MainPID=0 is
    # absence, not replacement; await the terminal state and exact ExecMainPID proof.
    [ "$current_pid" = 0 ] || [ "$current_pid" = "$ACS_DRAIN_PID" ] || {
      echo "ACS PID changed before its drain outcome was verified (expected=$ACS_DRAIN_PID observed=$current_pid state=$state)" >&2; return 1;
    }
    if [ "$current_pid" = 0 ] || [ "$state" = deactivating ]; then sleep 1; continue; fi
    if [ "$ACS_DRAIN_PROTOCOL" = 1 ]; then
      health="$(curl -fsS --max-time 5 "${ACS_HEALTH_URL:-http://127.0.0.1:3400/health}")" || { sleep 1; continue; }
      if printf '%s' "$health" | jq -e '.deploymentDrain.state=="timed_out" or .deploymentDrain.state=="cancelled"' >/dev/null; then
        echo 'ACS drain was cancelled or reached its safe deadline; old work was preserved' >&2; return 1
      fi
    fi
    sleep 1
  done
  echo 'ACS drain deadline exceeded; refusing to terminate accepted work' >&2
  return 1
}
