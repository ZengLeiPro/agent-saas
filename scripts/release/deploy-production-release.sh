#!/usr/bin/env bash
set -euo pipefail

: "${PHASE:?PHASE must be acs or app}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${MANIFEST_PATH:?MANIFEST_PATH is required}"
: "${EXPECTED_MANIFEST_DIGEST:?EXPECTED_MANIFEST_DIGEST is required}"
: "${VERIFY_INSTALLED_SCRIPT:?VERIFY_INSTALLED_SCRIPT is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${ROLLBACK_ATTEMPTED_MARKER:?ROLLBACK_ATTEMPTED_MARKER is required}"
case "$PHASE" in acs|app) ;; *) echo 'PHASE must be acs or app' >&2; exit 1 ;; esac
printf '%s:%s' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" | grep -Eq '^[1-9][0-9]*:[1-9][0-9]*$'
expected_marker="/tmp/agent-saas-promotion-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/rollback-attempted-$PHASE"
test "$ROLLBACK_ATTEMPTED_MARKER" = "$expected_marker" || {
  echo 'ROLLBACK_ATTEMPTED_MARKER must use the isolated promotion run-attempt path' >&2
  exit 1
}
rm -f "$ROLLBACK_ATTEMPTED_MARKER"
mark_rollback_attempted() {
  if ! install -m 0444 /dev/null "$ROLLBACK_ATTEMPTED_MARKER"; then
    echo "WARN: failed to persist rollback-attempted marker: $ROLLBACK_ATTEMPTED_MARKER" >&2
  fi
}

emit_rollback_attempted_sentinel() {
  printf 'AGENT_SAAS_ROLLBACK_ATTEMPTED PHASE=%s GITHUB_RUN_ID=%s GITHUB_RUN_ATTEMPT=%s\n' \
    "$PHASE" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
}

# BEGIN deploy rollback cleanup lifecycle
# EXIT runs after an errexit failure has unwound the deployment function, so the
# trap may only dispatch through script-scope state and handlers.
DEPLOY_ROLLBACK_ARMED=false
DEPLOY_ROLLBACK_HANDLER=
CONFIG_GOVERNANCE_FENCE=
CONFIG_GOVERNANCE_FENCE_OWNER=
CONFIG_GOVERNANCE_GUARD_FD=

release_config_governance_fence() {
  local fence="$CONFIG_GOVERNANCE_FENCE"
  local owner="$CONFIG_GOVERNANCE_FENCE_OWNER"
  local guard_fd="$CONFIG_GOVERNANCE_GUARD_FD"
  CONFIG_GOVERNANCE_FENCE=
  CONFIG_GOVERNANCE_FENCE_OWNER=
  CONFIG_GOVERNANCE_GUARD_FD=
  if [ -n "$fence" ] && [ -n "$owner" ] \
    && [ "$(cat "$fence/.owner-token" 2>/dev/null || true)" = "$owner" ]; then
    rm -rf "$fence"
  fi
  if [ -n "$guard_fd" ]; then
    flock -u "$guard_fd" >/dev/null 2>&1 || true
    exec {guard_fd}>&-
  fi
}

arm_deploy_rollback() {
  DEPLOY_ROLLBACK_HANDLER="$1"
  DEPLOY_ROLLBACK_ARMED=true
  trap deploy_rollback_cleanup EXIT
  trap 'exit 130' HUP INT TERM
}

disarm_deploy_rollback() {
  DEPLOY_ROLLBACK_ARMED=false
  DEPLOY_ROLLBACK_HANDLER=
  trap - EXIT HUP INT TERM
}

deploy_rollback_cleanup() {
  local exit_status=$?
  trap - EXIT
  trap '' HUP INT TERM
  # Cleanup is one-shot, best-effort, and must attempt every recovery step even when
  # the marker or an earlier recovery operation fails. The strict stdout sentinel
  # is an independent run-attempt-bound receipt when marker installation fails.
  set +e
  if [ "$DEPLOY_ROLLBACK_ARMED" = true ]; then
    local rollback_handler="$DEPLOY_ROLLBACK_HANDLER"
    DEPLOY_ROLLBACK_ARMED=false
    DEPLOY_ROLLBACK_HANDLER=
    emit_rollback_attempted_sentinel
    mark_rollback_attempted
    "$rollback_handler"
    release_config_governance_fence
  fi
  return "$exit_status"
}
# END deploy rollback cleanup lifecycle

# Rollback state must outlive deploy_acs/deploy_app function scope for EXIT.
DEPLOY_ACS_ROLLBACK_COMMITTED=false
DEPLOY_ACS_ROLLBACK_PREVIOUS=
DEPLOY_ACS_ROLLBACK_ENV_BACKUP=
DEPLOY_ACS_ROLLBACK_IDENTITY_BACKUP=
DEPLOY_ACS_ROLLBACK_HAD_PREVIOUS_IDENTITY=false

DEPLOY_APP_ROLLBACK_COMMITTED=false
DEPLOY_APP_ROLLBACK_API_ACTIVE=
DEPLOY_APP_ROLLBACK_API_IDLE=
DEPLOY_APP_ROLLBACK_WORKER_ACTIVE=
DEPLOY_APP_ROLLBACK_WORKER_IDLE=
DEPLOY_APP_ROLLBACK_API_IDLE_PREVIOUS=
DEPLOY_APP_ROLLBACK_WORKER_IDLE_PREVIOUS=
DEPLOY_APP_ROLLBACK_API_ENV=
DEPLOY_APP_ROLLBACK_WORKER_ENV=
DEPLOY_APP_ROLLBACK_ROOT=
DEPLOY_APP_ROLLBACK_HAD_API_ENV=false
DEPLOY_APP_ROLLBACK_HAD_WORKER_ENV=false
DEPLOY_APP_ROLLBACK_HAD_NGINX=false
DEPLOY_APP_ROLLBACK_NGINX_CHANGED=false
DEPLOY_APP_ROLLBACK_API_CANDIDATE_ADMITTED=false
DEPLOY_APP_ROLLBACK_WORKER_CANDIDATE_ADMITTED=false
DEPLOY_APP_ROLLBACK_CONFIG_IDENTITY=

release_id="$(node -p "require(process.env.MANIFEST_PATH).releaseId")"
release_sha="$(node -p "require(process.env.MANIFEST_PATH).releaseSha")"
manifest_digest="$(node -p "require(process.env.MANIFEST_PATH).digest")"
test "$manifest_digest" = "$EXPECTED_MANIFEST_DIGEST"
printf '%s' "$release_id" | grep -Eq '^rc-[0-9]{8}-[0-9]{2,}$'
printf '%s' "$release_sha" | grep -Eq '^[a-f0-9]{40}$'

lock=/run/lock/agent-saas/promotion.lock
mkdir -p "$(dirname "$lock")"
exec 9>"$lock"
flock -n 9 || { echo 'Another production promotion is active' >&2; exit 1; }

# Promotion preflight uploads this contract module. Local/manual harnesses may keep it
# next to this script; the production workflow's immutable remote uses the preflight directory.
config_identity_reader="${CONFIG_IDENTITY_READER:-$(dirname "$0")/read-production-state.mjs}"
if [ ! -f "$config_identity_reader" ]; then
  config_identity_reader="/tmp/release-preflight-$GITHUB_RUN_ID/read-production-state.mjs"
fi
test -f "$config_identity_reader" || {
  echo 'Missing shared ConfigIdentity readiness contract module' >&2
  exit 1
}

upsert_env() {
  local manifest="$1" target="$2" role="$3" config_identity="$4"
  node - "$manifest" "$target" "$role" "$config_identity" <<'NODE'
const fs = require('node:fs');
const [manifestPath, target, role, configIdentityJson] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const component = role === 'web' ? manifest.components.web : manifest.components.api;
// TASK-318：Release expected config identity 随发布绑定（由 config-identity-cli 计算）。
const identity = JSON.parse(configIdentityJson);
const desired = {
  AGENT_SAAS_RELEASE_ID: manifest.releaseId,
  AGENT_SAAS_RELEASE_SHA: component.sourceSha,
  AGENT_SAAS_SERVER_DIGEST: manifest.components.api.artifactDigest,
  AGENT_SAAS_WEB_DIGEST: manifest.components.web.artifactDigest,
  AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST: manifest.components.acs.orchestratorArtifactDigest,
  AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST: manifest.components.acs.sandboxImageDigest,
  AGENT_SAAS_CONFIG_IDENTITY_DIGEST: identity.digest,
  AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION: String(identity.schemaVersion),
};
if (identity.credentialVersionDigest) {
  desired.AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST = identity.credentialVersionDigest;
}
fs.writeFileSync(`${target}.candidate`, `${Object.entries(desired).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
fs.renameSync(`${target}.candidate`, target);
NODE
}

acquire_config_governance_fence() {
  local runtime_data_root="$1"
  local fence="$runtime_data_root/config-governance/config.lock"
  local guard="$runtime_data_root/config-governance/config.lock.guard"
  local owner="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$$-$(date +%s%N)"
  local guard_fd
  test -z "$CONFIG_GOVERNANCE_FENCE" || return 1
  mkdir -p "$(dirname "$fence")"
  exec {guard_fd}>"$guard" || return 1
  if ! flock -n "$guard_fd"; then
    exec {guard_fd}>&-
    echo "Config mutation guard is active; refusing App authority transition: $guard" >&2
    return 1
  fi
  CONFIG_GOVERNANCE_GUARD_FD="$guard_fd"
  # The OS guard is authoritative across deploy and Node mutations. A process
  # killed with SIGKILL releases flock but can leave the diagnostic directory;
  # only the new guard owner may reclaim that directory, using the same
  # 120-second/dead-PID rule as AdminConfigMutationService.
  if [ -e "$fence" ] && node - "$fence" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
let stale = false;
try {
  const lockStat = fs.statSync(path);
  let owner;
  try {
    const value = JSON.parse(fs.readFileSync(`${path}/owner.json`, 'utf8'));
    if (Number.isInteger(value?.pid) && value.pid > 0) owner = value.pid;
  } catch {}
  let alive = false;
  if (owner) {
    try {
      process.kill(owner, 0);
      alive = true;
    } catch (error) {
      alive = error?.code === 'EPERM';
    }
  }
  stale = lockStat.isDirectory() && Date.now() - lockStat.mtimeMs > 120_000 && !alive;
} catch {}
process.exit(stale ? 0 : 1);
NODE
  then
    rm -rf "$fence"
  fi
  if ! mkdir "$fence"; then
    echo "Config mutation is active; refusing App authority transition: $fence" >&2
    release_config_governance_fence
    return 1
  fi
  if ! printf '%s\n' "$owner" >"$fence/.owner-token" \
    || ! printf '{"pid":%s,"createdAt":"%s","token":"%s"}\n' \
      "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$owner" >"$fence/owner.json"; then
    rm -rf "$fence"
    release_config_governance_fence
    return 1
  fi
  CONFIG_GOVERNANCE_FENCE="$fence"
  CONFIG_GOVERNANCE_FENCE_OWNER="$owner"
}

validate_worker_release_boundary() {
  local color="$1" env_path="$2" expected_release_id="$3" expected_json="$4" label="$5"
  local run_root="${AGENT_SAAS_WORKER_RUN_ROOT:-/run}"
  local pid ready snapshot_path
  pid="$(cat "$run_root/agent-saas-runtime-worker-$color.pid" 2>/dev/null || true)"
  ready="$(cat "$run_root/agent-saas-runtime-worker-$color.ready" 2>/dev/null || true)"
  snapshot_path="$run_root/agent-saas-runtime-worker-$color.config-identity.json"
  systemctl is-active --quiet "agent-saas-runtime-worker@$color" \
    && test -n "$pid" && test "$pid" = "$ready" && kill -0 "$pid" 2>/dev/null \
    && systemctl show "agent-saas-runtime-worker@$color" --property Environment --value \
      | tr ' ' '\n' | grep -Fx 'AGENT_SAAS_ENVIRONMENT=production' >/dev/null \
    || return 1
  if ! node --input-type=module - "$env_path" "$snapshot_path" "$expected_release_id" \
    "$expected_json" "$label" "$config_identity_reader" <<'NODE'
import { pathToFileURL } from 'node:url';
const [envPath, snapshotPath, releaseId, expectedJson, label, readerPath] = process.argv.slice(2);
const {
  readReleaseConfigIdentityBinding,
  validatePrivateConfigIdentityReleaseBinding,
} = await import(pathToFileURL(readerPath));
const binding = envPath === '-'
  ? { releaseId, expectedConfigIdentity: JSON.parse(expectedJson) }
  : await readReleaseConfigIdentityBinding(envPath);
await validatePrivateConfigIdentityReleaseBinding({
  privateSnapshotPath: snapshotPath,
  ...binding,
  label,
});
NODE
  then
    return 1
  fi
  pid="$(cat "$run_root/agent-saas-runtime-worker-$color.pid" 2>/dev/null || true)"
  ready="$(cat "$run_root/agent-saas-runtime-worker-$color.ready" 2>/dev/null || true)"
  systemctl is-active --quiet "agent-saas-runtime-worker@$color" \
    && systemctl is-enabled --quiet "agent-saas-runtime-worker@$color" \
    && test -n "$pid" && test "$pid" = "$ready" && kill -0 "$pid" 2>/dev/null
}

revoke_systemd_authority() {
  local unit="$1" disable_status=0
  systemctl disable --now "$unit" >/dev/null 2>&1 || disable_status=$?
  if [ "$disable_status" -ne 0 ]; then
    systemctl disable "$unit" >/dev/null 2>&1 || return 1
  fi
  if systemctl is-active --quiet "$unit"; then
    return 1
  fi
  ! systemctl is-enabled --quiet "$unit"
}

retire_systemd_authority() {
  local unit="$1"
  for _ in $(seq 1 180); do
    if ! systemctl is-active --quiet "$unit"; then
      break
    fi
    sleep 1
  done
  revoke_systemd_authority "$unit"
}

validate_api_release_boundary() {
  local color="$1" expected_json="$2" label="$3"
  local run_root="${AGENT_SAAS_API_RUN_ROOT:-/run}"
  local ready_path
  systemctl is-active --quiet "agent-saas-server@$color" || return 1
  ready_path="$(mktemp)" || return 1
  if ! curl -fsS "http://127.0.0.1:$(port_for_color "$color")/api/healthz/ready" \
    >"$ready_path"; then
    rm -f "$ready_path"
    return 1
  fi
  if ! node --input-type=module - "$MANIFEST_PATH" "$ready_path" \
    "$run_root/agent-saas-server-$color.config-identity.json" "$expected_json" \
    "$label" "$config_identity_reader" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [manifestPath, readyPath, snapshotPath, expectedJson, label, readerPath] = process.argv.slice(2);
const { validateCandidateReleaseReadiness } = await import(pathToFileURL(readerPath));
await validateCandidateReleaseReadiness({
  environment: 'production',
  manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  readiness: JSON.parse(fs.readFileSync(readyPath, 'utf8')),
  privateSnapshotPath: snapshotPath,
  expectedConfigIdentity: JSON.parse(expectedJson),
  label,
});
NODE
  then
    rm -f "$ready_path"
    return 1
  fi
  if ! systemctl is-active --quiet "agent-saas-server@$color" \
    || ! systemctl is-enabled --quiet "agent-saas-server@$color" \
    || ! curl -fsS "http://127.0.0.1:$(port_for_color "$color")/api/healthz/ready" \
      >/dev/null; then
    rm -f "$ready_path"
    return 1
  fi
  rm -f "$ready_path"
}

validate_api_release_boundary_from_env() {
  local color="$1" env_path="$2" label="$3"
  local run_root="${AGENT_SAAS_API_RUN_ROOT:-/run}"
  local ready_path
  systemctl is-active --quiet "agent-saas-server@$color" || return 1
  ready_path="$(mktemp)" || return 1
  if ! curl -fsS "http://127.0.0.1:$(port_for_color "$color")/api/healthz/ready" \
    >"$ready_path"; then
    rm -f "$ready_path"
    return 1
  fi
  if ! node --input-type=module - "$env_path" "$ready_path" \
    "$run_root/agent-saas-server-$color.config-identity.json" "$label" \
    "$config_identity_reader" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [envPath, readyPath, snapshotPath, label, readerPath] = process.argv.slice(2);
const {
  readReleaseConfigIdentityBinding,
  validatePrivateConfigIdentityReleaseBinding,
} = await import(pathToFileURL(readerPath));
const env = new Map();
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
  if (!line) continue;
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
  if (!match || env.has(match[1])) throw new Error(`${label} release env is malformed`);
  env.set(match[1], match[2]);
}
const binding = await readReleaseConfigIdentityBinding(envPath);
const readiness = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
const release = readiness?.release;
if (
  readiness?.status !== 'ok'
  || release?.environment !== 'production'
  || release?.releaseId !== binding.releaseId
  || release?.releaseSha !== env.get('AGENT_SAAS_RELEASE_SHA')
  || release?.serverDigest !== env.get('AGENT_SAAS_SERVER_DIGEST')
  || release?.safetyAttested !== true
) {
  throw new Error(`${label} release identity disagrees with release env`);
}
await validatePrivateConfigIdentityReleaseBinding({
  privateSnapshotPath: snapshotPath,
  ...binding,
  label,
});
NODE
  then
    rm -f "$ready_path"
    return 1
  fi
  if ! systemctl is-active --quiet "agent-saas-server@$color" \
    || ! systemctl is-enabled --quiet "agent-saas-server@$color" \
    || ! curl -fsS "http://127.0.0.1:$(port_for_color "$color")/api/healthz/ready" \
      >/dev/null; then
    rm -f "$ready_path"
    return 1
  fi
  rm -f "$ready_path"
}

validate_api_routing_boundary() {
  local color="$1" expected_release_id="$2"
  local upstream="${AGENT_SAAS_NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
  local ready_path
  if ! systemctl is-active --quiet nginx \
    || ! nginx -t \
    || ! grep -Fx "# active=$color release=$expected_release_id" "$upstream" >/dev/null; then
    return 1
  fi
  ready_path="$(mktemp)" || return 1
  if ! curl -kfsS -H 'Host: api.agent.kaiyan.net' \
      https://127.0.0.1/api/healthz/ready >"$ready_path" \
    || ! node --input-type=module - "$ready_path" "$expected_release_id" <<'NODE'
import fs from 'node:fs';
const [readyPath, expectedReleaseId] = process.argv.slice(2);
const readiness = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
if (
  readiness?.status !== 'ok'
  || readiness?.release?.environment !== 'production'
  || readiness?.release?.releaseId !== expectedReleaseId
  || readiness?.release?.safetyAttested !== true
) {
  throw new Error('Routed API readiness disagrees with the selected release');
}
NODE
  then
    rm -f "$ready_path"
    return 1
  fi
  rm -f "$ready_path"
}

read_release_id_from_env() {
  local env_path="$1"
  node --input-type=module - "$env_path" <<'NODE'
import fs from 'node:fs';
const values = new Map();
for (const line of fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/u)) {
  if (!line) continue;
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
  if (!match || values.has(match[1])) throw new Error('Release env is malformed');
  values.set(match[1], match[2]);
}
const releaseId = values.get('AGENT_SAAS_RELEASE_ID');
if (!releaseId) throw new Error('Release env has no release id');
process.stdout.write(releaseId);
NODE
}

# Old API and Worker rollback envs must describe one App release.
validate_app_release_envs_match() {
  local api_env="$1" worker_env="$2"
  node --input-type=module - "$api_env" "$worker_env" <<'NODE'
import fs from 'node:fs';
const [apiPath, workerPath] = process.argv.slice(2);
const readEnv = (path) => {
  const result = new Map();
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || result.has(match[1])) throw new Error('App release env is malformed');
    result.set(match[1], match[2]);
  }
  return result;
};
const api = readEnv(apiPath);
const worker = readEnv(workerPath);
for (const key of [
  'AGENT_SAAS_RELEASE_ID',
  'AGENT_SAAS_RELEASE_SHA',
  'AGENT_SAAS_SERVER_DIGEST',
  'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION',
  'AGENT_SAAS_CONFIG_IDENTITY_DIGEST',
  'AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST',
]) {
  if ((api.get(key) ?? null) !== (worker.get(key) ?? null)) {
    throw new Error(`API and Worker release env disagree on ${key}`);
  }
}
NODE
}

commit_api_active_color() {
  local color="$1"
  local marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local candidate="$marker.candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  printf '%s\n' "$color" >"$candidate"
  mv -f "$candidate" "$marker"
}

commit_rollback_api_authority() {
  local active_color="$1" candidate_color="$2" old_nginx_backup="$3" had_nginx="$4"
  local nginx_changed="$5" active_env="$6"
  local -n candidate_stopped_ref="$7"
  local commit_marker="${8:-true}"
  local marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local upstream="${AGENT_SAAS_NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
  local disable_status=0 old_release_id
  old_release_id="$(read_release_id_from_env "$active_env")" || return 1
  systemctl disable --now "agent-saas-server@$candidate_color" >/dev/null 2>&1 \
    || disable_status=$?
  if ! systemctl is-active --quiet "agent-saas-server@$candidate_color"; then
    candidate_stopped_ref=true
  fi
  if [ "$disable_status" -ne 0 ] || [ "$candidate_stopped_ref" != true ] \
    || systemctl is-enabled --quiet "agent-saas-server@$candidate_color"; then
    return 1
  fi
  if [ "$nginx_changed" = true ]; then
    if [ "$had_nginx" = true ]; then
      cp -a "$old_nginx_backup" "$upstream" || return 1
    else
      rm -f "$upstream" || return 1
    fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || return 1
  fi
  validate_api_release_boundary_from_env "$active_color" "$active_env" \
    'Rollback old API final ConfigIdentity' || return 1
  if systemctl is-active --quiet "agent-saas-server@$candidate_color"; then
    return 1
  fi
  validate_api_routing_boundary "$active_color" "$old_release_id" || return 1
  if [ "$commit_marker" = true ]; then
    commit_api_active_color "$active_color" || return 1
  fi
  [ "$commit_marker" != true ] \
    || [ "$(tr -d '[:space:]' <"$marker")" = "$active_color" ]
}

restore_old_api_authority() {
  local active_color="$1" candidate_color="$2" old_nginx_backup="$3"
  local had_nginx="$4" nginx_changed="$5" active_env="$6"
  local commit_marker="${7:-true}"
  local marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local upstream="${AGENT_SAAS_NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
  local run_root="${AGENT_SAAS_API_RUN_ROOT:-/run}"
  local old_ready=false old_release_id
  old_release_id="$(read_release_id_from_env "$active_env")" || return 1
  rm -f "$run_root/agent-saas-server-$active_color.pid" \
    "$run_root/agent-saas-server-$active_color.ready" \
    "$run_root/agent-saas-server-$active_color.draining" || true
  systemctl reset-failed "agent-saas-server@$active_color" >/dev/null 2>&1 || true
  if systemctl enable "agent-saas-server@$active_color" >/dev/null 2>&1 \
    && systemctl restart "agent-saas-server@$active_color" >/dev/null 2>&1; then
    for _ in $(seq 1 180); do
      if validate_api_release_boundary_from_env "$active_color" "$active_env" \
        'Rollback old API restored ConfigIdentity'; then
        old_ready=true
        break
      fi
      sleep 1
    done
  fi
  [ "$old_ready" = true ] || return 1
  revoke_systemd_authority "agent-saas-server@$candidate_color" || return 1
  if [ "$nginx_changed" = true ]; then
    if [ "$had_nginx" = true ]; then
      cp -a "$old_nginx_backup" "$upstream" || return 1
    else
      rm -f "$upstream" || return 1
    fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || return 1
  fi
  validate_api_routing_boundary "$active_color" "$old_release_id" || return 1
  validate_api_release_boundary_from_env "$active_color" "$active_env" \
    'Rollback old API final ConfigIdentity' || return 1
  if [ "$commit_marker" = true ]; then
    commit_api_active_color "$active_color" || return 1
  fi
  systemctl is-active --quiet "agent-saas-server@$active_color" \
    && ! systemctl is-active --quiet "agent-saas-server@$candidate_color" \
    && { [ "$commit_marker" != true ] \
      || [ "$(tr -d '[:space:]' <"$marker")" = "$active_color" ]; }
}

restore_candidate_api_authority() {
  local active_color="$1" candidate_color="$2"
  local candidate_nginx_backup="$3" expected_json="$4"
  local old_nginx_backup="$5" had_nginx="$6" nginx_changed="$7" active_env="$8"
  local commit_marker="${9:-true}"
  local marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local upstream="${AGENT_SAAS_NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
  local run_root="${AGENT_SAAS_API_RUN_ROOT:-/run}"
  local candidate_ready=false
  rm -f "$run_root/agent-saas-server-$candidate_color.pid" \
    "$run_root/agent-saas-server-$candidate_color.ready" \
    "$run_root/agent-saas-server-$candidate_color.draining" \
    "$run_root/agent-saas-server-$candidate_color.config-identity.json" || true
  systemctl reset-failed "agent-saas-server@$candidate_color" >/dev/null 2>&1 || true
  if systemctl enable "agent-saas-server@$candidate_color" >/dev/null 2>&1 \
    && systemctl restart "agent-saas-server@$candidate_color" >/dev/null 2>&1; then
    for _ in $(seq 1 180); do
      if validate_api_release_boundary "$candidate_color" "$expected_json" \
        'Rollback candidate API restored ConfigIdentity'; then
        candidate_ready=true
        break
      fi
      sleep 1
    done
  fi
  [ "$candidate_ready" = true ] || return 1
  if ! revoke_systemd_authority "agent-saas-server@$active_color"; then
    revoke_systemd_authority "agent-saas-server@$candidate_color" || true
    restore_old_api_authority "$active_color" "$candidate_color" \
      "$old_nginx_backup" "$had_nginx" "$nginx_changed" "$active_env" \
      "$commit_marker" || true
    return 1
  fi
  rm -f "$run_root/agent-saas-server-$active_color.pid" \
    "$run_root/agent-saas-server-$active_color.ready" \
    "$run_root/agent-saas-server-$active_color.draining" || true
  if ! cp -a "$candidate_nginx_backup" "$upstream" \
    || ! grep -F "# active=$candidate_color " "$upstream" >/dev/null \
    || ! nginx -t >/dev/null 2>&1 \
    || ! systemctl reload nginx >/dev/null 2>&1 \
    || ! curl -kfsS -H 'Host: api.agent.kaiyan.net' \
      https://127.0.0.1/api/healthz/ready >/dev/null 2>&1 \
    || ! validate_api_release_boundary "$candidate_color" "$expected_json" \
      'Rollback candidate API final ConfigIdentity'; then
    restore_old_api_authority "$active_color" "$candidate_color" \
      "$old_nginx_backup" "$had_nginx" "$nginx_changed" "$active_env" \
      "$commit_marker" || true
    return 1
  fi
  if [ "$commit_marker" = true ] \
    && ! commit_api_active_color "$candidate_color"; then
    restore_old_api_authority "$active_color" "$candidate_color" \
      "$old_nginx_backup" "$had_nginx" "$nginx_changed" "$active_env" \
      "$commit_marker" || true
    return 1
  fi
  systemctl is-active --quiet "agent-saas-server@$candidate_color" \
    && ! systemctl is-active --quiet "agent-saas-server@$active_color" \
    && { [ "$commit_marker" != true ] \
      || [ "$(tr -d '[:space:]' <"$marker")" = "$candidate_color" ]; }
}

commit_worker_active_color() {
  local color="$1"
  local marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local candidate="$marker.candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  printf '%s\n' "$color" >"$candidate"
  mv -f "$candidate" "$marker"
}

commit_app_active_colors() {
  local api_color="$1" worker_color="$2"
  local api_marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local worker_marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local authority_dir="${AGENT_SAAS_APP_AUTHORITY_DIR:-$(dirname "$api_marker")/app-active-color-generations}"
  local authority_link="${AGENT_SAAS_APP_AUTHORITY_LINK:-$(dirname "$api_marker")/app-active-color-current}"
  local old_api old_worker old_generation new_generation link_candidate marker_candidate

  case "$api_color:$worker_color" in
    blue:blue|blue:green|green:blue|green:green) ;;
    *) return 1 ;;
  esac
  old_api="$(tr -d '[:space:]' <"$api_marker")" || return 1
  old_worker="$(tr -d '[:space:]' <"$worker_marker")" || return 1
  case "$old_api:$old_worker" in
    blue:blue|blue:green|green:blue|green:green) ;;
    *) return 1 ;;
  esac
  mkdir -p "$authority_dir"

  # Migrate the two legacy marker paths onto one indirection while both still
  # expose their old values. A hard stop after any migration rename therefore
  # leaves the old pair, never a partially committed new pair.
  old_generation="$(mktemp -d "$authority_dir/generation-old.XXXXXX")" || return 1
  printf '%s\n' "$old_api" >"$old_generation/api"
  printf '%s\n' "$old_worker" >"$old_generation/worker"
  link_candidate="$authority_link.candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$$"
  rm -f "$link_candidate"
  ln -s "$old_generation" "$link_candidate"
  mv -fT "$link_candidate" "$authority_link"

  marker_candidate="$api_marker.authority-link-candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$$"
  rm -f "$marker_candidate"
  ln -s "$authority_link/api" "$marker_candidate"
  mv -fT "$marker_candidate" "$api_marker"
  marker_candidate="$worker_marker.authority-link-candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$$"
  rm -f "$marker_candidate"
  ln -s "$authority_link/worker" "$marker_candidate"
  mv -fT "$marker_candidate" "$worker_marker"

  # The only externally visible commit is this symlink rename. Both legacy
  # paths traverse the same link and therefore observe the pair together.
  new_generation="$(mktemp -d "$authority_dir/generation.XXXXXX")" || return 1
  printf '%s\n' "$api_color" >"$new_generation/api"
  printf '%s\n' "$worker_color" >"$new_generation/worker"
  link_candidate="$authority_link.candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$$"
  rm -f "$link_candidate"
  ln -s "$new_generation" "$link_candidate"
  mv -fT "$link_candidate" "$authority_link"
  [ "$(tr -d '[:space:]' <"$api_marker")" = "$api_color" ] \
    && [ "$(tr -d '[:space:]' <"$worker_marker")" = "$worker_color" ]
}

commit_rollback_worker_authority() {
  local active_color="$1" candidate_color="$2" active_env="$3"
  local -n candidate_stopped_ref="$4" worker_restored_ref="$5"
  local run_root="${AGENT_SAAS_WORKER_RUN_ROOT:-/run}"
  local fence_held="${6:-false}" commit_marker="${7:-true}"
  local disable_status=0 old_ready=false fence_owned=false
  if [ "$fence_held" != true ]; then
    if ! acquire_config_governance_fence \
        "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}"; then
      worker_restored_ref=false
      return 1
    fi
    fence_owned=true
  fi
  systemctl disable --now "agent-saas-runtime-worker@$candidate_color" >/dev/null 2>&1 \
    || disable_status=$?
  if ! systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color"; then
    candidate_stopped_ref=true
  fi
  if [ "$disable_status" -ne 0 ] || [ "$candidate_stopped_ref" != true ]; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    worker_restored_ref=false
    return 1
  fi
  rm -f "$run_root/agent-saas-runtime-worker-$active_color.pid" \
    "$run_root/agent-saas-runtime-worker-$active_color.ready" \
    "$run_root/agent-saas-runtime-worker-$active_color.draining" \
    "$run_root/agent-saas-runtime-worker-$active_color.config-identity.json" || true
  systemctl reset-failed "agent-saas-runtime-worker@$active_color" >/dev/null 2>&1 || true
  if systemctl enable "agent-saas-runtime-worker@$active_color" >/dev/null 2>&1 \
    && systemctl restart "agent-saas-runtime-worker@$active_color" >/dev/null 2>&1; then
    for _ in $(seq 1 180); do
      if validate_worker_release_boundary "$active_color" "$active_env" - - \
        'Rollback Worker private ConfigIdentity'; then
        old_ready=true
        break
      fi
      sleep 1
    done
  fi
  if [ "$old_ready" != true ] \
    || ! validate_worker_release_boundary "$active_color" "$active_env" - - \
      'Rollback Worker final ConfigIdentity' \
    || systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color" \
    || systemctl is-enabled --quiet "agent-saas-runtime-worker@$candidate_color" \
    || { [ "$commit_marker" = true ] \
      && ! commit_worker_active_color "$active_color"; }; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    worker_restored_ref=false
    return 1
  fi
  [ "$fence_owned" != true ] || release_config_governance_fence
  worker_restored_ref=true
  [ "$commit_marker" != true ] \
    || [ "$(tr -d '[:space:]' <"${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}")" = "$active_color" ]
}

# Worker authority transitions hold one governance fence before stopping either side.
restore_candidate_worker_authority() {
  local active_color="$1" candidate_color="$2" env_path="$3"
  local commit_marker="${4:-true}" fence_held="${5:-false}"
  local marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local run_root="${AGENT_SAAS_WORKER_RUN_ROOT:-/run}"
  local candidate_ready=false fence_owned=false
  if [ "$fence_held" != true ]; then
    acquire_config_governance_fence \
      "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}" || return 1
    fence_owned=true
  fi
  if ! revoke_systemd_authority "agent-saas-runtime-worker@$active_color"; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  rm -f "$run_root/agent-saas-runtime-worker-$active_color.pid" \
    "$run_root/agent-saas-runtime-worker-$active_color.ready" \
    "$run_root/agent-saas-runtime-worker-$active_color.draining" \
    "$run_root/agent-saas-runtime-worker-$active_color.config-identity.json" \
    "$run_root/agent-saas-runtime-worker-$candidate_color.pid" \
    "$run_root/agent-saas-runtime-worker-$candidate_color.ready" \
    "$run_root/agent-saas-runtime-worker-$candidate_color.draining" \
    "$run_root/agent-saas-runtime-worker-$candidate_color.config-identity.json" || true
  systemctl reset-failed "agent-saas-runtime-worker@$candidate_color" >/dev/null 2>&1 || true
  if systemctl enable "agent-saas-runtime-worker@$candidate_color" >/dev/null 2>&1 \
    && systemctl restart "agent-saas-runtime-worker@$candidate_color" >/dev/null 2>&1; then
    for _ in $(seq 1 180); do
      if validate_worker_release_boundary "$candidate_color" "$env_path" - - \
        'Rollback candidate Worker restored authority'; then
        candidate_ready=true
        break
      fi
      sleep 1
    done
  fi
  if [ "$candidate_ready" != true ] \
    || ! validate_worker_release_boundary "$candidate_color" "$env_path" - - \
      'Rollback candidate Worker final ConfigIdentity' \
    || { [ "$commit_marker" = true ] \
      && ! commit_worker_active_color "$candidate_color"; }; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  [ "$fence_owned" != true ] || release_config_governance_fence
  systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color" \
    && ! systemctl is-active --quiet "agent-saas-runtime-worker@$active_color" \
    && { [ "$commit_marker" != true ] \
      || [ "$(tr -d '[:space:]' <"$marker")" = "$candidate_color" ]; }
}

# Old authority restoration follows the same pre-mutation fence rule.
restore_old_worker_authority() {
  local active_color="$1" candidate_color="$2" active_env="$3"
  local fence_held="${4:-false}" commit_marker="${5:-true}"
  local marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local run_root="${AGENT_SAAS_WORKER_RUN_ROOT:-/run}"
  local old_ready=false fence_owned=false
  if [ "$fence_held" != true ]; then
    acquire_config_governance_fence \
      "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}" || return 1
    fence_owned=true
  fi
  if ! revoke_systemd_authority "agent-saas-runtime-worker@$candidate_color"; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  rm -f "$run_root/agent-saas-runtime-worker-$active_color.pid" \
    "$run_root/agent-saas-runtime-worker-$active_color.ready" \
    "$run_root/agent-saas-runtime-worker-$active_color.draining" \
    "$run_root/agent-saas-runtime-worker-$active_color.config-identity.json" || true
  systemctl reset-failed "agent-saas-runtime-worker@$active_color" >/dev/null 2>&1 || true
  if systemctl enable "agent-saas-runtime-worker@$active_color" >/dev/null 2>&1 \
    && systemctl restart "agent-saas-runtime-worker@$active_color" >/dev/null 2>&1; then
    for _ in $(seq 1 180); do
      if validate_worker_release_boundary "$active_color" "$active_env" - - \
        'Rollback old Worker restored authority'; then
        old_ready=true
        break
      fi
      sleep 1
    done
  fi
  if [ "$old_ready" != true ] \
    || ! validate_worker_release_boundary "$active_color" "$active_env" - - \
      'Rollback old Worker final ConfigIdentity' \
    || systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color" \
    || systemctl is-enabled --quiet "agent-saas-runtime-worker@$candidate_color" \
    || { [ "$commit_marker" = true ] \
      && ! commit_worker_active_color "$active_color"; }; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  [ "$fence_owned" != true ] || release_config_governance_fence
  systemctl is-active --quiet "agent-saas-runtime-worker@$active_color" \
    && ! systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color" \
    && { [ "$commit_marker" != true ] \
      || [ "$(tr -d '[:space:]' <"$marker")" = "$active_color" ]; }
}

# App compensation keeps the fence across prepare, marker commit, and fallback.
restore_candidate_app_authority() {
  local api_active="$1" api_candidate="$2" candidate_nginx_backup="$3"
  local expected_json="$4" old_nginx_backup="$5" had_nginx="$6" nginx_changed="$7"
  local worker_active="$8" worker_candidate="$9" worker_env="${10}"
  local old_worker_env="${11}" old_api_env="${12}" fence_held="${13:-false}"
  local api_marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local worker_marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local app_prepared=false fence_owned=false
  if [ "$fence_held" != true ]; then
    acquire_config_governance_fence \
      "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}" || return 1
    fence_owned=true
  fi
  if restore_candidate_api_authority "$api_active" "$api_candidate" \
      "$candidate_nginx_backup" "$expected_json" "$old_nginx_backup" \
      "$had_nginx" "$nginx_changed" "$old_api_env" false \
    && restore_candidate_worker_authority "$worker_active" "$worker_candidate" \
      "$worker_env" false true \
    && validate_api_release_boundary "$api_candidate" "$expected_json" \
      'Rollback candidate App final API ConfigIdentity' \
    && validate_worker_release_boundary "$worker_candidate" "$worker_env" - - \
      'Rollback candidate App final Worker ConfigIdentity' \
    && validate_api_routing_boundary "$api_candidate" "$release_id" \
    && commit_app_active_colors "$api_candidate" "$worker_candidate" "$api_active"; then
    app_prepared=true
  fi
  if [ "$app_prepared" = true ] \
    && [ "$(tr -d '[:space:]' <"$api_marker")" = "$api_candidate" ] \
    && [ "$(tr -d '[:space:]' <"$worker_marker")" = "$worker_candidate" ]; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 0
  fi
  restore_old_api_authority "$api_active" "$api_candidate" \
    "$old_nginx_backup" "$had_nginx" "$nginx_changed" "$old_api_env" false || true
  restore_old_worker_authority "$worker_active" "$worker_candidate" \
    "$old_worker_env" true false || true
  [ "$fence_owned" != true ] || release_config_governance_fence
  return 1
}

# ACS deployment follows after App compensation helpers are fully defined.
deploy_acs() {
  local digest target previous main_pid identity_backup env_backup had_previous_identity candidate
  digest="$(node -p "require(process.env.MANIFEST_PATH).components.acs.orchestratorArtifactDigest.slice(7)")"
  target="/opt/agent-saas/acs-releases/$digest"
  previous=""
  if [ -L /opt/agent-saas/acs-current ]; then
    if ! previous="$(readlink -f /opt/agent-saas/acs-current)" || [ -z "$previous" ]; then
      echo 'Existing ACS release link cannot be resolved' >&2
      exit 1
    fi
  elif [ -e /opt/agent-saas/acs-current ]; then
    echo 'Existing ACS release path must be a symlink' >&2
    exit 1
  fi
  if [ -d "$target" ]; then
    node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component acs >/dev/null
  else
    candidate="$target.candidate-$GITHUB_RUN_ID"
    rm -rf "$candidate" && mkdir -p "$candidate/.release"
    install -m 0444 "$RELEASE_DIR/acs-orchestrator.tgz" "$candidate/.release/acs-orchestrator.tgz"
    tar -tzf "$candidate/.release/acs-orchestrator.tgz" \
      | awk '$0 == "./acs-orchestrator/dist/index.js" || $0 == "acs-orchestrator/dist/index.js" { found = 1 } END { exit !found }' \
      || { echo 'Production ACS bundle must contain acs-orchestrator/dist/index.js' >&2; exit 1; }
    tar -xzf "$candidate/.release/acs-orchestrator.tgz" -C "$candidate"
    test -s "$candidate/acs-orchestrator/dist/index.js"
    install -m 0444 "$MANIFEST_PATH" "$candidate/manifest.json"
    node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component acs >/dev/null
    mv "$candidate" "$target"
  fi
  env_backup="/etc/agent-saas/acs-orchestrator.env.before-$release_id-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  identity_backup="/etc/agent-saas/acs-release-identity.json.before-$release_id-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  rm -f "$env_backup" "$identity_backup"
  cp -a /etc/agent-saas/acs-orchestrator.env "$env_backup"
  had_previous_identity=false
  if [ -e /etc/agent-saas/acs-release-identity.json ]; then
    had_previous_identity=true
    cp -a /etc/agent-saas/acs-release-identity.json "$identity_backup"
  fi
  DEPLOY_ACS_ROLLBACK_COMMITTED=false
  DEPLOY_ACS_ROLLBACK_PREVIOUS="$previous"
  DEPLOY_ACS_ROLLBACK_ENV_BACKUP="$env_backup"
  DEPLOY_ACS_ROLLBACK_IDENTITY_BACKUP="$identity_backup"
  DEPLOY_ACS_ROLLBACK_HAD_PREVIOUS_IDENTITY="$had_previous_identity"
  cleanup_acs_failure() {
    if [ "$DEPLOY_ACS_ROLLBACK_COMMITTED" = false ]; then
      if [ -n "$DEPLOY_ACS_ROLLBACK_PREVIOUS" ]; then
        ln -sfn "$DEPLOY_ACS_ROLLBACK_PREVIOUS" /opt/agent-saas/acs-current || true
      else
        rm -f /opt/agent-saas/acs-current || true
      fi
      cp -a "$DEPLOY_ACS_ROLLBACK_ENV_BACKUP" /etc/agent-saas/acs-orchestrator.env || true
      if [ "$DEPLOY_ACS_ROLLBACK_HAD_PREVIOUS_IDENTITY" = true ]; then
        cp -a "$DEPLOY_ACS_ROLLBACK_IDENTITY_BACKUP" /etc/agent-saas/acs-release-identity.json || true
      else
        rm -f /etc/agent-saas/acs-release-identity.json || true
      fi
      systemctl restart agent-saas-acs-orchestrator.service || true
    fi
  }
  arm_deploy_rollback cleanup_acs_failure
  node - "$MANIFEST_PATH" /etc/agent-saas/acs-orchestrator.env <<'NODE'
const fs = require('node:fs');
const [manifestPath, envPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const image = `${manifest.artifacts.acsImage.repository}@${manifest.artifacts.acsImage.digest}`;
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('ACS_SANDBOX_IMAGE='));
lines.push(`ACS_SANDBOX_IMAGE=${image}`);
fs.writeFileSync(`${envPath}.candidate`, `${lines.join('\n')}\n`, { mode: 0o600 });
fs.renameSync(`${envPath}.candidate`, envPath);
NODE
  node - "$MANIFEST_PATH" /etc/agent-saas/acs-orchestrator.env <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [manifestPath, envPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const identity = {
  schemaVersion: 1, environment: 'production', releaseId: manifest.releaseId,
  sourceSha: manifest.components.acs.sourceSha,
  orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
  sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
  namespace: 'agent-saas-coding',
  configFingerprint: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(envPath)).digest('hex')}`,
};
fs.writeFileSync('/etc/agent-saas/acs-release-identity.json.candidate', `${JSON.stringify(identity)}\n`, { mode: 0o444 });
fs.renameSync('/etc/agent-saas/acs-release-identity.json.candidate', '/etc/agent-saas/acs-release-identity.json');
NODE
  ln -sfn "$target" /opt/agent-saas/acs-current
  if systemctl is-active --quiet agent-saas-acs-orchestrator.service; then
    main_pid="$(systemctl show agent-saas-acs-orchestrator.service --property MainPID --value)"
    kill -USR2 "$main_pid"
    for _ in $(seq 1 330); do
      systemctl is-active --quiet agent-saas-acs-orchestrator.service || break
      sleep 2
    done
    systemctl is-active --quiet agent-saas-acs-orchestrator.service && {
      echo 'Production ACS drain deadline exceeded' >&2
      exit 20
    }
  fi
  systemctl restart agent-saas-acs-orchestrator.service
  rm -f /tmp/acs-promotion-health.json
  for _ in $(seq 1 90); do
    curl -fsS http://127.0.0.1:3400/health >/tmp/acs-promotion-health.json && break
    sleep 2
  done
  if [ ! -s /tmp/acs-promotion-health.json ] || ! node - "$MANIFEST_PATH" /tmp/acs-promotion-health.json <<'NODE'
const fs = require('node:fs');
const [manifestPath, healthPath] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(manifestPath));
const h = JSON.parse(fs.readFileSync(healthPath));
if (h.environment !== 'production' || h.releaseId !== m.releaseId || h.sourceSha !== m.components.acs.sourceSha || h.orchestratorArtifactDigest !== m.components.acs.orchestratorArtifactDigest || h.sandboxImageDigest !== m.components.acs.sandboxImageDigest || h.namespace !== 'agent-saas-coding') process.exit(1);
NODE
  then
    exit 20
  fi
  DEPLOY_ACS_ROLLBACK_COMMITTED=true
  disarm_deploy_rollback
}

other_color() { [ "$1" = blue ] && echo green || echo blue; }
port_for_color() { [ "$1" = blue ] && echo 3200 || echo 3201; }

deploy_app() {
  local artifact_digest target api_active api_idle api_idle_port worker_active worker_idle old_api_pid old_worker_pid
  local api_idle_previous worker_idle_previous api_env worker_env rollback_root
  local had_api_env=false had_worker_env=false had_nginx=false nginx_changed=false
  artifact_digest="$(node -p "require(process.env.MANIFEST_PATH).components.api.artifactDigest.slice(7)")"
  target="/opt/agent-saas-app/releases/$artifact_digest"
  if [ -d "$target" ]; then
    node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component server >/dev/null
  else
    candidate="$target.candidate-$GITHUB_RUN_ID"
    rm -rf "$candidate" && mkdir -p "$candidate/.release"
    install -m 0444 "$RELEASE_DIR/server-bundle.tgz" "$candidate/.release/server-bundle.tgz"
    tar -tzf "$candidate/.release/server-bundle.tgz" \
      | awk '$0 == "./server/dist/index.js" || $0 == "server/dist/index.js" { found = 1 } END { exit !found }' \
      || { echo 'Production server bundle must contain server/dist/index.js' >&2; exit 1; }
    tar -xzf "$candidate/.release/server-bundle.tgz" -C "$candidate"
    test -s "$candidate/server/dist/index.js"
    install -m 0444 "$MANIFEST_PATH" "$candidate/manifest.json"
    node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component server >/dev/null
    mv "$candidate" "$target"
  fi
  mkdir -p "$target/server/data" "$target/workspace-shared"
  api_active="$(tr -d '[:space:]' </etc/agent-saas/active-color)"
  worker_active="$(tr -d '[:space:]' </etc/agent-saas/runtime-worker-active-color)"
  case "$api_active:$worker_active" in blue:blue|blue:green|green:blue|green:green) ;; *) exit 1 ;; esac
  api_idle="$(other_color "$api_active")"
  worker_idle="$(other_color "$worker_active")"
  api_idle_port="$(port_for_color "$api_idle")"
  api_idle_previous="$(readlink -f "/opt/agent-saas-app/color/$api_idle" 2>/dev/null || true)"
  worker_idle_previous="$(readlink -f "/opt/agent-saas-app/worker/$worker_idle" 2>/dev/null || true)"
  api_env="/etc/agent-saas/server-$api_idle.release.env"
  worker_env="/etc/agent-saas/runtime-worker-$worker_idle.release.env"
  rollback_root="/tmp/agent-saas-app-rollback-$release_id-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  rm -rf "$rollback_root"
  mkdir -p "$rollback_root"
  if [ -e "$api_env" ]; then
    had_api_env=true
    cp -a "$api_env" "$rollback_root/api.release.env"
  fi
  if [ -e "$worker_env" ]; then
    had_worker_env=true
    cp -a "$worker_env" "$rollback_root/worker.release.env"
  fi
  DEPLOY_APP_ROLLBACK_COMMITTED=false
  DEPLOY_APP_ROLLBACK_API_ACTIVE="$api_active"
  DEPLOY_APP_ROLLBACK_API_IDLE="$api_idle"
  DEPLOY_APP_ROLLBACK_WORKER_ACTIVE="$worker_active"
  DEPLOY_APP_ROLLBACK_WORKER_IDLE="$worker_idle"
  DEPLOY_APP_ROLLBACK_API_IDLE_PREVIOUS="$api_idle_previous"
  DEPLOY_APP_ROLLBACK_WORKER_IDLE_PREVIOUS="$worker_idle_previous"
  DEPLOY_APP_ROLLBACK_API_ENV="$api_env"
  DEPLOY_APP_ROLLBACK_WORKER_ENV="$worker_env"
  DEPLOY_APP_ROLLBACK_ROOT="$rollback_root"
  DEPLOY_APP_ROLLBACK_HAD_API_ENV="$had_api_env"
  DEPLOY_APP_ROLLBACK_HAD_WORKER_ENV="$had_worker_env"
  DEPLOY_APP_ROLLBACK_HAD_NGINX=false
  DEPLOY_APP_ROLLBACK_NGINX_CHANGED=false
  DEPLOY_APP_ROLLBACK_API_CANDIDATE_ADMITTED=false
  DEPLOY_APP_ROLLBACK_WORKER_CANDIDATE_ADMITTED=false
  DEPLOY_APP_ROLLBACK_CONFIG_IDENTITY=
  cleanup_app_failure() {
    local api_restored=false api_rollback_committed=false api_candidate_stopped=false
    local worker_restored=false candidate_stopped=false worker_rollback_committed=false
    local app_candidate_restored=false app_old_compensated=false
    local api_candidate_nginx_backup rollback_target=old old_release_id
    local app_committed="$DEPLOY_APP_ROLLBACK_COMMITTED"
    local api_active="$DEPLOY_APP_ROLLBACK_API_ACTIVE" api_idle="$DEPLOY_APP_ROLLBACK_API_IDLE"
    local worker_active="$DEPLOY_APP_ROLLBACK_WORKER_ACTIVE" worker_idle="$DEPLOY_APP_ROLLBACK_WORKER_IDLE"
    local api_idle_previous="$DEPLOY_APP_ROLLBACK_API_IDLE_PREVIOUS"
    local worker_idle_previous="$DEPLOY_APP_ROLLBACK_WORKER_IDLE_PREVIOUS"
    local api_env="$DEPLOY_APP_ROLLBACK_API_ENV" worker_env="$DEPLOY_APP_ROLLBACK_WORKER_ENV"
    local rollback_root="$DEPLOY_APP_ROLLBACK_ROOT"
    local had_api_env="$DEPLOY_APP_ROLLBACK_HAD_API_ENV"
    local had_worker_env="$DEPLOY_APP_ROLLBACK_HAD_WORKER_ENV"
    local had_nginx="$DEPLOY_APP_ROLLBACK_HAD_NGINX"
    local nginx_changed="$DEPLOY_APP_ROLLBACK_NGINX_CHANGED"
    local api_candidate_admitted="$DEPLOY_APP_ROLLBACK_API_CANDIDATE_ADMITTED"
    local worker_candidate_admitted="$DEPLOY_APP_ROLLBACK_WORKER_CANDIDATE_ADMITTED"
    local rollback_config_identity="$DEPLOY_APP_ROLLBACK_CONFIG_IDENTITY"
    local old_api_env="/etc/agent-saas/server-$api_active.release.env"
    local old_worker_env="/etc/agent-saas/runtime-worker-$worker_active.release.env"
    if [ "$app_committed" = false ]; then
      if [ -z "$CONFIG_GOVERNANCE_FENCE" ] \
        && ! acquire_config_governance_fence \
          "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}"; then
        echo 'ERROR: App rollback refused to mutate authority while config governance is active' >&2
        return 1
      fi
      # API 与 Worker 只共同提交同一旧 release；候选恢复也延迟到 App 双侧复检后提交 marker。
      if ! validate_app_release_envs_match "$old_api_env" "$old_worker_env"; then
        rollback_target=candidate
      fi
      if [ "$rollback_target" = old ]; then
        rm -f "/run/agent-saas-server-$api_active.pid" \
          "/run/agent-saas-server-$api_active.ready" \
          "/run/agent-saas-server-$api_active.draining" || true
        systemctl reset-failed "agent-saas-server@$api_active" >/dev/null 2>&1 || true
        if systemctl enable "agent-saas-server@$api_active" >/dev/null 2>&1 \
          && systemctl restart "agent-saas-server@$api_active" >/dev/null 2>&1; then
          for _ in $(seq 1 180); do
            if validate_api_release_boundary_from_env "$api_active" "$old_api_env" \
              'Rollback old API restored ConfigIdentity'; then
              api_restored=true
              break
            fi
            sleep 1
          done
        fi
      fi
      api_candidate_nginx_backup="$rollback_root/nginx-candidate-upstream.conf"
      rm -f "$api_candidate_nginx_backup"
      if [ "$nginx_changed" = true ] \
        && [ -s /etc/nginx/conf.d/agent-saas-upstream.conf ]; then
        cp -a /etc/nginx/conf.d/agent-saas-upstream.conf "$api_candidate_nginx_backup" || true
      else
        cat >"$api_candidate_nginx_backup" <<EOF
# active=$api_idle release=$release_id
upstream agent_saas_backend {
    server 127.0.0.1:$(port_for_color "$api_idle");
    server 127.0.0.1:$(port_for_color "$api_active") backup;
}
EOF
      fi
      if [ "$rollback_target" = old ] \
        && [ "$api_restored" = true ] \
        && commit_rollback_api_authority "$api_active" "$api_idle" \
          "$rollback_root/nginx-upstream.conf" "$had_nginx" "$nginx_changed" \
          "$old_api_env" api_candidate_stopped false; then
        api_rollback_committed=true
      else
        rollback_target=candidate
      fi

      if [ "$rollback_target" = old ]; then
        if commit_rollback_worker_authority "$worker_active" "$worker_idle" \
          "$old_worker_env" candidate_stopped worker_restored true false; then
          worker_rollback_committed=true
        else
          rollback_target=candidate
        fi
      fi

      if [ "$rollback_target" = old ] \
        && [ "$api_rollback_committed" = true ] \
        && [ "$worker_rollback_committed" = true ] \
        && old_release_id="$(read_release_id_from_env "$old_api_env")" \
        && validate_api_release_boundary_from_env "$api_active" "$old_api_env" \
          'Rollback old App final API ConfigIdentity' \
        && validate_worker_release_boundary "$worker_active" "$old_worker_env" - - \
          'Rollback old App final Worker ConfigIdentity' \
        && validate_api_routing_boundary "$api_active" "$old_release_id" \
        && commit_app_active_colors "$api_active" "$worker_active" "$api_idle"; then
        rm -f "/run/agent-saas-server-$api_idle.config-identity.json" \
          "/run/agent-saas-runtime-worker-$worker_idle.config-identity.json" || true
        if [ -n "$api_idle_previous" ]; then
          ln -sfn "$api_idle_previous" "/opt/agent-saas-app/color/$api_idle" || true
        else
          rm -f "/opt/agent-saas-app/color/$api_idle" || true
        fi
        if [ -n "$worker_idle_previous" ]; then
          ln -sfn "$worker_idle_previous" "/opt/agent-saas-app/worker/$worker_idle" || true
        else
          rm -f "/opt/agent-saas-app/worker/$worker_idle" || true
        fi
        if [ "$had_api_env" = true ]; then
          cp -a "$rollback_root/api.release.env" "$api_env" || true
        else
          rm -f "$api_env" || true
        fi
        if [ "$had_worker_env" = true ]; then
          cp -a "$rollback_root/worker.release.env" "$worker_env" || true
        else
          rm -f "$worker_env" || true
        fi
      else
        if [ "$api_candidate_admitted" = true ] \
          && [ "$worker_candidate_admitted" = true ] \
          && [ -n "$rollback_config_identity" ] \
          && [ -s "$api_candidate_nginx_backup" ] \
          && restore_candidate_app_authority \
            "$api_active" "$api_idle" "$api_candidate_nginx_backup" \
            "$rollback_config_identity" "$rollback_root/nginx-upstream.conf" \
            "$had_nginx" "$nginx_changed" "$worker_active" "$worker_idle" \
            "$worker_env" "$old_worker_env" "$old_api_env" true; then
          app_candidate_restored=true
        elif validate_app_release_envs_match "$old_api_env" "$old_worker_env"; then
          if restore_old_api_authority "$api_active" "$api_idle" \
            "$rollback_root/nginx-upstream.conf" "$had_nginx" "$nginx_changed" \
            "$old_api_env" false \
            && restore_old_worker_authority "$worker_active" "$worker_idle" \
              "$old_worker_env" true false \
            && old_release_id="$(read_release_id_from_env "$old_api_env")" \
            && validate_api_release_boundary_from_env "$api_active" "$old_api_env" \
              'Compensated old App final API ConfigIdentity' \
            && validate_worker_release_boundary "$worker_active" "$old_worker_env" - - \
              'Compensated old App final Worker ConfigIdentity' \
            && validate_api_routing_boundary "$api_active" "$old_release_id" \
            && commit_app_active_colors "$api_active" "$worker_active" "$api_idle"; then
            app_old_compensated=true
          fi
        fi
        if [ "$app_candidate_restored" = true ]; then
          echo 'ERROR: preserving one candidate App authority because rollback commit failed' >&2
        elif [ "$app_old_compensated" = true ]; then
          echo 'ERROR: restored one old App authority after candidate compensation failed' >&2
        else
          echo 'ERROR: App rollback could not converge API and Worker to one release' >&2
        fi
      fi
      release_config_governance_fence
    fi
  }
  arm_deploy_rollback cleanup_app_failure
  acquire_config_governance_fence /mnt/agent-saas/server-data
  ln -sfn "$target" "/opt/agent-saas-app/color/$api_idle"
  ln -sfn "$target" "/opt/agent-saas-app/worker/$worker_idle"
  # TASK-318：发布前对主机实际配置计算 expected config identity（同一实现于
  # 运行期 observed identity；含受管 inline secret 的 production fail-closed）。
  # 候选 CLI 不继承 rollback receipt 元数据，stderr 也加前缀后再回放，避免普通诊断
  # 碰巧形成 Workflow 识别的裸 sentinel。恶意 root 制品仍属于既有发布信任边界。
  config_identity="$(env \
    -u PHASE \
    -u GITHUB_RUN_ID \
    -u GITHUB_RUN_ATTEMPT \
    -u ROLLBACK_ATTEMPTED_MARKER \
    node "$target/server/dist/config-identity-cli.js" \
    --config /etc/agent-saas/config.json --environment production \
    --process-cwd "$target/server" \
    --runtime-data-dir /mnt/agent-saas/server-data \
    --env-file /etc/agent-saas/server.env \
    2> >(sed 's/^/[config-identity-cli] /' >&2))"
  DEPLOY_APP_ROLLBACK_CONFIG_IDENTITY="$config_identity"
  upsert_env "$MANIFEST_PATH" "$api_env" api "$config_identity"
  upsert_env "$MANIFEST_PATH" "$worker_env" worker "$config_identity"

  rm -f "/run/agent-saas-server-$api_idle.pid" \
    "/run/agent-saas-server-$api_idle.ready" \
    "/run/agent-saas-server-$api_idle.draining" \
    "/run/agent-saas-server-$api_idle.config-identity.json"
  systemctl enable --now "agent-saas-server@$api_idle"
  for _ in $(seq 1 180); do
    if curl -fsS "http://127.0.0.1:$api_idle_port/api/healthz/ready" >/tmp/api-candidate-ready.json; then break; fi
    sleep 1
  done
  node --input-type=module - "$MANIFEST_PATH" /tmp/api-candidate-ready.json \
    "/run/agent-saas-server-$api_idle.config-identity.json" "$config_identity" \
    "$config_identity_reader" <<'NODE'
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [manifestPath, readyPath, snapshotPath, expectedJson, readerPath] = process.argv.slice(2);
const { validateCandidateReleaseReadiness } = await import(pathToFileURL(readerPath));
await validateCandidateReleaseReadiness({
  environment: 'production',
  manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  readiness: JSON.parse(fs.readFileSync(readyPath, 'utf8')),
  privateSnapshotPath: snapshotPath,
  expectedConfigIdentity: JSON.parse(expectedJson),
});
NODE
  DEPLOY_APP_ROLLBACK_API_CANDIDATE_ADMITTED=true

  if [ -e /etc/nginx/conf.d/agent-saas-upstream.conf ]; then
    had_nginx=true
    DEPLOY_APP_ROLLBACK_HAD_NGINX=true
    cp -a /etc/nginx/conf.d/agent-saas-upstream.conf "$rollback_root/nginx-upstream.conf"
  fi
  nginx_changed=true
  DEPLOY_APP_ROLLBACK_NGINX_CHANGED=true
  cat > /etc/nginx/conf.d/agent-saas-upstream.conf <<EOF
# active=$api_idle release=$release_id
upstream agent_saas_backend {
    server 127.0.0.1:$api_idle_port;
    server 127.0.0.1:$(port_for_color "$api_active") backup;
}
EOF
  if ! nginx -t; then
    if [ "$had_nginx" = true ]; then
      cp -a "$rollback_root/nginx-upstream.conf" /etc/nginx/conf.d/agent-saas-upstream.conf
    else
      rm -f /etc/nginx/conf.d/agent-saas-upstream.conf
    fi
    exit 1
  fi
  systemctl reload nginx
  curl -kfsS -H 'Host: api.agent.kaiyan.net' https://127.0.0.1/api/healthz/ready >/dev/null
  validate_api_release_boundary "$api_idle" "$config_identity" \
    'Candidate API final ConfigIdentity'

  rm -f "/run/agent-saas-runtime-worker-$worker_idle.pid" \
    "/run/agent-saas-runtime-worker-$worker_idle.ready" \
    "/run/agent-saas-runtime-worker-$worker_idle.draining" \
    "/run/agent-saas-runtime-worker-$worker_idle.config-identity.json"
  systemctl enable --now "agent-saas-runtime-worker@$worker_idle"
  for _ in $(seq 1 180); do
    pid="$(cat "/run/agent-saas-runtime-worker-$worker_idle.pid" 2>/dev/null || true)"
    ready="$(cat "/run/agent-saas-runtime-worker-$worker_idle.ready" 2>/dev/null || true)"
    [ -n "$pid" ] && [ "$pid" = "$ready" ] && kill -0 "$pid" 2>/dev/null && break
    sleep 1
  done
  validate_worker_release_boundary "$worker_idle" - "$release_id" "$config_identity" \
    'Candidate Worker private ConfigIdentity'
  DEPLOY_APP_ROLLBACK_WORKER_CANDIDATE_ADMITTED=true
  if ! validate_api_release_boundary "$api_idle" "$config_identity" \
      'Candidate App final API ConfigIdentity' \
    || ! validate_worker_release_boundary "$worker_idle" - "$release_id" "$config_identity" \
      'Candidate App final Worker ConfigIdentity' \
    || ! validate_api_routing_boundary "$api_idle" "$release_id" \
    || ! commit_app_active_colors "$api_idle" "$worker_idle" "$api_active"; then
    echo 'Candidate App lost authority before marker commit' >&2
    exit 1
  fi

  old_worker_pid="$(cat "/run/agent-saas-runtime-worker-$worker_active.pid" 2>/dev/null || true)"
  if [ -n "$old_worker_pid" ]; then
    install -m 0644 /dev/null "/run/agent-saas-runtime-worker-$worker_active.draining"
    kill -USR2 "$old_worker_pid"
  fi
  old_api_pid="$(cat "/run/agent-saas-server-$api_active.pid" 2>/dev/null || true)"
  if [ -n "$old_api_pid" ]; then
    install -m 0644 /dev/null "/run/agent-saas-server-$api_active.draining"
    kill -USR2 "$old_api_pid"
  fi
  retire_systemd_authority "agent-saas-server@$api_active"
  retire_systemd_authority "agent-saas-runtime-worker@$worker_active"
  validate_api_release_boundary "$api_idle" "$config_identity" \
    'Committed candidate App final API ConfigIdentity'
  validate_worker_release_boundary "$worker_idle" "$worker_env" - - \
    'Committed candidate App final Worker ConfigIdentity'
  validate_api_routing_boundary "$api_idle" "$release_id"
  [ "$(tr -d '[:space:]' </etc/agent-saas/active-color)" = "$api_idle" ]
  [ "$(tr -d '[:space:]' </etc/agent-saas/runtime-worker-active-color)" = "$worker_idle" ]
  DEPLOY_APP_ROLLBACK_COMMITTED=true
  release_config_governance_fence
  disarm_deploy_rollback
}

if [ "$PHASE" = acs ]; then deploy_acs; else deploy_app; fi
echo "$PHASE phase completed for $release_id"
