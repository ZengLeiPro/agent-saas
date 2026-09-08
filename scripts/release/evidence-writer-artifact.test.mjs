import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildEvidenceWriter } from './build-evidence-writer.mjs';
import { verifyEvidenceWriterBundle } from './verify-evidence-writer-bundle.mjs';
import { writerUpgradeRequired } from './evidence-writer-capability.mjs';

const expected = {
  implementationDigest: `sha256:${'a'.repeat(64)}`,
  releaseEvidenceSchemaVersion: 2,
  releaseEvidenceSchemaRevision: 2,
};
const capability = {
  schemaVersion: 1,
  service: 'agent-saas-release-evidence',
  implementationDigest: expected.implementationDigest,
  currentReleaseEvidenceSchemaVersion: 2,
  releaseEvidenceSchemaRevision: 2,
  supportedReleaseEvidenceSchemaVersions: [1, 2],
};

test('Writer upgrades changed implementation independently of schema and supports recovery', () => {
  assert.equal(writerUpgradeRequired(capability, expected, 200), false);
  assert.equal(
    writerUpgradeRequired(
      { ...capability, implementationDigest: `sha256:${'b'.repeat(64)}` },
      expected,
      200,
    ),
    true,
  );
  assert.equal(
    writerUpgradeRequired(
      {
        ...capability,
        supportedReleaseEvidenceSchemaVersions: [1],
        currentReleaseEvidenceSchemaVersion: 1,
      },
      expected,
      200,
    ),
    true,
  );
  for (const status of [0, 404, 502, 503])
    assert.equal(writerUpgradeRequired(undefined, expected, status), true);
  for (const status of [401, 403])
    assert.throws(
      () => writerUpgradeRequired(undefined, expected, status),
      /authentication failed/u,
    );
  assert.throws(
    () => writerUpgradeRequired({ ...capability, service: 'another-service' }, expected, 200),
    /Unrecognized/u,
  );
});

test('Writer packaging is repeatable and its actual archive serves both service entry modes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'writer-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await buildEvidenceWriter(join(root, 'first'));
  const retry = await buildEvidenceWriter(join(root, 'retry'));
  assert.equal(first.archiveDigest, retry.archiveDigest);
  assert.equal(first.implementationDigest, retry.implementationDigest);
  assert.equal((await verifyEvidenceWriterBundle(first)).status, 'passed');
});
