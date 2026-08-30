import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createValidReleaseEvidence,
  RELEASE_EVIDENCE_SHA,
} from './release-evidence-fixture.test-helper.mjs';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { validateReleaseEvidenceDocument } from './release-evidence-schema.mjs';

test('accepts a complete release evidence document', () => {
  assert.deepEqual(
    validateReleaseEvidenceDocument(createValidReleaseEvidence(), {
      expectedSha: RELEASE_EVIDENCE_SHA,
    }),
    createValidReleaseEvidence(),
  );
});

test('continues to accept immutable legacy Taskboard Integration evidence', () => {
  const legacy = structuredClone(createValidReleaseEvidence());
  delete legacy.releasePullRequest;
  legacy.integrationCandidates = [
    {
      candidateId: '85a9cb68-4130-4c0a-aec3-e4cc9c671bd5',
      revision: 3,
      mergedCommitOid: RELEASE_EVIDENCE_SHA,
    },
  ];
  legacy.checks.integrationReceipt = legacy.checks.mergeReceipt;
  delete legacy.checks.mergeReceipt;
  legacy.compatibilityEvidenceDigest = `sha256:${'8'.repeat(64)}`;
  const { evidenceDigest: _previousDigest, ...body } = legacy;
  legacy.evidenceDigest = digestBuffer(Buffer.from(canonicalJson(body)));
  assert.equal(validateReleaseEvidenceDocument(legacy).releaseSha, RELEASE_EVIDENCE_SHA);
});

const invalidMutations = [
  ['release PR SHA', (value) => (value.releasePullRequest.mergeCommitOid = 'b'.repeat(40))],
  ['release PR membership', (value) => (value.sourcePullRequests = [202])],
  ['merge receipt', (value) => delete value.checks.mergeReceipt],
  ['CI head SHA', (value) => (value.checks.appCi.headSha = 'b'.repeat(40))],
  ['CI run ID', (value) => (value.checks.appCi.runId = 0)],
  ['component matrix', (value) => delete value.productionBaseline.acs],
  ['baseline artifact URI', (value) => (value.baselineArtifacts.webAssets.uri = 'relative.tgz')],
  ['baseline artifact size', (value) => (value.baselineArtifacts.serverBundle.size = 0)],
  [
    'baseline artifact binding',
    (value) => (value.baselineArtifacts.serverBundle.digest = `sha256:${'9'.repeat(64)}`),
  ],
  ['affected component name', (value) => value.affectedComponents.push('unknown')],
  ['API/Worker coupling', (value) => (value.affectedComponents = ['api'])],
  [
    'partial config identity',
    (value) => (value.configIdentity = { schemaVersion: 1, status: 'consistent' }),
  ],
  [
    'config identity without release binding',
    (value) =>
      (value.configIdentity = {
        schemaVersion: 1,
        status: 'consistent',
        expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
        observed: {
          schemaVersion: 1,
          digest: `sha256:${'a'.repeat(64)}`,
          credentialVersionDigest: null,
          versionResolution: 'resolved',
          secretRefCount: 0,
        },
      }),
  ],
  [
    'impossible consistent config identity',
    (value) =>
      (value.configIdentity = {
        schemaVersion: 1,
        status: 'consistent',
        expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
        observed: {
          schemaVersion: 1,
          digest: `sha256:${'a'.repeat(64)}`,
          credentialVersionDigest: null,
          versionResolution: 'unavailable',
          secretRefCount: 1,
        },
      }),
  ],
];

for (const [name, mutate] of invalidMutations) {
  test(`rejects invalid ${name}`, () => {
    const value = structuredClone(createValidReleaseEvidence());
    mutate(value);
    assert.throws(
      () =>
        validateReleaseEvidenceDocument(value, {
          expectedSha: RELEASE_EVIDENCE_SHA,
        }),
      /schema is invalid/u,
    );
  });
}
