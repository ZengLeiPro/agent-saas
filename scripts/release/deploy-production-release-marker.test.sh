#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy="$script_dir/deploy-production-release.sh"
bash -n "$deploy"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
lifecycle="$tmp/deploy-rollback-cleanup-lifecycle.sh"
{
  sed -n '/^mark_rollback_attempted() {/,/^}$/p' "$deploy"
  sed -n '/^emit_rollback_attempted_sentinel() {/,/^}$/p' "$deploy"
  sed -n '/^# BEGIN deploy rollback cleanup lifecycle$/,/^# END deploy rollback cleanup lifecycle$/p' "$deploy"
} > "$lifecycle"
test -s "$lifecycle"
bash -n "$lifecycle"

# This harness executes the exact production arm/disarm/EXIT dispatcher while
# replacing only phase-specific recovery operations with harmless sentinels.
harness="$tmp/cleanup-harness.sh"
cat > "$harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$CLEANUP_LIFECYCLE"

DEPLOY_ACS_ROLLBACK_TOKEN=
DEPLOY_APP_ROLLBACK_TOKEN=

if [ "$INJECT_MARKER_FAILURE" = 1 ]; then
  install() { return 73; }
fi

cleanup_acs_harness() {
  test "$DEPLOY_ACS_ROLLBACK_TOKEN" = acs-state
  if [ "${function_only_state+x}" = x ]; then
    printf 'acs:function-local-leaked\n' >> "$RESTORE_LOG"
  else
    printf 'acs:function-local-unwound\n' >> "$RESTORE_LOG"
  fi
  printf 'acs:restore-start\n' >> "$RESTORE_LOG"
  false
  printf 'acs:restore-after-failed-step\n' >> "$RESTORE_LOG"
  if [ "$INJECT_HANDLER_TERM" = 1 ]; then
    printf 'acs:handler-before-TERM\n' >> "$RESTORE_LOG"
    kill -TERM "$$"
    printf 'acs:handler-after-TERM\n' >> "$RESTORE_LOG"
  fi
  printf 'acs:restore-finished\n' >> "$RESTORE_LOG"
}

cleanup_app_harness() {
  test "$DEPLOY_APP_ROLLBACK_TOKEN" = app-state
  if [ "${function_only_state+x}" = x ]; then
    printf 'app:function-local-leaked\n' >> "$RESTORE_LOG"
  else
    printf 'app:function-local-unwound\n' >> "$RESTORE_LOG"
  fi
  printf 'app:restore-start\n' >> "$RESTORE_LOG"
  false
  printf 'app:restore-after-failed-step\n' >> "$RESTORE_LOG"
  if [ "$INJECT_HANDLER_TERM" = 1 ]; then
    printf 'app:handler-before-TERM\n' >> "$RESTORE_LOG"
    kill -TERM "$$"
    printf 'app:handler-after-TERM\n' >> "$RESTORE_LOG"
  fi
  printf 'app:restore-finished\n' >> "$RESTORE_LOG"
}

deploy_phase_harness() {
  local function_only_state=must-not-be-required-by-exit-trap
  case "$TEST_PHASE" in
    acs)
      DEPLOY_ACS_ROLLBACK_TOKEN=acs-state
      arm_deploy_rollback cleanup_acs_harness
      ;;
    app)
      DEPLOY_APP_ROLLBACK_TOKEN=app-state
      arm_deploy_rollback cleanup_app_harness
      ;;
    *) exit 90 ;;
  esac

  case "$INJECT_FAILURE" in
    false) false ;;
    subshell) ( false ) ;;
    HUP|INT|TERM) kill -s "$INJECT_FAILURE" "$$" ;;
    success) : ;;
    *) exit 91 ;;
  esac

  # Only the success case reaches this point under the harness's real set -e.
  test "$function_only_state" = must-not-be-required-by-exit-trap
  disarm_deploy_rollback
}

deploy_phase_harness
HARNESS
chmod +x "$harness"

run_case() {
  local phase="$1" failure="$2" marker_failure="$3" expected_status="$4" handler_term="$5"
  local case_dir="$tmp/$phase-$failure-marker-$marker_failure"
  local marker="$case_dir/rollback-attempted-$phase"
  local restore_log="$case_dir/restore.log"
  mkdir -p "$case_dir"

  set +e
  CLEANUP_LIFECYCLE="$lifecycle" \
    TEST_PHASE="$phase" \
    INJECT_FAILURE="$failure" \
    INJECT_MARKER_FAILURE="$marker_failure" \
    INJECT_HANDLER_TERM="$handler_term" \
    PHASE="$phase" \
    GITHUB_RUN_ID=4242 \
    GITHUB_RUN_ATTEMPT=7 \
    ROLLBACK_ATTEMPTED_MARKER="$marker" \
    RESTORE_LOG="$restore_log" \
    bash "$harness" >"$case_dir/stdout" 2>"$case_dir/stderr"
  local status=$?
  set -e

  if [ "$status" -ne "$expected_status" ]; then
    cat "$case_dir/stderr" >&2
    echo "unexpected status for $phase/$failure/marker=$marker_failure: $status (expected $expected_status)" >&2
    exit 1
  fi

  if [ "$failure" = success ]; then
    test ! -e "$marker"
    test ! -e "$restore_log"
    test ! -s "$case_dir/stdout"
    return
  fi

  test "$(grep -Fxc "AGENT_SAAS_ROLLBACK_ATTEMPTED PHASE=$phase GITHUB_RUN_ID=4242 GITHUB_RUN_ATTEMPT=7" "$case_dir/stdout")" = 1
  test -f "$restore_log"
  case "$failure" in
    false|subshell)
      # Errexit has unwound deploy_phase_harness before EXIT cleanup runs.
      grep -Fx "$phase:function-local-unwound" "$restore_log" >/dev/null
      ;;
  esac
  grep -Fx "$phase:restore-start" "$restore_log" >/dev/null
  # An injected failed recovery command must not block later recovery work.
  grep -Fx "$phase:restore-after-failed-step" "$restore_log" >/dev/null
  grep -Fx "$phase:restore-finished" "$restore_log" >/dev/null
  if [ "$handler_term" = 1 ]; then
    grep -Fx "$phase:handler-before-TERM" "$restore_log" >/dev/null
    grep -Fx "$phase:handler-after-TERM" "$restore_log" >/dev/null
  fi
  if [ "$marker_failure" = 1 ]; then
    test ! -e "$marker"
    grep -F 'WARN: failed to persist rollback-attempted marker:' "$case_dir/stderr" >/dev/null
  else
    test -f "$marker"
    test "$(stat -c %a "$marker")" = 444
  fi
}

for phase in acs app; do
  # Ordinary function commands and failing child subshells trigger genuine set -e
  # in a fresh bash process (never from an if/!/&& conditional context).
  for failure in false subshell; do
    run_case "$phase" "$failure" 0 1 0
    run_case "$phase" "$failure" 1 1 0
  done

  # Successful deployment disarms EXIT and signal traps.
  run_case "$phase" success 0 0 0

  # Preserve the deployment script's existing HUP/INT/TERM exit-130 contract;
  # signal EXIT may run before Bash unwinds the interrupted function's locals.
  for signal in HUP INT TERM; do
    run_case "$phase" "$signal" 0 130 0
  done

  # Once EXIT dispatch begins, a second TERM inside recovery is ignored: the
  # handler reaches later restoration steps and the original deploy status wins.
  run_case "$phase" false 1 1 1
done

# Production phases must both use the extracted lifecycle rather than owning an
# EXIT trap that could capture function-local state.
grep -F 'arm_deploy_rollback cleanup_acs_failure' "$deploy" >/dev/null
grep -F 'arm_deploy_rollback cleanup_app_failure' "$deploy" >/dev/null
# Candidate release/env cleanup stays gated by a successful topology stop + final commit.
grep -F 'elif commit_rollback_worker_authority "$worker_active" "$worker_idle"' "$deploy" >/dev/null
grep -F '&& restore_candidate_worker_authority "$worker_idle" "$worker_env"' "$deploy" >/dev/null

worker_helpers="$tmp/worker-authority-helpers.sh"
{
  sed -n '/^acquire_config_governance_fence() {/,/^}$/p' "$deploy"
  sed -n '/^validate_worker_release_boundary() {/,/^}$/p' "$deploy"
  sed -n '/^commit_worker_active_color() {/,/^}$/p' "$deploy"
  sed -n '/^commit_rollback_worker_authority() {/,/^}$/p' "$deploy"
  sed -n '/^restore_candidate_worker_authority() {/,/^}$/p' "$deploy"
} > "$worker_helpers"
test -s "$worker_helpers"
bash -n "$worker_helpers"

worker_harness="$tmp/worker-authority-harness.sh"
cat > "$worker_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$CLEANUP_LIFECYCLE"
source "$WORKER_HELPERS"

systemctl() {
  case "$1" in
    is-active) return 0 ;;
    show) printf 'AGENT_SAAS_ENVIRONMENT=production\n' ;;
    *) return 0 ;;
  esac
}
kill() { return 0; }
node() { test "$PRIVATE_BINDING_VALID" = true; }

write_runtime_state() {
  printf '%s\n' 4242 >"$AGENT_SAAS_WORKER_RUN_ROOT/agent-saas-runtime-worker-$BOUNDARY_COLOR.pid"
  printf '%s\n' 4242 >"$AGENT_SAAS_WORKER_RUN_ROOT/agent-saas-runtime-worker-$BOUNDARY_COLOR.ready"
  printf '{}\n' >"$AGENT_SAAS_WORKER_RUN_ROOT/agent-saas-runtime-worker-$BOUNDARY_COLOR.config-identity.json"
}

write_runtime_state
validate_worker_release_boundary "$BOUNDARY_COLOR" - rc-test '{}' initial

case "$FAULT" in
  ready-revoked)
    rm "$AGENT_SAAS_WORKER_RUN_ROOT/agent-saas-runtime-worker-$BOUNDARY_COLOR.ready"
    ;;
  snapshot-drift|rollback-snapshot-drift-after-stop)
    PRIVATE_BINDING_VALID=false
    ;;
  none) ;;
  *) exit 90 ;;
esac

acquire_config_governance_fence "$PROCESS_ROOT"
if validate_worker_release_boundary "$BOUNDARY_COLOR" - rc-test '{}' final; then
  commit_worker_active_color "$BOUNDARY_COLOR"
fi
release_config_governance_fence
HARNESS
chmod +x "$worker_harness"

run_worker_boundary_case() {
  local fault="$1" color="$2" initial_marker="$3" expected_marker="$4"
  local case_dir="$tmp/worker-$fault"
  mkdir -p "$case_dir/run" "$case_dir/process" "$case_dir/etc"
  if [ "$initial_marker" != absent ]; then
    printf '%s\n' "$initial_marker" >"$case_dir/etc/active-color"
  fi
  CLEANUP_LIFECYCLE="$lifecycle" \
    WORKER_HELPERS="$worker_helpers" \
    AGENT_SAAS_WORKER_RUN_ROOT="$case_dir/run" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$case_dir/etc/active-color" \
    PROCESS_ROOT="$case_dir/process" \
    PRIVATE_BINDING_VALID=true \
    BOUNDARY_COLOR="$color" \
    FAULT="$fault" \
    GITHUB_RUN_ID=4242 \
    GITHUB_RUN_ATTEMPT=7 \
    config_identity_reader="$deploy" \
    bash "$worker_harness"
  if [ "$expected_marker" = absent ]; then
    test ! -e "$case_dir/etc/active-color"
  else
    test "$(cat "$case_dir/etc/active-color")" = "$expected_marker"
  fi
  test ! -e "$case_dir/process/config-governance/config.lock"
}

# These failures happen after initial admission and before the final marker commit.
# The exact production helper must reject each stale state.
run_worker_boundary_case ready-revoked green absent absent
run_worker_boundary_case snapshot-drift green absent absent
run_worker_boundary_case none green absent green
# Rollback already points at the candidate (green). If old blue loses its private
# binding after the candidate stop, the final check must leave candidate authority.
run_worker_boundary_case rollback-snapshot-drift-after-stop blue green green

rollback_stop_harness="$tmp/rollback-stop-failure-harness.sh"
cat > "$rollback_stop_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$CLEANUP_LIFECYCLE"
source "$WORKER_HELPERS"

write_worker_state() {
  local color="$1" pid="$2"
  printf '%s\n' "$pid" >"$AGENT_SAAS_WORKER_RUN_ROOT/agent-saas-runtime-worker-$color.pid"
  printf '%s\n' "$pid" >"$AGENT_SAAS_WORKER_RUN_ROOT/agent-saas-runtime-worker-$color.ready"
  printf '{}\n' >"$AGENT_SAAS_WORKER_RUN_ROOT/agent-saas-runtime-worker-$color.config-identity.json"
}

systemctl() {
  local action="$1" unit="${*: -1}"
  case "$action" in
    disable)
      printf 'disable\n' >>"$ACTION_LOG"
      CANDIDATE_ACTIVE=false
      return "$DISABLE_STATUS"
      ;;
    is-active)
      if [[ "$unit" == *@green ]]; then
        test "$CANDIDATE_ACTIVE" = true
      else
        return 0
      fi
      ;;
    enable)
      printf 'restore\n' >>"$ACTION_LOG"
      CANDIDATE_ACTIVE=true
      write_worker_state green 5252
      ;;
    reset-failed) return 0 ;;
    show) printf 'AGENT_SAAS_ENVIRONMENT=production\n' ;;
    *) return 0 ;;
  esac
}
kill() { return 0; }
node() { return 0; }

write_worker_state blue 4242
write_worker_state green 5252
printf 'green\n' >"$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE"
printf 'candidate-link\n' >"$CANDIDATE_LINK_SENTINEL"
printf 'candidate-env\n' >"$CANDIDATE_ENV_SENTINEL"
candidate_stopped=false
worker_restored=true
if commit_rollback_worker_authority blue green "$CANDIDATE_ENV_SENTINEL" \
  candidate_stopped worker_restored; then
  transition_status=0
  rm "$CANDIDATE_LINK_SENTINEL" "$CANDIDATE_ENV_SENTINEL"
else
  transition_status=$?
  if [ "$candidate_stopped" = true ]; then
    restore_candidate_worker_authority green "$CANDIDATE_ENV_SENTINEL"
  fi
fi

test "$candidate_stopped" = true
test "$(grep -Fxc disable "$ACTION_LOG")" = 1
if [ "$EXPECTED_RESULT" = failure ]; then
  test "$transition_status" -ne 0
  test "$worker_restored" = false
  test "$(cat "$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE")" = green
  test "$(cat "$CANDIDATE_LINK_SENTINEL")" = candidate-link
  test "$(cat "$CANDIDATE_ENV_SENTINEL")" = candidate-env
  test "$(grep -Fxc restore "$ACTION_LOG")" = 1
else
  test "$transition_status" = 0
  test "$worker_restored" = true
  test "$(cat "$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE")" = blue
  test ! -e "$CANDIDATE_LINK_SENTINEL"
  test ! -e "$CANDIDATE_ENV_SENTINEL"
  ! grep -Fx restore "$ACTION_LOG" >/dev/null
fi
HARNESS
chmod +x "$rollback_stop_harness"
run_rollback_stop_case() {
  local disable_status="$1" expected_result="$2"
  local rollback_case="$tmp/rollback-disable-$disable_status-$expected_result"
  mkdir -p "$rollback_case/run" "$rollback_case/etc"
  CLEANUP_LIFECYCLE="$lifecycle" \
    WORKER_HELPERS="$worker_helpers" \
    AGENT_SAAS_WORKER_RUN_ROOT="$rollback_case/run" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$rollback_case/etc/active-color" \
    ACTION_LOG="$rollback_case/actions.log" \
    CANDIDATE_LINK_SENTINEL="$rollback_case/candidate-link" \
    CANDIDATE_ENV_SENTINEL="$rollback_case/candidate.env" \
    CANDIDATE_ACTIVE=true \
    DISABLE_STATUS="$disable_status" \
    EXPECTED_RESULT="$expected_result" \
    GITHUB_RUN_ID=4242 \
    GITHUB_RUN_ATTEMPT=7 \
    config_identity_reader="$deploy" \
    bash "$rollback_stop_harness"
}

# Non-zero disable plus an inactive process must restore candidate authority and
# preserve marker/release/env; only a zero disable may commit and clean up.
run_rollback_stop_case 73 failure
run_rollback_stop_case 0 success

source "$lifecycle"
source "$worker_helpers"
fence_root="$tmp/fence-conflict"
mkdir -p "$fence_root/config-governance/config.lock"
CONFIG_GOVERNANCE_FENCE=
if acquire_config_governance_fence "$fence_root" 2>/dev/null; then
  echo 'existing config mutation fence must block Worker marker commit' >&2
  exit 1
fi

echo 'deploy rollback lifecycle and Worker authority boundary fault injection: ok'
