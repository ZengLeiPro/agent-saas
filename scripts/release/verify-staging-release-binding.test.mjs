import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStagingReleaseBinding } from './verify-staging-release-binding.mjs';

const RELEASE_ID = 'rc-20260831-01';
const SHA = 'a'.repeat(40);
const MANIFEST = `sha256:${'1'.repeat(64)}`;
const SERVER = `sha256:${'2'.repeat(64)}`;
const WEB = `sha256:${'3'.repeat(64)}`;
const ACS_ORCHESTRATOR = `sha256:${'4'.repeat(64)}`;
const ACS_SANDBOX = `sha256:${'5'.repeat(64)}`;

function fixture() {
  return {
    manifest: {
      releaseId: RELEASE_ID,
      releaseSha: SHA,
      digest: MANIFEST,
      components: {
        api: { action: 'deploy', sourceSha: SHA, artifactDigest: SERVER },
        web: { action: 'deploy', sourceSha: SHA, artifactDigest: WEB },
        acs: {
          action: 'deploy',
          sourceSha: SHA,
          orchestratorArtifactDigest: ACS_ORCHESTRATOR,
          sandboxImageDigest: ACS_SANDBOX,
        },
      },
    },
    webIdentity: {
      environment: 'staging',
      releaseId: RELEASE_ID,
      releaseSha: SHA,
      configFingerprint: MANIFEST,
      webDigest: WEB,
    },
    apiReady: {
      status: 'ok',
      release: {
        environment: 'staging',
        releaseId: RELEASE_ID,
        releaseSha: SHA,
        serverDigest: SERVER,
        webDigest: WEB,
        acsOrchestratorDigest: ACS_ORCHESTRATOR,
        acsSandboxImageDigest: ACS_SANDBOX,
      },
    },
    acsHealth: {
      status: 'ok',
      environment: 'staging',
      releaseId: RELEASE_ID,
      sourceSha: SHA,
      orchestratorArtifactDigest: ACS_ORCHESTRATOR,
      sandboxImageDigest: ACS_SANDBOX,
      namespace: 'agent-saas-staging',
      releaseIdentityAttested: true,
    },
    expectedManifestDigest: MANIFEST,
  };
}

test('binds Web and API component identities to the exact Manifest', () => {
  assert.deepEqual(verifyStagingReleaseBinding(fixture()), {
    releaseId: RELEASE_ID,
    releaseSha: SHA,
    apiSourceSha: SHA,
    webSourceSha: SHA,
    acsSourceSha: SHA,
    manifestDigest: MANIFEST,
    serverDigest: SERVER,
    webDigest: WEB,
    acsOrchestratorDigest: ACS_ORCHESTRATOR,
    acsSandboxImageDigest: ACS_SANDBOX,
  });
});

for (const mutation of [
  (value) => {
    value.webIdentity.releaseSha = '9'.repeat(40);
  },
  (value) => {
    value.apiReady.release.releaseSha = '9'.repeat(40);
  },
  (value) => {
    value.acsHealth.sourceSha = '9'.repeat(40);
  },
  (value) => {
    value.acsHealth.orchestratorArtifactDigest = `sha256:${'9'.repeat(64)}`;
  },
  (value) => {
    value.acsHealth.sandboxImageDigest = `sha256:${'9'.repeat(64)}`;
  },
  (value) => {
    value.webIdentity.webDigest = `sha256:${'9'.repeat(64)}`;
  },
  (value) => {
    value.webIdentity.configFingerprint = `sha256:${'9'.repeat(64)}`;
  },
  (value) => {
    value.apiReady.release.serverDigest = `sha256:${'9'.repeat(64)}`;
  },
  (value) => {
    value.apiReady.release.webDigest = `sha256:${'9'.repeat(64)}`;
  },
  (value) => {
    value.apiReady.release.acsOrchestratorDigest = `sha256:${'9'.repeat(64)}`;
  },
  (value) => {
    value.apiReady.release.acsSandboxImageDigest = `sha256:${'9'.repeat(64)}`;
  },
]) {
  test('rejects a same-release/SHA identity with a wrong component digest', () => {
    const value = fixture();
    mutation(value);
    assert.throws(() => verifyStagingReleaseBinding(value), /does not match/u);
  });
}

for (const matrix of [
  {
    label: 'API-only',
    web: 'b',
    api: 'a',
    acs: 'c',
    webAction: 'keep',
    apiAction: 'deploy',
    acsAction: 'keep',
  },
  {
    label: 'Web-only',
    web: 'a',
    api: 'b',
    acs: 'c',
    webAction: 'deploy',
    apiAction: 'keep',
    acsAction: 'keep',
  },
  {
    label: 'ACS-only',
    web: 'b',
    api: 'c',
    acs: 'a',
    webAction: 'keep',
    apiAction: 'keep',
    acsAction: 'deploy',
  },
  {
    label: 'mixed keep/deploy',
    web: 'd',
    api: 'a',
    acs: 'a',
    webAction: 'keep',
    apiAction: 'deploy',
    acsAction: 'deploy',
  },
]) {
  test(`binds ${matrix.label} identities to component source SHAs instead of the RC SHA`, () => {
    const value = fixture();
    value.manifest.components.web.action = matrix.webAction;
    value.manifest.components.web.sourceSha = matrix.web.repeat(40);
    value.manifest.components.api.action = matrix.apiAction;
    value.manifest.components.api.sourceSha = matrix.api.repeat(40);
    value.manifest.components.acs.action = matrix.acsAction;
    value.manifest.components.acs.sourceSha = matrix.acs.repeat(40);
    value.webIdentity.releaseSha = value.manifest.components.web.sourceSha;
    value.apiReady.release.releaseSha = value.manifest.components.api.sourceSha;
    value.acsHealth.sourceSha = value.manifest.components.acs.sourceSha;
    const result = verifyStagingReleaseBinding(value);
    assert.equal(result.releaseSha, SHA);
    assert.equal(result.webSourceSha, value.manifest.components.web.sourceSha);
    assert.equal(result.apiSourceSha, value.manifest.components.api.sourceSha);
    assert.equal(result.acsSourceSha, value.manifest.components.acs.sourceSha);
  });
}

test('rejects a re-downloaded Manifest whose digest drifted during acceptance', () => {
  const value = fixture();
  value.manifest.digest = `sha256:${'9'.repeat(64)}`;
  value.webIdentity.configFingerprint = value.manifest.digest;
  assert.throws(() => verifyStagingReleaseBinding(value), /Manifest digest does not match/u);
});

test('rejects an unhealthy API even when its release identity matches', () => {
  const value = fixture();
  value.apiReady.status = 'not_ready';
  assert.throws(() => verifyStagingReleaseBinding(value), /API readiness/u);
});
