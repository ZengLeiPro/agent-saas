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

# The harness executes the exact production arm/disarm/EXIT dispatcher while
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

echo 'deploy rollback EXIT lifecycle, marker failure, and set-e fault injection: ok'
