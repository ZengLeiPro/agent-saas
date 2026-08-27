import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createValidReleaseEvidence,
  RELEASE_EVIDENCE_SHA,
} from './release-evidence-fixture.test-helper.mjs';
import { validateReleaseEvidenceDocument } from './release-evidence-schema.mjs';

test('accepts a complete release evidence document', () => {
  assert.deepEqual(
    validateReleaseEvidenceDocument(createValidReleaseEvidence(), {
      expectedSha: RELEASE_EVIDENCE_SHA,
    }),
    createValidReleaseEvidence(),
  );
});

const invalidMutations = [
  ['candidate identity', (value) => (value.integrationCandidates[0].candidateId = 'candidate')],
  ['candidate SHA', (value) => (value.integrationCandidates[0].mergedCommitOid = 'b'.repeat(40))],
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
