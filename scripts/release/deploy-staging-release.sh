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

if [ -d "$target" ]; then
  node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component server
  node "$VERIFY_INSTALLED_SCRIPT" --action verify --root "$target" --component acs
  existing="$(node -p "require('$target/manifest.json').digest")"
  test "$existing" = "$manifest_digest" || { echo 'Immutable Staging release conflicts' >&2; exit 1; }
else
  rm -rf "$candidate"
  mkdir -p "$candidate/server" "$candidate/web" "$candidate/acs-orchestrator" "$candidate/.release"
  install -m 0444 "$RELEASE_DIR/server-bundle.tgz" "$candidate/.release/server-bundle.tgz"
  install -m 0444 "$RELEASE_DIR/acs-orchestrator.tgz" "$candidate/.release/acs-orchestrator.tgz"
  tar -xzf "$candidate/.release/server-bundle.tgz" -C "$candidate/server"
  tar -xzf "$RELEASE_DIR/web-assets.tgz" -C "$candidate/web"
  tar -xzf "$candidate/.release/acs-orchestrator.tgz" -C "$candidate/acs-orchestrator"
  test -s "$candidate/server/dist/index.js"
  test -s "$candidate/acs-orchestrator/dist/index.js"
  install -m 0444 "$MANIFEST_PATH" "$candidate/manifest.json"
  node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component server
  node "$VERIFY_INSTALLED_SCRIPT" --action seal --root "$candidate" --component acs
  mv "$candidate" "$target"
fi

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
