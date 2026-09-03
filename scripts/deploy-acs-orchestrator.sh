#!/usr/bin/env bash
# 由 ACS workflow 通过 SSH stdin 执行；保持依赖预检、远程部署与回滚为单一事务。
set -euo pipefail

PRESERVE_ACS_UNIT_BAK=false
ACS_ROLLBACK_ATTEMPTED=false

cleanup_acs_unit_backup() {
  if [ "${PRESERVE_ACS_UNIT_BAK:-false}" = true ]; then
    echo "preserving ACS unit backup for manual recovery: ${ACS_UNIT_BAK:-unknown}" >&2
    return 0
  fi
  [ -n "${ACS_UNIT_BAK:-}" ] && rm -f "$ACS_UNIT_BAK"
}

rollback() {
  # 每个恢复边界独立累计状态；任何单点故障都不得截断后续 unit/restart 恢复。
  ACS_ROLLBACK_ATTEMPTED=true
  local rollback_status=0 unit_restore_status=0 restart_status=0 health_ok=false
  set +e
  echo "ROLLING BACK SNAT, release link, identity, env, managed unit, and runtime config..."

  if [ ! -d "$PREVIOUS_APP_DIR" ]; then
    echo "previous content-addressed release is unavailable; continuing best-effort rollback" >&2
    rollback_status=1
  fi
  if [ "$SNAT_ROLLBACK_SHARED_CONFIG_SAFE" = "true" ]; then
    echo "rollback retains the verified identical shared SNAT config (digest=$SNAT_ROLLBACK_DIGEST)"
  elif [ "$SNAT_ROLLBACK_OFFLINE_RESTORE" = "true" ]; then
    echo "legacy rollback: stopping failed candidate and restoring every non-Paused /32 offline..."
    "$SYSTEMCTL_BIN" stop "$ACS_SERVICE_NAME" || rollback_status=1
    timeout 600s node "$APP_DIR/acs-orchestrator/dist/restorePerPodCli.js" \
      >/tmp/acs-offline-snat-restore.json || rollback_status=1
    node -e "const r=require('/tmp/acs-offline-snat-restore.json');if(r.status!=='ok'||r.rollbackPrepared!==true||r.report.available!==r.report.checked)process.exit(1)" \
      || rollback_status=1
    if [ "$rollback_status" -eq 0 ]; then SNAT_ROLLBACK_PREPARED=true; fi
  elif [ "$SNAT_ROLLBACK_PREPARED" != "true" ]; then
    echo "neither per-Pod SNAT nor an identical shared rollback config was verified" >&2
    rollback_status=1
  fi

  cp "$ENV_BAK" "$ENV_FILE" || rollback_status=1
  cp "$RUNTIME_CONFIG_BAK" "$RUNTIME_CONFIG_FILE" || rollback_status=1
  if [ "$HAD_IDENTITY" = "true" ]; then
    cp "$IDENTITY_BAK" "$IDENTITY_FILE" || rollback_status=1
  else
    rm -f "$IDENTITY_FILE" || rollback_status=1
  fi
  if [ "$RUNTIME_IDENTITY_UPDATED" = "true" ]; then
    if cp "$RUNTIME_IDENTITY_BAK" "$RUNTIME_IDENTITY_FILE"; then
      RUNTIME_IDENTITY_UPDATED=false
    else
      rollback_status=1
    fi
  fi
  if [ -d "$PREVIOUS_APP_DIR" ]; then
    if ln -sfn "$PREVIOUS_APP_DIR" "$CURRENT_LINK"; then
      CURRENT_LINK_UPDATED=false
    else
      rollback_status=1
    fi
  fi
  rm -f "$SNAT_OPERATION_STATE_FILE" || rollback_status=1

  if [ "$ACS_UNIT_UPDATED" = true ]; then
    restore_acs_managed_unit \
      "$ACS_UNIT_PATH" "$ACS_UNIT_BAK" "$ACS_UNIT_HAD_PREVIOUS" "$SYSTEMCTL_BIN" \
      || unit_restore_status=$?
    if [ "$unit_restore_status" -eq 0 ]; then
      ACS_UNIT_UPDATED=false
    else
      rollback_status=1
      PRESERVE_ACS_UNIT_BAK=true
    fi
  fi

  "$SYSTEMCTL_BIN" restart "$ACS_SERVICE_NAME" || restart_status=$?
  if [ "$restart_status" -ne 0 ]; then
    rollback_status=1
    echo 'rollback could not restart the previous ACS service; manual intervention required' >&2
  else
    for _ in $(seq 1 "${ROLLBACK_HEALTH_ATTEMPTS:-60}"); do
      if curl -fsS -m 5 http://127.0.0.1:3400/health >/dev/null 2>&1; then
        health_ok=true
        echo "rollback health ok"
        break
      fi
      sleep "${ROLLBACK_HEALTH_INTERVAL_SECONDS:-1}"
    done
    if [ "$health_ok" != true ]; then
      rollback_status=1
      echo "ROLLBACK HEALTH ALSO FAILED — manual intervention required" >&2
    fi
  fi

  if [ "$rollback_status" -ne 0 ]; then
    PRESERVE_ACS_UNIT_BAK=true
    echo 'ACS direct rollback completed with one or more recovery failures' >&2
    return 70
  fi
  return 0
}

rollback_and_exit() {
  local deploy_status="${1:-1}" rollback_status=0
  rollback || rollback_status=$?
  if [ "$rollback_status" -ne 0 ]; then exit "$rollback_status"; fi
  exit "$deploy_status"
}

ACS_DIRECT_CLEANUP_TRAP_TEST=false
case "${1:-}" in
  --test-acs-direct-rollback|--test-acs-direct-cleanup-trap)
    restore_acs_managed_unit() {
      "$ROLLBACK_TEST_BIN/restore_acs_managed_unit" "$@"
    }
    if [ "$1" = --test-acs-direct-rollback ]; then
      rollback_status=0
      rollback || rollback_status=$?
      cleanup_acs_unit_backup
      exit "$rollback_status"
    fi
    ACS_DIRECT_CLEANUP_TRAP_TEST=true
    ;;
esac

if [ "$ACS_DIRECT_CLEANUP_TRAP_TEST" != true ]; then
: "${IMAGE:?missing IMAGE}"
: "${IMAGE_TAG:?missing IMAGE_TAG}"
: "${IMAGE_DIGEST:?missing IMAGE_DIGEST}"
: "${ORCHESTRATOR_ARTIFACT_DIGEST:?missing ORCHESTRATOR_ARTIFACT_DIGEST}"
: "${COMPAT_RELEASE_ID:?missing COMPAT_RELEASE_ID}"
: "${ECS_DEPLOY_ROOT:?missing ECS_DEPLOY_ROOT}"
: "${ACS_SERVICE_NAME:?missing ACS_SERVICE_NAME}"
: "${GITHUB_RUN_ID:?missing GITHUB_RUN_ID}"
: "${GITHUB_SHA:?missing GITHUB_SHA}"

printf '%s' "$IMAGE_DIGEST" | grep -Eq '^sha256:[a-f0-9]{64}$'
printf '%s' "$ORCHESTRATOR_ARTIFACT_DIGEST" | grep -Eq '^sha256:[a-f0-9]{64}$'
printf '%s' "$COMPAT_RELEASE_ID" | grep -Eq '^rc-[0-9]{8}-[0-9]{2,}$'
printf '%s' "$GITHUB_SHA" | grep -Eq '^[a-f0-9]{40}$'

lock=/run/lock/agent-saas/promotion.lock
mkdir -p "$(dirname "$lock")"
exec 9>"$lock"
flock -n 9 || { echo 'Another production promotion is active' >&2; exit 1; }

CURRENT_LINK="$ECS_DEPLOY_ROOT/acs-current"
if [ ! -L "$CURRENT_LINK" ]; then
  echo "ACS current release must be a symlink: $CURRENT_LINK" >&2
  exit 1
fi
PREVIOUS_APP_DIR="$(readlink -f "$CURRENT_LINK")"
test -d "$PREVIOUS_APP_DIR"
APP_DIR="$ECS_DEPLOY_ROOT/acs-releases/${ORCHESTRATOR_ARTIFACT_DIGEST#sha256:}"
ENV_FILE="/etc/agent-saas/acs-orchestrator.env"
IDENTITY_FILE="/etc/agent-saas/acs-release-identity.json"
IDENTITY_STATE_CAPTURED=false
RUNTIME_IDENTITY_FILE="/etc/agent-saas/runtime-identity.json"
RUNTIME_IDENTITY_BAK="/tmp/runtime-identity.before-acs-${GITHUB_RUN_ID}.json"
RUNTIME_IDENTITY_UPDATED=false
RUNTIME_PREFLIGHT_DIR=""
ACS_NODE=/usr/bin/node
SYSTEMCTL_BIN=/usr/bin/systemctl
ACS_UNIT_PATH=/etc/systemd/system/agent-saas-acs-orchestrator.service
ACS_UNIT_BAK="/tmp/agent-saas-acs-unit-before-${GITHUB_RUN_ID}"
ACS_UNIT_HAD_PREVIOUS=false
ACS_UNIT_UPDATED=false
PRODUCTION_CLEANUP_ARMED=false
CURRENT_LINK_UPDATED=false
RELEASE_TGZ="/tmp/agent-saas-acs-release.tgz"
# 07-05：SMOKE_SESSION 提前定型（改进 1A）。历史残留 CI sandbox（3d8h 前那批）
# 是因为 SMOKE_SESSION 之前在第 5 步 smoke 阶段才赋值——provision/deploy 阶段失败时
# cleanup 走到、SMOKE_SESSION 还是空 → cleanup 什么也不删 → sandbox 残留普通 TTL。
# 现在提前赋值，无论后续哪步失败，都能按 annotation 找到并清理 smoke sandbox。
SMOKE_SESSION="ci-acr-${GITHUB_RUN_ID}"
SMOKE_WS="ws_ci_acr_${GITHUB_RUN_ID}"
SMOKE_MOUNT="workspaces/_ci/${SMOKE_WS}"
SMOKE_WORKSPACE_DIR="/mnt/agent-saas/${SMOKE_MOUNT}"
SMOKE_CLEANUP_ERROR="/tmp/acs-smoke-workspace-cleanup-${GITHUB_RUN_ID}.err"
fi

cleanup() {
  # EXIT trap 既回收资源，也兜住进程替换后未显式包装的失败；显式 rollback_and_exit
  # 已设置 ACS_ROLLBACK_ATTEMPTED，避免同一失败被重复回滚。
  local deploy_status=$? rollback_status=0
  set +e
  if [ "$deploy_status" -ne 0 ] \
    && [ "${PROCESS_REPLACED:-false}" = "true" ] \
    && [ "${ACS_ROLLBACK_ATTEMPTED:-false}" != "true" ]; then
    rollback || rollback_status=$?
  fi
  if [ "$deploy_status" -ne 0 ] \
    && [ "${ACS_UNIT_UPDATED:-false}" = "true" ] \
    && [ "${PROCESS_REPLACED:-false}" != "true" ]; then
    if restore_acs_managed_unit \
      "$ACS_UNIT_PATH" "$ACS_UNIT_BAK" "$ACS_UNIT_HAD_PREVIOUS" "$SYSTEMCTL_BIN"; then
      ACS_UNIT_UPDATED=false
    else
      PRESERVE_ACS_UNIT_BAK=true
      echo 'failed to restore ACS managed unit; manual intervention required' >&2
    fi
  fi
  if [ "${PRODUCTION_CLEANUP_ARMED:-false}" != "true" ]; then
    case "${RUNTIME_PREFLIGHT_DIR:-}" in
      /tmp/agent-saas-runtime-preflight-*) rm -rf -- "$RUNTIME_PREFLIGHT_DIR" ;;
    esac
    rm -f "$RELEASE_TGZ"
    cleanup_acs_unit_backup
    return "$deploy_status"
  fi
  local sandbox_cleanup_safe=true
  if [ -n "${SMOKE_SESSION:-}" ] && command -v kubectl >/dev/null 2>&1; then
    if [ -n "${ACS_KUBECONFIG:-}" ]; then KCFG_ARGS="--kubeconfig ${ACS_KUBECONFIG}"; else KCFG_ARGS=""; fi
    # shellcheck disable=SC2086
    if ! kubectl $KCFG_ARGS -n "${ACS_NAMESPACE:-agent-saas-coding}" get sandbox \
      -l "app.kubernetes.io/managed-by=agent-saas-acs-orchestrator" \
      -o json >/tmp/acs-cleanup-sandboxes.json 2>/dev/null; then
      sandbox_cleanup_safe=false
      echo "::warning::cannot list smoke sandboxes; cleanup fails closed" >&2
    elif [ -s /tmp/acs-cleanup-sandboxes.json ] && command -v node >/dev/null 2>&1; then
      sandbox_names="$(
        SMOKE_SESSION="$SMOKE_SESSION" SMOKE_MOUNT="$SMOKE_MOUNT" node <<'NODE'
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync('/tmp/acs-cleanup-sandboxes.json', 'utf8') || '{"items":[]}');
const items = Array.isArray(body.items) ? body.items : [];
const sessionId = process.env.SMOKE_SESSION;
const mountSubPath = process.env.SMOKE_MOUNT;
for (const item of items) {
  const annotations = item?.metadata?.annotations || {};
  if (
    annotations['agent-saas.kaiyan.net/session-id'] === sessionId
    || annotations['agent-saas.kaiyan.net/mount-subpath'] === mountSubPath
  ) {
    console.log(item.metadata.name);
  }
}
NODE
      )"
      sandbox_parse_status=$?
      if [ "$sandbox_parse_status" -ne 0 ]; then
        sandbox_cleanup_safe=false
        echo "::warning::cannot parse smoke sandbox inventory; cleanup fails closed" >&2
      fi
      safe_delete_api_ready=false
      if [ -n "${ACS_ORCH_AUTH_TOKEN:-}" ] \
        && command -v curl >/dev/null 2>&1 \
        && curl -fsS -m 5 http://127.0.0.1:3400/health >/tmp/acs-cleanup-health.json 2>/dev/null \
        && grep -F "$IMAGE" /tmp/acs-cleanup-health.json >/dev/null; then
        # health 中的新镜像证明当前进程由本次发布代码启动；rollback 后的旧进程
        # 不得接管安全删除，否则会重新落回旧的裸删语义。
        safe_delete_api_ready=true
      fi
      if [ -n "$sandbox_names" ]; then
        while IFS= read -r sandbox_name; do
          [ -n "$sandbox_name" ] || continue
          # 禁止在 trap 里裸删 Sandbox 后遗留无主体网络策略。只有新 orchestrator
          # 的安全 DELETE 链成功，且 kubectl 二次确认 CR 不存在，才允许清 workspace。
          if [ "$safe_delete_api_ready" != "true" ] \
            || ! curl -fsS -m 30 -X DELETE \
              -H "Authorization: Bearer ${ACS_ORCH_AUTH_TOKEN}" \
              "http://127.0.0.1:3400/sandboxes/${sandbox_name}" >/dev/null; then
            sandbox_cleanup_safe=false
            echo "::warning::safe smoke sandbox delete failed: $sandbox_name; retaining network policy and workspace" >&2
            continue
          fi
          # shellcheck disable=SC2086
          confirmed_name="$(kubectl $KCFG_ARGS -n "${ACS_NAMESPACE:-agent-saas-coding}" get \
            "sandbox/${sandbox_name}" --ignore-not-found=true -o name 2>/dev/null)"
          confirm_status=$?
          if [ "$confirm_status" -ne 0 ] || [ -n "$confirmed_name" ]; then
            sandbox_cleanup_safe=false
            echo "::warning::smoke sandbox absence not confirmed: $sandbox_name; retaining workspace" >&2
          fi
        done <<EOF
$sandbox_names
EOF
      fi
    else
      sandbox_cleanup_safe=false
      echo "::warning::cannot parse smoke sandbox inventory; cleanup fails closed" >&2
    fi
  elif [ -n "${SMOKE_SESSION:-}" ]; then
    sandbox_cleanup_safe=false
    echo "::warning::kubectl unavailable; smoke cleanup fails closed" >&2
  fi
  if [ "$sandbox_cleanup_safe" = "true" ] && [ -n "${SMOKE_WORKSPACE_DIR:-}" ]; then
    case "$SMOKE_WORKSPACE_DIR" in
      /mnt/agent-saas/workspaces/_ci/ws_ci_acr_*|/mnt/agent-saas/workspaces/_ci/ws_ci_acs_*)
        # Sandbox CR 删除后 Pod/NFS 写入可能短暂滞后；单次 rm -rf 会因
        # __pycache__ 等目录被并发写回而报 Directory not empty。
        for cleanup_attempt in 1 2 3 4 5; do
          rm -rf -- "$SMOKE_WORKSPACE_DIR" 2>"$SMOKE_CLEANUP_ERROR"
          [ ! -e "$SMOKE_WORKSPACE_DIR" ] && break
          sleep "$cleanup_attempt"
        done
        if [ -e "$SMOKE_WORKSPACE_DIR" ]; then
          echo "::warning::smoke workspace cleanup incomplete after retries: $SMOKE_WORKSPACE_DIR" >&2
          if [ -s "$SMOKE_CLEANUP_ERROR" ]; then
            printf '  last error: ' >&2
            tr '\n' ' ' <"$SMOKE_CLEANUP_ERROR" >&2
            printf '\n' >&2
          fi
        fi
        ;;
      *)
        echo "skip smoke workspace cleanup: unexpected path $SMOKE_WORKSPACE_DIR" >&2
        ;;
    esac
  elif [ "$sandbox_cleanup_safe" != "true" ]; then
    echo "::warning::skip smoke workspace cleanup until Sandbox absence is confirmed: ${SMOKE_WORKSPACE_DIR:-unknown}" >&2
  fi
  if [ "$deploy_status" -ne 0 ] \
    && [ "${SNAT_ROLLBACK_PREPARED:-false}" = "true" ] \
    && [ "${PROCESS_REPLACED:-false}" != "true" ] \
    && [ -n "${SNAT_ROLLBACK_DIGEST:-}" ] \
    && [ -n "${AUTH_HEADER:-}" ]; then
    curl -fsS -m 30 -X POST http://127.0.0.1:3400/snat/restore-per-pod/cancel \
      -H "$AUTH_HEADER" -H "X-ACS-SNAT-Rollback-Confirmed: $SNAT_ROLLBACK_DIGEST" >/dev/null \
      || echo "failed to cancel pre-deploy SNAT maintenance; manual intervention required" >&2
  fi
  if [ "$deploy_status" -ne 0 ] \
    && [ "${PROCESS_REPLACED:-false}" != "true" ]; then
    [ -s "${ENV_BAK:-}" ] && cp "$ENV_BAK" "$ENV_FILE"
    [ -s "${RUNTIME_CONFIG_BAK:-}" ] && cp "$RUNTIME_CONFIG_BAK" "$RUNTIME_CONFIG_FILE"
    if [ "$IDENTITY_STATE_CAPTURED" = "true" ]; then
      if [ "${HAD_IDENTITY:-false}" = "true" ] && [ -s "${IDENTITY_BAK:-}" ]; then
        cp "$IDENTITY_BAK" "$IDENTITY_FILE"
      else
        rm -f "$IDENTITY_FILE"
      fi
    fi
    if [ "${CURRENT_LINK_UPDATED:-false}" = "true" ]; then
      ln -sfn "$PREVIOUS_APP_DIR" "$CURRENT_LINK"
      CURRENT_LINK_UPDATED=false
    fi
    [ -n "${SNAT_OPERATION_STATE_FILE:-}" ] && rm -f "$SNAT_OPERATION_STATE_FILE"
  fi
  case "${RUNTIME_PREFLIGHT_DIR:-}" in
    /tmp/agent-saas-runtime-preflight-*) rm -rf -- "$RUNTIME_PREFLIGHT_DIR" ;;
  esac
  rm -f "$RELEASE_TGZ" "$SMOKE_CLEANUP_ERROR" \
    /tmp/acs-cleanup-sandboxes.json /tmp/acs-cleanup-health.json
  cleanup_acs_unit_backup
  if [ "$rollback_status" -ne 0 ]; then
    echo "ACS direct deployment failed with status $deploy_status; rollback status $rollback_status" >&2
    trap - EXIT HUP INT TERM
    exit "$rollback_status"
  fi
  return "$deploy_status"
}
trap cleanup EXIT

if [ "$ACS_DIRECT_CLEANUP_TRAP_TEST" = true ]; then
  false
fi

# ── 1. 安装按 artifact digest 寻址的 orchestrator release（旧进程零影响）──
actual_archive_digest="sha256:$(sha256sum "$RELEASE_TGZ" | cut -d' ' -f1)"
test "$actual_archive_digest" = "$ORCHESTRATOR_ARTIFACT_DIGEST"

# 先在 /tmp 解包，并用 systemd 最终 ExecStart 的同一个 /usr/bin/node 执行 Runtime guard。
# guard 与 managed unit 校验通过前，不得写入 /etc 或落下持久 release 目录。
RUNTIME_PREFLIGHT_DIR="$(mktemp -d "/tmp/agent-saas-runtime-preflight-${GITHUB_RUN_ID}-XXXXXX")"
tar -xzf "$RELEASE_TGZ" -C "$RUNTIME_PREFLIGHT_DIR"
test -x "$ACS_NODE"
test -x "$SYSTEMCTL_BIN"
test -f "$ENV_FILE"
test -s "$RUNTIME_PREFLIGHT_DIR/acs-orchestrator/runtime-dependencies.json"
unit_helper="$RUNTIME_PREFLIGHT_DIR/scripts/release/manage-acs-systemd-unit.sh"
unit_source="$RUNTIME_PREFLIGHT_DIR/daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template"
desired_environment_file="$RUNTIME_PREFLIGHT_DIR/acs-orchestrator/config/production.env"
runtime_environment_file="$RUNTIME_PREFLIGHT_DIR/acs-orchestrator.env"
test -s "$unit_helper"
test -s "$desired_environment_file"
# 在 /tmp 构造最终 EnvironmentFile：仓库声明的 SNAT 模式会先应用，自定义 CLI 路径原样保留。
# Runtime guard 自己按 systemd EnvironmentFile 语义解析，禁止 source/eval 生产 env。
install -m 0600 "$ENV_FILE" "$runtime_environment_file"
python3 "$RUNTIME_PREFLIGHT_DIR/scripts/apply-orchestrator-env.py" \
  --desired "$desired_environment_file" \
  --target "$runtime_environment_file"
# shellcheck disable=SC1090
. "$unit_helper"
validate_acs_managed_unit "$unit_source" "$ACS_NODE" "$ACS_SERVICE_NAME"
assert_no_acs_managed_unit_dropins "$ACS_SERVICE_NAME"
"$ACS_NODE" "$RUNTIME_PREFLIGHT_DIR/acs-orchestrator/dist/runtime-dependency.mjs" \
  --manifest="$RUNTIME_PREFLIGHT_DIR/acs-orchestrator/runtime-dependencies.json" \
  --component=acsOrchestrator --environment-file="$runtime_environment_file" --production=true

# Runtime guard 通过后，在进程替换前原子安装受管 unit；首次升级允许 /etc 下无旧 unit，
# 失败时 cleanup/rollback 会恢复旧 unit 或移除本次新增 override 并 daemon-reload。
if [ -L "$ACS_UNIT_PATH" ] || { [ -e "$ACS_UNIT_PATH" ] && [ ! -f "$ACS_UNIT_PATH" ]; }; then
  echo "ACS managed unit target must be absent or a regular file: $ACS_UNIT_PATH" >&2
  exit 1
fi
if [ -f "$ACS_UNIT_PATH" ]; then
  ACS_UNIT_HAD_PREVIOUS=true
  install -m 0644 "$ACS_UNIT_PATH" "$ACS_UNIT_BAK"
fi
ACS_UNIT_UPDATED=true
install_acs_managed_unit "$unit_source" "$ACS_UNIT_PATH" "$SYSTEMCTL_BIN"
assert_no_acs_managed_unit_dropins "$ACS_SERVICE_NAME"
rm -rf -- "$RUNTIME_PREFLIGHT_DIR"
RUNTIME_PREFLIGHT_DIR=""
PRODUCTION_CLEANUP_ARMED=true

# Runtime guard 通过后才读取、备份并探测生产 identity 写入边界。
test -s "$RUNTIME_IDENTITY_FILE"
node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" \
  "$RUNTIME_IDENTITY_FILE"
cp "$RUNTIME_IDENTITY_FILE" "$RUNTIME_IDENTITY_BAK"
runtime_identity_probe="/etc/agent-saas/.runtime-identity-write-probe-acs-${GITHUB_RUN_ID}"
printf '{}\n' > "$runtime_identity_probe.candidate"
mv "$runtime_identity_probe.candidate" "$runtime_identity_probe"
rm -f "$runtime_identity_probe"

if [ -d "$APP_DIR" ]; then
  node "$APP_DIR/scripts/release/verify-installed-release.mjs" \
    --action verify --root "$APP_DIR" --component acs >/dev/null
else
  candidate="$APP_DIR.candidate-${GITHUB_RUN_ID}"
  rm -rf "$candidate"
  mkdir -p "$candidate/.release"
  install -m 0444 "$RELEASE_TGZ" "$candidate/.release/acs-orchestrator.tgz"
  tar -xzf "$RELEASE_TGZ" -C "$candidate"
  test -f "$candidate/acs-orchestrator/dist/index.js"
  test -f "$candidate/acs-orchestrator/dist/backgroundShellWorker.js"
  test -f "$candidate/acs-orchestrator/dist/restorePerPodCli.js"
  test -f "$candidate/acs-orchestrator/descriptions/Edit.md"
  node "$candidate/scripts/release/seal-compatibility-release.mjs" \
    --root "$candidate" --component acs --release-id "$COMPAT_RELEASE_ID" \
    --sha "$GITHUB_SHA" --sandbox-image-digest "$IMAGE_DIGEST" >/dev/null
  mv "$candidate" "$APP_DIR"
fi
cd "$APP_DIR"

# ── 2. 备份并更新镜像 env（新进程拉起时生效）──
test -f "$ENV_FILE"
ENV_BAK="${ENV_FILE}.bak.${GITHUB_RUN_ID}-${GITHUB_SHA:0:7}"
cp "$ENV_FILE" "$ENV_BAK"
HAD_IDENTITY=false
IDENTITY_BAK="${IDENTITY_FILE}.bak.${GITHUB_RUN_ID}-${GITHUB_SHA:0:7}"
if [ -f "$IDENTITY_FILE" ]; then
  HAD_IDENTITY=true
  cp "$IDENTITY_FILE" "$IDENTITY_BAK"
fi
IDENTITY_STATE_CAPTURED=true
RUNTIME_CONFIG_FILE="$(grep '^ACS_ORCH_RUNTIME_CONFIG_FILE=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
case "$RUNTIME_CONFIG_FILE" in
  /*) ;;
  *) echo "ACS_ORCH_RUNTIME_CONFIG_FILE 缺失或不是绝对路径，拒绝部署: $RUNTIME_CONFIG_FILE" >&2; exit 1 ;;
esac
test -f "$RUNTIME_CONFIG_FILE"
RUNTIME_CONFIG_BAK="${RUNTIME_CONFIG_FILE}.bak.${GITHUB_RUN_ID}-${GITHUB_SHA:0:7}"
cp "$RUNTIME_CONFIG_FILE" "$RUNTIME_CONFIG_BAK"
if grep -q '^ACS_SANDBOX_IMAGE=' "$ENV_FILE"; then
  sed -i "s|^ACS_SANDBOX_IMAGE=.*|ACS_SANDBOX_IMAGE=${IMAGE}|" "$ENV_FILE"
else
  printf '\nACS_SANDBOX_IMAGE=%s\n' "$IMAGE" >> "$ENV_FILE"
fi

# ── 2b. apply 仓库声明的运行参数（2026-08-10）──
# 此前规格 / SNAT / 生命周期这些值只存在于 ECS 上手写的 env：没有版本
# 控制、没有审计、改错只能人肉回滚。现在改参数 = 改
# acs-orchestrator/config/production.env 并走 CI，git log 即变更史、
# git revert 即回滚，CI 日志留下「哪个值从 A 变成 B」。
#
# 逐键 upsert：只动声明过的键，token 等敏感项与主机相关路径原样保留；
# 同时把配额类声明同步进 runtime JSON，避免旧的管理端持久值在启动时反向覆盖 env。
# 脚本对敏感键与 ACS_SANDBOX_IMAGE 有硬拒绝，写入后还会断言原有键无丢失。
# 上面已备份 env/runtime JSON，此处不重复备份。失败即中止部署（set -e），
# 此时旧进程仍带旧 env 运行，不受影响。
DESIRED_ENV="$APP_DIR/acs-orchestrator/config/production.env"
if [ -f "$DESIRED_ENV" ]; then
  python3 "$APP_DIR/scripts/apply-orchestrator-env.py" \
    --desired "$DESIRED_ENV" \
    --target "$ENV_FILE" \
    --runtime-config-target "$RUNTIME_CONFIG_FILE"
  # 最终 unit 将读取这个同一 EnvironmentFile；在旧进程 drain 前再次校验实际落盘值。
  "$ACS_NODE" "$APP_DIR/acs-orchestrator/dist/runtime-dependency.mjs" \
    --manifest="$APP_DIR/acs-orchestrator/runtime-dependencies.json" \
    --component=acsOrchestrator --environment-file="$ENV_FILE" --production=true
else
  echo "未找到声明式运行配置 $DESIRED_ENV，拒绝部署" >&2
  exit 1
fi
# 部署事务只读取自身需要的非 Runtime 字段；通过 NUL 分隔传值，不 source/eval EnvironmentFile。
unset ACS_ORCH_AUTH_TOKEN ACS_KUBECONFIG
ACS_NAMESPACE=agent-saas-coding
shopt -s lastpipe
"$ACS_NODE" "$APP_DIR/acs-orchestrator/dist/runtime-dependency.mjs" \
  --environment-file="$ENV_FILE" \
  --print-environment=ACS_ORCH_AUTH_TOKEN,ACS_KUBECONFIG,ACS_NAMESPACE \
  | while IFS= read -r -d '' environment_key && IFS= read -r -d '' environment_value; do
      printf -v "$environment_key" '%s' "$environment_value"
      export "$environment_key"
    done
shopt -u lastpipe
: "${ACS_ORCH_AUTH_TOKEN:?missing ACS_ORCH_AUTH_TOKEN in env file}"
AUTH_HEADER="Authorization: Bearer ${ACS_ORCH_AUTH_TOKEN}"
SNAT_OPERATION_STATE_FILE="${RUNTIME_CONFIG_FILE}.snat-operation-state.json"
SNAT_ROLLBACK_PREPARED=false
SNAT_ROLLBACK_OFFLINE_RESTORE=false
SNAT_ROLLBACK_SHARED_CONFIG_SAFE=false
SNAT_ROLLBACK_DIGEST=""
PROCESS_REPLACED=false

prepare_snat_rollback() {
  local health_file=/tmp/acs-rollback-health.json
  local restore_file=/tmp/acs-rollback-restore.json
  curl -sS -m 10 http://127.0.0.1:3400/health >"$health_file" 2>/dev/null || {
    echo "cannot read current SNAT state; refusing deploy without rollback safety" >&2
    return 1
  }
  local digest
  digest="$(node -e "const h=require('$health_file');process.stdout.write(h?.snat?.sharedCidrConfigDigest||'')" 2>/dev/null || true)"
  if [ -z "$digest" ]; then
    return 2
  fi
  SNAT_ROLLBACK_DIGEST="$digest"
  if node "$APP_DIR/scripts/check-acs-shared-rollback-compatibility.mjs" \
    "$health_file" "$ENV_BAK" "$ENV_FILE"; then
    SNAT_ROLLBACK_SHARED_CONFIG_SAFE=true
    echo "shared SNAT config is identical across running/candidate/rollback; per-Pod restore is unnecessary"
    return 0
  fi
  echo "preparing per-Pod SNAT entries before process replacement (digest=$digest)..."
  if ! curl -fsS -m 420 -X POST http://127.0.0.1:3400/snat/restore-per-pod \
    -H "$AUTH_HEADER" -H "X-ACS-SNAT-Rollback-Confirmed: $digest" >"$restore_file"; then
    echo "SNAT rollback preparation failed; refusing process replacement" >&2
    return 1
  fi
  node -e "const r=require('$restore_file');if(r.status!=='ok'||r.rollbackPrepared!==true)process.exit(1)"
}

# 旧基线没有 restore API：首轮部署若需回滚，必须先停掉失败候选并用本次
# release 内置的离线 CLI 恢复全部 /32；后续版本则在替换进程前在线恢复。
# 在线路径只删除磁盘 marker，旧进程内存维护态持续到退出。
if prepare_snat_rollback; then
  if [ "$SNAT_ROLLBACK_SHARED_CONFIG_SAFE" != "true" ]; then
    SNAT_ROLLBACK_PREPARED=true
    rm -f "$SNAT_OPERATION_STATE_FILE"
  fi
else
  prepare_status=$?
  if [ "$prepare_status" -eq 2 ] \
    && [ ! -f "$PREVIOUS_APP_DIR/acs-orchestrator/src/snatOperations.ts" ]; then
    SNAT_ROLLBACK_OFFLINE_RESTORE=true
    echo "legacy baseline has no restore endpoint; rollback will require offline /32 restore"
  else
    exit "$prepare_status"
  fi
fi

CONFIG_FINGERPRINT="sha256:$(sha256sum "$ENV_FILE" | cut -d' ' -f1)"
node "$APP_DIR/scripts/release/write-compatibility-acs-identity.mjs" \
  --output "$IDENTITY_FILE" --release-id "$COMPAT_RELEASE_ID" --sha "$GITHUB_SHA" \
  --orchestrator-digest "$ORCHESTRATOR_ARTIFACT_DIGEST" \
  --sandbox-image-digest "$IMAGE_DIGEST" \
  --namespace "${ACS_NAMESPACE:-agent-saas-coding}" \
  --config-fingerprint "$CONFIG_FINGERPRINT" >/dev/null
ln -sfn "$APP_DIR" "$CURRENT_LINK"
CURRENT_LINK_UPDATED=true


# ── 3. Drain 旧进程: SIGUSR2 → 排空 inflight 后 clean exit →
#      当前事务显式 systemctl restart 拉起新代码、新 env 与 managed unit ──
# 2026-07-15 修复：SIGUSR2 必须送达注册了 handler 的 node 本体。
# ExecStart 是 pnpm wrapper 时 MainPID 是 wrapper 的 node 进程——它不
# 转发 SIGUSR2 且收到即被默认动作终止（drain 静默失效、inflight 被
# cgroup 清场硬杀）。优先读 orchestrator 自写 pidfile（ACS_ORCH_PIDFILE），
# 并用 journal 断言 drain 真实生效；未确认一律 restart 兜底。
ORCH_PIDFILE="/run/agent-saas-acs-orchestrator.pid"
DRAIN_PID=""
RESTART_FALLBACK=0
if [ -f "$ORCH_PIDFILE" ] && kill -0 "$(cat "$ORCH_PIDFILE")" 2>/dev/null; then
  DRAIN_PID=$(cat "$ORCH_PIDFILE")
  echo "draining orchestrator pid=$DRAIN_PID (SIGUSR2 via pidfile)..."
else
  MAIN_PID=$("$SYSTEMCTL_BIN" show -p MainPID --value "$ACS_SERVICE_NAME" 2>/dev/null || echo 0)
  if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ]; then
    DRAIN_PID="$MAIN_PID"
    echo "WARN: pidfile missing/stale; SIGUSR2 to MainPID=$MAIN_PID (wrapper may swallow it)"
  else
    RESTART_FALLBACK=1
  fi
fi
if [ "$RESTART_FALLBACK" = "0" ]; then
  kill -USR2 "$DRAIN_PID" 2>/dev/null || true
  sleep 3
  if journalctl -u "$ACS_SERVICE_NAME" --since "-45 seconds" --no-pager 2>/dev/null | grep -q "entering drain mode"; then
    echo "drain confirmed via journal"
    for _ in $(seq 1 135); do
      kill -0 "$DRAIN_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$DRAIN_PID" 2>/dev/null; then
      echo "drain deadline exceeded, falling back to systemctl restart"
      RESTART_FALLBACK=1
    fi
  else
    echo "WARN: drain not confirmed in journal (signal may have hit a wrapper); falling back to systemctl restart"
    RESTART_FALLBACK=1
  fi
fi
if [ "$RESTART_FALLBACK" = "1" ]; then
  echo 'restarting orchestrator without a confirmed graceful drain'
fi
# Restart=on-failure 不会在 drain 的 clean exit(0) 后自动拉起；无论 drain 是否
# 优雅完成，都必须由当前受锁事务显式 restart，确保 managed unit 与候选 symlink 生效。
PROCESS_REPLACED=true
if ! "$SYSTEMCTL_BIN" restart "$ACS_SERVICE_NAME"; then
  echo 'candidate restart failed; rolling back the managed unit and previous release' >&2
  rollback_and_exit 1
fi

# ── 4. 等新进程 health 且 image 已切换 ──
HEALTH_OK=false
for _ in $(seq 1 120); do
  if curl -fsS -m 5 http://127.0.0.1:3400/health >/tmp/acs-health.json 2>/dev/null; then
    if grep -F "$IMAGE" /tmp/acs-health.json >/dev/null; then
      HEALTH_OK=true
      break
    fi
  fi
  sleep 1
done

if [ "$HEALTH_OK" != "true" ]; then
  echo "health/image check failed after 120s" >&2
  journalctl -u "$ACS_SERVICE_NAME" -n 100 --no-pager || true
  rollback_and_exit 1
fi

EXPECTED_MAX_RUNNING="$(grep '^ACS_SANDBOX_MAX_RUNNING=' "$DESIRED_ENV" | head -n1 | cut -d= -f2-)"
EXPECTED_WARN_RUNNING="$(grep '^ACS_SANDBOX_WARN_RUNNING=' "$DESIRED_ENV" | head -n1 | cut -d= -f2-)"
EXPECTED_MAX_CPU="$(grep '^ACS_SANDBOX_MAX_ALLOCATED_CPU_MILLICORES=' "$DESIRED_ENV" | head -n1 | cut -d= -f2-)"
EXPECTED_WARN_CPU="$(grep '^ACS_SANDBOX_WARN_ALLOCATED_CPU_MILLICORES=' "$DESIRED_ENV" | head -n1 | cut -d= -f2-)"
EXPECTED_MAX_MEMORY="$(grep '^ACS_SANDBOX_MAX_ALLOCATED_MEMORY_MIB=' "$DESIRED_ENV" | head -n1 | cut -d= -f2-)"
EXPECTED_WARN_MEMORY="$(grep '^ACS_SANDBOX_WARN_ALLOCATED_MEMORY_MIB=' "$DESIRED_ENV" | head -n1 | cut -d= -f2-)"
if ! EXPECTED_MAX_RUNNING="$EXPECTED_MAX_RUNNING" EXPECTED_WARN_RUNNING="$EXPECTED_WARN_RUNNING" \
  EXPECTED_MAX_CPU="$EXPECTED_MAX_CPU" EXPECTED_WARN_CPU="$EXPECTED_WARN_CPU" \
  EXPECTED_MAX_MEMORY="$EXPECTED_MAX_MEMORY" EXPECTED_WARN_MEMORY="$EXPECTED_WARN_MEMORY" node <<'NODE'
const fs = require('node:fs');
const health = JSON.parse(fs.readFileSync('/tmp/acs-health.json', 'utf8'));
const actual = { ...(health.runtimeConfig || {}), lifecycleEnabled: health.lifecycle?.enabled, lifecyclePolicyMode: health.lifecyclePolicyMode };
const expected = {
  lifecycleEnabled: true,
  lifecyclePolicyMode: 'enforce',
  maxRunningSandboxes: Number(process.env.EXPECTED_MAX_RUNNING),
  warnRunningSandboxes: Number(process.env.EXPECTED_WARN_RUNNING),
  maxAllocatedCpuMillicores: Number(process.env.EXPECTED_MAX_CPU),
  warnAllocatedCpuMillicores: Number(process.env.EXPECTED_WARN_CPU),
  maxAllocatedMemoryMib: Number(process.env.EXPECTED_MAX_MEMORY),
  warnAllocatedMemoryMib: Number(process.env.EXPECTED_WARN_MEMORY),
};
const mismatch = Object.entries(expected).filter(([key, value]) => actual[key] !== value);
if (mismatch.length > 0) {
  console.error(
    `runtime config mismatch: ${mismatch.map(([key, value]) => `${key} expected=${value} actual=${actual[key]}`).join(', ')}`,
  );
  process.exit(1);
}
NODE
then
  rollback_and_exit 1
fi
echo "runtime config and lifecycle policy gate passed: max=$EXPECTED_MAX_RUNNING warn=$EXPECTED_WARN_RUNNING enabled=true mode=enforce"

# ── 5. Smoke: provision + execute 真实拉新镜像跑通 ──
# SMOKE_SESSION/SMOKE_WS/SMOKE_MOUNT 已在 cleanup 定义前赋值，确保任何失败路径都能清理。

SMOKE_OK=true
if ! curl -fsS -m 420 -X POST http://127.0.0.1:3400/provision \
  -H "$AUTH_HEADER" -H 'X-ACS-Maintenance-Bypass: deploy-smoke-v1' -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"${SMOKE_WS}\",\"recipe\":{\"workspaceId\":\"${SMOKE_WS}\",\"sessionId\":\"${SMOKE_SESSION}\",\"mountSubPath\":\"${SMOKE_MOUNT}\",\"workload\":{\"class\":\"deploy-smoke\"}}}" \
  >/tmp/acs-provision.json; then
  SMOKE_OK=false
elif ! grep -F '"status":"ok"' /tmp/acs-provision.json >/dev/null; then
  SMOKE_OK=false
fi

if [ "$SMOKE_OK" = "true" ]; then
  printf '%s' "{\"toolName\":\"Shell\",\"input\":{\"command\":\"set -eu; test \\\"\$(id -u)\\\" = 501; test \\\"\$(pwd)\\\" = /workspace; command -v aliyun; aliyun version; command -v gh; gh --version; command -v ntn; ntn --version; command -v gws; gws --version; command -v dws; dws --version; command -v lark-cli; lark-cli --version; echo ACR_BUILD_DEPLOY_SMOKE_OK\",\"timeoutMs\":120000},\"context\":{\"workspace\":{\"id\":\"${SMOKE_WS}\",\"sessionId\":\"${SMOKE_SESSION}\",\"mountSubPath\":\"${SMOKE_MOUNT}\",\"workload\":{\"class\":\"deploy-smoke\"}}}}" >/tmp/acs-execute-payload.json
  if ! curl -fsS -m 420 -X POST http://127.0.0.1:3400/execute \
    -H "$AUTH_HEADER" -H 'X-ACS-Maintenance-Bypass: deploy-smoke-v1' -H 'Content-Type: application/json' \
    --data-binary @/tmp/acs-execute-payload.json >/tmp/acs-execute.json; then
    SMOKE_OK=false
  elif ! grep -F 'ACR_BUILD_DEPLOY_SMOKE_OK' /tmp/acs-execute.json >/dev/null; then
    SMOKE_OK=false
  fi
fi

if [ "$SMOKE_OK" = "true" ]; then
  if ! ACS_ORCH_URL='http://127.0.0.1:3400' \
    ACS_ORCH_AUTH_TOKEN="$ACS_ORCH_AUTH_TOKEN" \
    ACS_SMOKE_WORKSPACE_ID="$SMOKE_WS" \
    ACS_SMOKE_SESSION_ID="$SMOKE_SESSION" \
    ACS_SMOKE_MOUNT_SUBPATH="$SMOKE_MOUNT" \
    ACS_SMOKE_WORKSPACE_DIR="$SMOKE_WORKSPACE_DIR" \
    ACS_APP_DIR="$APP_DIR" \
    GITHUB_RUN_ID="$GITHUB_RUN_ID" \
    node "$APP_DIR/scripts/acs-browser-lease-e2e.mjs" \
    >/tmp/acs-browser-lease-e2e.log 2>&1; then
    SMOKE_OK=false
  fi
fi

if [ "$SMOKE_OK" != "true" ]; then
  echo "SMOKE FAILED — dumping diagnostics" >&2
  cat /tmp/acs-provision.json 2>/dev/null || true
  cat /tmp/acs-execute.json 2>/dev/null || true
  cat /tmp/acs-browser-lease-e2e.log 2>/dev/null || true
  if command -v kubectl >/dev/null 2>&1; then
    if [ -n "${ACS_KUBECONFIG:-}" ]; then KCFG_ARGS="--kubeconfig ${ACS_KUBECONFIG}"; else KCFG_ARGS=""; fi
    # imagePullSecret 401 是历史高发根因(2026-06-29), events 里最直观
    # shellcheck disable=SC2086
    kubectl $KCFG_ARGS -n "${ACS_NAMESPACE:-agent-saas-coding}" get events --sort-by=.lastTimestamp 2>/dev/null | tail -20 || true
  fi
  rollback_and_exit 1
fi

if command -v kubectl >/dev/null 2>&1; then
  if [ -n "${ACS_KUBECONFIG:-}" ]; then KCFG_ARGS="--kubeconfig ${ACS_KUBECONFIG}"; else KCFG_ARGS=""; fi
  # shellcheck disable=SC2086
  kubectl $KCFG_ARGS -n "${ACS_NAMESPACE:-agent-saas-coding}" get sandbox \
    -l "app.kubernetes.io/managed-by=agent-saas-acs-orchestrator" \
    -o json >/tmp/acs-sandboxes.json 2>/dev/null || true
  if [ -s /tmp/acs-sandboxes.json ]; then
    CURRENT_IMAGE="$IMAGE" node <<'NODE'
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync('/tmp/acs-sandboxes.json', 'utf8') || '{"items":[]}');
const items = Array.isArray(body.items) ? body.items : [];
const currentImage = process.env.CURRENT_IMAGE;
const byPhaseImage = new Map();
let stalePaused = 0;
for (const item of items) {
  const phase = item?.status?.phase || 'Unknown';
  const containers = item?.spec?.template?.spec?.containers || [];
  const image = containers.find((container) => !container.name || container.name === 'sandbox')?.image || 'unknown';
  if (phase === 'Paused' && image !== currentImage) stalePaused += 1;
  const key = `${phase}\t${image}`;
  byPhaseImage.set(key, (byPhaseImage.get(key) || 0) + 1);
}
console.log(`ACS sandbox inventory: total=${items.length} stalePaused=${stalePaused}`);
for (const [key, count] of [...byPhaseImage.entries()].sort()) {
  const [phase, image] = key.split('\t');
  console.log(`  ${phase} x${count} ${image}`);
}
NODE
  fi

  # ── 5.5 发布门禁：假暂停必须收敛为 0（2026-08-01，07-22/08-01 事故）──
  # 假暂停 = phase=Paused 但 SandboxPaused condition != True（如卡 False/
  # ImageChanged）或 spec.paused != true 的半状态；ACS 对其持续按运行态计费。
  # 新 orchestrator startup 会 retire stale Paused + lifecycle 回收 broken
  # （回收宽限默认 5min），给最多 8 分钟收敛。门禁失败不回滚（旧版行为更差），
  # 只 fail 提醒人工介入。
  GATE_OK=false
  for _ in $(seq 1 48); do
    # shellcheck disable=SC2086
    kubectl $KCFG_ARGS -n "${ACS_NAMESPACE:-agent-saas-coding}" get sandbox \
      -l "app.kubernetes.io/managed-by=agent-saas-acs-orchestrator" \
      -o json >/tmp/acs-gate-sandboxes.json 2>/dev/null || true
    BROKEN_COUNT="$(node <<'NODE'
const fs = require('node:fs');
let body = { items: [] };
try { body = JSON.parse(fs.readFileSync('/tmp/acs-gate-sandboxes.json', 'utf8') || '{"items":[]}'); } catch {}
const items = Array.isArray(body.items) ? body.items : [];
let broken = 0;
for (const item of items) {
  if ((item?.status?.phase || '') !== 'Paused') continue;
  const conditions = Array.isArray(item?.status?.conditions) ? item.status.conditions : [];
  const paused = conditions.find((c) => c && c.type === 'SandboxPaused');
  const pausedOk = paused && paused.status === 'True';
  const specPaused = item?.spec?.paused === true;
  if (!pausedOk || !specPaused) {
    broken += 1;
    console.error(`broken paused: ${item?.metadata?.name} specPaused=${item?.spec?.paused} cond=${paused ? `${paused.status}/${paused.reason}` : 'missing'}`);
  }
}
console.log(broken);
NODE
    )"
    if [ "$BROKEN_COUNT" = "0" ]; then
      GATE_OK=true
      break
    fi
    echo "false-paused gate: ${BROKEN_COUNT} broken paused sandbox(es) remaining, waiting..."
    sleep 10
  done
  if [ "$GATE_OK" != "true" ]; then
    echo "FALSE-PAUSED GATE FAILED: broken paused sandboxes did not converge to 0 within 8min" >&2
    echo "these sandboxes keep billing as running (see 07-22/08-01 incidents); investigate orchestrator lifecycle logs" >&2
    exit 1
  fi
  echo "false-paused gate passed: 0 broken paused sandboxes"
fi

# ── 5.6 从 ACS health 与当前 App/Web 现场原子重建 Production identity ──
IDENTITY_SYNC_DIR="/tmp/agent-saas-runtime-identity-acs-${GITHUB_RUN_ID}"
rm -rf "$IDENTITY_SYNC_DIR"
mkdir -p "$IDENTITY_SYNC_DIR"
IDENTITY_SYNCED=false
for identity_attempt in $(seq 1 10); do
  rm -f "$IDENTITY_SYNC_DIR/live.json" "$IDENTITY_SYNC_DIR/confirmed.json"
  if node "$APP_DIR/scripts/release/read-live-production-components.mjs" \
      --output "$IDENTITY_SYNC_DIR/live.json" >/dev/null \
    && node "$APP_DIR/scripts/release/write-live-production-identity.mjs" \
      --input "$IDENTITY_SYNC_DIR/live.json" --output "$RUNTIME_IDENTITY_FILE" >/dev/null; then
    RUNTIME_IDENTITY_UPDATED=true
    if node "$APP_DIR/scripts/release/read-production-state.mjs" \
      --output "$IDENTITY_SYNC_DIR/confirmed.json" >/dev/null; then
      IDENTITY_SYNCED=true
      break
    fi
  fi
  echo "Production identity convergence attempt $identity_attempt/10 failed" >&2
  sleep 2
done
if [ "$IDENTITY_SYNCED" != "true" ]; then
  echo "Production runtime identity failed to converge after ACS deployment; rolling ACS back" >&2
  rollback_and_exit 1
fi
rm -rf "$IDENTITY_SYNC_DIR"
echo "Production identity atomically rebuilt from live API/Worker/Web/ACS evidence"

# ── 6. ImageCache: 为本次镜像提交缓存制作 + 清理旧缓存（2026-07-31 方案3-P0）──
# 命中缓存的新 Sandbox 镜像拉取官方口径省 90%+。整段子 shell 容错：
# 缓存制作失败只告警，绝不影响部署结果（无缓存时 Pod 回退正常拉取）。
# ECS 侧凭据=EcsRamRole（policy AgentSaasAccImageCache，仅 acc 镜像缓存四个 API）。
(
  set +e
  if ! command -v aliyun >/dev/null 2>&1; then echo "WARN: aliyun CLI missing, skip image cache"; exit 0; fi
  CACHE_NAME="agent-saas-acs-sandbox-$(printf '%s' "$IMAGE_TAG" | tr 'A-Z._' 'a-z--')"
  EXISTING=$(aliyun acc list-image-caches --biz-region-id cn-shenzhen 2>/dev/null)
  if printf '%s' "$EXISTING" | grep -F "\"$IMAGE\"" >/dev/null 2>&1; then
    echo "image cache already exists for $IMAGE_TAG"
  else
    if aliyun acc create-image-cache \
      --biz-region-id cn-shenzhen \
      --image-cache-name "$CACHE_NAME" \
      --images "$IMAGE" \
      --network-config '{"SecurityGroupId":"sg-wz97utch71p1mo0etbg9","VSwitchIds":["vsw-wz99c9ukqjjwn8xlzg5h5"]}' \
      --acr-registry-infos InstanceId=cri-tapxtcyd6odwj3m4 RegionId=cn-shenzhen >/tmp/acs-imc-create.json 2>&1; then
      echo "image cache creation submitted: $CACHE_NAME"
    else
      echo "WARN: image cache creation failed (non-fatal)"
      cat /tmp/acs-imc-create.json 2>/dev/null || true
    fi
  fi
  # 只清理本前缀且不是最近 3 个的缓存（免费额度 20/地域，防堆积）
  aliyun acc list-image-caches --biz-region-id cn-shenzhen 2>/dev/null | node -e '
    let raw = ""; process.stdin.on("data", (c) => raw += c).on("end", () => {
      const caches = (JSON.parse(raw || "{}").ImageCaches || [])
        .filter((c) => (c.ImageCacheName || "").startsWith("agent-saas-acs-sandbox-"))
        .sort((a, b) => String(b.CreateTime).localeCompare(String(a.CreateTime)));
      for (const c of caches.slice(3)) console.log(c.ImageCacheId);
    });
  ' | while IFS= read -r cache_id; do
    [ -n "$cache_id" ] || continue
    if aliyun acc delete-image-cache --biz-region-id cn-shenzhen --image-cache-id "$cache_id" >/dev/null 2>&1; then
      echo "pruned old image cache $cache_id"
    else
      echo "WARN: failed to prune image cache $cache_id"
    fi
  done
  exit 0
)

rm -f "$RUNTIME_IDENTITY_BAK"
echo "ACS deploy OK: $IMAGE"
