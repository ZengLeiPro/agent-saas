import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createValidLegacyReleaseEvidence,
  createValidReleaseEvidence,
  RELEASE_EVIDENCE_SHA,
} from './release-evidence-fixture.test-helper.mjs';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import {
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  SUPPORTED_RELEASE_EVIDENCE_SCHEMA_VERSIONS,
  validateReleaseEvidenceDocument,
} from './release-evidence-schema.mjs';

test('keeps a monotonic N and N-1 Release Evidence compatibility matrix', () => {
  assert.deepEqual(SUPPORTED_RELEASE_EVIDENCE_SCHEMA_VERSIONS, [1, 2]);
  assert.equal(RELEASE_EVIDENCE_SCHEMA_VERSION, 2);
  assert.equal(
    new Set(SUPPORTED_RELEASE_EVIDENCE_SCHEMA_VERSIONS).size,
    SUPPORTED_RELEASE_EVIDENCE_SCHEMA_VERSIONS.length,
  );
});

test('accepts a complete Release Evidence v2 document with kept-component Runtime and OCI identities', () => {
  assert.deepEqual(
    validateReleaseEvidenceDocument(createValidReleaseEvidence(), {
      expectedSha: RELEASE_EVIDENCE_SHA,
    }),
    createValidReleaseEvidence(),
  );
});

test('strictly accepts historical v1 evidence without v2 runtime fields', () => {
  const legacy = createValidLegacyReleaseEvidence();
  assert.equal(validateReleaseEvidenceDocument(legacy).schemaVersion, 1);

  legacy.baselineArtifacts.runtimeDependencies =
    createValidReleaseEvidence().baselineArtifacts.runtimeDependencies;
  assert.throws(() => validateReleaseEvidenceDocument(legacy), /v1 excludes/u);
});

test('allows missing legacy baseline Runtime identities only when those components deploy', () => {
  const fullDeploy = structuredClone(createValidReleaseEvidence());
  fullDeploy.affectedComponents = ['api', 'runtimeWorker', 'acs'];
  delete fullDeploy.baselineArtifacts.runtimeDependencies.server;
  delete fullDeploy.baselineArtifacts.runtimeDependencies.acs;
  const { evidenceDigest: _previousDigest, ...body } = fullDeploy;
  fullDeploy.evidenceDigest = digestBuffer(Buffer.from(canonicalJson(body)));
  assert.equal(validateReleaseEvidenceDocument(fullDeploy).schemaVersion, 2);

  const keptServer = structuredClone(createValidReleaseEvidence());
  delete keptServer.baselineArtifacts.runtimeDependencies.server;
  assert.throws(() => validateReleaseEvidenceDocument(keptServer), /kept component requires/iu);

  const keptAcs = structuredClone(createValidReleaseEvidence());
  keptAcs.affectedComponents = ['api', 'runtimeWorker'];
  delete keptAcs.baselineArtifacts.runtimeDependencies.acs;
  assert.throws(() => validateReleaseEvidenceDocument(keptAcs), /kept component requires/iu);
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
    'baseline ACS image repository',
    (value) => (value.baselineArtifacts.acsImage.repository = '.../'),
  ],
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
