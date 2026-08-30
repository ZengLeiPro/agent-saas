#!/usr/bin/env bash
set -euo pipefail

rollback_app_release() {
  # 每个恢复动作独立累计状态，避免首个故障阻断旧实例复活。
  local rollback_status=0
  set +e

  systemctl disable --now "agent-saas-runtime-worker@$worker_idle" >/dev/null 2>&1 || rollback_status=1
  systemctl disable --now "agent-saas-server@$api_idle" >/dev/null 2>&1 || rollback_status=1

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

  printf '%s\n' "$api_active" >"$ACTIVE_COLOR_PATH" || rollback_status=1
  printf '%s\n' "$worker_active" >"$WORKER_ACTIVE_COLOR_PATH" || rollback_status=1

  if [ "$nginx_changed" = true ] && [ -s "$rollback_root/nginx-upstream.conf" ]; then
    cp -a "$rollback_root/nginx-upstream.conf" "$NGINX_UPSTREAM_PATH" || rollback_status=1
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx || rollback_status=1
    else
      rollback_status=1
    fi
  fi

  cp -a "$rollback_root/server@.service" "$server_unit" || rollback_status=1
  cp -a "$rollback_root/runtime-worker@.service" "$worker_unit" || rollback_status=1
  systemctl daemon-reload || rollback_status=1
  rm -f "/run/agent-saas-server-$api_active.draining" || rollback_status=1
  rm -f "/run/agent-saas-runtime-worker-$worker_active.draining" || rollback_status=1
  systemctl enable "agent-saas-server@$api_active" >/dev/null 2>&1 || rollback_status=1
  systemctl enable "agent-saas-runtime-worker@$worker_active" >/dev/null 2>&1 || rollback_status=1
  systemctl restart "agent-saas-server@$api_active" >/dev/null 2>&1 || rollback_status=1
  systemctl restart "agent-saas-runtime-worker@$worker_active" >/dev/null 2>&1 || rollback_status=1

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
  if [ "$app_committed" = false ]; then
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
  set +e

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
  systemctl restart "$ACS_SERVICE_NAME" || rollback_status=1

  if [ "$rollback_status" -ne 0 ]; then
    echo 'ACS rollback completed with one or more recovery failures' >&2
    return 70
  fi
  return 0
}

cleanup_acs_failure() {
  local deploy_status=$?
  local rollback_status=0
  set +e
  if [ "$acs_committed" = false ]; then
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
    rollback_app_release
    exit $?
    ;;
  --test-app-cleanup-trap)
    app_committed=false
    trap cleanup_app_failure EXIT
    false
    ;;
  --test-acs-rollback)
    rollback_acs_release
    exit $?
    ;;
  --test-acs-cleanup-trap)
    acs_committed=false
    trap cleanup_acs_failure EXIT
    false
    ;;
esac

: "${PHASE:?PHASE must be acs, app or web}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${MANIFEST_PATH:?MANIFEST_PATH is required}"
: "${EXPECTED_MANIFEST_DIGEST:?EXPECTED_MANIFEST_DIGEST is required}"
: "${VERIFY_INSTALLED_SCRIPT:?VERIFY_INSTALLED_SCRIPT is required}"
: "${READ_LIVE_COMPONENTS_SCRIPT:?READ_LIVE_COMPONENTS_SCRIPT is required}"
: "${VERIFY_PROMOTION_PHASE_SCRIPT:?VERIFY_PROMOTION_PHASE_SCRIPT is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
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

# Promotion 的 GitHub gate 与分阶段写入之间仍可能有手工/兼容入口；每个阶段必须在
# 同一主机锁内从 observer、systemd 与已安装密封字节重建 live matrix，再只接受该阶段
# 应看到的“冻结基线 + 已提交 phase”精确前置矩阵；重试时也只接受当前 phase 已精确提交的目标矩阵。
# 不能先要求 live 全量等于旧 trusted identity，
# 否则首个 phase 成功后会把后续 phase 拒绝在事务中间。
production_now="/tmp/agent-saas-production-before-${PHASE}-${GITHUB_RUN_ID}.json"
rm -f "$production_now"
node "$READ_LIVE_COMPONENTS_SCRIPT" --output "$production_now" >/dev/null
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
  local manifest="$1" target="$2" role="$3"
  node - "$manifest" "$target" "$role" <<'NODE'
const fs = require('node:fs');
const [manifestPath, target, role] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const component = role === 'web' ? manifest.components.web : manifest.components.api;
const desired = {
  AGENT_SAAS_RELEASE_ID: manifest.releaseId,
  AGENT_SAAS_RELEASE_SHA: component.sourceSha,
  AGENT_SAAS_SERVER_DIGEST: manifest.components.api.artifactDigest,
  AGENT_SAAS_WEB_DIGEST: manifest.components.web.artifactDigest,
  AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST: manifest.components.acs.orchestratorArtifactDigest,
  AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST: manifest.components.acs.sandboxImageDigest,
};
fs.writeFileSync(`${target}.candidate`, `${Object.entries(desired).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
fs.renameSync(`${target}.candidate`, target);
NODE
}

deploy_acs() {
  local digest target previous main_pid
  local rollback_root unit_path had_previous_identity candidate
  local had_previous_unit=false
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
  rollback_root="/tmp/agent-saas-acs-rollback-$release_id-$GITHUB_RUN_ID"
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
  had_previous_identity=false
  if [ -e "$ACS_IDENTITY_PATH" ]; then
    had_previous_identity=true
    cp -a "$ACS_IDENTITY_PATH" "$rollback_root/acs-release-identity.json"
  fi
  trap cleanup_acs_failure EXIT
  trap 'exit 130' HUP INT TERM
  install -m 0644 "$ACS_UNIT_TEMPLATE" "$unit_path"
  systemctl daemon-reload
  node - "$MANIFEST_PATH" "$ACS_ENV_PATH" <<'NODE'
const fs = require('node:fs');
const [manifestPath, envPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const image = `${manifest.artifacts.acsImage.repository}@${manifest.artifacts.acsImage.digest}`;
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('ACS_SANDBOX_IMAGE='));
lines.push(`ACS_SANDBOX_IMAGE=${image}`);
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
  acs_committed=true
  trap - EXIT HUP INT TERM
  rm -rf "$rollback_root"
}

other_color() { [ "$1" = blue ] && echo green || echo blue; }
port_for_color() { [ "$1" = blue ] && echo 3200 || echo 3201; }

deploy_app() {
  local artifact_digest target api_active api_idle api_idle_port worker_active worker_idle old_api_pid old_worker_pid
  local api_idle_previous worker_idle_previous api_env worker_env rollback_root server_unit worker_unit
  local had_api_env=false had_worker_env=false nginx_changed=false app_committed=false
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
  api_active="$(tr -d '[:space:]' <"$ACTIVE_COLOR_PATH")"
  worker_active="$(tr -d '[:space:]' <"$WORKER_ACTIVE_COLOR_PATH")"
  case "$api_active:$worker_active" in blue:blue|blue:green|green:blue|green:green) ;; *) exit 1 ;; esac
  api_idle="$(other_color "$api_active")"
  worker_idle="$(other_color "$worker_active")"
  api_idle_port="$(port_for_color "$api_idle")"
  api_idle_previous="$(readlink -f "$APP_COLOR_ROOT/$api_idle" 2>/dev/null || true)"
  worker_idle_previous="$(readlink -f "$APP_WORKER_ROOT/$worker_idle" 2>/dev/null || true)"
  api_env="/etc/agent-saas/server-$api_idle.release.env"
  worker_env="/etc/agent-saas/runtime-worker-$worker_idle.release.env"
  rollback_root="/tmp/agent-saas-app-rollback-$release_id-$GITHUB_RUN_ID"
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
  install -m 0644 "$SERVER_UNIT_TEMPLATE" "$server_unit"
  install -m 0644 "$WORKER_UNIT_TEMPLATE" "$worker_unit"
  systemctl daemon-reload
  ln -sfn "$target" "$APP_COLOR_ROOT/$api_idle"
  ln -sfn "$target" "$APP_WORKER_ROOT/$worker_idle"
  upsert_env "$MANIFEST_PATH" "$api_env" api
  upsert_env "$MANIFEST_PATH" "$worker_env" worker

  rm -f "/run/agent-saas-server-$api_idle.pid" "/run/agent-saas-server-$api_idle.draining"
  systemctl enable --now "agent-saas-server@$api_idle"
  for _ in $(seq 1 180); do
    if curl -fsS "http://127.0.0.1:$api_idle_port/api/healthz/ready" >/tmp/api-candidate-ready.json; then break; fi
    sleep 1
  done
  node - "$MANIFEST_PATH" /tmp/api-candidate-ready.json <<'NODE'
const fs = require('node:fs');
const [manifestPath, readyPath] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(manifestPath));
const r = JSON.parse(fs.readFileSync(readyPath)).release;
if (r.environment !== 'production' || r.releaseId !== m.releaseId || r.releaseSha !== m.components.api.sourceSha || r.serverDigest !== m.components.api.artifactDigest) process.exit(1);
NODE

  cp -a "$NGINX_UPSTREAM_PATH" "$rollback_root/nginx-upstream.conf"
  nginx_changed=true
  cat > "$NGINX_UPSTREAM_PATH" <<EOF
# active=$api_idle release=$release_id
upstream agent_saas_backend {
    server 127.0.0.1:$api_idle_port;
    server 127.0.0.1:$(port_for_color "$api_active") backup;
}
EOF
  nginx -t || { cp -a "$rollback_root/nginx-upstream.conf" "$NGINX_UPSTREAM_PATH"; exit 1; }
  systemctl reload nginx
  curl -kfsS -H 'Host: api.agent.kaiyan.net' https://127.0.0.1/api/healthz/ready >/dev/null
  echo "$api_idle" >"$ACTIVE_COLOR_PATH"

  rm -f "/run/agent-saas-runtime-worker-$worker_idle.pid" "/run/agent-saas-runtime-worker-$worker_idle.ready" "/run/agent-saas-runtime-worker-$worker_idle.draining"
  systemctl enable --now "agent-saas-runtime-worker@$worker_idle"
  for _ in $(seq 1 180); do
    pid="$(cat "/run/agent-saas-runtime-worker-$worker_idle.pid" 2>/dev/null || true)"
    ready="$(cat "/run/agent-saas-runtime-worker-$worker_idle.ready" 2>/dev/null || true)"
    [ -n "$pid" ] && [ "$pid" = "$ready" ] && kill -0 "$pid" 2>/dev/null && break
    sleep 1
  done
  test -n "${pid:-}" && test "$pid" = "${ready:-}" && kill -0 "$pid"
  systemctl show "agent-saas-runtime-worker@$worker_idle" --property Environment --value \
    | tr ' ' '\n' | grep -Fx 'AGENT_SAAS_ENVIRONMENT=production' >/dev/null
  echo "$worker_idle" >"$WORKER_ACTIVE_COLOR_PATH"

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
