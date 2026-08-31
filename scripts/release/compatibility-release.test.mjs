import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createComponentArtifactIndex } from './create-component-artifact-index.mjs';
import { sealCompatibilityRelease } from './seal-compatibility-release.mjs';
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
  assert.equal(index.sourceSha, SHA);
  assert.equal(index.artifacts.serverBundle.path, 'server-bundle.tgz');
  assert.match(index.aggregateDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(index.acsImage, null);
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
  const [appWorkflow, acsWorkflow, promotionWorkflow, acsDeploy, releaseDocs] = await Promise.all([
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('.github/workflows/acs-sandbox.yml', 'utf8'),
    readFile('.github/workflows/promote-release.yml', 'utf8'),
    readFile('scripts/deploy-acs-orchestrator.sh', 'utf8'),
    readFile('docs/release-workflow-configuration.md', 'utf8'),
  ]);
  assert.match(appWorkflow, /baselines\/app-/u);
  assert.match(appWorkflow, /baselines\/web-/u);
  assert.match(appWorkflow, /github\.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  assert.doesNotMatch(appWorkflow, /agent-saas-production-runtime/u);
  assert.match(appWorkflow, /server_artifact_digest/u);
  assert.match(
    appWorkflow,
    /Commit trusted Production identity after all compatibility targets converge/u,
  );
  assert.match(appWorkflow, /runtime worker rollout: required to converge/u);
  assert.match(appWorkflow, /GITHUB_RUN_ID='\$\{GITHUB_RUN_ID\}'/u);
  assert.match(appWorkflow, /GITHUB_RUN_ATTEMPT='\$\{GITHUB_RUN_ATTEMPT\}'/u);
  assert.match(appWorkflow, /missing GITHUB_RUN_ID/u);
  assert.match(appWorkflow, /missing GITHUB_RUN_ATTEMPT/u);
  assert.equal(
    appWorkflow.match(/write-live-production-identity\.mjs' --input '\$remote\/live\.json'/gu)
      ?.length,
    1,
  );
  assert.ok(
    appWorkflow.indexOf(
      'Commit trusted Production identity after all compatibility targets converge',
    ) > appWorkflow.indexOf('Verify deployed Web'),
  );
  assert.match(appWorkflow, /trusted identity remains unchanged until Web converges/u);
  assert.match(
    appWorkflow,
    /components\.api\.artifactDigest==\\\$digest[\s\S]*components\.runtimeWorker\.artifactDigest==\\\$digest/u,
  );
  assert.match(appWorkflow, /github\.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  assert.match(acsWorkflow, /group: production-runtime/u);
  assert.match(promotionWorkflow, /group: production-runtime/u);
  assert.match(acsWorkflow, /baselines\/acs-/u);
  assert.match(acsWorkflow, /group: production-runtime/u);
  assert.match(appWorkflow, /format\('agent-saas-\{0\}', github\.run_id\)/u);
  assert.match(acsWorkflow, /ACS_IMAGE_REFERENCE/u);
  assert.match(acsWorkflow, /acs-release-identity\.json/u);
  assert.match(acsWorkflow, /后续 main 推进不影响本次代码与镜像/u);
  assert.match(releaseDocs, /记录一旦进入\s+`PENDING`\/`BUILDING`/u);
  assert.match(releaseDocs, /此后 main 前进不会把本次\s+已锁定部署改成新 SHA/u);
  assert.match(acsDeploy, /acs-releases\/\$\{ORCHESTRATOR_ARTIFACT_DIGEST#sha256:\}/u);
  assert.match(acsDeploy, /ln -sfn "\$APP_DIR" "\$CURRENT_LINK"/u);
  assert.doesNotMatch(acsDeploy, /APP_DIR="\$ECS_DEPLOY_ROOT"\n/u);
});
