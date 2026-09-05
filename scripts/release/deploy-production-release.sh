#!/usr/bin/env bash
set -euo pipefail

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

  # 首次迁移时两个旧 marker 仍保持原值；持久提交只有 authority link 的原子 rename。
  old_generation="$(mktemp -d "$authority_dir/generation-old.XXXXXX")" || return 1
  printf '%s\n' "$old_api" >"$old_generation/api"
  printf '%s\n' "$old_worker" >"$old_generation/worker"
  link_candidate="$authority_link.candidate-${GITHUB_RUN_ID:-rollback}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$link_candidate"
  ln -s "$old_generation" "$link_candidate"
  mv -fT "$link_candidate" "$authority_link"

  marker_candidate="$api_marker.authority-link-candidate-${GITHUB_RUN_ID:-rollback}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$marker_candidate"
  ln -s "$authority_link/api" "$marker_candidate"
  mv -fT "$marker_candidate" "$api_marker"
  marker_candidate="$worker_marker.authority-link-candidate-${GITHUB_RUN_ID:-rollback}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$marker_candidate"
  ln -s "$authority_link/worker" "$marker_candidate"
  mv -fT "$marker_candidate" "$worker_marker"

  new_generation="$(mktemp -d "$authority_dir/generation.XXXXXX")" || return 1
  printf '%s\n' "$api_color" >"$new_generation/api"
  printf '%s\n' "$worker_color" >"$new_generation/worker"
  link_candidate="$authority_link.candidate-${GITHUB_RUN_ID:-rollback}-${GITHUB_RUN_ATTEMPT:-1}-$$"
  rm -f "$link_candidate"
  ln -s "$new_generation" "$link_candidate"
  mv -fT "$link_candidate" "$authority_link"
  [ "$(tr -d '[:space:]' <"$api_marker")" = "$api_color" ] \
    && [ "$(tr -d '[:space:]' <"$worker_marker")" = "$worker_color" ]
}

record_rollback_attempt() {
  local path="${ROLLBACK_ATTEMPTED_RECEIPT_PATH:-${ROLLBACK_RECEIPT_PATH:-}}"
  [ -z "$path" ] || printf '%s\n' "${PHASE:-unknown}:${release_id:-unknown}" >"$path"
}

record_rollback_success() {
  local path="${ROLLBACK_SUCCEEDED_RECEIPT_PATH:-}"
  [ -z "$path" ] || printf '%s\n' "${PHASE:-unknown}:${release_id:-unknown}" >"$path"
}


rollback_app_release() {
  # 这里只恢复旧 generation 的磁盘状态。服务、nginx 与 authority 必须由
  # cleanup_app_failure 在持有 governance fence 且通过双侧 readiness 后提交。
  local rollback_status=0
  set +e

  record_rollback_attempt || rollback_status=1
  if [ "$had_api_env" = true ]; then
    cp -a "$rollback_root/api.release.env" "$api_env" || rollback_status=1
  else
    rm -f "$api_env" || rollback_status=1
  fi
  if [ "$had_worker_env" = true ]; then
    cp -a "$rollback_root/worker.release.env" "$worker_env" || rollback_status=1
  else
    rm -f "$worker_env" || rollback_status=1
  fi

  if [ -n "$api_idle_previous" ]; then
    ln -sfn "$api_idle_previous" "$APP_COLOR_ROOT/$api_idle" || rollback_status=1
  else
    rm -f "$APP_COLOR_ROOT/$api_idle" || rollback_status=1
  fi
  if [ -n "$worker_idle_previous" ]; then
    ln -sfn "$worker_idle_previous" "$APP_WORKER_ROOT/$worker_idle" || rollback_status=1
  else
    rm -f "$APP_WORKER_ROOT/$worker_idle" || rollback_status=1
  fi

  cp -a "$rollback_root/server@.service" "$server_unit" || rollback_status=1
  cp -a "$rollback_root/runtime-worker@.service" "$worker_unit" || rollback_status=1
  systemctl daemon-reload || rollback_status=1
  rm -f "/run/agent-saas-server-$api_active.draining" || rollback_status=1
  rm -f "/run/agent-saas-runtime-worker-$worker_active.draining" || rollback_status=1

  if [ "$rollback_status" -ne 0 ]; then
    echo 'App rollback completed with one or more recovery failures' >&2
    return 70
  fi
  return 0
}

cleanup_app_failure() {
  local deploy_status=$?
  local rollback_status=0
  set +e
  if [ "$app_committed" = false ] && [ "${app_mutation_started:-false}" = true ]; then
    rollback_app_release
    rollback_status=$?
    if [ "$rollback_status" -ne 0 ]; then
      echo "App deployment failed with status $deploy_status; rollback status $rollback_status" >&2
      trap - EXIT HUP INT TERM
      exit "$rollback_status"
    fi
  fi
  return "$deploy_status"
}

rollback_acs_release() {
  # current、env、identity、unit 与服务恢复全部独立尝试，失败时保留 rollback_root。
  local rollback_status=0
  local runtime_verify="${ROLLBACK_RUNTIME_VERIFY:-true}"
  set +e

  record_rollback_attempt || rollback_status=1
  if [ -n "$previous" ]; then
    ln -sfn "$previous" "$ACS_CURRENT_PATH" || rollback_status=1
  else
    rm -f "$ACS_CURRENT_PATH" || rollback_status=1
  fi
  cp -a "$rollback_root/acs-orchestrator.env" "$ACS_ENV_PATH" || rollback_status=1
  if [ "$had_previous_identity" = true ]; then
    cp -a "$rollback_root/acs-release-identity.json" "$ACS_IDENTITY_PATH" || rollback_status=1
  else
    rm -f "$ACS_IDENTITY_PATH" || rollback_status=1
  fi
  if [ "$had_previous_unit" = true ]; then
    cp -a "$rollback_root/acs-orchestrator.service" "$unit_path" || rollback_status=1
  else
    rm -f "$unit_path" || rollback_status=1
  fi
  systemctl daemon-reload || rollback_status=1

  if [ -n "$previous" ]; then
    if [ "$runtime_verify" = true ]; then
      test "$(readlink -f "$ACS_CURRENT_PATH" 2>/dev/null || true)" = "$previous" || rollback_status=1
      node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$previous" --component acs >/dev/null || rollback_status=1
      cmp "$rollback_root/acs-orchestrator.env" "$ACS_ENV_PATH" || rollback_status=1
      if [ "$had_previous_identity" = true ]; then
        cmp "$rollback_root/acs-release-identity.json" "$ACS_IDENTITY_PATH" || rollback_status=1
      else
        test ! -e "$ACS_IDENTITY_PATH" || rollback_status=1
      fi
      if [ "$had_previous_unit" = true ]; then
        cmp "$rollback_root/acs-orchestrator.service" "$unit_path" || rollback_status=1
      else
        test ! -e "$unit_path" || rollback_status=1
      fi
    fi
    systemctl restart "$ACS_SERVICE_NAME" || rollback_status=1
    if [ "$runtime_verify" = true ]; then
      rm -f /tmp/acs-rollback-health.json || rollback_status=1
      for _ in $(seq 1 90); do
        curl -fsS http://127.0.0.1:3400/health >/tmp/acs-rollback-health.json && break
        sleep 2
      done
      test -s /tmp/acs-rollback-health.json || rollback_status=1
      node - "$ACS_IDENTITY_PATH" /tmp/acs-rollback-health.json <<'NODE' || rollback_status=1
const fs = require('node:fs');
const [identityPath, healthPath] = process.argv.slice(2);
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
for (const key of ['environment', 'releaseId', 'sourceSha', 'orchestratorArtifactDigest', 'sandboxImageDigest', 'namespace']) {
  if (identity[key] !== health[key]) process.exit(1);
}
NODE
    fi
  else
    systemctl disable --now "$ACS_SERVICE_NAME" || rollback_status=1
    if [ "$runtime_verify" = true ]; then
      test ! -e "$ACS_CURRENT_PATH" && test ! -L "$ACS_CURRENT_PATH" || rollback_status=1
      test ! -e "$ACS_IDENTITY_PATH" || rollback_status=1
    fi
  fi

  if [ "$rollback_status" -ne 0 ]; then
    echo 'ACS rollback completed with one or more recovery failures' >&2
    return 70
  fi
  record_rollback_success || return 70
  return 0
}

cleanup_acs_failure() {
  local deploy_status=$?
  local rollback_status=0
  set +e
  if [ "$acs_committed" = false ] && [ "${acs_mutation_started:-false}" = true ]; then
    rollback_acs_release
    rollback_status=$?
    if [ "$rollback_status" -ne 0 ]; then
      echo "ACS deployment failed with status $deploy_status; rollback status $rollback_status" >&2
      trap - EXIT HUP INT TERM
      exit "$rollback_status"
    fi
  fi
  rm -rf "$rollback_root"
  return "$deploy_status"
}

APP_COLOR_ROOT="${APP_COLOR_ROOT:-/opt/agent-saas-app/color}"
APP_WORKER_ROOT="${APP_WORKER_ROOT:-/opt/agent-saas-app/worker}"
ACTIVE_COLOR_PATH="${ACTIVE_COLOR_PATH:-/etc/agent-saas/active-color}"
WORKER_ACTIVE_COLOR_PATH="${WORKER_ACTIVE_COLOR_PATH:-/etc/agent-saas/runtime-worker-active-color}"
NGINX_UPSTREAM_PATH="${NGINX_UPSTREAM_PATH:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
ACS_CURRENT_PATH="${ACS_CURRENT_PATH:-/opt/agent-saas/acs-current}"
ACS_ENV_PATH="${ACS_ENV_PATH:-/etc/agent-saas/acs-orchestrator.env}"
ACS_IDENTITY_PATH="${ACS_IDENTITY_PATH:-/etc/agent-saas/acs-release-identity.json}"
ACS_UNIT_PATH="${ACS_UNIT_PATH:-/etc/systemd/system/agent-saas-acs-orchestrator.service}"
ACS_SERVICE_NAME="${ACS_SERVICE_NAME:-agent-saas-acs-orchestrator.service}"

case "${1:-}" in
  --test-app-rollback)
    ROLLBACK_RUNTIME_VERIFY=false
    rollback_app_release
    exit $?
    ;;
  --test-app-cleanup-trap)
    ROLLBACK_RUNTIME_VERIFY=false
    app_committed=false
    app_mutation_started=true
    trap cleanup_app_failure EXIT
    false
    ;;
  --test-acs-rollback)
    ROLLBACK_RUNTIME_VERIFY=false
    rollback_acs_release
    exit $?
    ;;
  --test-acs-cleanup-trap)
    ROLLBACK_RUNTIME_VERIFY=false
    acs_committed=false
    acs_mutation_started=true
    trap cleanup_acs_failure EXIT
    false
    ;;
esac

# 该开关只供上面的无特权测试入口使用；正式路径始终执行现场 readback。
ROLLBACK_RUNTIME_VERIFY=true

: "${PHASE:?PHASE must be acs, app or web}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${MANIFEST_PATH:?MANIFEST_PATH is required}"
: "${EXPECTED_MANIFEST_DIGEST:?EXPECTED_MANIFEST_DIGEST is required}"
: "${VERIFY_INSTALLED_SCRIPT:?VERIFY_INSTALLED_SCRIPT is required}"
: "${READ_LIVE_COMPONENTS_SCRIPT:?READ_LIVE_COMPONENTS_SCRIPT is required}"
: "${VERIFY_PROMOTION_PHASE_SCRIPT:?VERIFY_PROMOTION_PHASE_SCRIPT is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
VERIFY_ONLY="${VERIFY_ONLY:-false}"
case "$VERIFY_ONLY" in true|false) ;; *) echo 'VERIFY_ONLY must be true or false' >&2; exit 1 ;; esac
case "$PHASE" in
  acs) : "${ACS_UNIT_TEMPLATE:?ACS_UNIT_TEMPLATE is required}" ;;
  app)
    if [ "$VERIFY_ONLY" != true ]; then
      : "${SERVER_UNIT_TEMPLATE:?SERVER_UNIT_TEMPLATE is required}"
      : "${WORKER_UNIT_TEMPLATE:?WORKER_UNIT_TEMPLATE is required}"
    fi
    ;;
  web)
    : "${WEB_LOCK_READY:?WEB_LOCK_READY is required for the Web phase}"
    : "${WEB_LOCK_RELEASE:?WEB_LOCK_RELEASE is required for the Web phase}"
    WEB_LOCK_TIMEOUT_SECONDS="${WEB_LOCK_TIMEOUT_SECONDS:-900}"
    printf '%s' "$WEB_LOCK_TIMEOUT_SECONDS" | grep -Eq '^[1-9][0-9]*$'
    case "$WEB_LOCK_READY:$WEB_LOCK_RELEASE" in
      /tmp/agent-saas-promotion-*:/tmp/agent-saas-promotion-*) ;;
      *) echo 'Web lock handshake paths must stay under the promotion temp directory' >&2; exit 1 ;;
    esac
    ;;
  *) echo 'PHASE must be acs, app or web' >&2; exit 1 ;;
esac
if [ "$VERIFY_ONLY" != true ] && { [ "$PHASE" = acs ] || [ "$PHASE" = app ]; }; then
  : "${ROLLBACK_ATTEMPTED_MARKER:?ROLLBACK_ATTEMPTED_MARKER is required}"
  printf '%s:%s' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" | grep -Eq '^[1-9][0-9]*:[1-9][0-9]*$'
  expected_marker="/tmp/agent-saas-promotion-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/rollback-attempted-$PHASE"
  test "$ROLLBACK_ATTEMPTED_MARKER" = "$expected_marker" || {
    echo 'ROLLBACK_ATTEMPTED_MARKER must use the isolated promotion run-attempt path' >&2
    exit 1
  }
  rm -f "$ROLLBACK_ATTEMPTED_MARKER"
fi
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
ROLLBACK_ATTEMPTED_RECEIPT_PATH="${ROLLBACK_ATTEMPTED_RECEIPT_PATH:-${ROLLBACK_RECEIPT_PATH:-}}"
ROLLBACK_SUCCEEDED_RECEIPT_PATH="${ROLLBACK_SUCCEEDED_RECEIPT_PATH:-}"
[ -z "$ROLLBACK_ATTEMPTED_RECEIPT_PATH" ] || rm -f "$ROLLBACK_ATTEMPTED_RECEIPT_PATH"
[ -z "$ROLLBACK_SUCCEEDED_RECEIPT_PATH" ] || rm -f "$ROLLBACK_SUCCEEDED_RECEIPT_PATH"

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
# next to this script; the production workflow uses a run-attempt-isolated preflight directory.
config_identity_reader="${CONFIG_IDENTITY_READER:-$(dirname "$0")/read-production-state.mjs}"
if [ ! -f "$config_identity_reader" ]; then
  config_identity_reader="/tmp/release-preflight-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT/read-production-state.mjs"
fi
test -f "$config_identity_reader" || {
  echo 'Missing shared ConfigIdentity readiness contract module' >&2
  exit 1
}
# Promotion 的 GitHub gate 与分阶段写入之间仍可能有手工/兼容入口；每个阶段必须在
# 同一主机锁内从 observer、systemd 与已安装密封字节重建 live matrix，再只接受该阶段
# 应看到的“冻结基线 + 已提交 phase”精确前置矩阵；重试时也只接受当前 phase 已精确提交的目标矩阵。
# 不能先要求 live 全量等于旧 trusted identity，
# 否则首个 phase 成功后会把后续 phase 拒绝在事务中间。
production_now="/tmp/agent-saas-production-before-${PHASE}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json"
rm -f "$production_now"
phase_config_identity_stage="$(node "$VERIFY_PROMOTION_PHASE_SCRIPT" "$MANIFEST_PATH" --config-identity-stage "$PHASE")"
node "$READ_LIVE_COMPONENTS_SCRIPT" --config-identity-stage "$phase_config_identity_stage" --output "$production_now" >/dev/null
node "$VERIFY_PROMOTION_PHASE_SCRIPT" "$MANIFEST_PATH" "$production_now" "$PHASE" >/dev/null
rm -f "$production_now"
if [ "$VERIFY_ONLY" = true ]; then
  echo "$PHASE live precondition verified for $release_id"
  exit 0
fi
if [ "$PHASE" = web ]; then
  rm -f "$WEB_LOCK_READY" "$WEB_LOCK_RELEASE"
  cleanup_web_lock_handshake() {
    rm -f "$WEB_LOCK_READY" "$WEB_LOCK_RELEASE"
  }
  trap cleanup_web_lock_handshake EXIT
  touch "$WEB_LOCK_READY"
  deadline=$((SECONDS + WEB_LOCK_TIMEOUT_SECONDS))
  while [ ! -f "$WEB_LOCK_RELEASE" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo 'Timed out while holding the production lock for Web publication' >&2
      exit 1
    fi
    sleep 1
  done
  echo "web live precondition and publication lock completed for $release_id"
  exit 0
fi

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

begin_app_deploy_transaction() {
  # Before this succeeds, App rollback must remain unarmed: a competing config
  # transaction must make PHASE=app fail without any production mutation.
  acquire_config_governance_fence \
    "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}" || return 1
  trap release_config_governance_fence EXIT
  trap 'exit 130' HUP INT TERM
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
  validate_api_release_boundary_from_env "$active_color" "$active_env" \
    'Rollback old API pre-commit ConfigIdentity' || return 1
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
  systemctl disable --now "agent-saas-server@$candidate_color" >/dev/null 2>&1 \
    || disable_status=$?
  if ! systemctl is-active --quiet "agent-saas-server@$candidate_color"; then
    candidate_stopped_ref=true
  fi
  if [ "$disable_status" -ne 0 ] || [ "$candidate_stopped_ref" != true ] \
    || systemctl is-enabled --quiet "agent-saas-server@$candidate_color"; then
    return 1
  fi
  if systemctl is-active --quiet "agent-saas-server@$candidate_color"; then
    return 1
  fi
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
  if validate_api_release_boundary_from_env "$active_color" "$active_env" \
      'Rollback existing old API ConfigIdentity'; then
    old_ready=true
  else
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
  fi
  [ "$old_ready" = true ] || return 1
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
  revoke_systemd_authority "agent-saas-server@$candidate_color" || return 1
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
  local commit_marker="${9:-true}" prepare_only="${10:-false}"
  local marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local upstream="${AGENT_SAAS_NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
  local run_root="${AGENT_SAAS_API_RUN_ROOT:-/run}"
  local candidate_ready=false
  if validate_api_release_boundary "$candidate_color" "$expected_json" \
      'Rollback existing candidate API ConfigIdentity'; then
    candidate_ready=true
  else
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
  fi
  if [ "$candidate_ready" != true ] \
    || ! validate_api_release_boundary "$candidate_color" "$expected_json" \
      'Rollback candidate API prepared ConfigIdentity'; then
    return 1
  fi
  if [ "$prepare_only" = true ]; then
    systemctl is-active --quiet "agent-saas-server@$candidate_color" \
      && systemctl is-enabled --quiet "agent-saas-server@$candidate_color"
    return
  fi
  if ! revoke_systemd_authority "agent-saas-server@$active_color"; then
    # Keep the verified candidate online until the old API and route are proven restored.
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
  if validate_worker_release_boundary "$active_color" "$active_env" - - \
      'Rollback existing Worker private ConfigIdentity'; then
    old_ready=true
  else
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
  fi
  if [ "$old_ready" != true ] \
    || ! validate_worker_release_boundary "$active_color" "$active_env" - - \
      'Rollback Worker prepared ConfigIdentity'; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    worker_restored_ref=false
    return 1
  fi
  systemctl disable --now "agent-saas-runtime-worker@$candidate_color" >/dev/null 2>&1 \
    || disable_status=$?
  if ! systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color"; then
    candidate_stopped_ref=true
  fi
  if [ "$disable_status" -ne 0 ] || [ "$candidate_stopped_ref" != true ] \
    || systemctl is-enabled --quiet "agent-saas-runtime-worker@$candidate_color"; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    worker_restored_ref=false
    return 1
  fi
  rm -f "$run_root/agent-saas-runtime-worker-$candidate_color.pid" \
    "$run_root/agent-saas-runtime-worker-$candidate_color.ready" \
    "$run_root/agent-saas-runtime-worker-$candidate_color.draining" \
    "$run_root/agent-saas-runtime-worker-$candidate_color.config-identity.json" || true
  if ! validate_worker_release_boundary "$active_color" "$active_env" - - \
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

# Worker authority transitions hold one governance fence before stopping either generation.
restore_candidate_worker_authority() {
  local active_color="$1" candidate_color="$2" env_path="$3"
  local commit_marker="${4:-true}" fence_held="${5:-false}" prepare_only="${6:-false}"
  local marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local run_root="${AGENT_SAAS_WORKER_RUN_ROOT:-/run}"
  local candidate_ready=false fence_owned=false
  if [ "$fence_held" != true ]; then
    acquire_config_governance_fence \
      "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}" || return 1
    fence_owned=true
  fi
  if validate_worker_release_boundary "$candidate_color" "$env_path" - - \
      'Rollback existing candidate Worker ConfigIdentity'; then
    candidate_ready=true
  else
    rm -f "$run_root/agent-saas-runtime-worker-$candidate_color.pid" \
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
  fi
  if [ "$candidate_ready" != true ] \
    || ! validate_worker_release_boundary "$candidate_color" "$env_path" - - \
      'Rollback candidate Worker prepared ConfigIdentity'; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  if [ "$prepare_only" = true ]; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color" \
      && systemctl is-enabled --quiet "agent-saas-runtime-worker@$candidate_color"
    return
  fi
  if ! revoke_systemd_authority "agent-saas-runtime-worker@$active_color"; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  rm -f "$run_root/agent-saas-runtime-worker-$active_color.pid" \
    "$run_root/agent-saas-runtime-worker-$active_color.ready" \
    "$run_root/agent-saas-runtime-worker-$active_color.draining" \
    "$run_root/agent-saas-runtime-worker-$active_color.config-identity.json" || true
  if [ "$commit_marker" = true ] \
    && ! commit_worker_active_color "$candidate_color"; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  [ "$fence_owned" != true ] || release_config_governance_fence
  systemctl is-active --quiet "agent-saas-runtime-worker@$candidate_color" \
    && ! systemctl is-active --quiet "agent-saas-runtime-worker@$active_color" \
    && { [ "$commit_marker" != true ] \
      || [ "$(tr -d '[:space:]' <"$marker")" = "$candidate_color" ]; }
}

# Old authority restoration prepares the old Worker before revoking the candidate.
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
  if validate_worker_release_boundary "$active_color" "$active_env" - - \
      'Rollback existing old Worker ConfigIdentity'; then
    old_ready=true
  else
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
  fi
  if [ "$old_ready" != true ] \
    || ! validate_worker_release_boundary "$active_color" "$active_env" - - \
      'Rollback old Worker prepared ConfigIdentity' \
    || ! revoke_systemd_authority "agent-saas-runtime-worker@$candidate_color" \
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

validate_candidate_api_routing_preparation() {
  local candidate_color="$1" expected_release_id="$2" candidate_nginx_backup="$3"
  local expected_path
  expected_path="$(mktemp)" || return 1
  cat >"$expected_path" <<EOF
# active=$candidate_color release=$expected_release_id
upstream agent_saas_backend {
    server 127.0.0.1:$(port_for_color "$candidate_color");
    server 127.0.0.1:$(port_for_color "$(other_color "$candidate_color")") backup;
}
EOF
  if ! cmp -s "$expected_path" "$candidate_nginx_backup"; then
    rm -f "$expected_path"
    return 1
  fi
  rm -f "$expected_path"
}

restore_candidate_app_disk() {
  local api_candidate="$1" worker_candidate="$2" api_env="$3" worker_env="$4"
  local backup_root="$5" api_target worker_target
  test -s "$backup_root/api.candidate.target" \
    && test -s "$backup_root/worker.candidate.target" \
    && test -s "$backup_root/api.candidate.release.env" \
    && test -s "$backup_root/worker.candidate.release.env" \
    && test -s "$backup_root/server@.candidate.service" \
    && test -s "$backup_root/runtime-worker@.candidate.service" || return 1
  api_target="$(cat "$backup_root/api.candidate.target")" || return 1
  worker_target="$(cat "$backup_root/worker.candidate.target")" || return 1
  test -d "$api_target" && test -d "$worker_target" || return 1
  ln -sfn "$api_target" "$APP_COLOR_ROOT/$api_candidate" \
    && ln -sfn "$worker_target" "$APP_WORKER_ROOT/$worker_candidate" \
    && cp -a "$backup_root/api.candidate.release.env" "$api_env" \
    && cp -a "$backup_root/worker.candidate.release.env" "$worker_env" \
    && cp -a "$backup_root/server@.candidate.service" \
      /etc/systemd/system/agent-saas-server@.service \
    && cp -a "$backup_root/runtime-worker@.candidate.service" \
      /etc/systemd/system/agent-saas-runtime-worker@.service \
    && systemctl daemon-reload \
    && validate_app_release_envs_match "$api_env" "$worker_env"
}

commit_candidate_app_authority() {
  local api_active="$1" api_candidate="$2" candidate_nginx_backup="$3"
  local expected_json="$4" worker_active="$5" worker_candidate="$6" worker_env="$7"
  local api_marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local worker_marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local upstream="${AGENT_SAAS_NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/agent-saas-upstream.conf}"
  validate_api_release_boundary "$api_candidate" "$expected_json" \
    'Rollback candidate App commit API ConfigIdentity' \
    && validate_worker_release_boundary "$worker_candidate" "$worker_env" - - \
      'Rollback candidate App commit Worker ConfigIdentity' \
    && validate_candidate_api_routing_preparation \
      "$api_candidate" "$release_id" "$candidate_nginx_backup" || return 1
  cp -a "$candidate_nginx_backup" "$upstream" \
    && nginx -t >/dev/null 2>&1 \
    && systemctl reload nginx >/dev/null 2>&1 \
    && validate_api_routing_boundary "$api_candidate" "$release_id" \
    && revoke_systemd_authority "agent-saas-runtime-worker@$worker_active" \
    && revoke_systemd_authority "agent-saas-server@$api_active" \
    && commit_app_active_colors "$api_candidate" "$worker_candidate" "$api_active" \
    && [ "$(tr -d '[:space:]' <"$api_marker")" = "$api_candidate" ] \
    && [ "$(tr -d '[:space:]' <"$worker_marker")" = "$worker_candidate" ]
}

# App compensation keeps one fence across preparation, unified commit, and fallback.
restore_candidate_app_authority() {
  local api_active="$1" api_candidate="$2" candidate_nginx_backup="$3"
  local expected_json="$4" old_nginx_backup="$5" had_nginx="$6" nginx_changed="$7"
  local worker_active="$8" worker_candidate="$9" worker_env="${10}"
  local old_worker_env="${11}" old_api_env="${12}" fence_held="${13:-false}"
  local candidate_backup_root="${14:-}"
  local api_env="${15:-/etc/agent-saas/server-$api_candidate.release.env}"
  local api_marker="${AGENT_SAAS_API_ACTIVE_COLOR_FILE:-/etc/agent-saas/active-color}"
  local worker_marker="${AGENT_SAAS_WORKER_ACTIVE_COLOR_FILE:-/etc/agent-saas/runtime-worker-active-color}"
  local app_prepared=false app_committed=false old_compensated=false fence_owned=false
  if [ "$fence_held" != true ]; then
    acquire_config_governance_fence \
      "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}" || return 1
    fence_owned=true
  fi
  if { [ -z "$candidate_backup_root" ] \
      || restore_candidate_app_disk "$api_candidate" "$worker_candidate" \
        "$api_env" "$worker_env" "$candidate_backup_root"; } \
    && restore_candidate_api_authority "$api_active" "$api_candidate" \
      "$candidate_nginx_backup" "$expected_json" "$old_nginx_backup" \
      "$had_nginx" "$nginx_changed" "$old_api_env" false true \
    && restore_candidate_worker_authority "$worker_active" "$worker_candidate" \
      "$worker_env" false true true \
    && validate_api_release_boundary "$api_candidate" "$expected_json" \
      'Rollback candidate App prepared API ConfigIdentity' \
    && validate_worker_release_boundary "$worker_candidate" "$worker_env" - - \
      'Rollback candidate App prepared Worker ConfigIdentity' \
    && validate_candidate_api_routing_preparation \
      "$api_candidate" "$release_id" "$candidate_nginx_backup"; then
    app_prepared=true
  fi
  if [ "$app_prepared" = true ] \
    && commit_candidate_app_authority "$api_active" "$api_candidate" \
      "$candidate_nginx_backup" "$expected_json" "$worker_active" \
      "$worker_candidate" "$worker_env"; then
    app_committed=true
  fi
  # The generation-link rename may have committed even if its final readback failed.
  # Preserve that complete candidate pair rather than compensating it to old.
  if [ "$app_prepared" = true ] \
    && [ "$(tr -d '[:space:]' <"$api_marker" 2>/dev/null || true)" = "$api_candidate" ] \
    && [ "$(tr -d '[:space:]' <"$worker_marker" 2>/dev/null || true)" = "$worker_candidate" ] \
    && validate_api_release_boundary "$api_candidate" "$expected_json" \
      'Committed candidate compensation API ConfigIdentity' \
    && validate_worker_release_boundary "$worker_candidate" "$worker_env" - - \
      'Committed candidate compensation Worker ConfigIdentity' \
    && validate_api_routing_boundary "$api_candidate" "$release_id" \
    && revoke_systemd_authority "agent-saas-runtime-worker@$worker_active" \
    && revoke_systemd_authority "agent-saas-server@$api_active"; then
    app_committed=true
  fi
  if [ "$app_committed" = true ]; then
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 0
  fi
  if [ "$app_prepared" != true ]; then
    revoke_systemd_authority "agent-saas-runtime-worker@$worker_candidate" || true
    revoke_systemd_authority "agent-saas-server@$api_candidate" || true
    [ "$fence_owned" != true ] || release_config_governance_fence
    return 1
  fi
  if { [ -z "$candidate_backup_root" ] \
      || { cp -a "$candidate_backup_root/server@.service" \
          /etc/systemd/system/agent-saas-server@.service \
        && cp -a "$candidate_backup_root/runtime-worker@.service" \
          /etc/systemd/system/agent-saas-runtime-worker@.service \
        && systemctl daemon-reload; }; } \
    && validate_app_release_envs_match "$old_api_env" "$old_worker_env" \
    && restore_old_worker_authority "$worker_active" "$worker_candidate" \
      "$old_worker_env" true false \
    && restore_old_api_authority "$api_active" "$api_candidate" \
      "$old_nginx_backup" "$had_nginx" "$nginx_changed" "$old_api_env" false \
    && validate_api_release_boundary_from_env "$api_active" "$old_api_env" \
      'Compensated old App API ConfigIdentity' \
    && validate_worker_release_boundary "$worker_active" "$old_worker_env" - - \
      'Compensated old App Worker ConfigIdentity' \
    && validate_api_routing_boundary "$api_active" \
      "$(read_release_id_from_env "$old_api_env")" \
    && commit_app_active_colors "$api_active" "$worker_active" "$api_candidate"; then
    old_compensated=true
  fi
  [ "$fence_owned" != true ] || release_config_governance_fence
  [ "$old_compensated" = true ] || return 1
  return 1
}

# ACS deployment follows after App compensation helpers are fully defined and closed.
deploy_acs() {
  local digest target previous main_pid identity_backup env_backup candidate
  local rollback_root unit_path
  local had_previous_identity=false had_previous_unit=false
  local acs_committed=false
  digest="$(node -p "require(process.env.MANIFEST_PATH).components.acs.orchestratorArtifactDigest.slice(7)")"
  target="/opt/agent-saas/acs-releases/$digest"
  previous=""
  if [ -L "$ACS_CURRENT_PATH" ]; then
    if ! previous="$(readlink -f "$ACS_CURRENT_PATH")" || [ -z "$previous" ]; then
      echo 'Existing ACS release link cannot be resolved' >&2
      exit 1
    fi
  elif [ -e "$ACS_CURRENT_PATH" ]; then
    echo 'Existing ACS release path must be a symlink' >&2
    exit 1
  fi
  if [ -d "$target" ]; then
    node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component acs >/dev/null
  else
    candidate="$target.candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
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
  rollback_root="/tmp/agent-saas-acs-rollback-$release_id-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  rm -rf "$rollback_root"
  mkdir -p "$rollback_root"
  unit_path="$ACS_UNIT_PATH"
  cp -a "$ACS_ENV_PATH" "$rollback_root/acs-orchestrator.env"
  if [ -L "$unit_path" ] || { [ -e "$unit_path" ] && [ ! -f "$unit_path" ]; }; then
    echo "Existing ACS managed unit must be absent or a regular file: $unit_path" >&2
    exit 1
  fi
  if [ -f "$unit_path" ]; then
    had_previous_unit=true
    cp -a "$unit_path" "$rollback_root/acs-orchestrator.service"
  fi
  if [ -e "$ACS_IDENTITY_PATH" ]; then
    had_previous_identity=true
    cp -a "$ACS_IDENTITY_PATH" "$rollback_root/acs-release-identity.json"
  fi
  trap cleanup_acs_failure EXIT
  arm_deploy_rollback cleanup_acs_failure
  trap 'exit 130' HUP INT TERM
  acs_mutation_started=true
  install -m 0644 "$ACS_UNIT_TEMPLATE" "$unit_path"
  systemctl daemon-reload
  node - "$MANIFEST_PATH" "$ACS_ENV_PATH" <<'NODE'
const fs = require('node:fs');
const [manifestPath, envPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const image = `${manifest.artifacts.acsImage.repository}@${manifest.artifacts.acsImage.digest}`;
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter((line) => line
  && !line.startsWith('ACS_SANDBOX_IMAGE=')
  && !line.startsWith('ACS_SANDBOX_LIFECYCLE_POLICY_MODE=')
  && !line.startsWith('ACS_SANDBOX_LIFECYCLE_ENABLED='));
lines.push(`ACS_SANDBOX_IMAGE=${image}`);
lines.push('ACS_SANDBOX_LIFECYCLE_ENABLED=true');
lines.push('ACS_SANDBOX_LIFECYCLE_POLICY_MODE=enforce');
fs.writeFileSync(`${envPath}.candidate`, `${lines.join('\n')}\n`, { mode: 0o600 });
fs.renameSync(`${envPath}.candidate`, envPath);
NODE
  node - "$MANIFEST_PATH" "$ACS_ENV_PATH" "$ACS_IDENTITY_PATH" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [manifestPath, envPath, identityPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const identity = {
  schemaVersion: 1, environment: 'production', releaseId: manifest.releaseId,
  sourceSha: manifest.components.acs.sourceSha,
  orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
  sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
  namespace: 'agent-saas-coding',
  configFingerprint: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(envPath)).digest('hex')}`,
};
fs.writeFileSync(`${identityPath}.candidate`, `${JSON.stringify(identity)}\n`, { mode: 0o444 });
fs.renameSync(`${identityPath}.candidate`, identityPath);
NODE
  ln -sfn "$target" "$ACS_CURRENT_PATH"
  if systemctl is-active --quiet "$ACS_SERVICE_NAME"; then
    main_pid="$(systemctl show "$ACS_SERVICE_NAME" --property MainPID --value)"
    kill -USR2 "$main_pid"
    for _ in $(seq 1 330); do
      systemctl is-active --quiet "$ACS_SERVICE_NAME" || break
      sleep 2
    done
    systemctl is-active --quiet "$ACS_SERVICE_NAME" && {
      echo 'Production ACS drain deadline exceeded' >&2
      exit 20
    }
  fi
  systemctl restart "$ACS_SERVICE_NAME"
  acs_health_path="/tmp/acs-promotion-health-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json"
  rm -f "$acs_health_path"
  for _ in $(seq 1 90); do
    curl -fsS http://127.0.0.1:3400/health >"$acs_health_path" && break
    sleep 2
  done
  if [ ! -s "$acs_health_path" ] || ! node - "$MANIFEST_PATH" "$acs_health_path" <<'NODE'
const fs = require('node:fs');
const [manifestPath, healthPath] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(manifestPath));
const h = JSON.parse(fs.readFileSync(healthPath));
if (h.environment !== 'production' || h.releaseId !== m.releaseId || h.sourceSha !== m.components.acs.sourceSha || h.orchestratorArtifactDigest !== m.components.acs.orchestratorArtifactDigest || h.sandboxImageDigest !== m.components.acs.sandboxImageDigest || h.namespace !== 'agent-saas-coding' || h.lifecycle?.enabled !== true || h.lifecyclePolicyMode !== 'enforce') process.exit(1);
NODE
  then
    exit 20
  fi
  rm -f "$acs_health_path"
  acs_committed=true
  DEPLOY_ACS_ROLLBACK_COMMITTED=true
  disarm_deploy_rollback
  rm -rf "$rollback_root"
}

other_color() { [ "$1" = blue ] && echo green || echo blue; }
port_for_color() { [ "$1" = blue ] && echo 3200 || echo 3201; }

# 蓝绿 idle 槽位在上一次交接后可能仍被后台 drain 的旧进程占用。发布前等待其自然退出
# （durable run 的交棒/收尾由进程自身的 drain deadline 决定），绝不强停；等待发生在
# governance fence 与任何生产写入之前，超时即 fail closed，不留下半提交状态。
IDLE_SLOT_DRAIN_WAIT_SECONDS=1800
wait_for_idle_app_slots() {
  local api_idle="$1" worker_idle="$2"
  local run_root="${AGENT_SAAS_WORKER_RUN_ROOT:-/run}"
  local waited=0 unit marker busy
  while :; do
    busy=""
    if systemctl is-active --quiet "agent-saas-server@$api_idle"; then
      busy="$busy agent-saas-server@$api_idle"
    fi
    if systemctl is-active --quiet "agent-saas-runtime-worker@$worker_idle"; then
      busy="$busy agent-saas-runtime-worker@$worker_idle"
    fi
    [ -n "$busy" ] || break
    for unit in $busy; do
      case "$unit" in
        agent-saas-server@*) marker="$run_root/agent-saas-server-$api_idle.draining" ;;
        *) marker="$run_root/agent-saas-runtime-worker-$worker_idle.draining" ;;
      esac
      if [ ! -e "$marker" ]; then
        echo "ERROR: idle unit $unit is active without a drain marker; refusing to reuse the slot" >&2
        return 1
      fi
      if [ $((waited % 30)) -eq 0 ]; then
        echo "idle slot still draining from the previous handoff (waited=${waited}s): $unit marker=$(tr -d '\n' <"$marker" 2>/dev/null || echo unreadable)"
      fi
    done
    if [ "$waited" -ge "$IDLE_SLOT_DRAIN_WAIT_SECONDS" ]; then
      echo "ERROR: idle slot still draining after ${IDLE_SLOT_DRAIN_WAIT_SECONDS}s:$busy; refusing to interrupt durable work" >&2
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  systemctl reset-failed "agent-saas-server@$api_idle" >/dev/null 2>&1 || true
  systemctl reset-failed "agent-saas-runtime-worker@$worker_idle" >/dev/null 2>&1 || true
  [ "$waited" -eq 0 ] || echo "idle slots free after ${waited}s"
}

# 旧 generation 交接：写 drain marker（unit 的 ExecCondition 据此拒绝重新拉起）、取消开机
# 自启、SIGUSR2 让进程在安全边界交棒/排空后自退。不等待也不 --now 强停：等待会把发布
# 时长绑在最长 durable run 上（旧入口实测 905～935s 贴着超时回滚），强停会把在途 run
# 变成 orphaned。下一次发布在 wait_for_idle_app_slots 里等它腾出槽位。
hand_off_retired_authority() {
  local unit="$1" marker="$2" pidfile="$3" pid
  if ! systemctl is-active --quiet "$unit"; then
    systemctl disable "$unit" >/dev/null 2>&1 || true
    echo "$unit already inactive; boot ownership revoked"
    return 0
  fi
  install -m 0644 /dev/null "$marker"
  if ! systemctl disable "$unit" >/dev/null 2>&1; then
    echo "WARN: failed to disable $unit; drain marker still blocks restarts" >&2
  fi
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -USR2 "$pid" 2>/dev/null; then
    echo "$unit draining in background (pid $pid); durable work exits at its own safe boundary"
  else
    echo "WARN: $unit pidfile missing or signal failed; leaving the unit to its drain guard" >&2
  fi
}

deploy_app() {
  local artifact_digest target api_active api_idle api_idle_port worker_active worker_idle
  local api_idle_previous worker_idle_previous api_env worker_env rollback_root server_unit worker_unit
  local had_api_env=false had_worker_env=false had_nginx=false nginx_changed=false app_committed=false
  local planned_api_active planned_worker_active
  planned_api_active="$(tr -d '[:space:]' <"$ACTIVE_COLOR_PATH")"
  planned_worker_active="$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_PATH")"
  case "$planned_api_active:$planned_worker_active" in blue:blue|blue:green|green:blue|green:green) ;; *) exit 1 ;; esac
  wait_for_idle_app_slots "$(other_color "$planned_api_active")" "$(other_color "$planned_worker_active")"
  begin_app_deploy_transaction
  artifact_digest="$(node -p "require(process.env.MANIFEST_PATH).components.api.artifactDigest.slice(7)")"
  target="/opt/agent-saas-app/releases/$artifact_digest"
  if [ -d "$target" ]; then
    node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component server >/dev/null
  else
    candidate="$target.candidate-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
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
  api_active="$(tr -d '[:space:]' <"$ACTIVE_COLOR_PATH")"
  worker_active="$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_PATH")"
  case "$api_active:$worker_active" in blue:blue|blue:green|green:blue|green:green) ;; *) exit 1 ;; esac
  if [ "$api_active" != "$planned_api_active" ] || [ "$worker_active" != "$planned_worker_active" ]; then
    echo 'Active colors changed while waiting for idle slots; refusing to continue' >&2
    exit 1
  fi
  api_idle="$(other_color "$api_active")"
  worker_idle="$(other_color "$worker_active")"
  api_idle_port="$(port_for_color "$api_idle")"
  api_active_port="$(port_for_color "$api_active")"
  api_idle_previous="$(readlink -f "$APP_COLOR_ROOT/$api_idle" 2>/dev/null || true)"
  worker_idle_previous="$(readlink -f "$APP_WORKER_ROOT/$worker_idle" 2>/dev/null || true)"
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
  server_unit=/etc/systemd/system/agent-saas-server@.service
  worker_unit=/etc/systemd/system/agent-saas-runtime-worker@.service
  cp -a "$server_unit" "$rollback_root/server@.service"
  cp -a "$worker_unit" "$rollback_root/runtime-worker@.service"
  trap cleanup_app_failure EXIT
  trap 'exit 130' HUP INT TERM
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
    local app_old_restored=false app_candidate_restored=false app_old_compensated=false
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
    local transaction_rollback_status=0
    if [ "$app_committed" = false ]; then
      # The fence must already be held from deploy_app entry. Keep this fail-closed
      # guard before even the disk-only rollback preparation for defensive reuse.
      if [ -z "$CONFIG_GOVERNANCE_FENCE" ] \
        && ! acquire_config_governance_fence \
          "${AGENT_SAAS_RUNTIME_DATA_ROOT:-/mnt/agent-saas/server-data}"; then
        echo 'ERROR: App rollback refused to mutate authority while config governance is active' >&2
        return 1
      fi
      rollback_app_release || transaction_rollback_status=$?
      # Prepare both old services and verify their strict private boundaries before
      # stopping the API candidate or restoring nginx. Marker publication remains a
      # single App generation commit only after routed readiness also succeeds.
      if ! validate_app_release_envs_match "$old_api_env" "$old_worker_env"; then
        rollback_target=candidate
      fi
      if [ "$rollback_target" = old ]; then
        if validate_api_release_boundary_from_env "$api_active" "$old_api_env" \
            'Rollback existing old API ConfigIdentity'; then
          api_restored=true
        else
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

      if [ "$rollback_target" = old ]; then
        if commit_rollback_worker_authority "$worker_active" "$worker_idle" \
          "$old_worker_env" candidate_stopped worker_restored true false; then
          worker_rollback_committed=true
        else
          rollback_target=candidate
        fi
      fi

      if [ "$rollback_target" = old ] \
        && [ "$api_restored" = true ] \
        && [ "$worker_rollback_committed" = true ] \
        && commit_rollback_api_authority "$api_active" "$api_idle" \
          "$rollback_root/nginx-upstream.conf" "$had_nginx" "$nginx_changed" \
          "$old_api_env" api_candidate_stopped false; then
        api_rollback_committed=true
      else
        rollback_target=candidate
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
        app_old_restored=true
      else
        if [ "$api_candidate_admitted" = true ] \
          && [ "$worker_candidate_admitted" = true ] \
          && [ -n "$rollback_config_identity" ] \
          && [ -s "$api_candidate_nginx_backup" ] \
          && restore_candidate_app_authority \
            "$api_active" "$api_idle" "$api_candidate_nginx_backup" \
            "$rollback_config_identity" "$rollback_root/nginx-upstream.conf" \
            "$had_nginx" "$nginx_changed" "$worker_active" "$worker_idle" \
            "$worker_env" "$old_worker_env" "$old_api_env" true \
            "$rollback_root" "$api_env"; then
          app_candidate_restored=true
        elif rollback_app_release \
          && validate_app_release_envs_match "$old_api_env" "$old_worker_env"; then
          if restore_old_worker_authority "$worker_active" "$worker_idle" \
              "$old_worker_env" true false \
            && restore_old_api_authority "$api_active" "$api_idle" \
              "$rollback_root/nginx-upstream.conf" "$had_nginx" "$nginx_changed" \
              "$old_api_env" false \
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
          echo 'ERROR: restored one old App authority after candidate compensation failed safely' >&2
        else
          echo 'ERROR: App rollback could not converge API and Worker to one release' >&2
        fi
      fi
      release_config_governance_fence
      if [ "$transaction_rollback_status" -eq 0 ] \
        && { [ "$app_old_restored" = true ] \
          || [ "$app_candidate_restored" = true ] \
          || [ "$app_old_compensated" = true ]; }; then
        record_rollback_success || transaction_rollback_status=70
      else
        transaction_rollback_status=70
      fi
      if [ "$transaction_rollback_status" -ne 0 ]; then
        exit "$transaction_rollback_status"
      fi
    fi
  }
  arm_deploy_rollback cleanup_app_failure
  install -m 0644 "$SERVER_UNIT_TEMPLATE" "$server_unit"
  install -m 0644 "$WORKER_UNIT_TEMPLATE" "$worker_unit"
  cp -a "$server_unit" "$rollback_root/server@.candidate.service"
  cp -a "$worker_unit" "$rollback_root/runtime-worker@.candidate.service"
  systemctl daemon-reload
  ln -sfn "$target" "$APP_COLOR_ROOT/$api_idle"
  ln -sfn "$target" "$APP_WORKER_ROOT/$worker_idle"
  printf '%s\n' "$target" >"$rollback_root/api.candidate.target"
  printf '%s\n' "$target" >"$rollback_root/worker.candidate.target"
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
  cp -a "$api_env" "$rollback_root/api.candidate.release.env"
  cp -a "$worker_env" "$rollback_root/worker.candidate.release.env"

  rm -f "/run/agent-saas-server-$api_idle.pid" \
    "/run/agent-saas-server-$api_idle.ready" \
    "/run/agent-saas-server-$api_idle.draining" \
    "/run/agent-saas-server-$api_idle.config-identity.json"
  systemctl enable --now "agent-saas-server@$api_idle"
  api_candidate_ready_path="/tmp/api-candidate-ready-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json"
  rm -f "$api_candidate_ready_path"
  for _ in $(seq 1 180); do
    if curl -fsS "http://127.0.0.1:$api_idle_port/api/healthz/ready" >"$api_candidate_ready_path"; then break; fi
    sleep 1
  done
  node --input-type=module - "$MANIFEST_PATH" "$api_candidate_ready_path" \
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
  rm -f "$api_candidate_ready_path"
  DEPLOY_APP_ROLLBACK_API_CANDIDATE_ADMITTED=true

  if [ -e "$NGINX_UPSTREAM_PATH" ]; then
    had_nginx=true
    DEPLOY_APP_ROLLBACK_HAD_NGINX=true
    cp -a "$NGINX_UPSTREAM_PATH" "$rollback_root/nginx-upstream.conf"
  fi
  nginx_changed=true
  DEPLOY_APP_ROLLBACK_NGINX_CHANGED=true
  cat > "$NGINX_UPSTREAM_PATH" <<EOF
# active=$api_idle release=$release_id
upstream agent_saas_backend {
    server 127.0.0.1:$api_idle_port;
    server 127.0.0.1:$(port_for_color "$api_active") backup;
}
EOF
  if ! nginx -t; then
    if [ "$had_nginx" = true ]; then
      cp -a "$rollback_root/nginx-upstream.conf" "$NGINX_UPSTREAM_PATH"
    else
      rm -f "$NGINX_UPSTREAM_PATH"
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

  # 交接点：authority 已提交给候选，从这里起任何失败都不再回滚到旧 generation。
  DEPLOY_APP_ROLLBACK_COMMITTED=true
  hand_off_retired_authority "agent-saas-runtime-worker@$worker_active" \
    "/run/agent-saas-runtime-worker-$worker_active.draining" \
    "/run/agent-saas-runtime-worker-$worker_active.pid"
  hand_off_retired_authority "agent-saas-server@$api_active" \
    "/run/agent-saas-server-$api_active.draining" \
    "/run/agent-saas-server-$api_active.pid"
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
  app_committed=true
  trap - EXIT HUP INT TERM
  rm -rf "$rollback_root"
}

case "$PHASE" in
  acs) deploy_acs ;;
  app) deploy_app ;;
  web) exit 0 ;;
esac
echo "$PHASE phase completed for $release_id"
