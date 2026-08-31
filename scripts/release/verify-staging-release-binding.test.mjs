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
        api: { artifactDigest: SERVER },
        web: { artifactDigest: WEB },
        acs: {
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
    expectedManifestDigest: MANIFEST,
  };
}

test('binds Web and API component identities to the exact Manifest', () => {
  assert.deepEqual(verifyStagingReleaseBinding(fixture()), {
    releaseId: RELEASE_ID,
    releaseSha: SHA,
    manifestDigest: MANIFEST,
    serverDigest: SERVER,
    webDigest: WEB,
    acsOrchestratorDigest: ACS_ORCHESTRATOR,
    acsSandboxImageDigest: ACS_SANDBOX,
  });
});

for (const mutation of [
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
