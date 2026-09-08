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
  local health state status code result deadline proof
  systemctl is-active --quiet "$ACS_SERVICE_NAME" || {
    echo 'ACS must be healthy before starting its generation handoff' >&2; return 1;
  }
  ACS_DRAIN_PID="$(systemctl show "$ACS_SERVICE_NAME" --property=MainPID --value)"
  [[ "$ACS_DRAIN_PID" =~ ^[1-9][0-9]*$ ]] || return 1
  health="$(curl -fsS --max-time 10 "${ACS_HEALTH_URL:-http://127.0.0.1:3400/health}")" || return 1
  ACS_DRAIN_PROTOCOL="$(printf '%s' "$health" | jq -r '.deploymentDrain.protocolVersion // 0')"
  if [ "$ACS_DRAIN_PROTOCOL" = 1 ]; then
    printf '%s' "$health" | jq -e --argjson pid "$ACS_DRAIN_PID" '.deploymentDrain.pid==$pid and .draining==false' >/dev/null || return 1
  else
    # The first upgrade cannot change the old binary's unsafe timeout behavior.
    # Require a quiet old generation and still prove its clean exit below.
    printf '%s' "$health" | jq -e '.inflight==0 and .draining==false' >/dev/null || {
      ACS_DRAIN_PID=''
      echo 'Legacy ACS upgrade requires zero inflight work; retry after it drains naturally' >&2
      return 75
    }
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
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(systemctl show "$ACS_SERVICE_NAME" --property=ActiveState --value)" || return 1
    if [ "$state" = inactive ] || [ "$state" = failed ]; then
      status="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainStatus --value)" || return 1
      code="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainCode --value)" || return 1
      result="$(systemctl show "$ACS_SERVICE_NAME" --property=Result --value)" || return 1
      [ "$state:$status:$code:$result" = inactive:0:1:success ] || {
        echo "ACS did not exit cleanly (pid=$ACS_DRAIN_PID state=$state status=$status code=$code result=$result)" >&2; return 1;
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
    [ "$state" = active ] || return 1
    [ "$(systemctl show "$ACS_SERVICE_NAME" --property=MainPID --value)" = "$ACS_DRAIN_PID" ] || {
      echo 'ACS PID changed before its drain outcome was verified' >&2; return 1;
    }
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
