#!/usr/bin/env bash
set -euo pipefail

: "${PHASE:?PHASE must be acs or app}"
: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${MANIFEST_PATH:?MANIFEST_PATH is required}"
: "${EXPECTED_MANIFEST_DIGEST:?EXPECTED_MANIFEST_DIGEST is required}"
: "${VERIFY_INSTALLED_SCRIPT:?VERIFY_INSTALLED_SCRIPT is required}"
case "$PHASE" in
  acs) : "${ACS_UNIT_TEMPLATE:?ACS_UNIT_TEMPLATE is required}" ;;
  app)
    : "${SERVER_UNIT_TEMPLATE:?SERVER_UNIT_TEMPLATE is required}"
    : "${WORKER_UNIT_TEMPLATE:?WORKER_UNIT_TEMPLATE is required}"
    ;;
  *) echo 'PHASE must be acs or app' >&2; exit 1 ;;
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
  local digest target previous main_pid rollback_root unit_path had_previous_identity candidate
  local acs_committed=false
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
  rollback_root="/tmp/agent-saas-acs-rollback-$release_id-$GITHUB_RUN_ID"
  rm -rf "$rollback_root"
  mkdir -p "$rollback_root"
  unit_path=/etc/systemd/system/agent-saas-acs-orchestrator.service
  cp -a /etc/agent-saas/acs-orchestrator.env "$rollback_root/acs-orchestrator.env"
  cp -a "$unit_path" "$rollback_root/acs-orchestrator.service"
  had_previous_identity=false
  if [ -e /etc/agent-saas/acs-release-identity.json ]; then
    had_previous_identity=true
    cp -a /etc/agent-saas/acs-release-identity.json "$rollback_root/acs-release-identity.json"
  fi
  cleanup_acs_failure() {
    if [ "$acs_committed" = false ]; then
      if [ -n "$previous" ]; then
        ln -sfn "$previous" /opt/agent-saas/acs-current
      else
        rm -f /opt/agent-saas/acs-current
      fi
      cp -a "$rollback_root/acs-orchestrator.env" /etc/agent-saas/acs-orchestrator.env
      if [ "$had_previous_identity" = true ]; then
        cp -a "$rollback_root/acs-release-identity.json" /etc/agent-saas/acs-release-identity.json
      else
        rm -f /etc/agent-saas/acs-release-identity.json
      fi
      cp -a "$rollback_root/acs-orchestrator.service" "$unit_path"
      systemctl daemon-reload
      systemctl restart agent-saas-acs-orchestrator.service || true
    fi
    rm -rf "$rollback_root"
  }
  trap cleanup_acs_failure EXIT
  trap 'exit 130' HUP INT TERM
  install -m 0644 "$ACS_UNIT_TEMPLATE" "$unit_path"
  systemctl daemon-reload
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
  acs_committed=true
  trap - EXIT HUP INT TERM
  rm -rf "$rollback_root"
}

other_color() { [ "$1" = blue ] && echo green || echo blue; }
port_for_color() { [ "$1" = blue ] && echo 3200 || echo 3201; }

deploy_app() {
  local artifact_digest target api_active api_idle api_idle_port worker_active worker_idle old_api_pid old_worker_pid
  local api_idle_previous worker_idle_previous api_env worker_env rollback_root
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
  cleanup_app_failure() {
    if [ "$app_committed" = false ]; then
      systemctl disable --now "agent-saas-runtime-worker@$worker_idle" >/dev/null 2>&1 || true
      systemctl disable --now "agent-saas-server@$api_idle" >/dev/null 2>&1 || true
      if [ -n "$worker_idle_previous" ]; then
        ln -sfn "$worker_idle_previous" "/opt/agent-saas-app/worker/$worker_idle"
      else
        rm -f "/opt/agent-saas-app/worker/$worker_idle"
      fi
      if [ -n "$api_idle_previous" ]; then
        ln -sfn "$api_idle_previous" "/opt/agent-saas-app/color/$api_idle"
      else
        rm -f "/opt/agent-saas-app/color/$api_idle"
      fi
      if [ "$had_api_env" = true ]; then
        cp -a "$rollback_root/api.release.env" "$api_env"
      else
        rm -f "$api_env"
      fi
      if [ "$had_worker_env" = true ]; then
        cp -a "$rollback_root/worker.release.env" "$worker_env"
      else
        rm -f "$worker_env"
      fi
      printf '%s\n' "$api_active" >/etc/agent-saas/active-color
      printf '%s\n' "$worker_active" >/etc/agent-saas/runtime-worker-active-color
      if [ "$nginx_changed" = true ] && [ -s "$rollback_root/nginx-upstream.conf" ]; then
        cp -a "$rollback_root/nginx-upstream.conf" /etc/nginx/conf.d/agent-saas-upstream.conf
        nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
      fi
      cp -a "$rollback_root/server@.service" "$server_unit"
      cp -a "$rollback_root/runtime-worker@.service" "$worker_unit"
      systemctl daemon-reload
      systemctl enable --now "agent-saas-server@$api_active" >/dev/null 2>&1 || true
      systemctl enable --now "agent-saas-runtime-worker@$worker_active" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_app_failure EXIT
  trap 'exit 130' HUP INT TERM
  install -m 0644 "$SERVER_UNIT_TEMPLATE" "$server_unit"
  install -m 0644 "$WORKER_UNIT_TEMPLATE" "$worker_unit"
  systemctl daemon-reload
  ln -sfn "$target" "/opt/agent-saas-app/color/$api_idle"
  ln -sfn "$target" "/opt/agent-saas-app/worker/$worker_idle"
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

  cp -a /etc/nginx/conf.d/agent-saas-upstream.conf "$rollback_root/nginx-upstream.conf"
  nginx_changed=true
  cat > /etc/nginx/conf.d/agent-saas-upstream.conf <<EOF
# active=$api_idle release=$release_id
upstream agent_saas_backend {
    server 127.0.0.1:$api_idle_port;
    server 127.0.0.1:$(port_for_color "$api_active") backup;
}
EOF
  nginx -t || { cp -a "$rollback_root/nginx-upstream.conf" /etc/nginx/conf.d/agent-saas-upstream.conf; exit 1; }
  systemctl reload nginx
  curl -kfsS -H 'Host: api.agent.kaiyan.net' https://127.0.0.1/api/healthz/ready >/dev/null
  echo "$api_idle" >/etc/agent-saas/active-color

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
  echo "$worker_idle" >/etc/agent-saas/runtime-worker-active-color

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

if [ "$PHASE" = acs ]; then deploy_acs; else deploy_app; fi
echo "$PHASE phase completed for $release_id"
