import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { produceReleaseEvidence } from './produce-release-evidence.mjs';

const RELEASE_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const DIGESTS = Object.fromEntries(
  ['production', 'server', 'web', 'acs', 'image', 'review', 'migration'].map((name, index) => [
    name,
    `sha256:${String(index + 1).repeat(64)}`,
  ]),
);

function productionState() {
  const body = {
    schemaVersion: 1,
    environment: 'production',
    observedAt: '2026-08-28T00:00:00.000Z',
    releaseId: 'release-previous',
    components: {
      web: { gitSha: BASE_SHA, artifactDigest: DIGESTS.web },
      api: { gitSha: BASE_SHA, artifactDigest: DIGESTS.server },
      runtimeWorker: { gitSha: BASE_SHA, artifactDigest: DIGESTS.server },
      acs: {
        gitSha: BASE_SHA,
        orchestratorArtifactDigest: DIGESTS.acs,
        sandboxImageDigest: DIGESTS.image,
      },
    },
    configFingerprints: {
      runtime: DIGESTS.server,
      acs: DIGESTS.acs,
      web: DIGESTS.web,
    },
    topology: { observedAt: '2026-08-28T00:00:00.000Z' },
  };
  return { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) };
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'release-evidence-producer-'));
  const documents = {
    integration: {
      schemaVersion: 1,
      task: {
        id: '85a9cb68-4130-4c0a-aec3-e4cc9c671bd5',
        revision: 3,
        status: 'merged',
      },
      finalPullRequest: {
        number: 300,
        headSha: 'c'.repeat(40),
        mergeCommitOid: RELEASE_SHA,
        state: 'MERGED',
      },
      sources: [
        {
          number: 299,
          headSha: 'd'.repeat(40),
          state: 'MERGED',
          reviewedSubjectDigest: DIGESTS.review,
        },
      ],
    },
    checks: {
      appCi: {
        workflow: 'Build & Check',
        status: 'success',
        headSha: RELEASE_SHA,
        runId: 100,
      },
      acsImpact: {
        workflow: 'ACS Impact Gate',
        status: 'not_required',
        headSha: RELEASE_SHA,
      },
    },
    production: productionState(),
    'baseline-artifacts': {
      serverBundle: { uri: 'oss://releases/base/server.tgz', digest: DIGESTS.server, size: 10 },
      webAssets: { uri: 'oss://releases/base/web.tgz', digest: DIGESTS.web, size: 11 },
      acsOrchestrator: { uri: 'oss://releases/base/acs.tgz', digest: DIGESTS.acs, size: 12 },
      acsImage: { repository: 'registry.example.com/app/image', digest: DIGESTS.image },
    },
    classification: {
      ok: true,
      changedFiles: ['docs/release.md'],
      components: [],
      blockingReasons: [],
    },
    migration: {
      ok: true,
      migrationPlan: {
        phase: 'none',
        planDigest: DIGESTS.migration,
        confirmation: 'not_required',
        contract: 'separate_release',
      },
      blockingReasons: [],
    },
    compatibility: {
      schemaVersion: 1,
      releaseSha: RELEASE_SHA,
      productionBaselineDigest: productionState().digest,
      affectedComponents: [],
      status: 'not_required',
      executedAt: '2026-08-28T01:00:00.000Z',
      checks: [],
    },
  };
  for (const [name, value] of Object.entries(overrides)) documents[name] = value;
  const options = { sha: RELEASE_SHA, output: join(root, 'evidence.json') };
  for (const [name, value] of Object.entries(documents)) {
    const path = join(root, `${name}.json`);
    await writeFile(path, `${JSON.stringify(value)}\n`);
    options[name] = path;
  }
  return { root, options, documents };
}

test('produces digest-bound release evidence from independent authoritative inputs', async () => {
  const { options, documents } = await fixture();
  const evidence = await produceReleaseEvidence(options);
  const stored = JSON.parse(await readFile(options.output, 'utf8'));

  assert.deepEqual(stored, evidence);
  assert.equal(evidence.releaseSha, RELEASE_SHA);
  assert.deepEqual(evidence.sourcePullRequests, [299]);
  assert.equal(evidence.integrationCandidates[0].candidateId, documents.integration.task.id);
  const { evidenceDigest, ...body } = evidence;
  assert.equal(evidenceDigest, digestBuffer(Buffer.from(canonicalJson(body))));
});

test('rejects production components tampered without recomputing the canonical digest', async () => {
  const base = await fixture();
  base.documents.production.components.web.artifactDigest = `sha256:${'9'.repeat(64)}`;
  await writeFile(base.options.production, `${JSON.stringify(base.documents.production)}\n`);

  await assert.rejects(
    produceReleaseEvidence(base.options),
    /Production state digest does not match its canonical body/u,
  );
});

test('rejects a final Integration PR that is not the release commit', async () => {
  const base = await fixture();
  base.documents.integration.finalPullRequest.mergeCommitOid = 'e'.repeat(40);
  await writeFile(base.options.integration, `${JSON.stringify(base.documents.integration)}\n`);
  await assert.rejects(produceReleaseEvidence(base.options), /does not equal the release SHA/u);
});

test('rejects synthetic compatibility for a runtime release', async () => {
  const base = await fixture();
  base.documents.classification.components = ['web'];
  base.documents.compatibility.affectedComponents = ['web'];
  for (const name of ['classification', 'compatibility'])
    await writeFile(base.options[name], `${JSON.stringify(base.documents[name])}\n`);
  await assert.rejects(produceReleaseEvidence(base.options), /requires passed N\/N\+1/u);
});
