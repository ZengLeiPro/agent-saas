#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_DIR:?RELEASE_DIR is required}"
: "${MANIFEST_PATH:?MANIFEST_PATH is required}"
: "${EXPECTED_MANIFEST_DIGEST:?EXPECTED_MANIFEST_DIGEST is required}"

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

previous="$(readlink -f "$current" 2>/dev/null || true)"
candidate="$target.candidate-$GITHUB_RUN_ID"
cleanup() { rm -rf "$candidate"; }
rollback() {
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" "$current"
    systemctl restart agent-saas-acs-orchestrator-staging.service || true
    systemctl restart agent-saas-server-staging.service || true
    systemctl restart agent-saas-runtime-worker-staging.service || true
  fi
}
trap cleanup EXIT
trap 'rollback' ERR

if [ -d "$target" ]; then
  test -f "$target/manifest.json"
  existing="$(node -p "require('$target/manifest.json').digest")"
  test "$existing" = "$manifest_digest" || { echo 'Immutable Staging release conflicts' >&2; exit 1; }
else
  rm -rf "$candidate"
  mkdir -p "$candidate/server" "$candidate/web" "$candidate/acs-orchestrator"
  tar -xzf "$RELEASE_DIR/server-bundle.tgz" -C "$candidate/server"
  tar -xzf "$RELEASE_DIR/web-assets.tgz" -C "$candidate/web"
  tar -xzf "$RELEASE_DIR/acs-orchestrator.tgz" -C "$candidate/acs-orchestrator"
  test -s "$candidate/server/dist/index.js"
  test -s "$candidate/acs-orchestrator/dist/index.js"
  install -m 0444 "$MANIFEST_PATH" "$candidate/manifest.json"
  mv "$candidate" "$target"
fi

ln -sfn "$target" "$current"
node - "$MANIFEST_PATH" /etc/agent-saas-staging/acs-orchestrator.env <<'NODE'
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
node - "$MANIFEST_PATH" /etc/agent-saas-staging/acs-orchestrator.env <<'NODE'
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
trap - ERR
echo "$release_id deployed to isolated Staging runtime"
