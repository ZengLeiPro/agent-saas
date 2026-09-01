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

candidate=/fixture/candidate # cleanup target for the active deploy attempt
artifact_persistence_probe=/fixture/artifact-probe
acs_health_probe=/fixture/acs-health
api_ready_probe=/fixture/api-ready
rollback_root=/fixture/rollback
server_env=/fixture/server.env
server_config=/fixture/config.json
acs_env=/fixture/acs.env
acs_identity=/fixture/acs-identity.json
server_unit=/fixture/server.service
worker_unit=/fixture/worker.service
acs_unit=/fixture/acs.service
run_root=/fixture/run
deployment_attempt_id=4242-1
had_server_config=true
had_server_env=true
had_acs_env=true
had_previous_identity=true
had_server_unit=true
had_worker_unit=true
had_acs_unit=true
had_previous_release=true
previous=/fixture/previous
current=/fixture/current

source "$CLEANUP_LIFECYCLE"
runtime_mutated=true

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
  signal) kill -"$SIGNAL_NAME" "$$" ;;
  *) exit 90 ;;
esac
HARNESS
chmod +x "$harness"

run_case() {
  local trigger="$1" signal_name="$2" second_signal="$3" expected_status="$4"
  local case_dir="$tmp/$trigger-$signal_name-$second_signal"
  mkdir -p "$case_dir"

  set +e
  CLEANUP_LIFECYCLE="$lifecycle" RESTORE_LOG="$case_dir/restore.log" \
    TRIGGER="$trigger" SIGNAL_NAME="$signal_name" INJECT_SECOND_SIGNAL="$second_signal" \
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

run_case status INT 1 23
run_case signal HUP 0 129
run_case signal INT 0 130
run_case signal TERM 0 143

# Executable fixtures: an already-migrated mutable config remains authoritative, and a
# first deployment exercises the real legacy-to-mutable migration branch. Both receive the
# deploy-time mutation and are read by config-identity-cli from the path declared by systemd.
# Each case uses an isolated temporary root, so no host path is touched.
config_selection="$tmp/staging-config-selection.sh"
sed -n \
  '/^install -d -o agent-saas-staging .*"\$config_root"$/,/^chmod 0600 "\$server_config"$/p' \
  "$deploy" > "$config_selection"
test -s "$config_selection"
bash -n "$config_selection"

config_finalize="$tmp/staging-config-finalize.sh"
sed -n '/^runtime_mutated=true$/,/^  --env-file "\$server_env")"$/p' \
  "$deploy" > "$config_finalize"
test -s "$config_finalize"
bash -n "$config_finalize"

systemd_server_unit="$script_dir/../../daemon-packaging/systemd/agent-saas-server-staging.service.template"
systemd_config_path="$(sed -n 's/^Environment=AGENT_SAAS_CONFIG_PATH=//p' "$systemd_server_unit")"
test "$systemd_config_path" = /var/lib/agent-saas-staging/config/config.json

config_identity_fixture="$tmp/config-identity-fixture.sh"
cat > "$config_identity_fixture" <<'FIXTURE'
#!/usr/bin/env bash
set -euo pipefail

config_root="$FIXTURE_ROOT$(dirname "$SYSTEMD_CONFIG_PATH")"
server_config="$FIXTURE_ROOT$SYSTEMD_CONFIG_PATH"
legacy_server_config="$FIXTURE_ROOT/etc/agent-saas-staging/config.json"
deployment_attempt_id=4242-1
target="$FIXTURE_ROOT/opt/agent-saas-staging/releases/rc-20260901-318"
current="$FIXTURE_ROOT/opt/agent-saas-staging/current"
server_env="$FIXTURE_ROOT/etc/agent-saas-staging/server.env"

mkdir -p "$(dirname "$server_config")" "$(dirname "$server_env")" \
  "$target/server/dist" "$(dirname "$current")"
case "$FIXTURE_CASE" in
  already-migrated)
    test ! -e "$legacy_server_config"
    config_seed="$server_config"
    ;;
  first-migration)
    test ! -e "$server_config"
    mkdir -p "$(dirname "$legacy_server_config")"
    config_seed="$legacy_server_config"
    ;;
  *)
    echo "unknown config identity fixture case: $FIXTURE_CASE" >&2
    exit 2
    ;;
esac
cat > "$config_seed" <<JSON
{
  "fixtureStage": "$FIXTURE_CASE",
  "agent": { "sharedDir": "/legacy/shared" },
  "auth": { "jwtSecret": "fixture-jwt-secret" }
}
JSON
cp "$config_seed" "$FIXTURE_INITIAL_CONFIG"
: > "$server_env"

cat > "$target/server/dist/config-identity-cli.js" <<'NODE'
const fs = require('node:fs');
const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
if (configIndex < 0 || !args[configIndex + 1]) throw new Error('missing --config');
const configPath = args[configIndex + 1];
const content = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.writeFileSync(
  process.env.CONFIG_IDENTITY_CLI_LOG,
  `${JSON.stringify({ args, configPath, content })}\n`,
);
process.stdout.write(JSON.stringify({ schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` }));
NODE

install() {
  if [ "$1" = -d ]; then
    mkdir -p "${@: -1}"
  else
    command install -m 0600 "${@: -2:1}" "${@: -1}"
  fi
}
chown() { :; }
chmod() { command chmod "$@"; }

# Execute the deployment's real selection and final mutation/CLI slices.
source "$CONFIG_SELECTION"
cmp -s "$FIXTURE_INITIAL_CONFIG" "$server_config"
if [ "$FIXTURE_CASE" = first-migration ]; then
  # The deployment copies legacy into a same-directory candidate and atomically renames it.
  # Its current compatibility semantics retain the unchanged legacy source.
  cmp -s "$FIXTURE_INITIAL_CONFIG" "$legacy_server_config"
  test ! -e "$config_root/.config.json.migrate-$deployment_attempt_id"
fi
source "$CONFIG_FINALIZE"
printf '%s\n' "$config_identity" > "$FIXTURE_IDENTITY"
cp "$server_config" "$FIXTURE_FINAL_CONFIG"
FIXTURE
chmod +x "$config_identity_fixture"
test -x "$config_identity_fixture"

run_config_identity_case() {
  fixture_case="$1"
  config_fixture_root="$tmp/config-identity-$fixture_case-root"
  config_cli_log="$tmp/config-identity-$fixture_case-cli.log"
  initial_config="$tmp/config-identity-$fixture_case-initial.json"
  final_config="$tmp/config-identity-$fixture_case-final.json"
  identity_json="$tmp/config-identity-$fixture_case.json"
  FIXTURE_CASE="$fixture_case" FIXTURE_ROOT="$config_fixture_root" \
    SYSTEMD_CONFIG_PATH="$systemd_config_path" CONFIG_SELECTION="$config_selection" \
    CONFIG_FINALIZE="$config_finalize" CONFIG_IDENTITY_CLI_LOG="$config_cli_log" \
    FIXTURE_INITIAL_CONFIG="$initial_config" FIXTURE_FINAL_CONFIG="$final_config" \
    FIXTURE_IDENTITY="$identity_json" "$config_identity_fixture"

  node - "$config_cli_log" "$initial_config" "$final_config" \
    "$config_fixture_root$systemd_config_path" "$fixture_case" <<'NODE'
const fs = require('node:fs');
const [logPath, initialPath, finalPath, systemdConfigPath, fixtureCase] = process.argv.slice(2);
const invocation = JSON.parse(fs.readFileSync(logPath, 'utf8'));
const initial = JSON.parse(fs.readFileSync(initialPath, 'utf8'));
const final = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
if (initial.fixtureStage !== fixtureCase || initial.agent.sharedDir !== '/legacy/shared') {
  throw new Error(`${fixtureCase} fixture did not preserve its source config`);
}
if (final.agent.sharedDir !== '/opt/agent-saas-staging/current/server/workspace-shared') {
  throw new Error(`${fixtureCase} deploy-time mutable config modification was not applied`);
}
if (invocation.configPath !== systemdConfigPath) {
  throw new Error(`CLI --config ${invocation.configPath} differs from systemd ${systemdConfigPath}`);
}
if (JSON.stringify(invocation.content) !== JSON.stringify(final)) {
  throw new Error(`${fixtureCase} config-identity-cli did not read the post-modification mutable config`);
}
NODE
}

run_config_identity_case already-migrated
run_config_identity_case first-migration

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

bash "$script_dir/staging-unit-preflight-rollback.test.sh"
printf '%s\n' 'staging cleanup fault injection, config identity, and run-attempt isolation: ok'
