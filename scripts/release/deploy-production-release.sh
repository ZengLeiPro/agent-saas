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

release_config_governance_fence() {
  if [ -n "$CONFIG_GOVERNANCE_FENCE" ]; then
    rm -rf "$CONFIG_GOVERNANCE_FENCE"
    CONFIG_GOVERNANCE_FENCE=
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
    release_config_governance_fence
    emit_rollback_attempted_sentinel
    mark_rollback_attempted
    "$rollback_handler"
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
  test -z "$CONFIG_GOVERNANCE_FENCE" || return 1
  mkdir -p "$(dirname "$fence")"
  if ! mkdir "$fence"; then
    echo "Config mutation is active; refusing Worker authority commit: $fence" >&2
    return 1
  fi
  if ! printf '{"pid":%s,"createdAt":"%s"}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$fence/owner.json"; then
    rm -rf "$fence"
    return 1
  fi
  CONFIG_GOVERNANCE_FENCE="$fence"
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
  node --input-type=module - "$env_path" "$snapshot_path" "$expected_release_id" \
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
}

commit_worker_active_color() {
  local color="$1"
  local marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local candidate="$marker.candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  printf '%s\n' "$color" >"$candidate"
  mv -f "$candidate" "$marker"
}

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
  cleanup_app_failure() {
    local api_restored=false worker_restored=false
    local candidate_stopped=false candidate_restored=false
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
    if [ "$app_committed" = false ]; then
      # 清除旧 API drain 状态并恢复 ready，再翻回 nginx；只有流量确认回旧色后才停候选与恢复其 env。
      rm -f "/run/agent-saas-server-$api_active.pid" \
        "/run/agent-saas-server-$api_active.ready" \
        "/run/agent-saas-server-$api_active.draining" || true
      systemctl reset-failed "agent-saas-server@$api_active" >/dev/null 2>&1 || true
      if systemctl enable "agent-saas-server@$api_active" >/dev/null 2>&1 \
        && systemctl restart "agent-saas-server@$api_active" >/dev/null 2>&1; then
        for _ in $(seq 1 180); do
          if curl -fsS "http://127.0.0.1:$(port_for_color "$api_active")/api/healthz/ready" >/dev/null 2>&1; then
            api_restored=true
            break
          fi
          sleep 1
        done
      fi
      if [ "$api_restored" = true ] && [ "$nginx_changed" = true ]; then
        if [ "$had_nginx" = true ]; then
          cp -a "$rollback_root/nginx-upstream.conf" /etc/nginx/conf.d/agent-saas-upstream.conf
        else
          rm -f /etc/nginx/conf.d/agent-saas-upstream.conf
        fi
        if ! { nginx -t >/dev/null 2>&1 && systemctl reload nginx; }; then
          api_restored=false
        fi
      fi
      if [ "$api_restored" = true ] \
        && systemctl disable --now "agent-saas-server@$api_idle" >/dev/null 2>&1 \
        && ! systemctl is-active --quiet "agent-saas-server@$api_idle"; then
        printf '%s\n' "$api_active" >/etc/agent-saas/active-color
        if [ -n "$api_idle_previous" ]; then
          ln -sfn "$api_idle_previous" "/opt/agent-saas-app/color/$api_idle" || true
        else
          rm -f "/opt/agent-saas-app/color/$api_idle" || true
        fi
        if [ "$had_api_env" = true ]; then
          cp -a "$rollback_root/api.release.env" "$api_env" || true
        else
          rm -f "$api_env" || true
        fi
      else
        echo 'ERROR: preserving candidate API release/env because old traffic or candidate stop is unverified' >&2
      fi

      # 旧 Worker 先完成初检；停候选后，在配置 mutation fence 内再复检并提交 marker。
      rm -f "/run/agent-saas-runtime-worker-$worker_active.pid" \
        "/run/agent-saas-runtime-worker-$worker_active.ready" \
        "/run/agent-saas-runtime-worker-$worker_active.draining" \
        "/run/agent-saas-runtime-worker-$worker_active.config-identity.json" || true
      systemctl reset-failed "agent-saas-runtime-worker@$worker_active" >/dev/null 2>&1 || true
      if systemctl enable "agent-saas-runtime-worker@$worker_active" >/dev/null 2>&1 \
        && systemctl restart "agent-saas-runtime-worker@$worker_active" >/dev/null 2>&1; then
        for _ in $(seq 1 180); do
          if validate_worker_release_boundary "$worker_active" \
            "/etc/agent-saas/runtime-worker-$worker_active.release.env" - - \
            'Rollback Worker private ConfigIdentity'; then
            worker_restored=true
            break
          fi
          sleep 1
        done
      fi
      if [ "$worker_restored" = true ] \
        && acquire_config_governance_fence /mnt/agent-saas/server-data; then
        if ! validate_worker_release_boundary "$worker_active" \
          "/etc/agent-saas/runtime-worker-$worker_active.release.env" - - \
          'Rollback Worker private ConfigIdentity'; then
          worker_restored=false
        else
          systemctl disable --now "agent-saas-runtime-worker@$worker_idle" >/dev/null 2>&1
          if ! systemctl is-active --quiet "agent-saas-runtime-worker@$worker_idle"; then
            candidate_stopped=true
            if validate_worker_release_boundary "$worker_active" \
              "/etc/agent-saas/runtime-worker-$worker_active.release.env" - - \
              'Rollback Worker final ConfigIdentity' \
              && commit_worker_active_color "$worker_active"; then
              release_config_governance_fence
              rm -f "/run/agent-saas-runtime-worker-$worker_idle.config-identity.json" || true
              if [ -n "$worker_idle_previous" ]; then
                ln -sfn "$worker_idle_previous" "/opt/agent-saas-app/worker/$worker_idle" || true
              else
                rm -f "/opt/agent-saas-app/worker/$worker_idle" || true
              fi
              if [ "$had_worker_env" = true ]; then
                cp -a "$rollback_root/worker.release.env" "$worker_env" || true
              else
                rm -f "$worker_env" || true
              fi
            else
              worker_restored=false
            fi
          else
            worker_restored=false
          fi
        fi
        release_config_governance_fence
      else
        worker_restored=false
      fi
      if [ "$worker_restored" != true ]; then
        if [ "$candidate_stopped" = true ]; then
          rm -f "/run/agent-saas-runtime-worker-$worker_idle.pid" \
            "/run/agent-saas-runtime-worker-$worker_idle.ready" \
            "/run/agent-saas-runtime-worker-$worker_idle.draining" \
            "/run/agent-saas-runtime-worker-$worker_idle.config-identity.json" || true
          systemctl reset-failed "agent-saas-runtime-worker@$worker_idle" >/dev/null 2>&1 || true
          if systemctl enable --now "agent-saas-runtime-worker@$worker_idle" >/dev/null 2>&1; then
            for _ in $(seq 1 180); do
              if validate_worker_release_boundary "$worker_idle" "$worker_env" - - \
                'Rollback candidate Worker restored authority'; then
                candidate_restored=true
                break
              fi
              sleep 1
            done
          fi
        fi
        if [ "$candidate_stopped" = true ] && [ "$candidate_restored" != true ]; then
          echo 'ERROR: Worker rollback failed after candidate stop; candidate restart is not ready' >&2
        else
          echo 'ERROR: preserving candidate Worker authority because rollback final validation failed' >&2
        fi
      fi
    fi
  }
  arm_deploy_rollback cleanup_app_failure
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
  upsert_env "$MANIFEST_PATH" "$api_env" api "$config_identity"
  upsert_env "$MANIFEST_PATH" "$worker_env" worker "$config_identity"

  rm -f "/run/agent-saas-server-$api_idle.pid" "/run/agent-saas-server-$api_idle.draining"
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
  echo "$api_idle" >/etc/agent-saas/active-color

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
  acquire_config_governance_fence /mnt/agent-saas/server-data
  if ! validate_worker_release_boundary "$worker_idle" - "$release_id" "$config_identity" \
    'Candidate Worker final ConfigIdentity'; then
    release_config_governance_fence
    echo 'Candidate Worker lost authority before marker commit' >&2
    exit 1
  fi
  commit_worker_active_color "$worker_idle"
  release_config_governance_fence

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
  systemctl disable "agent-saas-server@$api_active" "agent-saas-runtime-worker@$worker_active"
  DEPLOY_APP_ROLLBACK_COMMITTED=true
  disarm_deploy_rollback
}

if [ "$PHASE" = acs ]; then deploy_acs; else deploy_app; fi
echo "$PHASE phase completed for $release_id"
