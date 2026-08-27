import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductionIdentity } from './write-production-identity.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

test('maps the immutable Manifest matrix to the trusted runtime identity schema', () => {
  const manifest = {
    releaseSha: SHA,
    digest: DIGEST,
    components: {
      web: { action: 'deploy', sourceSha: SHA, artifactDigest: DIGEST },
      api: { action: 'deploy', sourceSha: SHA, artifactDigest: DIGEST },
      runtimeWorker: { action: 'deploy', sourceSha: SHA, artifactDigest: DIGEST },
      acs: {
        action: 'deploy',
        sourceSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
      },
    },
  };
  const identity = buildProductionIdentity(
    manifest,
    { api: {}, runtimeWorker: {} },
    '2026-08-26T00:00:00.000Z',
  );
  assert.equal(identity.components.runtimeWorker.artifactDigest, DIGEST);
  assert.equal(identity.topology.observedAt, '2026-08-26T00:00:00.000Z');
  assert.equal(identity.environment, 'production');
});

test('preserves deployment time for kept components and anchors top-level SHA to the API', () => {
  const manifest = {
    releaseSha: 'c'.repeat(40),
    digest: DIGEST,
    components: {
      web: { action: 'deploy', sourceSha: 'c'.repeat(40), artifactDigest: DIGEST },
      api: { action: 'keep', sourceSha: SHA, artifactDigest: DIGEST },
      runtimeWorker: { action: 'keep', sourceSha: SHA, artifactDigest: DIGEST },
      acs: {
        action: 'keep',
        sourceSha: SHA,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
      },
    },
  };
  const previous = {
    components: Object.fromEntries(
      ['web', 'api', 'runtimeWorker', 'acs'].map((name) => [
        name,
        { deployedAt: '2026-08-25T00:00:00.000Z' },
      ]),
    ),
  };
  const identity = buildProductionIdentity(
    manifest,
    { api: {}, runtimeWorker: {} },
    '2026-08-26T00:00:00.000Z',
    previous,
  );
  assert.equal(identity.gitSha, SHA);
  assert.equal(identity.components.web.deployedAt, '2026-08-26T00:00:00.000Z');
  assert.equal(identity.components.api.deployedAt, '2026-08-25T00:00:00.000Z');
});
