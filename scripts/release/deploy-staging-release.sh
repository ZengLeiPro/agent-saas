#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${UNIT_DIR:?UNIT_DIR is required}"
: "${MANIFEST_PATH:?MANIFEST_PATH is required}"
: "${EXPECTED_MANIFEST_DIGEST:?EXPECTED_MANIFEST_DIGEST is required}"
: "${STAGING_RUNTIME_ASSETS_PATH:?STAGING_RUNTIME_ASSETS_PATH is required}"
: "${STAGING_RUNTIME_ASSETS_DIGEST:?STAGING_RUNTIME_ASSETS_DIGEST is required}"
: "${VERIFY_INSTALLED_SCRIPT:?VERIFY_INSTALLED_SCRIPT is required}"

release_id="$(node -p "require(process.env.MANIFEST_PATH).releaseId")"
release_sha="$(node -p "require(process.env.MANIFEST_PATH).releaseSha")"
manifest_digest="$(node -p "require(process.env.MANIFEST_PATH).digest")"
printf '%s' "$release_id" | grep -Eq '^rc-[0-9]{8}-[0-9]{2,}$'
printf '%s' "$release_sha" | grep -Eq '^[a-f0-9]{40}$'
test "$manifest_digest" = "$EXPECTED_MANIFEST_DIGEST"
printf '%s' "$STAGING_RUNTIME_ASSETS_DIGEST" | grep -Eq '^sha256:[a-f0-9]{64}$'
test "sha256:$(sha256sum "$STAGING_RUNTIME_ASSETS_PATH" | cut -d' ' -f1)" = \
  "$STAGING_RUNTIME_ASSETS_DIGEST"

root=/opt/agent-saas-staging
state_root=/var/lib/agent-saas-staging
config_root="$state_root/config"
server_config="$config_root/config.json"
legacy_server_config=/etc/agent-saas-staging/config.json
target="$root/releases/$release_id"
current="$root/current"
lock=/run/lock/agent-saas-staging/deploy.lock
mkdir -p "$(dirname "$lock")" "$root/releases" "$state_root/releases"
exec 9>"$lock"
flock -n 9 || { echo 'Another Staging deployment is active' >&2; exit 1; }

install -d -o agent-saas-staging -g agent-saas-staging -m 0700 "$config_root"
if [ ! -e "$server_config" ]; then
  test -f "$legacy_server_config" || {
    echo 'Staging shared config is missing from both mutable and legacy paths' >&2
    exit 1
  }
  config_candidate="$config_root/.config.json.migrate-$GITHUB_RUN_ID"
  install -o agent-saas-staging -g agent-saas-staging -m 0600 \
    "$legacy_server_config" "$config_candidate"
  mv -f "$config_candidate" "$server_config"
fi
test -f "$server_config" && test ! -L "$server_config" || {
  echo 'Staging mutable config must be a regular non-symlink file' >&2
  exit 1
}
chown agent-saas-staging:agent-saas-staging "$server_config"
chmod 0600 "$server_config"

install_staging_unit() {
  source_path="$1"
  destination_path="$2"
  candidate_path="${destination_path}.candidate-${GITHUB_RUN_ID}"
  test -f "$source_path" || {
    echo "Missing Staging systemd unit template: $source_path" >&2
    exit 1
  }
  install -o root -g root -m 0644 "$source_path" "$candidate_path"
  mv -f "$candidate_path" "$destination_path"
}

verify_staging_unit_environment() {
  local api_environment="$1"
  local worker_environment="$2"
  local expected_config='AGENT_SAAS_CONFIG_PATH=/var/lib/agent-saas-staging/config/config.json'
  if ! printf '%s\n' "$worker_environment" \
    | grep -Fq 'AGENT_SAAS_READYFILE=/run/agent-saas-staging/runtime-worker.ready'; then
    echo 'Staging Runtime Worker unit does not publish the canonical readyfile' >&2
    return 1
  fi
  if ! printf '%s\n' "$api_environment" \
    | grep -Fq 'AGENT_SAAS_ACTIVE_RUNTIME_WORKER_READYFILE=/run/agent-saas-staging/runtime-worker.ready'; then
    echo 'Staging API unit does not observe the canonical Runtime Worker readyfile' >&2
    return 1
  fi
  for unit_environment in "$api_environment" "$worker_environment"; do
    if ! printf '%s\n' "$unit_environment" \
      | grep -Fq "$expected_config"; then
      echo 'Staging API and Runtime Worker must use the shared Staging config' >&2
      return 1
    fi
  done
}

runtime_dir=/mnt/agent-saas-staging/runtime/server
artifact_dir=/mnt/agent-saas-staging/runtime/artifacts
runuser -u agent-saas-staging -- sh -c \
  'umask 027; mkdir -p -- "$1" "$2"' sh "$runtime_dir" "$artifact_dir"
runtime_owner="$(stat -c '%u:%g' "$runtime_dir")"
artifact_owner="$(stat -c '%u:%g' "$artifact_dir")"
test "$artifact_owner" = "$runtime_owner" || {
  echo 'Staging Artifact directory owner does not match the persistent runtime owner' >&2
  exit 1
}
for directory in "$runtime_dir" "$artifact_dir"; do
  test ! -L "$directory" || {
    echo "Staging persistent directory must not be a symlink: $directory" >&2
    exit 1
  }
  for access in r w x; do
    runuser -u agent-saas-staging -- test "-$access" "$directory" || {
      echo "Staging persistent directory is not ${access}-accessible to agent-saas-staging: $directory" >&2
      exit 1
    }
  done
done
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
worker_unit_environment="$(systemctl show agent-saas-runtime-worker-staging.service --property Environment --value)"
api_unit_environment="$(systemctl show agent-saas-server-staging.service --property Environment --value)"
verify_staging_unit_environment "$api_unit_environment" "$worker_unit_environment"
candidate="$target.candidate-$GITHUB_RUN_ID"
rollback_root="$state_root/rollback-$release_id-$GITHUB_RUN_ID"
artifact_persistence_probe="$artifact_dir/.release-persistence-$release_id-$GITHUB_RUN_ID"
mkdir -p "$rollback_root"
server_env=/etc/agent-saas-staging/server.env
acs_env=/etc/agent-saas-staging/acs-orchestrator.env
acs_identity=/etc/agent-saas-staging/acs-release-identity.json
cp -a "$server_env" "$rollback_root/server.env"
cp -a "$server_config" "$rollback_root/config.json"
cp -a "$acs_env" "$rollback_root/acs-orchestrator.env"
had_previous_identity=false
if [ -e "$acs_identity" ]; then
  had_previous_identity=true
  cp -a "$acs_identity" "$rollback_root/acs-release-identity.json"
fi
server_unit=/etc/systemd/system/agent-saas-server-staging.service
worker_unit=/etc/systemd/system/agent-saas-runtime-worker-staging.service
acs_unit=/etc/systemd/system/agent-saas-acs-orchestrator-staging.service
cp -a "$server_unit" "$rollback_root/server.service"
cp -a "$worker_unit" "$rollback_root/runtime-worker.service"
cp -a "$acs_unit" "$rollback_root/acs-orchestrator.service"
units_updated=false
deployment_committed=false
rollback() {
  if [ "$units_updated" = true ]; then
    cp -a "$rollback_root/server.service" "$server_unit"
    cp -a "$rollback_root/runtime-worker.service" "$worker_unit"
    cp -a "$rollback_root/acs-orchestrator.service" "$acs_unit"
    systemctl daemon-reload
  fi
  cp -a "$rollback_root/server.env" "$server_env"
  cp -a "$rollback_root/config.json" "$server_config"
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
    rm -f /run/agent-saas-staging/server.pid \
      /run/agent-saas-staging/runtime-worker.pid \
      /run/agent-saas-staging/runtime-worker.ready \
      /run/agent-saas-staging/acs-orchestrator.pid
    systemctl reset-failed agent-saas-runtime-worker-staging.service \
      agent-saas-server-staging.service agent-saas-acs-orchestrator-staging.service || true
  fi
}
finish() {
  status=$?
  trap - EXIT
  rm -rf "$candidate"
  rm -f "$artifact_persistence_probe"
  if [ "$deployment_committed" = false ]; then rollback; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

units_updated=true
install_staging_unit \
  "$UNIT_DIR/agent-saas-server-staging.service.template" "$server_unit"
install_staging_unit \
  "$UNIT_DIR/agent-saas-runtime-worker-staging.service.template" "$worker_unit"
install_staging_unit \
  "$UNIT_DIR/agent-saas-acs-orchestrator-staging.service.template" "$acs_unit"
systemctl daemon-reload

for service_name in agent-saas-server-staging.service agent-saas-runtime-worker-staging.service; do
  test "$(systemctl show "$service_name" --property WorkingDirectory --value)" = \
    "$runtime_dir" || {
    echo "$service_name does not use the persistent Staging runtime directory" >&2
    exit 1
  }
  systemctl show "$service_name" --property ExecStart --value \
    | grep -Fq '/opt/agent-saas-staging/current/server/dist/index.js' || {
    echo "$service_name does not execute the immutable Staging server entrypoint" >&2
    exit 1
  }
done
worker_unit_environment="$(systemctl show agent-saas-runtime-worker-staging.service --property Environment --value)"
api_unit_environment="$(systemctl show agent-saas-server-staging.service --property Environment --value)"
verify_staging_unit_environment "$api_unit_environment" "$worker_unit_environment"

node - "$server_config" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const currentSecret = config.artifact?.signedUrlSecret;
const signedUrlSecret = typeof currentSecret === 'string'
  && currentSecret.length >= 16
  && currentSecret !== config.auth?.jwtSecret
  ? currentSecret
  : crypto.randomBytes(32).toString('hex');
config.artifact = {
  backend: 'local',
  rootDir: '/mnt/agent-saas-staging/runtime/artifacts',
  signedUrlSecret,
  readUrlTtlSeconds: 900,
  maxBlobBytes: 100 * 1024 * 1024,
  retentionDays: 90,
  gcIntervalMs: 24 * 60 * 60 * 1000,
};
fs.writeFileSync(`${configPath}.candidate`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(`${configPath}.candidate`, configPath);
NODE
chown agent-saas-staging:agent-saas-staging "$server_config"
chmod 0600 "$server_config"

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
  test "sha256:$(sha256sum "$target/.release/staging-runtime-assets.tgz" | cut -d' ' -f1)" = \
    "$STAGING_RUNTIME_ASSETS_DIGEST" || {
    echo 'Immutable Staging runtime assets conflict' >&2
    exit 1
  }
  existing="$(node -p "require('$target/manifest.json').digest")"
  test "$existing" = "$manifest_digest" || { echo 'Immutable Staging release conflicts' >&2; exit 1; }
else
  rm -rf "$candidate"
  mkdir -p "$candidate/web" "$candidate/.release"
  install -m 0444 "$RELEASE_DIR/server-bundle.tgz" "$candidate/.release/server-bundle.tgz"
  install -m 0444 "$RELEASE_DIR/acs-orchestrator.tgz" "$candidate/.release/acs-orchestrator.tgz"
  install -m 0444 "$STAGING_RUNTIME_ASSETS_PATH" \
    "$candidate/.release/staging-runtime-assets.tgz"
  tar -tzf "$candidate/.release/server-bundle.tgz" \
    | awk '$0 == "./server/dist/index.js" || $0 == "server/dist/index.js" { found = 1 } END { exit !found }' \
    || { echo 'Staging server bundle must contain server/dist/index.js' >&2; exit 1; }
  for required_asset in \
    .ky-agent/skills-pool/_manifest.json \
    prompts/static.md \
    PERSONA.template.md; do
    tar -tzf "$candidate/.release/staging-runtime-assets.tgz" \
      | awk -v expected="$required_asset" '$0 == expected || $0 == "./" expected { found = 1 } END { exit !found }' \
      || { echo "Staging runtime assets are missing $required_asset" >&2; exit 1; }
  done
  tar -tzf "$candidate/.release/acs-orchestrator.tgz" \
    | awk '$0 == "./acs-orchestrator/dist/index.js" || $0 == "acs-orchestrator/dist/index.js" { found = 1 } END { exit !found }' \
    || { echo 'Staging ACS bundle must contain acs-orchestrator/dist/index.js' >&2; exit 1; }
  tar -xzf "$candidate/.release/server-bundle.tgz" -C "$candidate"
  tar -xzf "$RELEASE_DIR/web-assets.tgz" -C "$candidate/web"
  tar -xzf "$candidate/.release/acs-orchestrator.tgz" -C "$candidate"
  mkdir -p "$candidate/server/workspace-shared"
  tar -xzf "$candidate/.release/staging-runtime-assets.tgz" \
    -C "$candidate/server/workspace-shared"
  test -s "$candidate/server/dist/index.js"
  test -s "$candidate/acs-orchestrator/dist/index.js"
  install -m 0444 "$MANIFEST_PATH" "$candidate/manifest.json"
  node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component server
  node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component acs
  mv "$candidate" "$target"
fi

for required_directory in \
  .ky-agent/scripts \
  .ky-agent/skills-pool \
  prompts; do
  installed_asset="$target/server/workspace-shared/$required_directory"
  if [ ! -d "$installed_asset" ] || [ -L "$installed_asset" ]; then
    echo "Staging runtime directory must be a real immutable directory: $installed_asset" >&2
    exit 1
  fi
done

runuser -u agent-saas-staging -- env \
  STAGING_CONFIG_PATH="$server_config" STAGING_RELEASE_ROOT="$target" \
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

node - "$server_config" <<'NODE'
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const failures = [];
if (!config.models?.groups?.length) failures.push('models must be explicitly configured');
for (const group of config.models?.groups ?? []) {
  if (group.apiKey) failures.push(`models.${group.id}.apiKey must use a Staging SecretRef`);
  const usesCodex = group.responses_transport === 'codex_subscription'
    || (group.models ?? []).some((model) => model.responses_transport === 'codex_subscription');
  if (!usesCodex && !group.apiKeyRef) failures.push(`models.${group.id}.apiKeyRef is required`);
}
if (config.codexSubscription?.enabled && !(config.codexSubscription.credentialRefs?.length || config.codexSubscription.credentialRef)) {
  failures.push('enabled Codex requires a Staging credentialRef');
}
if (config.stt?.enabled) {
  for (const key of ['apiKeyRef', 'ossAccessKeyIdRef', 'ossAccessKeySecretRef']) {
    if (!config.stt[key]) failures.push(`enabled stt.${key} is required`);
  }
  for (const key of ['apiKey', 'ossAccessKeyId', 'ossAccessKeySecret']) {
    if (config.stt[key]) failures.push(`stt.${key} must use a Staging SecretRef`);
  }
}
if (config.memory?.index?.embedding?.apiKey) failures.push('memory.index.embedding.apiKey must use a Staging SecretRef');
if (config.memory?.index?.enabled && !config.memory.index.embedding?.apiKeyRef) {
  failures.push('enabled memory index requires embedding.apiKeyRef');
}
if (config.cron?.enabled && config.cron.store !== '/mnt/agent-saas-staging/runtime/server/data/cron-jobs.json') {
  failures.push('enabled cron must use the Staging job store');
}
if (Object.keys(config.dispatch?.env ?? {}).length > 0) failures.push('dispatch.env must be empty');
const artifact = config.artifact ?? {};
if (artifact.backend !== 'local') failures.push('artifact.backend must be local');
if (artifact.rootDir !== '/mnt/agent-saas-staging/runtime/artifacts') failures.push('artifact.rootDir must use the shared NAS Artifact directory');
if (typeof artifact.signedUrlSecret !== 'string' || artifact.signedUrlSecret.length < 16) failures.push('artifact.signedUrlSecret must be persistent');
if (artifact.signedUrlSecret === config.auth?.jwtSecret) failures.push('artifact.signedUrlSecret must be independent from auth.jwtSecret');
if (artifact.readUrlTtlSeconds !== 900) failures.push('artifact.readUrlTtlSeconds must be 900');
if (artifact.maxBlobBytes !== 104857600) failures.push('artifact.maxBlobBytes must be 104857600');
if (artifact.retentionDays !== 90) failures.push('artifact.retentionDays must be 90');
if (artifact.gcIntervalMs !== 86400000) failures.push('artifact.gcIntervalMs must be 86400000');
for (const key of ['bucket', 'region', 'endpoint', 'accessKeyId', 'accessKeySecret']) {
  if (artifact[key]) failures.push(`artifact.${key} must be absent for local storage`);
}
if (failures.length > 0) {
  throw new Error(`Staging runtime profile preflight failed:\n- ${failures.join('\n- ')}`);
}
NODE

ln -sfn "$target" "$current"
node - "$server_config" <<'NODE'
const fs = require('node:fs');
const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.agent = {
  ...(config.agent || {}),
  sharedDir: '/opt/agent-saas-staging/current/server/workspace-shared',
};
fs.writeFileSync(`${configPath}.candidate`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(`${configPath}.candidate`, configPath);
NODE
chown agent-saas-staging:agent-saas-staging "$server_config"
chmod 0600 "$server_config"
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
runuser -u agent-saas-staging -- sh -c \
  'umask 077; printf "%s" "$2" > "$1"' sh "$artifact_persistence_probe" "$release_id"
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
runuser -u agent-saas-staging -- test -r "$artifact_persistence_probe"
test "$(cat "$artifact_persistence_probe")" = "$release_id" || {
  echo 'Staging Artifact persistence probe did not survive the service restart' >&2
  exit 1
}
rm -f "$artifact_persistence_probe"

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
