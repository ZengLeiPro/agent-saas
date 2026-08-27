import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReleaseEnvironment,
  validateLiveProductionComponents,
} from './read-live-production-components.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

test('reads an independently attested production component matrix', () => {
  const components = validateLiveProductionComponents({
    api: {
      status: 'ok',
      release: {
        environment: 'production',
        safetyAttested: true,
        releaseSha: SHA,
        serverDigest: DIGEST,
      },
    },
    web: { schemaVersion: 1, environment: 'production', releaseSha: SHA, webDigest: DIGEST },
    workerEnvironment: {
      AGENT_SAAS_ENVIRONMENT: 'production',
      AGENT_SAAS_RELEASE_SHA: SHA,
      AGENT_SAAS_SERVER_DIGEST: DIGEST,
    },
    acs: {
      environment: 'production',
      releaseIdentityAttested: true,
      namespace: 'agent-saas-coding',
      sourceSha: SHA,
      orchestratorArtifactDigest: DIGEST,
      sandboxImageDigest: DIGEST,
    },
  });
  assert.equal(components.runtimeWorker.artifactDigest, DIGEST);
  assert.equal(components.acs.gitSha, SHA);
});

test('rejects unknown identity and ambiguous release environment', () => {
  assert.throws(() => parseReleaseEnvironment('KEY=first\nKEY=second\n'), /repeats KEY/u);
  assert.throws(
    () =>
      validateLiveProductionComponents({
        api: { status: 'ok', release: { environment: 'production', safetyAttested: true } },
        web: {},
        workerEnvironment: {},
        acs: {},
      }),
    /Web release identity/u,
  );
});
