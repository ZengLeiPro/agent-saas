#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${MANIFEST_PATH:?MANIFEST_PATH is required}"
: "${EXPECTED_MANIFEST_DIGEST:?EXPECTED_MANIFEST_DIGEST is required}"
: "${VERIFY_INSTALLED_SCRIPT:?VERIFY_INSTALLED_SCRIPT is required}"

release_id="$(node -p "require(process.env.MANIFEST_PATH).releaseId")"
release_sha="$(node -p "require(process.env.MANIFEST_PATH).releaseSha")"
manifest_digest="$(node -p "require(process.env.MANIFEST_PATH).digest")"
printf '%s' "$release_id" | grep -Eq '^rc-[0-9]{8}-[0-9]{2,}$'
printf '%s' "$release_sha" | grep -Eq '^[a-f0-9]{40}$'
test "$manifest_digest" = "$EXPECTED_MANIFEST_DIGEST"

root=/opt/agent-saas-staging
state_root=/var/lib/agent-saas-staging
target="$root/releases/$release_id"
current="$root/current"
lock=/run/lock/agent-saas-staging/deploy.lock
mkdir -p "$(dirname "$lock")" "$root/releases" "$state_root/releases"
exec 9>"$lock"
flock -n 9 || { echo 'Another Staging deployment is active' >&2; exit 1; }

previous=''
had_previous_release=false
if [ -L "$current" ]; then
  previous="$(readlink -f -- "$current")" || {
    echo 'Staging current symlink cannot be resolved' >&2
    exit 1
  }
  case "$previous" in
    "$root/releases/"*) ;;
    *) echo 'Staging current symlink is outside the immutable release root' >&2; exit 1 ;;
  esac
  test -d "$previous" || { echo 'Staging current release target is missing' >&2; exit 1; }
  had_previous_release=true
elif [ -e "$current" ]; then
  echo 'Staging current path exists but is not a symlink' >&2
  exit 1
fi
candidate="$target.candidate-$GITHUB_RUN_ID"
rollback_root="$state_root/rollback-$release_id-$GITHUB_RUN_ID"
mkdir -p "$rollback_root"
server_env=/etc/agent-saas-staging/server.env
acs_env=/etc/agent-saas-staging/acs-orchestrator.env
acs_identity=/etc/agent-saas-staging/acs-release-identity.json
cp -a "$server_env" "$rollback_root/server.env"
cp -a "$acs_env" "$rollback_root/acs-orchestrator.env"
had_previous_identity=false
if [ -e "$acs_identity" ]; then
  had_previous_identity=true
  cp -a "$acs_identity" "$rollback_root/acs-release-identity.json"
fi
deployment_committed=false
rollback() {
  cp -a "$rollback_root/server.env" "$server_env"
  cp -a "$rollback_root/acs-orchestrator.env" "$acs_env"
  if [ "$had_previous_identity" = true ]; then
    cp -a "$rollback_root/acs-release-identity.json" "$acs_identity"
  else
    rm -f "$acs_identity"
  fi
  if [ "$had_previous_release" = true ]; then
    ln -sfn "$previous" "$current"
    systemctl restart agent-saas-acs-orchestrator-staging.service || true
    systemctl restart agent-saas-server-staging.service || true
    systemctl restart agent-saas-runtime-worker-staging.service || true
  else
    rm -f "$current"
    systemctl stop agent-saas-runtime-worker-staging.service || true
    systemctl stop agent-saas-server-staging.service || true
    systemctl stop agent-saas-acs-orchestrator-staging.service || true
    systemctl reset-failed agent-saas-runtime-worker-staging.service \
      agent-saas-server-staging.service agent-saas-acs-orchestrator-staging.service || true
  fi
}
finish() {
  status=$?
  trap - EXIT
  rm -rf "$candidate"
  if [ "$deployment_committed" = false ]; then rollback; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

node - "$acs_env" <<'NODE'
const fs = require('node:fs');
const envPath = process.argv[2];
const values = Object.fromEntries(
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).trim()];
    }),
);
const mode = values.ACS_SNAT_MODE || 'disabled';
if (mode !== 'disabled') {
  for (const key of ['ACS_SNAT_REGION_ID', 'ACS_SNAT_TABLE_ID', 'ACS_SNAT_IP']) {
    if (!values[key]) throw new Error(`Staging ACS configuration is missing ${key}`);
  }
}
if (mode === 'shared-cidr' && !(values.ACS_SNAT_SHARED_CIDRS || values.ACS_SNAT_SHARED_CIDR)) {
  throw new Error('Staging ACS shared-cidr mode has no configured CIDR');
}
NODE
snat_mode="$(awk -F= '$1 == "ACS_SNAT_MODE" { print substr($0, index($0, "=") + 1) }' "$acs_env")"
if [ -n "$snat_mode" ] && [ "$snat_mode" != disabled ]; then
  aliyun_cli="$(command -v aliyun)" || {
    echo 'Staging ACS SNAT is enabled but the aliyun CLI runtime dependency is missing' >&2
    exit 1
  }
  "$aliyun_cli" version >/dev/null
  snat_region="$(awk -F= '$1 == "ACS_SNAT_REGION_ID" { print substr($0, index($0, "=") + 1) }' "$acs_env")"
  snat_table="$(awk -F= '$1 == "ACS_SNAT_TABLE_ID" { print substr($0, index($0, "=") + 1) }' "$acs_env")"
  runuser -u agent-saas-staging -- env HOME=/var/lib/agent-saas-staging/acs \
    "$aliyun_cli" vpc DescribeSnatTableEntries \
    --RegionId "$snat_region" --SnatTableId "$snat_table" --PageSize 1 --PageNumber 1 \
    >/dev/null || {
      echo 'Staging ACS SNAT runtime identity cannot read the configured SNAT table' >&2
      exit 1
    }
fi

if [ -d "$target" ]; then
  node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component server
  node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component acs
  existing="$(node -p "require('$target/manifest.json').digest")"
  test "$existing" = "$manifest_digest" || { echo 'Immutable Staging release conflicts' >&2; exit 1; }
else
  rm -rf "$candidate"
  mkdir -p "$candidate/web" "$candidate/.release"
  install -m 0444 "$RELEASE_DIR/server-bundle.tgz" "$candidate/.release/server-bundle.tgz"
  install -m 0444 "$RELEASE_DIR/acs-orchestrator.tgz" "$candidate/.release/acs-orchestrator.tgz"
  tar -tzf "$candidate/.release/server-bundle.tgz" \
    | awk '$0 == "./server/dist/index.js" || $0 == "server/dist/index.js" { found = 1 } END { exit !found }' \
    || { echo 'Staging server bundle must contain server/dist/index.js' >&2; exit 1; }
  tar -tzf "$candidate/.release/acs-orchestrator.tgz" \
    | awk '$0 == "./acs-orchestrator/dist/index.js" || $0 == "acs-orchestrator/dist/index.js" { found = 1 } END { exit !found }' \
    || { echo 'Staging ACS bundle must contain acs-orchestrator/dist/index.js' >&2; exit 1; }
  tar -xzf "$candidate/.release/server-bundle.tgz" -C "$candidate"
  tar -xzf "$RELEASE_DIR/web-assets.tgz" -C "$candidate/web"
  tar -xzf "$candidate/.release/acs-orchestrator.tgz" -C "$candidate"
  test -s "$candidate/server/dist/index.js"
  test -s "$candidate/acs-orchestrator/dist/index.js"
  install -m 0444 "$MANIFEST_PATH" "$candidate/manifest.json"
  node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component server
  node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component acs
  mv "$candidate" "$target"
fi

runuser -u agent-saas-staging -- env \
  STAGING_CONFIG_PATH=/etc/agent-saas-staging/config.json STAGING_RELEASE_ROOT="$target" \
  /usr/bin/node - <<'NODE'
const fs = require('node:fs');
const { Client } = require(`${process.env.STAGING_RELEASE_ROOT}/server/node_modules/pg`);
const config = JSON.parse(fs.readFileSync(process.env.STAGING_CONFIG_PATH, 'utf8'));
const client = new Client({
  connectionString: config.runtimeEventStore.connectionString,
  connectionTimeoutMillis: 10_000,
});
(async () => {
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS database, current_user AS username');
    const row = result.rows[0];
    if (row.database !== 'agent_saas_staging' || row.username !== 'agent_saas_staging') {
      throw new Error('Staging database identity does not match the isolated database and role');
    }
  } finally {
    await client.end().catch(() => {});
  }
})().catch((error) => {
  console.error(`Staging database runtime preflight failed: ${error.message}`);
  process.exit(1);
});
NODE

node - /etc/agent-saas-staging/config.json <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const failures = [];
if (config.tts) failures.push('tts must be absent');
if (config.stt?.enabled !== false) failures.push('stt.enabled must be false');
for (const key of ['apiKey', 'apiKeyRef', 'ossAccessKeyId', 'ossAccessKeyIdRef', 'ossAccessKeySecret', 'ossAccessKeySecretRef']) {
  if (config.stt?.[key]) failures.push(`stt.${key} must be absent`);
}
if (config.memory?.enabled !== false) failures.push('memory.enabled must be false');
if (config.memory?.index) failures.push('memory.index must be absent');
for (const key of ['injectContext', 'maintenance', 'polling', 'consolidation']) {
  if (config.memory?.[key]?.enabled !== false) failures.push(`memory.${key}.enabled must be false`);
}
if (Object.keys(config.dispatch?.env ?? {}).length > 0) failures.push('dispatch.env must be empty');
if (config.systemMonitor?.enabled !== false) failures.push('systemMonitor.enabled must be false');
if (config.runtimeEventRetention?.enabled !== false) failures.push('runtimeEventRetention.enabled must be false');
if (config.integrationV3ControlPlane) failures.push('integrationV3ControlPlane must be absent');
if (failures.length > 0) {
  throw new Error(`Staging runtime profile preflight failed:\n- ${failures.join('\n- ')}`);
}
NODE

ln -sfn "$target" "$current"
node - "$MANIFEST_PATH" "$server_env" <<'NODE'
const fs = require('node:fs');
const [manifestPath, envPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const desired = {
  AGENT_SAAS_RELEASE_ID: manifest.releaseId,
  AGENT_SAAS_RELEASE_SHA: manifest.releaseSha,
  AGENT_SAAS_SERVER_DIGEST: manifest.components.api.artifactDigest,
  AGENT_SAAS_WEB_DIGEST: manifest.components.web.artifactDigest,
  AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST: manifest.components.acs.orchestratorArtifactDigest,
  AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST: manifest.components.acs.sandboxImageDigest,
};
const keys = new Set(Object.keys(desired));
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter((line) => line && !keys.has(line.split('=', 1)[0]));
for (const [key, value] of Object.entries(desired)) lines.push(`${key}=${value}`);
fs.writeFileSync(`${envPath}.candidate`, `${lines.join('\n')}\n`, { mode: 0o600 });
fs.renameSync(`${envPath}.candidate`, envPath);
NODE
chown root:agent-saas-staging "$server_env"
chmod 0640 "$server_env"
node - "$MANIFEST_PATH" "$acs_env" <<'NODE'
const fs = require('node:fs');
const [manifestPath, envPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const reference = `${manifest.artifacts.acsImage.repository}@${manifest.artifacts.acsImage.digest}`;
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter(Boolean);
const output = lines.filter((line) => !line.startsWith('ACS_SANDBOX_IMAGE='));
output.push(`ACS_SANDBOX_IMAGE=${reference}`);
fs.writeFileSync(`${envPath}.candidate`, `${output.join('\n')}\n`, { mode: 0o600 });
fs.renameSync(`${envPath}.candidate`, envPath);
NODE
chown root:agent-saas-staging "$acs_env"
chmod 0640 "$acs_env"
node - "$MANIFEST_PATH" "$acs_env" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [manifestPath, envPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const configFingerprint = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(envPath)).digest('hex')}`;
const identity = {
  schemaVersion: 1,
  environment: 'staging',
  releaseId: manifest.releaseId,
  sourceSha: manifest.components.acs.sourceSha,
  orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
  sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
  namespace: 'agent-saas-staging',
  configFingerprint,
};
fs.writeFileSync('/etc/agent-saas-staging/acs-release-identity.json.candidate', `${JSON.stringify(identity)}\n`, { mode: 0o444 });
fs.renameSync('/etc/agent-saas-staging/acs-release-identity.json.candidate', '/etc/agent-saas-staging/acs-release-identity.json');
NODE
if systemctl is-active --quiet agent-saas-acs-orchestrator-staging.service; then
  main_pid="$(systemctl show agent-saas-acs-orchestrator-staging.service --property MainPID --value)"
  test "$main_pid" -gt 0
  kill -USR2 "$main_pid"
  for attempt in $(seq 1 330); do
    systemctl is-active --quiet agent-saas-acs-orchestrator-staging.service || break
    sleep 2
  done
  systemctl is-active --quiet agent-saas-acs-orchestrator-staging.service && {
    echo 'Staging ACS drain deadline exceeded' >&2
    exit 1
  }
fi
systemctl restart agent-saas-acs-orchestrator-staging.service
for attempt in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3410/health >"$state_root/acs-health.json" && break
  sleep 2
done
test -s "$state_root/acs-health.json"
systemctl restart agent-saas-server-staging.service
systemctl restart agent-saas-runtime-worker-staging.service
for attempt in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3210/api/healthz/ready >"$state_root/api-ready.json" && break
  sleep 2
done
test -s "$state_root/api-ready.json"

node - "$MANIFEST_PATH" "$state_root/api-ready.json" "$state_root/acs-health.json" <<'NODE'
const fs = require('node:fs');
const [manifestPath, apiPath, acsPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
const acs = JSON.parse(fs.readFileSync(acsPath, 'utf8'));
const release = api.release ?? {};
if (release.releaseId !== manifest.releaseId || release.releaseSha !== manifest.releaseSha)
  throw new Error('Staging API readiness identity does not match Manifest');
if (acs.environment !== 'staging' || acs.releaseId !== manifest.releaseId || acs.sourceSha !== manifest.components.acs.sourceSha)
  throw new Error('Staging ACS identity does not match Manifest');
if (acs.orchestratorArtifactDigest !== manifest.components.acs.orchestratorArtifactDigest || acs.sandboxImageDigest !== manifest.components.acs.sandboxImageDigest || acs.namespace !== 'agent-saas-staging')
  throw new Error('Staging ACS digest or namespace does not match Manifest');
NODE

install -m 0444 "$MANIFEST_PATH" "$state_root/releases/$release_id.manifest.json"
deployment_committed=true
trap - HUP INT TERM
echo "$release_id deployed to isolated Staging runtime"
