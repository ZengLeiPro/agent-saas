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
# preserving production authority topology assertions in dedicated harnesses.
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
# Candidate release/env cleanup requires one successful App topology commit.
# Active markers require units to remain active and enabled after private identity validation.
# either marker state must be recoverable to one verified authority and release binding.
grep -F 'if commit_rollback_worker_authority "$worker_active" "$worker_idle"' "$deploy" >/dev/null
grep -F 'restore_candidate_worker_authority' "$deploy" >/dev/null
grep -F 'commit_rollback_api_authority' "$deploy" >/dev/null
grep -F 'restore_candidate_app_authority' "$deploy" >/dev/null

api_helpers="$tmp/api-authority-helpers.sh"
{
  sed -n '/^revoke_systemd_authority() {/,/^}$/p' "$deploy"
  sed -n '/^validate_api_release_boundary() {/,/^validate_api_release_boundary_from_env() {/p' "$deploy" \
    | sed '$d'
  sed -n '/^validate_api_release_boundary_from_env() {/,/^commit_api_active_color() {/p' "$deploy" \
    | sed '$d'
  sed -n '/^commit_api_active_color() {/,/^}$/p' "$deploy"
  sed -n '/^commit_rollback_api_authority() {/,/^}$/p' "$deploy"
  sed -n '/^restore_old_api_authority() {/,/^}$/p' "$deploy"
  sed -n '/^restore_candidate_api_authority() {/,/^}$/p' "$deploy"
} > "$api_helpers"
test -s "$api_helpers"
bash -n "$api_helpers"

app_env_helper="$tmp/app-env-helper.sh"
sed -n '/^validate_app_release_envs_match() {/,/^commit_api_active_color() {/p' "$deploy" \
  | sed '$d' >"$app_env_helper"
source "$app_env_helper"
api_old_env="$tmp/api-old.env"
worker_old_env="$tmp/worker-old.env"
cat >"$api_old_env" <<'ENV'
AGENT_SAAS_RELEASE_ID=rc-20260831-01
AGENT_SAAS_RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
AGENT_SAAS_SERVER_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=1
AGENT_SAAS_CONFIG_IDENTITY_DIGEST=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
ENV
cp "$api_old_env" "$worker_old_env"
validate_app_release_envs_match "$api_old_env" "$worker_old_env"
sed -i 's/rc-20260831-01/rc-20260830-99/' "$worker_old_env"
if validate_app_release_envs_match "$api_old_env" "$worker_old_env" 2>/dev/null; then
  echo 'mismatched API/Worker rollback env must be rejected' >&2
  exit 1
fi

old_api_binding_harness="$tmp/old-api-binding-harness.sh"
cat >"$old_api_binding_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$API_HELPERS"
systemctl() { [ "$1" = is-active ] || [ "$1" = is-enabled ]; }
curl() { cat "$READINESS_FIXTURE"; }
port_for_color() { [ "$1" = blue ] && echo 4001 || echo 4002; }
validate_api_release_boundary_from_env blue "$OLD_API_ENV" 'Rollback old API ConfigIdentity'
HARNESS
chmod +x "$old_api_binding_harness"
old_api_case="$tmp/old-api-binding"
mkdir -p "$old_api_case/run"
cp "$script_dir/fixtures/candidate-config-identity.json" \
  "$old_api_case/run/agent-saas-server-blue.config-identity.json"
API_HELPERS="$api_helpers" AGENT_SAAS_API_RUN_ROOT="$old_api_case/run" \
  READINESS_FIXTURE="$script_dir/fixtures/production-readiness.json" \
  OLD_API_ENV="$api_old_env" MANIFEST_PATH="$old_api_case/manifest.json" \
  config_identity_reader="$script_dir/read-production-state.mjs" \
  bash "$old_api_binding_harness"
node -e "const fs=require('fs');const p=process.argv[1];const v=JSON.parse(fs.readFileSync(p));v.expected.digest='sha256:'+('d'.repeat(64));fs.writeFileSync(p,JSON.stringify(v));" \
  "$old_api_case/run/agent-saas-server-blue.config-identity.json"
if API_HELPERS="$api_helpers" AGENT_SAAS_API_RUN_ROOT="$old_api_case/run" \
  READINESS_FIXTURE="$script_dir/fixtures/production-readiness.json" \
  OLD_API_ENV="$api_old_env" MANIFEST_PATH="$old_api_case/manifest.json" \
  config_identity_reader="$script_dir/read-production-state.mjs" \
  bash "$old_api_binding_harness" 2>/dev/null; then
  echo 'old API private ConfigIdentity drift must block rollback authority' >&2
  exit 1
fi

# Post-validation liveness and routed-release identity are separate authority gates.
api_liveness_harness="$tmp/api-liveness-harness.sh"
cat >"$api_liveness_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$API_HELPERS"
API_ACTIVE=true
systemctl() {
  case "$1" in
    is-active|is-enabled) test "$API_ACTIVE" = true ;;
    *) return 0 ;;
  esac
}
curl() { cat "$READINESS_FIXTURE"; }
node() { API_ACTIVE=false; }
port_for_color() { [ "$1" = blue ] && echo 4001 || echo 4002; }
if validate_api_release_boundary_from_env blue "$OLD_API_ENV" \
  'Rollback old API liveness race'; then
  echo 'API exit after private identity validation must block authority' >&2
  exit 1
fi
HARNESS
chmod +x "$api_liveness_harness"
API_HELPERS="$api_helpers" READINESS_FIXTURE="$script_dir/fixtures/production-readiness.json" \
  OLD_API_ENV="$api_old_env" MANIFEST_PATH="$old_api_case/manifest.json" \
  config_identity_reader="$script_dir/read-production-state.mjs" \
  bash "$api_liveness_harness"

api_route_harness="$tmp/api-route-harness.sh"
cat >"$api_route_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$API_HELPERS"
systemctl() { [ "$1" = is-active ]; }
nginx() { return 0; }
curl() { cat "$READINESS_FIXTURE"; }
printf '# active=green release=%s\n' "$EXPECTED_RELEASE_ID" >"$AGENT_SAAS_NGINX_UPSTREAM_FILE"
validate_api_routing_boundary green "$EXPECTED_RELEASE_ID"
HARNESS
chmod +x "$api_route_harness"
route_case="$tmp/api-route"
mkdir -p "$route_case"
API_HELPERS="$api_helpers" READINESS_FIXTURE="$script_dir/fixtures/production-readiness.json" \
  EXPECTED_RELEASE_ID=rc-20260831-01 AGENT_SAAS_NGINX_UPSTREAM_FILE="$route_case/upstream.conf" \
  bash "$api_route_harness"
if API_HELPERS="$api_helpers" READINESS_FIXTURE="$script_dir/fixtures/production-readiness.json" \
  EXPECTED_RELEASE_ID=rc-candidate AGENT_SAAS_NGINX_UPSTREAM_FILE="$route_case/upstream.conf" \
  bash "$api_route_harness" 2>/dev/null; then
  echo 'Nginx backup readiness from the old release must not admit candidate authority' >&2
  exit 1
fi

api_rollback_harness="$tmp/api-rollback-topology-harness.sh"
cat > "$api_rollback_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$API_HELPERS"

systemctl() {
  local action="$1" unit="${*: -1}"
  case "$action" in
    disable)
      if [[ "$unit" == *@green ]]; then
        printf 'stop-candidate\n' >>"$ACTION_LOG"
        CANDIDATE_ACTIVE=false
        CANDIDATE_DISABLE_ATTEMPTS=$((CANDIDATE_DISABLE_ATTEMPTS + 1))
        if [ "$CANDIDATE_DISABLE_ATTEMPTS" = 1 ]; then
          return "$CANDIDATE_DISABLE_STATUS"
        fi
        return 0
      fi
      printf 'stop-old\n' >>"$ACTION_LOG"
      OLD_ACTIVE=false
      OLD_DISABLE_ATTEMPTS=$((OLD_DISABLE_ATTEMPTS + 1))
      if [ "$OLD_DISABLE_ALWAYS_FAIL" = true ] \
        || [ "$OLD_DISABLE_ATTEMPTS" = 1 ]; then
        return "$OLD_DISABLE_STATUS"
      fi
      return 0
      ;;
    is-active)
      if [[ "$unit" == *@green ]]; then
        test "$CANDIDATE_ACTIVE" = true
      else
        test "$OLD_ACTIVE" = true
      fi
      ;;
    enable)
      if [[ "$unit" == *@green ]]; then
        printf 'start-candidate\n' >>"$ACTION_LOG"
        CANDIDATE_ACTIVE=true
        if [ ! -e "$AGENT_SAAS_API_RUN_ROOT/agent-saas-server-green.config-identity.json" ]; then
          printf 'fresh\n' >"$AGENT_SAAS_API_RUN_ROOT/agent-saas-server-green.config-identity.json"
        fi
      else
        printf 'start-old\n' >>"$ACTION_LOG"
        OLD_ACTIVE=true
      fi
      ;;
    restart) return 0 ;;
    is-enabled)
      if [[ "$unit" == *@green ]]; then
        test "$CANDIDATE_ACTIVE" = true
      else
        test "$OLD_ACTIVE" = true
      fi
      ;;
    reset-failed|reload) return 0 ;;
    *) return 0 ;;
  esac
}
nginx() { return 0; }
curl() { return 0; }
node() {
  if [ "$#" = 3 ] && [ "$3" = old-api.env ]; then
    printf 'old'
    return 0
  fi
  if [[ " $* " == *"agent-saas-server-green.config-identity.json"* ]]; then
    test "$(cat "$AGENT_SAAS_API_RUN_ROOT/agent-saas-server-green.config-identity.json" 2>/dev/null)" = fresh
  fi
}
port_for_color() { [ "$1" = blue ] && echo 4001 || echo 4002; } # production helper dependency
sleep() { return 0; }

printf 'stale\n' >"$AGENT_SAAS_API_RUN_ROOT/agent-saas-server-green.config-identity.json"
printf '%s\n' "$INITIAL_MARKER" >"$AGENT_SAAS_API_ACTIVE_COLOR_FILE"
if [ "$CANDIDATE_ADMITTED" = true ]; then
  printf '# active=green release=candidate\n' >"$AGENT_SAAS_NGINX_UPSTREAM_FILE"
else
  printf '# active=blue release=old\n' >"$AGENT_SAAS_NGINX_UPSTREAM_FILE"
fi
printf '# active=blue release=old\n' >"$OLD_NGINX_BACKUP"
printf '# active=green release=candidate\n' >"$CANDIDATE_NGINX_BACKUP"
printf 'candidate-link\n' >"$CANDIDATE_LINK_SENTINEL"
printf 'candidate-env\n' >"$CANDIDATE_ENV_SENTINEL"
OLD_ACTIVE=true
CANDIDATE_ACTIVE=true
OLD_DISABLE_ATTEMPTS=0
CANDIDATE_DISABLE_ATTEMPTS=0
candidate_stopped=false
if commit_rollback_api_authority blue green "$OLD_NGINX_BACKUP" true true \
  old-api.env candidate_stopped; then
  transition_status=0
  rm "$CANDIDATE_LINK_SENTINEL" "$CANDIDATE_ENV_SENTINEL"
else
  transition_status=$?
  recovery_status=0
  if [ "$CANDIDATE_ADMITTED" = true ]; then
    restore_candidate_api_authority blue green "$CANDIDATE_NGINX_BACKUP" '{}' \
      "$OLD_NGINX_BACKUP" true true old-api.env || recovery_status=$?
  else
    revoke_systemd_authority agent-saas-server@green || recovery_status=$?
  fi
fi

if [ "$EXPECTED_RESULT" = failure ]; then
  test "$transition_status" -ne 0
  test "$candidate_stopped" = true
  test "$(cat "$CANDIDATE_LINK_SENTINEL")" = candidate-link
  test "$(cat "$CANDIDATE_ENV_SENTINEL")" = candidate-env
  if [ "$CANDIDATE_ADMITTED" = true ] && [ "$EXPECTED_AUTHORITY" = candidate ]; then
    test "$recovery_status" = 0
    test "$OLD_ACTIVE" = false
    test "$CANDIDATE_ACTIVE" = true
    test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE")" = green
    grep -F '# active=green ' "$AGENT_SAAS_NGINX_UPSTREAM_FILE" >/dev/null
    test "$(grep -Fxc start-candidate "$ACTION_LOG")" = 1
  elif [ "$CANDIDATE_ADMITTED" = true ]; then
    test "$recovery_status" -ne 0
    test "$OLD_ACTIVE" = true
    test "$CANDIDATE_ACTIVE" = false
    test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE")" = blue
    grep -F '# active=blue ' "$AGENT_SAAS_NGINX_UPSTREAM_FILE" >/dev/null
    test "$(grep -Fxc start-old "$ACTION_LOG")" -ge 1
  else
    test "$OLD_ACTIVE" = true
    test "$CANDIDATE_ACTIVE" = false
    test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE")" = blue
    grep -F '# active=blue ' "$AGENT_SAAS_NGINX_UPSTREAM_FILE" >/dev/null
    ! grep -Fx start-candidate "$ACTION_LOG" >/dev/null
  fi
else
  test "$transition_status" = 0
  test "$candidate_stopped" = true
  test "$OLD_ACTIVE" = true
  test "$CANDIDATE_ACTIVE" = false
  test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE")" = blue
  grep -F '# active=blue ' "$AGENT_SAAS_NGINX_UPSTREAM_FILE" >/dev/null
  test ! -e "$CANDIDATE_LINK_SENTINEL"
  test ! -e "$CANDIDATE_ENV_SENTINEL"
  ! grep -Fx stop-old "$ACTION_LOG" >/dev/null
  ! grep -Fx start-candidate "$ACTION_LOG" >/dev/null
fi
HARNESS
chmod +x "$api_rollback_harness"
run_api_rollback_case() {
  local disable_status="$1" expected_result="$2" initial_marker="${3:-green}"
  local admitted="${4:-true}" old_disable_status="${5:-0}"
  local expected_authority="${6:-candidate}" old_disable_always_fail="${7:-false}"
  local api_case="$tmp/api-disable-$disable_status-$expected_result-$initial_marker-$admitted-$old_disable_status"
  mkdir -p "$api_case/etc" "$api_case/run"
  API_HELPERS="$api_helpers" \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$api_case/etc/active-color" \
    AGENT_SAAS_NGINX_UPSTREAM_FILE="$api_case/etc/upstream.conf" \
    AGENT_SAAS_API_RUN_ROOT="$api_case/run" \
    ACTION_LOG="$api_case/actions.log" \
    OLD_NGINX_BACKUP="$api_case/old-upstream.conf" \
    CANDIDATE_NGINX_BACKUP="$api_case/candidate-upstream.conf" \
    CANDIDATE_LINK_SENTINEL="$api_case/candidate-link" \
    CANDIDATE_ENV_SENTINEL="$api_case/candidate.env" \
    CANDIDATE_DISABLE_STATUS="$disable_status" \
    OLD_DISABLE_STATUS="$old_disable_status" \
    OLD_DISABLE_ALWAYS_FAIL="$old_disable_always_fail" \
    EXPECTED_AUTHORITY="$expected_authority" \
    CANDIDATE_ADMITTED="$admitted" \
    EXPECTED_RESULT="$expected_result" \
    INITIAL_MARKER="$initial_marker" \
    GITHUB_RUN_ID=4242 \
    GITHUB_RUN_ATTEMPT=7 \
    MANIFEST_PATH="$api_case/manifest.json" \
    config_identity_reader="$deploy" \
    bash "$api_rollback_harness"
}

run_api_rollback_case 73 failure
run_api_rollback_case 73 failure blue true 73
run_api_rollback_case 73 failure blue true 73 old true
run_api_rollback_case 73 failure blue false
run_api_rollback_case 0 success

worker_helpers="$tmp/worker-authority-helpers.sh"
{
  sed -n '/^revoke_systemd_authority() {/,/^}$/p' "$deploy"
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

WORKER_ACTIVE=true
EXIT_AFTER_PRIVATE=false
systemctl() {
  case "$1" in
    is-active|is-enabled) test "$WORKER_ACTIVE" = true ;;
    show) printf 'AGENT_SAAS_ENVIRONMENT=production\n' ;;
    *) return 0 ;;
  esac
}
kill() { return 0; }
node() {
  test "$PRIVATE_BINDING_VALID" = true || return 1
  if [ "$EXIT_AFTER_PRIVATE" = true ]; then
    WORKER_ACTIVE=false
  fi
}

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
  exit-after-private)
    EXIT_AFTER_PRIVATE=true
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
run_worker_boundary_case exit-after-private green absent absent
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
      if [[ "$unit" == *@green ]]; then
        printf 'stop-candidate\n' >>"$ACTION_LOG"
        CANDIDATE_ACTIVE=false
        CANDIDATE_DISABLE_ATTEMPTS=$((CANDIDATE_DISABLE_ATTEMPTS + 1))
        if [ "$CANDIDATE_DISABLE_ATTEMPTS" = 1 ]; then
          return "$DISABLE_STATUS"
        fi
        return 0
      fi
      printf 'stop-old\n' >>"$ACTION_LOG"
      OLD_ACTIVE=false
      OLD_DISABLE_ATTEMPTS=$((OLD_DISABLE_ATTEMPTS + 1))
      if [ "$OLD_DISABLE_ATTEMPTS" = 1 ]; then
        return "$OLD_DISABLE_STATUS"
      fi
      return 0
      ;;
    is-active)
      if [[ "$unit" == *@green ]]; then
        test "$CANDIDATE_ACTIVE" = true
      else
        test "$OLD_ACTIVE" = true
      fi
      ;;
    enable)
      if [[ "$unit" == *@green ]]; then
        printf 'restore-candidate\n' >>"$ACTION_LOG"
        CANDIDATE_ACTIVE=true
        write_worker_state green 5252
      else
        printf 'start-old\n' >>"$ACTION_LOG"
        OLD_ACTIVE=true
        write_worker_state blue 4242
      fi
      ;;
    is-enabled)
      if [[ "$unit" == *@green ]]; then
        test "$CANDIDATE_ACTIVE" = true
      else
        test "$OLD_ACTIVE" = true
      fi
      ;;
    reset-failed) return 0 ;;
    show) printf 'AGENT_SAAS_ENVIRONMENT=production\n' ;;
    *) return 0 ;;
  esac
}
kill() { return 0; }
node() { return 0; }
sleep() { return 0; }

write_worker_state blue 4242
write_worker_state green 5252
OLD_ACTIVE=true
CANDIDATE_ACTIVE=true
OLD_DISABLE_ATTEMPTS=0
CANDIDATE_DISABLE_ATTEMPTS=0
printf '%s\n' "$INITIAL_MARKER" >"$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE"
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
  if [ "$CANDIDATE_ADMITTED" = true ]; then
    restore_candidate_worker_authority blue green "$CANDIDATE_ENV_SENTINEL"
  else
    revoke_systemd_authority agent-saas-runtime-worker@green
  fi
fi

test "$candidate_stopped" = true
if [ "$EXPECTED_RESULT" = failure ]; then
  test "$transition_status" -ne 0
  test "$worker_restored" = false
  test "$(cat "$CANDIDATE_LINK_SENTINEL")" = candidate-link
  test "$(cat "$CANDIDATE_ENV_SENTINEL")" = candidate-env
  if [ "$CANDIDATE_ADMITTED" = true ]; then
    test "$OLD_ACTIVE" = false
    test "$CANDIDATE_ACTIVE" = true
    test "$(cat "$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE")" = green
    test "$(grep -Fxc restore-candidate "$ACTION_LOG")" = 1
  else
    test "$OLD_ACTIVE" = true
    test "$CANDIDATE_ACTIVE" = false
    test "$(cat "$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE")" = blue
    ! grep -Fx restore-candidate "$ACTION_LOG" >/dev/null
  fi
else
  test "$transition_status" = 0
  test "$worker_restored" = true
  test "$OLD_ACTIVE" = true
  test "$CANDIDATE_ACTIVE" = false
  test "$(cat "$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE")" = blue
  test ! -e "$CANDIDATE_LINK_SENTINEL"
  test ! -e "$CANDIDATE_ENV_SENTINEL"
  ! grep -Fx stop-old "$ACTION_LOG" >/dev/null
  ! grep -Fx restore-candidate "$ACTION_LOG" >/dev/null
  test "$(grep -Fxc start-old "$ACTION_LOG")" = 1
  stop_candidate_line="$(grep -n -Fm1 stop-candidate "$ACTION_LOG" | cut -d: -f1)"
  start_old_line="$(grep -n -Fm1 start-old "$ACTION_LOG" | cut -d: -f1)"
  test "$stop_candidate_line" -lt "$start_old_line"
fi
HARNESS
chmod +x "$rollback_stop_harness"
run_rollback_stop_case() {
  local disable_status="$1" expected_result="$2" initial_marker="${3:-green}"
  local admitted="${4:-true}" old_disable_status="${5:-0}"
  local rollback_case="$tmp/rollback-disable-$disable_status-$expected_result-$initial_marker-$admitted-$old_disable_status"
  mkdir -p "$rollback_case/run" "$rollback_case/etc" "$rollback_case/process"
  CLEANUP_LIFECYCLE="$lifecycle" \
    WORKER_HELPERS="$worker_helpers" \
    AGENT_SAAS_WORKER_RUN_ROOT="$rollback_case/run" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$rollback_case/etc/active-color" \
    AGENT_SAAS_RUNTIME_DATA_ROOT="$rollback_case/process" \
    ACTION_LOG="$rollback_case/actions.log" \
    CANDIDATE_LINK_SENTINEL="$rollback_case/candidate-link" \
    CANDIDATE_ENV_SENTINEL="$rollback_case/candidate.env" \
    CANDIDATE_ACTIVE=true \
    DISABLE_STATUS="$disable_status" \
    OLD_DISABLE_STATUS="$old_disable_status" \
    CANDIDATE_ADMITTED="$admitted" \
    EXPECTED_RESULT="$expected_result" \
    INITIAL_MARKER="$initial_marker" \
    GITHUB_RUN_ID=4242 \
    GITHUB_RUN_ATTEMPT=7 \
    config_identity_reader="$deploy" \
    bash "$rollback_stop_harness"
}

# Non-zero disable plus an inactive process must preserve one verified authority;
# Successful authority validation also requires the selected unit to remain enabled;
# only a zero disable may commit old Worker authority and clean up.
run_rollback_stop_case 73 failure
run_rollback_stop_case 73 failure blue true 73
run_rollback_stop_case 73 failure blue false
run_rollback_stop_case 0 success

worker_fence_conflict_harness="$tmp/worker-fence-conflict-harness.sh"
cat >"$worker_fence_conflict_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$WORKER_HELPERS"
systemctl() { printf 'unexpected mutation\n' >>"$ACTION_LOG"; return 0; }
CONFIG_GOVERNANCE_FENCE=
CONFIG_GOVERNANCE_FENCE_OWNER=
CONFIG_GOVERNANCE_GUARD_FD=
candidate_stopped=false
worker_restored=true
if commit_rollback_worker_authority blue green old-worker.env \
  candidate_stopped worker_restored 2>/dev/null; then
  echo 'pre-existing governance fence must block Worker transition' >&2
  exit 1
fi
test "$candidate_stopped" = false
test "$worker_restored" = false
test ! -e "$ACTION_LOG"
HARNESS
chmod +x "$worker_fence_conflict_harness"
# Directory and OS-guard conflicts both precede unit mutation; diagnostics stay local.
worker_fence_case="$tmp/worker-fence-conflict"
mkdir -p "$worker_fence_case/config-governance/config.lock"
WORKER_HELPERS="$worker_helpers" \
  AGENT_SAAS_RUNTIME_DATA_ROOT="$worker_fence_case" \
  ACTION_LOG="$worker_fence_case/actions.log" \
  GITHUB_RUN_ID=4242 GITHUB_RUN_ATTEMPT=7 \
  bash "$worker_fence_conflict_harness"

app_authority_helpers="$tmp/app-authority-helpers.sh"
sed -n '/^restore_candidate_app_authority() {/,/^}$/p' "$deploy" >"$app_authority_helpers"
test -s "$app_authority_helpers"
bash -n "$app_authority_helpers"

app_authority_harness="$tmp/app-authority-harness.sh"
cat >"$app_authority_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$APP_AUTHORITY_HELPERS"
restore_candidate_api_authority() {
  if [ "$API_RESTORE_STATUS" -ne 0 ]; then return "$API_RESTORE_STATUS"; fi
  API_UNIT=candidate
}
restore_candidate_worker_authority() {
  if [ "$WORKER_RESTORE_STATUS" -ne 0 ]; then return "$WORKER_RESTORE_STATUS"; fi
  WORKER_UNIT=candidate
}
restore_old_api_authority() {
  API_UNIT=old
  printf 'blue\n' >"$AGENT_SAAS_API_ACTIVE_COLOR_FILE"
}
restore_old_worker_authority() {
  WORKER_UNIT=old
  printf 'blue\n' >"$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE"
}
validate_api_release_boundary() { return 0; }
validate_worker_release_boundary() { return 0; }
validate_api_routing_boundary() { return "$ROUTE_STATUS"; }
acquire_config_governance_fence() { return 0; }
release_config_governance_fence() { return 0; }
commit_app_active_colors() {
  printf '%s\n' "$1" >"$AGENT_SAAS_API_ACTIVE_COLOR_FILE"
  if [ "$APP_COMMIT_STATUS" -ne 0 ]; then return "$APP_COMMIT_STATUS"; fi
  printf '%s\n' "$2" >"$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE"
}
API_UNIT=old
WORKER_UNIT=old
release_id=rc-test
printf 'blue\n' >"$AGENT_SAAS_API_ACTIVE_COLOR_FILE"
printf 'blue\n' >"$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE"
status=0
restore_candidate_app_authority blue green candidate-nginx '{}' old-nginx true true \
  blue green candidate-worker.env old-worker.env old-api.env || status=$?
if [ "$EXPECTED_AUTHORITY" = candidate ]; then
  test "$status" = 0
  test "$API_UNIT:$WORKER_UNIT" = candidate:candidate
  test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE"):$(cat "$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE")" \
    = green:green
else
  test "$status" -ne 0
  test "$API_UNIT:$WORKER_UNIT" = old:old
  test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE"):$(cat "$AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE")" \
    = blue:blue
fi
HARNESS
chmod +x "$app_authority_harness"
for app_case in candidate worker-failure api-failure routing-failure marker-commit-failure; do
  app_case_root="$tmp/app-authority-$app_case"
  mkdir -p "$app_case_root"
  api_restore_status=0
  worker_restore_status=0
  app_commit_status=0
  route_status=0
  expected_authority=candidate
  if [ "$app_case" = worker-failure ]; then worker_restore_status=79; expected_authority=old; fi
  if [ "$app_case" = api-failure ]; then api_restore_status=78; expected_authority=old; fi
  if [ "$app_case" = routing-failure ]; then route_status=76; expected_authority=old; fi
  if [ "$app_case" = marker-commit-failure ]; then app_commit_status=77; expected_authority=old; fi
  APP_AUTHORITY_HELPERS="$app_authority_helpers" \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$app_case_root/api-color" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$app_case_root/worker-color" \
    API_RESTORE_STATUS="$api_restore_status" WORKER_RESTORE_STATUS="$worker_restore_status" \
    ROUTE_STATUS="$route_status" APP_COMMIT_STATUS="$app_commit_status" \
    EXPECTED_AUTHORITY="$expected_authority" \
    bash "$app_authority_harness"
done

# App marker publication uses one atomic authority-link rename. Kill the exact
# helper after every rename and prove observers can see only the complete old
# pair or the complete new pair, never a split API/Worker authority.
app_marker_helpers="$tmp/app-marker-helpers.sh"
sed -n '/^commit_app_active_colors() {/,/^}$/p' "$deploy" >"$app_marker_helpers"
test -s "$app_marker_helpers"
bash -n "$app_marker_helpers"
app_marker_harness="$tmp/app-marker-harness.sh"
cat >"$app_marker_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$APP_MARKER_HELPERS"
mv_count=0
mv() {
  command mv "$@"
  mv_count=$((mv_count + 1))
  if [ "$KILL_AFTER" -gt 0 ] && [ "$mv_count" -eq "$KILL_AFTER" ]; then
    kill -KILL "$$"
  fi
}
commit_app_active_colors green blue blue
HARNESS
chmod +x "$app_marker_harness"
for kill_after in 1 2 3 4 0; do
  atomic_root="$tmp/app-marker-atomic-$kill_after"
  mkdir -p "$atomic_root"
  printf 'blue\n' >"$atomic_root/api-color"
  printf 'green\n' >"$atomic_root/worker-color"
  set +e
  APP_MARKER_HELPERS="$app_marker_helpers" \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$atomic_root/api-color" \
    AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE="$atomic_root/worker-color" \
    AGENT_SAAS_APP_AUTHORITY_DIR="$atomic_root/generations" \
    AGENT_SAAS_APP_AUTHORITY_LINK="$atomic_root/current" \
    GITHUB_RUN_ID=4242 GITHUB_RUN_ATTEMPT=7 KILL_AFTER="$kill_after" \
    bash "$app_marker_harness" 2>/dev/null
  atomic_status=$?
  set -e
  observed_pair="$(cat "$atomic_root/api-color"):$(cat "$atomic_root/worker-color")"
  if [ "$kill_after" -eq 0 ]; then
    test "$atomic_status" = 0
    test "$observed_pair" = green:blue
  elif [ "$kill_after" -lt 4 ]; then
    test "$atomic_status" -ne 0
    test "$observed_pair" = blue:green
  else
    test "$atomic_status" -ne 0
    test "$observed_pair" = green:blue
  fi
done

forward_api_harness="$tmp/forward-api-final-boundary-harness.sh"
cat >"$forward_api_harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$API_HELPERS"
systemctl() {
  if [ "$1" = is-active ]; then
    test "$CANDIDATE_ACTIVE" = true
    return
  fi
  return 0
}
curl() {
  case " $* " in
    *" http://127.0.0.1:4002/"*) test "$CANDIDATE_ACTIVE" = true ;;
    *) return 0 ;;
  esac
}
node() { return 0; }
port_for_color() { [ "$1" = blue ] && echo 4001 || echo 4002; }
printf 'blue\n' >"$AGENT_SAAS_API_ACTIVE_COLOR_FILE"
curl -kfsS -H 'Host: api.agent.kaiyan.net' https://127.0.0.1/api/healthz/ready >/dev/null
if validate_api_release_boundary green '{}' 'Candidate API final ConfigIdentity'; then
  commit_api_active_color green
fi
if [ "$CANDIDATE_ACTIVE" = true ]; then
  test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE")" = green
else
  test "$(cat "$AGENT_SAAS_API_ACTIVE_COLOR_FILE")" = blue
fi
HARNESS
chmod +x "$forward_api_harness"
for candidate_active in false true; do
  forward_case="$tmp/forward-api-$candidate_active"
  mkdir -p "$forward_case/run" "$forward_case/etc"
  API_HELPERS="$api_helpers" \
    AGENT_SAAS_API_ACTIVE_COLOR_FILE="$forward_case/etc/active-color" \
    AGENT_SAAS_API_RUN_ROOT="$forward_case/run" \
    CANDIDATE_ACTIVE="$candidate_active" \
    GITHUB_RUN_ID=4242 GITHUB_RUN_ATTEMPT=7 MANIFEST_PATH="$forward_case/manifest.json" \
    config_identity_reader="$deploy" bash "$forward_api_harness"
done

source "$lifecycle"
source "$worker_helpers"
GITHUB_RUN_ID=4242
GITHUB_RUN_ATTEMPT=7
fence_root="$tmp/fence-conflict"
mkdir -p "$fence_root/config-governance/config.lock"
CONFIG_GOVERNANCE_FENCE=
if acquire_config_governance_fence "$fence_root" 2>/dev/null; then
  echo 'existing config mutation fence must block Worker marker commit' >&2
  exit 1
fi

guard_root="$tmp/fence-guard-conflict"
mkdir -p "$guard_root/config-governance"
exec {held_guard_fd}>"$guard_root/config-governance/config.lock.guard"
flock -n "$held_guard_fd"
if acquire_config_governance_fence "$guard_root" 2>/dev/null; then
  echo 'existing OS guard must block App authority mutation' >&2
  exit 1
fi
flock -u "$held_guard_fd"
exec {held_guard_fd}>&-
test ! -e "$guard_root/config-governance/config.lock"

# Once flock is free, a dead owner older than the shared 120-second threshold
# is crash residue and must not block every future deployment forever.
stale_root="$tmp/fence-stale-dead-owner"
mkdir -p "$stale_root/config-governance/config.lock"
printf '{"pid":99999999,"createdAt":"2000-01-01T00:00:00Z","token":"stale"}\n' \
  >"$stale_root/config-governance/config.lock/owner.json"
touch -d '3 minutes ago' "$stale_root/config-governance/config.lock"
acquire_config_governance_fence "$stale_root"
release_config_governance_fence
test ! -e "$stale_root/config-governance/config.lock"

# Age alone is insufficient: a live owner keeps the diagnostic fence active.
live_root="$tmp/fence-stale-live-owner"
mkdir -p "$live_root/config-governance/config.lock"
printf '{"pid":%s,"createdAt":"2000-01-01T00:00:00Z","token":"live"}\n' "$$" \
  >"$live_root/config-governance/config.lock/owner.json"
touch -d '3 minutes ago' "$live_root/config-governance/config.lock"
if acquire_config_governance_fence "$live_root" 2>/dev/null; then
  echo 'stale-aged fence with a live owner must remain authoritative' >&2
  exit 1
fi
rm -rf "$live_root/config-governance/config.lock"

# Releasing an old token must never remove a replacement owner.
owner_root="$tmp/fence-owner"
acquire_config_governance_fence "$owner_root"
printf 'replacement-owner\n' >"$owner_root/config-governance/config.lock/.owner-token"
release_config_governance_fence
test -d "$owner_root/config-governance/config.lock"
rm -rf "$owner_root/config-governance/config.lock"
acquire_config_governance_fence "$owner_root"
release_config_governance_fence
test ! -e "$owner_root/config-governance/config.lock"

echo 'deploy rollback lifecycle and App authority boundary fault injection: ok'
