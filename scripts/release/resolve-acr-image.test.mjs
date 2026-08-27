import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAcrImage } from './resolve-acr-image.mjs';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

test('resolves a successful exact-prefix build to an immutable digest reference', () => {
  const value = resolveAcrImage({
    releaseSha: SHA,
    buildRecord: {
      BuildStatus: 'SUCCESS',
      BuildRecordId: 'build-1',
      Image: { ImageTag: '202608261200-abcdef' },
    },
    tagRecord: { Status: 'NORMAL', Digest: '1'.repeat(64) },
    registry: 'registry.example.com',
    repository: 'agent-saas/acs-sandbox',
  });
  assert.equal(
    value.reference,
    `registry.example.com/agent-saas/acs-sandbox@sha256:${'1'.repeat(64)}`,
  );
});

test('rejects a later or mutable image identity', () => {
  assert.throws(
    () =>
      resolveAcrImage({
        releaseSha: SHA,
        buildRecord: { BuildStatus: 'SUCCESS', Image: { ImageTag: 'latest-fedcba' } },
        tagRecord: { Status: 'NORMAL', Digest: '1'.repeat(64) },
        registry: 'registry.example.com',
        repository: 'agent-saas/acs-sandbox',
      }),
    /not bound/u,
  );
});
