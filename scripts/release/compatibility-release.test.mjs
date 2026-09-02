import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createComponentArtifactIndex } from './create-component-artifact-index.mjs';
import { sealCompatibilityRelease } from './seal-compatibility-release.mjs';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
} from './runtime-dependency.mjs';
import { buildCompatibilityAppEnvironment } from './write-compatibility-app-env.mjs';
import { buildCompatibilityAcsIdentity } from './write-compatibility-acs-identity.mjs';
import {
  buildLiveProductionIdentity,
  topologyFromLive,
} from './write-live-production-identity.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const RELEASE_ID = 'rc-20260828-33185461811';

test('creates component-scoped immutable artifact indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-index-'));
  const artifactPath = join(root, 'server-bundle.tgz');
  await writeFile(artifactPath, 'server');
  const index = await createComponentArtifactIndex({
    sourceSha: SHA,
    artifactName: 'serverBundle',
    artifactPath,
  });
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.sourceSha, SHA);
  assert.equal(index.artifacts.serverBundle.path, 'server-bundle.tgz');
  assert.match(index.aggregateDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(index.acsImage, null);
  assert.equal(index.runtimeDependencies, null);
});

test('component indexes reject malformed digest-suffixed ACS image references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-acs-index-'));
  const artifactPath = join(root, 'acs-orchestrator.tgz');
  await writeFile(artifactPath, 'acs');
  await assert.rejects(
    createComponentArtifactIndex({
      sourceSha: SHA,
      artifactName: 'acsOrchestrator',
      artifactPath,
      imageReference: `:@${DIGEST}`,
    }),
    /ACS image reference must use a valid immutable repository digest/u,
  );
});

test('component indexes bind the standalone runtime identity to the same source SHA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-runtime-index-'));
  const artifactPath = join(root, 'server-bundle.tgz');
  const runtimePath = join(root, 'runtime-dependencies.json');
  await writeFile(artifactPath, 'server');
  await writeFile(
    runtimePath,
    `${JSON.stringify(createRuntimeDependencyIdentity(await loadRuntimeDependencyContract(), SHA))}\n`,
  );
  const index = await createComponentArtifactIndex({
    sourceSha: SHA,
    artifactName: 'serverBundle',
    artifactPath,
    runtimeDependencyPath: runtimePath,
  });
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.runtimeDependencies.sourceSha, SHA);
  assert.equal(index.runtimeDependencies.path, 'runtime-dependencies.json');
  assert.equal(
    index.runtimeDependencies.identityDigest,
    createRuntimeDependencyIdentity(await loadRuntimeDependencyContract(), SHA).identityDigest,
  );
  assert.match(index.runtimeDependencies.dependencyDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('seals compatibility releases against both archive and installed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-seal-'));
  await mkdir(join(root, '.release'));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, '.release', 'server-bundle.tgz'), 'archive');
  await writeFile(join(root, 'server', 'index.js'), 'server');
  const result = await sealCompatibilityRelease({
    rootPath: root,
    component: 'server',
    releaseId: RELEASE_ID,
    sourceSha: SHA,
  });
  assert.equal(result.manifest.releaseSha, SHA);
  assert.equal(result.installed.component, 'server');
  assert.equal(result.installed.artifactDigest, result.manifest.components.api.artifactDigest);
  assert.ok(await readFile(join(root, '.release', 'installed-release-server.json'), 'utf8'));
});

test('builds compatibility runtime identities without carrying stale App metadata', () => {
  const current = {
    components: {
      web: { artifactDigest: DIGEST },
      acs: { orchestratorArtifactDigest: DIGEST, sandboxImageDigest: DIGEST },
    },
  };
  const environment = buildCompatibilityAppEnvironment({
    identity: current,
    releaseId: RELEASE_ID,
    sourceSha: SHA,
    serverDigest: DIGEST,
  });
  assert.equal(environment.AGENT_SAAS_RELEASE_SHA, SHA);
  assert.equal(environment.AGENT_SAAS_WEB_DIGEST, DIGEST);

  const acs = buildCompatibilityAcsIdentity({
    releaseId: RELEASE_ID,
    sourceSha: SHA,
    orchestratorArtifactDigest: DIGEST,
    sandboxImageDigest: DIGEST,
    namespace: 'agent-saas-coding',
    configFingerprint: DIGEST,
  });
  assert.equal(acs.releaseIdentityAttested, undefined);
  assert.equal(acs.environment, 'production');
});

test('rebuilds the trusted identity from the observed live component matrix', () => {
  const components = {
    web: { gitSha: SHA, artifactDigest: DIGEST },
    api: { gitSha: SHA, artifactDigest: DIGEST },
    runtimeWorker: { gitSha: SHA, artifactDigest: DIGEST },
    acs: {
      gitSha: SHA,
      orchestratorArtifactDigest: DIGEST,
      sandboxImageDigest: DIGEST,
    },
  };
  const live = {
    schemaVersion: 1,
    environment: 'production',
    observedAt: '2026-08-28T16:00:00.000Z',
    components,
    topology: {
      api: { color: 'blue', unit: 'agent-saas-server@blue.service' },
      runtimeWorker: { color: 'blue', unit: 'agent-saas-runtime-worker@blue.service' },
    },
  };
  const topology = topologyFromLive(live, {
    readFile: () => 'blue',
    realpath: () => `/opt/agent-saas-app/releases/${DIGEST.slice(7)}`,
  });
  const identity = buildLiveProductionIdentity({ live, topology });
  assert.equal(identity.gitSha, SHA);
  assert.equal(identity.topology.api.activeColor, 'blue');
  assert.equal(identity.components.api.deployedAt, live.observedAt);
  assert.match(identity.configFingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test('legacy deploy entrypoints persist immutable baselines and refresh trusted identity', async () => {
  const [appWorkflow, acsWorkflow, promotionWorkflow, acsDeploy] = await Promise.all([
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('.github/workflows/acs-sandbox.yml', 'utf8'),
    readFile('.github/workflows/promote-release.yml', 'utf8'),
    readFile('scripts/deploy-acs-orchestrator.sh', 'utf8'),
  ]);
  assert.match(appWorkflow, /baselines\/app-/u);
  assert.match(appWorkflow, /server-release-stage\/server\/runtime-dependencies\.json/u);
  assert.match(appWorkflow, /baselines\/web-/u);
  assert.match(appWorkflow, /Refresh trusted Production identity/u);
  assert.match(appWorkflow, /runtime worker rollout: required to converge/u);
  assert.match(appWorkflow, /GITHUB_RUN_ID='\$\{GITHUB_RUN_ID\}'/u);
  assert.match(appWorkflow, /GITHUB_RUN_ATTEMPT='\$\{GITHUB_RUN_ATTEMPT\}'/u);
  assert.match(appWorkflow, /missing GITHUB_RUN_ID/u);
  assert.match(appWorkflow, /missing GITHUB_RUN_ATTEMPT/u);
  assert.ok(
    appWorkflow.indexOf('Production identity atomically rebuilt') <
      appWorkflow.indexOf('drain signal SIGUSR2 sent to old color'),
  );
  assert.match(appWorkflow, /github\.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  assert.match(acsWorkflow, /group: production-runtime/u);
  assert.match(promotionWorkflow, /group: production-runtime/u);
  assert.doesNotMatch(
    `${appWorkflow}\n${acsWorkflow}\n${promotionWorkflow}`,
    /group: agent-saas-production-deploy/u,
  );
  assert.match(acsWorkflow, /baselines\/acs-/u);
  assert.match(acsWorkflow, /acs-release-stage\/acs-orchestrator\/runtime-dependencies\.json/u);
  assert.match(acsWorkflow, /manage-acs-systemd-unit\.sh/u);
  assert.match(acsWorkflow, /agent-saas-acs-orchestrator\.service\.template/u);
  assert.match(acsWorkflow, /ACS_IMAGE_REFERENCE/u);
  assert.match(acsWorkflow, /environment: production/u);
  assert.match(appWorkflow, /DEPLOY_LOCK_FILE="\/run\/lock\/agent-saas\/promotion\.lock"/u);
  assert.doesNotMatch(appWorkflow, /agent-saas-deploy\.lock/u);
  assert.ok(
    appWorkflow.indexOf('flock -n 9') < appWorkflow.indexOf('identity_probe="/etc/agent-saas/'),
  );
  assert.match(acsWorkflow, /acs-release-identity\.json/u);
  assert.match(acsDeploy, /acs-releases\/\$\{ORCHESTRATOR_ARTIFACT_DIGEST#sha256:\}/u);
  assert.match(acsDeploy, /ln -sfn "\$APP_DIR" "\$CURRENT_LINK"/u);
  assert.match(acsDeploy, /lock=\/run\/lock\/agent-saas\/promotion\.lock/u);
  assert.match(appWorkflow, /\/run\/lock\/agent-saas\/promotion\.lock/u);
  assert.match(acsDeploy, /flock -n 9/u);
  assert.match(
    acsDeploy,
    /if \[ "\$\{CURRENT_LINK_UPDATED:-false\}" = "true" \]; then[\s\S]*ln -sfn "\$PREVIOUS_APP_DIR" "\$CURRENT_LINK"/u,
  );
  assert.match(
    acsDeploy,
    /if \[ "\$\{PRODUCTION_CLEANUP_ARMED:-false\}" != "true" \]; then[\s\S]*return "\$deploy_status"/u,
  );
  assert.match(acsDeploy, /ACS_NODE=\/usr\/bin\/node/u);
  assert.match(acsDeploy, /SYSTEMCTL_BIN=\/usr\/bin\/systemctl/u);
  assert.match(
    acsDeploy,
    /"\$ACS_NODE" "\$RUNTIME_PREFLIGHT_DIR\/acs-orchestrator\/dist\/runtime-dependency\.mjs"[\s\S]*--component=acsOrchestrator --environment-file="\$runtime_environment_file" --production=true/u,
  );
  assert.match(
    acsDeploy,
    /validate_acs_managed_unit "\$unit_source" "\$ACS_NODE" "\$ACS_SERVICE_NAME"/u,
  );
  assert.match(
    acsDeploy,
    /install_acs_managed_unit "\$unit_source" "\$ACS_UNIT_PATH" "\$SYSTEMCTL_BIN"/u,
  );
  assert.match(acsDeploy, /restore_acs_managed_unit/u);
  assert.ok(
    acsDeploy.indexOf('--environment-file="$runtime_environment_file" --production=true') <
      acsDeploy.indexOf('install_acs_managed_unit'),
  );
  assert.ok(
    acsDeploy.indexOf('install_acs_managed_unit') <
      acsDeploy.indexOf('PRODUCTION_CLEANUP_ARMED=true'),
  );
  assert.ok(
    acsDeploy.indexOf('install_acs_managed_unit') < acsDeploy.indexOf('cp "$ENV_FILE" "$ENV_BAK"'),
  );
  assert.ok(
    acsDeploy.indexOf('PRODUCTION_CLEANUP_ARMED=true') <
      acsDeploy.indexOf('runtime_identity_probe="/etc/agent-saas/'),
  );
  assert.ok(
    acsDeploy.indexOf('--environment-file="$runtime_environment_file" --production=true') <
      acsDeploy.indexOf('candidate="$APP_DIR.candidate-${GITHUB_RUN_ID}"'),
  );
  assert.ok(
    acsDeploy.indexOf('flock -n 9') <
      acsDeploy.indexOf('PREVIOUS_APP_DIR="$(readlink -f "$CURRENT_LINK")"'),
  );
  assert.doesNotMatch(acsDeploy, /APP_DIR="\$ECS_DEPLOY_ROOT"\n/u);
});
