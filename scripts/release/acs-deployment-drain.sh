#!/usr/bin/env bash
# Sourced under the production host lock. Runtime override prevents systemd from
# replacing the observed old PID before its terminal outcome can be verified.
ACS_DRAIN_PID=''
ACS_DRAIN_PROTOCOL=''
ACS_DRAIN_DROPIN=''
ACS_DRAIN_LAST_INFLIGHT=unknown
ACS_DRAIN_DIAGNOSTICS_LAST_FINGERPRINT=''
ACS_DRAIN_DIAGNOSTICS_FAILURES=0
# 外层等待窗口。ACS 进程内部的 deadline 必须严格小于它：进程一旦自己把 drain
# 判成 timed_out 就会恢复准入并放弃换代，此时外层再长的等待都没有意义。
#
# drain 等的是单次工具调用跑完（/execute-stream 一个请求 = 一次工具调用），而前台
# Shell 的 timeoutMs 默认即顶格 30 分钟（server 的 DEFAULT_SHELL_TIMEOUT_MS =
# MAX_SHELL_TIMEOUT_MS）。窗口取 20 分钟：盖住绝大多数真实调用，又不至于让准入
# 长时间停摆；撞上顶格长任务仍会超时失败，此时旧工作原样保留、回滚照走。
ACS_DRAIN_WINDOW_SECONDS=1200
# 留给终态取证与回执落盘的余量。
ACS_DRAIN_DEADLINE_MARGIN_SECONDS=60

acs_runtime_config_url() {
  local health="${ACS_HEALTH_URL:-http://127.0.0.1:3400/health}"
  printf '%s' "${health%/health}/runtime-config"
}

# Bearer token 只经 stdin 交给 curl，避免出现在 /proc/*/cmdline 里；-q 必须是首参数
# 才能挡掉可能开了 verbose 的 .curlrc，否则 Authorization 头会被打进部署日志。
_acs_runtime_config_request() {
  local token env_path="${ACS_ENV_PATH:-/etc/agent-saas/acs-orchestrator.env}"
  [ -r "$env_path" ] || { echo "ACS env file is unreadable: $env_path" >&2; return 1; }
  token="$(sed -n 's/^[[:space:]]*ACS_ORCH_AUTH_TOKEN=//p' "$env_path" | tail -n1)" || return 1
  token="${token%\"}"
  token="${token#\"}"
  [ -n "$token" ] || { echo 'ACS_ORCH_AUTH_TOKEN is missing from the ACS env file' >&2; return 1; }
  printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -q -fsS --max-time 10 -K - "$@"
}

# xtrace 会把上面 printf 的参数原样展开到 stderr，凭据必须在此期间关掉它。
acs_runtime_config_request() {
  local resume_xtrace='' status=0
  case "$-" in *x*) resume_xtrace='set -x'; set +x ;; esac
  _acs_runtime_config_request "$@" || status=$?
  ${resume_xtrace:-:}
  return "$status"
}

# Select the independent capability when available. During the first upgrade an old
# protocol-1 process can still drain with its existing shorter deadline. Never stretch
# its shared SNAT timeout: a busy old binary may safely refuse this attempt, not kill work.
align_acs_drain_deadline() {
  local target current applied configuration
  target=$(((ACS_DRAIN_WINDOW_SECONDS - ACS_DRAIN_DEADLINE_MARGIN_SECONDS) * 1000))
  [ "$target" -ge 1000 ] || { echo 'ACS drain window is too small to align' >&2; return 1; }
  configuration="$(acs_runtime_config_request "$(acs_runtime_config_url)")" || return 1
  current="$(printf '%s' "$configuration" | jq -r '.runtimeConfig.deploymentDrainDeadlineMs // empty')" || return 1
  if [ -z "$current" ]; then
    current="$(printf '%s' "$configuration" | jq -r '.runtimeConfig.drainDeadlineMs // empty')" || return 1
    [[ "$current" =~ ^[1-9][0-9]*$ ]] || { echo 'ACS did not report a usable drain deadline' >&2; return 1; }
    echo "Legacy shared deadline preserved at ${current}ms; busy work may safely reject this transition" >&2
    return 0
  fi
  [[ "$current" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid deploymentDrainDeadlineMs' >&2; return 1; }
  if [ "$current" -ge "$target" ]; then
    printf 'ACS drain deadline already covers the promotion window: %sms\n' "$current" >&2
    return 0
  fi
  applied="$(acs_runtime_config_request -X PATCH -H 'content-type: application/json' \
    -d "{\"deploymentDrainDeadlineMs\":$target}" "$(acs_runtime_config_url)" \
    | jq -r '.runtimeConfig.deploymentDrainDeadlineMs // empty')" || return 1
  [ "$applied" = "$target" ] || {
    echo "ACS applied deploymentDrainDeadlineMs=${applied:-none}, expected $target" >&2
    return 1
  }
  printf 'Aligned ACS drain deadline with the promotion window: %sms -> %sms\n' "$current" "$applied" >&2
}

acs_drain_diagnostics_path() {
  printf '%s' "$(dirname "${MANIFEST_PATH:?}")/acs-drain-diagnostics-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}.jsonl"
}

acs_drain_diagnostics_url() {
  local health="${ACS_HEALTH_URL:-http://127.0.0.1:3400/health}"
  printf '%s' "${health%/health}/diagnostics/drain"
}

acs_drain_observed_at() {
  node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ
}

_acs_validate_drain_diagnostics() {
  printf '%s' "$1" | jq -e '
    .protocolVersion == 1
    and (.requests | type=="number" and .>=0 and floor==.)
    and (.recovery | type=="number" and .>=0 and floor==.)
    and (.ownedWork | type=="number" and .>=0 and floor==.)
    and (.draining | type=="boolean")
    and (.journalAvailable | type=="boolean")
    and (.blockers | type=="array")
    and (
      (.unresolvedInvocations | type=="number" and .>=0 and floor==.)
      or (.unresolvedInvocations == null)
    )
  ' >/dev/null
}

_acs_diagnostics_fingerprint() {
  printf '%s' "$1" | jq -c '{
    requests,
    recovery,
    unresolvedInvocations: (.unresolvedInvocations // 0),
    ownedWork,
    journalAvailable,
    persistedUnresolved,
    ids: [.blockers[]? | [(.operationId // ""), (.invocationId // ""), (.phase // ""), (.resource // ""), (.kind // "")]]
  }'
}

_acs_diagnostics_summary() {
  printf '%s' "$1" | jq -c '{
    requests,
    recovery,
    unresolvedInvocations: (.unresolvedInvocations // 0),
    ownedWork,
    draining,
    journalAvailable,
    persistedUnresolved,
    blockerCount: (.blockers | length),
    blockers: [.blockers[:8][] | {
      kind, phase, resource, invocationId, sandboxName, workspaceId, elapsedMs, reasonCode, durable
    }]
  }'
}

_acs_write_drain_diagnostics_record() {
  local phase="$1" body="$2" path observed digest record
  path="$(acs_drain_diagnostics_path)" || return 1
  [ -n "$release_id" ] && [ -n "$manifest_digest" ] || {
    echo 'ACS drain diagnostics require releaseId and manifestDigest' >&2
    return 1
  }
  [[ "${ACS_DRAIN_PID:-0}" =~ ^[0-9]+$ ]] || {
    echo 'ACS drain diagnostics require a numeric old PID' >&2
    return 1
  }
  observed="$(acs_drain_observed_at)"
  digest="sha256:$(printf '%s' "$body" | openssl dgst -sha256 | awk '{print $NF}')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo 'ACS drain diagnostics snapshot digest failed' >&2
    return 1
  }
  record="$(printf '%s' "$body" | jq -c \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$manifest_digest" \
    --arg runId "$GITHUB_RUN_ID" \
    --arg runAttempt "$GITHUB_RUN_ATTEMPT" \
    --argjson pid "$ACS_DRAIN_PID" \
    --arg observedAt "$observed" \
    --arg drainPhase "$phase" \
    --arg snapshotDigest "$digest" \
    '{
      schemaVersion: 1,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      runId: $runId,
      runAttempt: $runAttempt,
      oldAcsPid: $pid,
      observedAt: $observedAt,
      drainPhase: $drainPhase,
      snapshotDigest: $snapshotDigest,
      diagnostics: .
    }')" || return 1
  printf '%s\n' "$record" >> "$path" || return 1
  ACS_DRAIN_DIAGNOSTICS_LAST_FINGERPRINT="$(_acs_diagnostics_fingerprint "$body")"
  printf 'ACS drain diagnostics: phase=%s pid=%s %s\n' \
    "$phase" "$ACS_DRAIN_PID" "$(_acs_diagnostics_summary "$body")" >&2
}

acs_record_legacy_drain_diagnostics() {
  local path observed
  path="$(acs_drain_diagnostics_path)" || return 1
  observed="$(acs_drain_observed_at)"
  jq -nc \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$manifest_digest" \
    --arg runId "$GITHUB_RUN_ID" \
    --arg runAttempt "$GITHUB_RUN_ATTEMPT" \
    --argjson pid "${ACS_DRAIN_PID:-0}" \
    --arg observedAt "$observed" \
    --arg drainPhase "$1" \
    '{
      schemaVersion: 1,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      runId: $runId,
      runAttempt: $runAttempt,
      oldAcsPid: $pid,
      observedAt: $observedAt,
      drainPhase: $drainPhase,
      snapshotDigest: null,
      diagnostics: null,
      legacyProtocol: true
    }' >> "$path" || return 1
}

acs_snapshot_drain_diagnostics() {
  local phase="$1" required="${2:-true}" attempt body
  if [ "$ACS_DRAIN_PROTOCOL" != 1 ]; then
    [ -s "$(acs_drain_diagnostics_path)" ] || acs_record_legacy_drain_diagnostics "$phase" || return 1
    return 0
  fi
  body=''
  for attempt in 1 2 3; do
    if body="$(acs_runtime_config_request --max-time 5 --max-filesize 1048576 "$(acs_drain_diagnostics_url)")" \
      && _acs_validate_drain_diagnostics "$body"; then
      ACS_DRAIN_DIAGNOSTICS_FAILURES=0
      _acs_write_drain_diagnostics_record "$phase" "$body"
      return $?
    fi
    body=''
    [ "$attempt" -eq 3 ] || sleep 1
  done
  ACS_DRAIN_DIAGNOSTICS_FAILURES=$((ACS_DRAIN_DIAGNOSTICS_FAILURES + 1))
  echo "ACS drain diagnostics unavailable or invalid (phase=$phase)" >&2
  [ "$required" = true ] && return 1
  return 0
}

acs_poll_drain_diagnostics() {
  local phase="$1" body fingerprint
  if [ "$ACS_DRAIN_PROTOCOL" != 1 ]; then
    return 0
  fi
  if ! body="$(acs_runtime_config_request --max-time 5 --max-filesize 1048576 "$(acs_drain_diagnostics_url)")"; then
    ACS_DRAIN_DIAGNOSTICS_FAILURES=$((ACS_DRAIN_DIAGNOSTICS_FAILURES + 1))
    if [ "$ACS_DRAIN_DIAGNOSTICS_FAILURES" -ge 3 ]; then
      echo "ACS drain diagnostics unreachable (phase=$phase)" >&2
      return 1
    fi
    return 0
  fi
  if ! _acs_validate_drain_diagnostics "$body"; then
    echo "ACS drain diagnostics schema invalid (phase=$phase)" >&2
    return 1
  fi
  ACS_DRAIN_DIAGNOSTICS_FAILURES=0
  fingerprint="$(_acs_diagnostics_fingerprint "$body")"
  if [ "$fingerprint" != "$ACS_DRAIN_DIAGNOSTICS_LAST_FINGERPRINT" ]; then
    _acs_write_drain_diagnostics_record changed "$body" || return 1
  elif [ "$phase" = heartbeat ]; then
    _acs_write_drain_diagnostics_record heartbeat "$body" || return 1
  fi
}

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
        acs_snapshot_drain_diagnostics recovered false || true
        return 0
      fi
      sleep 1
    done
    return 1
  fi
  # No current/env mutation has happened: a stopped old process can be restored.
  systemctl start "$ACS_SERVICE_NAME" || return 1
  for _ in $(seq 1 30); do
    local restored_pid restored_health
    restored_pid="$(systemctl show "$ACS_SERVICE_NAME" --property=MainPID --value)" || return 1
    restored_health="$(curl -fsS --max-time 3 "${ACS_HEALTH_URL:-http://127.0.0.1:3400/health}" 2>/dev/null || true)"
    if [[ "$restored_pid" =~ ^[1-9][0-9]*$ ]] && printf '%s' "$restored_health" | jq -e \
      --argjson pid "$restored_pid" \
      '.draining==false and (.inflight | type=="number" and .>=0 and floor==.) and
       ((.deploymentDrain.protocolVersion // 0)==0 or .deploymentDrain.pid==$pid)' >/dev/null; then
      acs_snapshot_drain_diagnostics recovered false || true
      return 0
    fi
    sleep 1
  done
  return 1
}

drain_acs_before_cutover() {
  local health state status code result deadline proof current_pid terminal_pid next_progress
  local proof_state proof_exit_status
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
    ACS_DRAIN_LAST_INFLIGHT="$(printf '%s' "$health" | jq -r '.inflight')"
    printf 'Legacy ACS: stopping admission and waiting for accepted work: %s\n' \
      "$(printf '%s' "$health" | jq -c '{inflight,draining,drainDeadlineMs:.lifecycle.drainDeadlineMs}')" >&2
    echo 'WARNING: legacy timeout exits are refused; only a clean empty-work exit permits automatic cutover' >&2
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
  [ "$ACS_DRAIN_PROTOCOL" != 1 ] || align_acs_drain_deadline || return 1
  acs_snapshot_drain_diagnostics before_signal || return 1
  kill -USR2 "$ACS_DRAIN_PID" || return 1
  acs_snapshot_drain_diagnostics after_signal || return 1
  deadline=$((SECONDS + ACS_DRAIN_WINDOW_SECONDS))
  next_progress=$SECONDS
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(systemctl show "$ACS_SERVICE_NAME" --property=ActiveState --value)" || return 1
    if [ "$SECONDS" -ge "$next_progress" ]; then
      printf 'Waiting for ACS drain: pid=%s protocol=%s state=%s inflight=%s remainingSeconds=%s\n' \
        "$ACS_DRAIN_PID" "$ACS_DRAIN_PROTOCOL" "$state" "$ACS_DRAIN_LAST_INFLIGHT" \
        "$((deadline - SECONDS))" >&2
      acs_poll_drain_diagnostics heartbeat || return 1
      next_progress=$((SECONDS + 15))
    fi
    if [ "$state" = inactive ] || [ "$state" = failed ]; then
      terminal_pid="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainPID --value)" || return 1
      status="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainStatus --value)" || return 1
      code="$(systemctl show "$ACS_SERVICE_NAME" --property=ExecMainCode --value)" || return 1
      result="$(systemctl show "$ACS_SERVICE_NAME" --property=Result --value)" || return 1
      proof_state=completed
      proof_exit_status=0
      if [ "$state:$status:$code:$result:$terminal_pid" = "inactive:0:1:success:$ACS_DRAIN_PID" ]; then
        :
      else
        echo "ACS did not exit cleanly (expectedPid=$ACS_DRAIN_PID terminalPid=$terminal_pid state=$state status=$status code=$code result=$result)" >&2; return 1;
      fi
      proof="$(dirname "$MANIFEST_PATH")/acs-drain-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json"
      if [ "$ACS_DRAIN_PROTOCOL" = 1 ]; then
        jq -e --argjson pid "$ACS_DRAIN_PID" '.protocolVersion==1 and .pid==$pid and .state=="completed" and .inflight==0' \
          "${ACS_DRAIN_STATE_PATH:-/run/agent-saas-acs-drain.json}" >/dev/null || return 1
      fi
      jq -n --argjson pid "$ACS_DRAIN_PID" --argjson protocol "$ACS_DRAIN_PROTOCOL" \
        --arg proofState "$proof_state" --argjson exitStatus "$proof_exit_status" \
        --arg releaseId "$release_id" --arg manifestDigest "$manifest_digest" \
        '{schemaVersion:1,releaseId:$releaseId,manifestDigest:$manifestDigest,pid:$pid,protocolVersion:$protocol,state:$proofState,exitStatus:$exitStatus}' > "$proof" || return 1
      chmod 0444 "$proof"
      acs_snapshot_drain_diagnostics completed false || true
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
      ACS_DRAIN_LAST_INFLIGHT="$(printf '%s' "$health" | jq -r '.inflight // "unknown"')"
      if printf '%s' "$health" | jq -e '.deploymentDrain.state=="timed_out" or .deploymentDrain.state=="cancelled"' >/dev/null; then
        printf 'ACS drain was cancelled or reached its safe deadline; old work was preserved (inflight=%s)\n' \
          "$ACS_DRAIN_LAST_INFLIGHT" >&2
        acs_snapshot_drain_diagnostics cancelled || true
        return 1
      fi
      acs_poll_drain_diagnostics changed || return 1
    fi
    sleep 1
  done
  echo 'ACS drain deadline exceeded; refusing to terminate accepted work' >&2
  acs_snapshot_drain_diagnostics deadline || true
  return 1
}
