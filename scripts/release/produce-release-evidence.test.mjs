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
const configIdentityCases = JSON.parse(
  await readFile(
    new URL('./fixtures/config-identity-producer-cases.json', import.meta.url),
    'utf8',
  ),
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
    merge: {
      schemaVersion: 1,
      finalPullRequest: {
        number: 300,
        headSha: 'c'.repeat(40),
        mergeCommitOid: RELEASE_SHA,
        state: 'MERGED',
      },
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
  assert.equal(evidence.releasePullRequest.number, documents.merge.finalPullRequest.number);
  assert.deepEqual(evidence.sourcePullRequests, [300]);
  assert.deepEqual(evidence.integrationCandidates, []);
  assert.equal(evidence.checks.mergeReceipt.status, 'success');
  assert.equal('configIdentity' in evidence, false);
  const { evidenceDigest, ...body } = evidence;
  assert.equal(evidenceDigest, digestBuffer(Buffer.from(canonicalJson(body))));
});

function withConfigIdentity(production, configIdentity) {
  const { digest: _previousDigest, ...previousBody } = production;
  const body = { ...previousBody, configIdentity };
  return { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) };
}

test('passes a valid config identity summary through and binds it into evidenceDigest', async () => {
  const base = await fixture();
  base.documents.production = withConfigIdentity(
    base.documents.production,
    configIdentityCases.valid,
  );
  await writeFile(base.options.production, `${JSON.stringify(base.documents.production)}\n`);

  const evidence = await produceReleaseEvidence(base.options);
  assert.deepEqual(evidence.configIdentity, configIdentityCases.valid);
  const { evidenceDigest, ...body } = evidence;
  assert.equal(evidenceDigest, digestBuffer(Buffer.from(canonicalJson(body))));
  const { configIdentity: _configIdentity, ...bodyWithoutConfigIdentity } = body;
  assert.notEqual(
    evidenceDigest,
    digestBuffer(Buffer.from(canonicalJson(bodyWithoutConfigIdentity))),
  );
});

for (const [name, configIdentity] of Object.entries(configIdentityCases.invalid)) {
  test(`rejects explicitly present invalid production configIdentity: ${name}`, async () => {
    const base = await fixture();
    base.documents.production = withConfigIdentity(base.documents.production, configIdentity);
    await writeFile(base.options.production, `${JSON.stringify(base.documents.production)}\n`);

    await assert.rejects(
      produceReleaseEvidence(base.options),
      /Production state is invalid at configIdentity/u,
    );
  });
}

test('reports malformed config identity before a stale production digest', async () => {
  const base = await fixture();
  base.documents.production.configIdentity = null;
  await writeFile(base.options.production, `${JSON.stringify(base.documents.production)}\n`);

  await assert.rejects(
    produceReleaseEvidence(base.options),
    /Production state is invalid at configIdentity/u,
  );
});

test('keeps valid config identity inside canonical production digest verification', async () => {
  const base = await fixture();
  base.documents.production = withConfigIdentity(
    base.documents.production,
    configIdentityCases.valid,
  );
  base.documents.production.configIdentity.releaseId = 'tampered-after-digest';
  await writeFile(base.options.production, `${JSON.stringify(base.documents.production)}\n`);

  await assert.rejects(
    produceReleaseEvidence(base.options),
    /Production state digest does not match its canonical body/u,
  );
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

test('rejects a final GitHub PR that is not the release commit', async () => {
  const base = await fixture();
  base.documents.merge.finalPullRequest.mergeCommitOid = 'e'.repeat(40);
  await writeFile(base.options.merge, `${JSON.stringify(base.documents.merge)}\n`);
  await assert.rejects(produceReleaseEvidence(base.options), /does not equal the release SHA/u);
});

test('preserves optional Taskboard Integration audit evidence without requiring it', async () => {
  const base = await fixture();
  base.documents.merge.task = {
    id: '85a9cb68-4130-4c0a-aec3-e4cc9c671bd5',
    revision: 3,
    status: 'merged',
  };
  base.documents.merge.sources = [
    {
      number: 299,
      headSha: 'd'.repeat(40),
      state: 'MERGED',
      reviewedSubjectDigest: DIGESTS.review,
    },
  ];
  await writeFile(base.options.merge, `${JSON.stringify(base.documents.merge)}\n`);
  const evidence = await produceReleaseEvidence(base.options);
  assert.deepEqual(evidence.sourcePullRequests, [299, 300]);
  assert.equal(evidence.integrationCandidates[0].candidateId, base.documents.merge.task.id);
});

test('accepts a runtime release without a separate compatibility report', async () => {
  const base = await fixture();
  base.documents.classification.components = ['web'];
  await writeFile(
    base.options.classification,
    `${JSON.stringify(base.documents.classification)}\n`,
  );
  const evidence = await produceReleaseEvidence(base.options);
  assert.deepEqual(evidence.affectedComponents, ['web']);
  assert.equal('compatibilityEvidenceDigest' in evidence, false);
});
