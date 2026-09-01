#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
deploy="$script_dir/deploy-staging-release.sh"
bash -n "$deploy"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
lifecycle="$tmp/staging-deploy-cleanup-lifecycle.sh"
sed -n '/^# BEGIN staging deploy cleanup lifecycle$/,/^# END staging deploy cleanup lifecycle$/p' \
  "$deploy" > "$lifecycle"
test -s "$lifecycle"
bash -n "$lifecycle"

harness="$tmp/cleanup-harness.sh"
cat > "$harness" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail

candidate=/fixture/candidate
artifact_persistence_probe=/fixture/artifact-probe
acs_health_probe=/fixture/acs-health
api_ready_probe=/fixture/api-ready
rollback_root=/fixture/rollback
server_env=/fixture/server.env
server_config=/fixture/config.json
acs_env=/fixture/acs.env
acs_identity=/fixture/acs-identity.json
had_previous_identity=true
had_previous_release=true
previous=/fixture/previous
current=/fixture/current

source "$CLEANUP_LIFECYCLE"

rm_count=0
cp_count=0
systemctl_count=0
rm() {
  rm_count=$((rm_count + 1))
  printf 'rm:%s\n' "$*" >> "$RESTORE_LOG"
  if [ "$rm_count" -eq 1 ]; then
    if [ "$INJECT_SECOND_SIGNAL" = 1 ]; then
      printf 'cleanup:before-second-TERM\n' >> "$RESTORE_LOG"
      kill -TERM "$$"
      printf 'cleanup:after-second-TERM\n' >> "$RESTORE_LOG"
    fi
    return 71
  fi
}
cp() {
  cp_count=$((cp_count + 1))
  printf 'cp:%s\n' "$*" >> "$RESTORE_LOG"
  if [ "$cp_count" -eq 1 ]; then return 72; fi
}
ln() {
  printf 'ln:%s\n' "$*" >> "$RESTORE_LOG"
}
systemctl() {
  systemctl_count=$((systemctl_count + 1))
  printf 'systemctl:%s\n' "$*" >> "$RESTORE_LOG"
  if [ "$systemctl_count" -eq 1 ]; then return 73; fi
}

case "$TRIGGER" in
  status) exit 23 ;;
  signal) kill -INT "$$" ;;
  *) exit 90 ;;
esac
HARNESS
chmod +x "$harness"

run_case() {
  local trigger="$1" second_signal="$2" expected_status="$3"
  local case_dir="$tmp/$trigger-$second_signal"
  mkdir -p "$case_dir"

  set +e
  CLEANUP_LIFECYCLE="$lifecycle" RESTORE_LOG="$case_dir/restore.log" \
    TRIGGER="$trigger" INJECT_SECOND_SIGNAL="$second_signal" \
    bash "$harness" >"$case_dir/stdout" 2>"$case_dir/stderr"
  local status=$?
  set -e

  test "$status" -eq "$expected_status"
  local log="$case_dir/restore.log"
  test -f "$log"
  # A failing first cleanup command cannot suppress later cleanup or rollback.
  grep -Fx 'rm:-f /fixture/artifact-probe' "$log" >/dev/null
  grep -Fx 'rm:-f /fixture/acs-health /fixture/api-ready' "$log" >/dev/null
  # A failing first rollback copy and first service recovery cannot suppress the rest;
  # rollback backups remain available for manual recovery.
  grep -Fx 'cp:-a /fixture/rollback/config.json /fixture/config.json' "$log" >/dev/null
  grep -Fx 'cp:-a /fixture/rollback/acs-orchestrator.env /fixture/acs.env' "$log" >/dev/null
  grep -Fx 'ln:-sfn /fixture/previous /fixture/current' "$log" >/dev/null
  grep -Fx 'systemctl:restart agent-saas-runtime-worker-staging.service' "$log" >/dev/null
  ! grep -Fx 'rm:-rf /fixture/rollback' "$log" >/dev/null
  test "$(grep -c '^cp:-a /fixture/rollback/server.env ' "$log")" -eq 1

  if [ "$second_signal" = 1 ]; then
    grep -Fx 'cleanup:before-second-TERM' "$log" >/dev/null
    grep -Fx 'cleanup:after-second-TERM' "$log" >/dev/null
  fi
}

run_case status 1 23
run_case signal 0 130

# Static/run-time fixture: the same run's attempts produce disjoint deploy paths.
paths_for_attempt() {
  local attempt="$1"
  GITHUB_RUN_ID=4242
  GITHUB_RUN_ATTEMPT="$attempt"
  deployment_attempt_id="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  release_id=rc-20260901-318
  target=/opt/agent-saas-staging/releases/rc-20260901-318
  state_root=/var/lib/agent-saas-staging
  artifact_dir=/mnt/agent-saas-staging/runtime/artifacts
  candidate="$target.candidate-$deployment_attempt_id"
  rollback_root="$state_root/rollback-$release_id-$deployment_attempt_id"
  artifact_persistence_probe="$artifact_dir/.release-persistence-$release_id-$deployment_attempt_id"
  acs_health_probe="$state_root/acs-health-$deployment_attempt_id.json"
  api_ready_probe="$state_root/api-ready-$deployment_attempt_id.json"
  printf '%s\n' "$candidate" "$rollback_root" "$artifact_persistence_probe" \
    "$acs_health_probe" "$api_ready_probe"
}
paths_for_attempt 1 > "$tmp/attempt-1"
paths_for_attempt 2 > "$tmp/attempt-2"
test "$(wc -l < "$tmp/attempt-1")" -eq 5
test "$(wc -l < "$tmp/attempt-2")" -eq 5
test -z "$(comm -12 <(sort "$tmp/attempt-1") <(sort "$tmp/attempt-2"))"
grep -F -- '-4242-1' "$tmp/attempt-1" >/dev/null
grep -F -- '-4242-2' "$tmp/attempt-2" >/dev/null

printf '%s\n' 'staging cleanup fault injection and run-attempt isolation: ok'
