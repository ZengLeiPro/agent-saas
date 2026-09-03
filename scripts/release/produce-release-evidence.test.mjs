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
  [
    'production',
    'server',
    'web',
    'acs',
    'image',
    'review',
    'migration',
    'runtime',
    'dependencies',
    'contract',
    'identityServer',
    'identityAcs',
  ].map((name, index) => [name, `sha256:${(index + 1).toString(16).repeat(64)}`]),
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
      runtimeDependencies: {
        server: {
          uri: 'oss://releases/base/server-runtime.json',
          digest: DIGESTS.runtime,
          size: 13,
          sourceSha: BASE_SHA,
          identityDigest: DIGESTS.identityServer,
          dependencyDigest: DIGESTS.dependencies,
          contractDigest: DIGESTS.contract,
        },
        acs: {
          uri: 'oss://releases/base/acs-runtime.json',
          digest: DIGESTS.runtime,
          size: 13,
          sourceSha: BASE_SHA,
          identityDigest: DIGESTS.identityAcs,
          dependencyDigest: DIGESTS.dependencies,
          contractDigest: DIGESTS.contract,
        },
      },
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

test('produces digest-bound Release Evidence v2 with kept-component Runtime identities', async () => {
  const { options, documents } = await fixture();
  const evidence = await produceReleaseEvidence(options);
  const stored = JSON.parse(await readFile(options.output, 'utf8'));

  assert.deepEqual(stored, evidence);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.releaseSha, RELEASE_SHA);
  assert.equal(evidence.releasePullRequest.number, documents.merge.finalPullRequest.number);
  assert.deepEqual(evidence.sourcePullRequests, [300]);
  assert.deepEqual(evidence.integrationCandidates, []);
  assert.equal(evidence.checks.mergeReceipt.status, 'success');
  assert.equal('configIdentity' in evidence, false);
  assert.equal(
    evidence.baselineArtifacts.acsImage.repository,
    documents['baseline-artifacts'].acsImage.repository,
  );
  const { evidenceDigest, ...body } = evidence;
  assert.equal(evidenceDigest, digestBuffer(Buffer.from(canonicalJson(body))));
});

function withConfigIdentity(production, configIdentity) {
  const { digest: _previousDigest, ...previousBody } = production;
  const body = { ...previousBody, configIdentity };
  return { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) };
}

test('projects the validated private config identity summary into Evidence v2', async () => {
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

test('rejects a malformed baseline ACS image repository', async () => {
  const base = await fixture();
  base.documents['baseline-artifacts'].acsImage.repository = ':.../';
  await writeFile(
    base.options['baseline-artifacts'],
    `${JSON.stringify(base.documents['baseline-artifacts'])}\n`,
  );
  await assert.rejects(produceReleaseEvidence(base.options), /Baseline artifacts/u);
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

test('rejects a baseline runtime identity bound to another component source', async () => {
  const base = await fixture();
  base.documents['baseline-artifacts'].runtimeDependencies.server.sourceSha = 'd'.repeat(40);
  await writeFile(
    base.options['baseline-artifacts'],
    `${JSON.stringify(base.documents['baseline-artifacts'])}\n`,
  );
  await assert.rejects(
    produceReleaseEvidence(base.options),
    /Server runtime dependency is not bound/u,
  );
});

test('allows absent baseline Runtime identities only for components classified to deploy', async () => {
  const fullDeploy = await fixture();
  fullDeploy.documents.classification.components = ['api', 'runtimeWorker', 'acs'];
  delete fullDeploy.documents['baseline-artifacts'].runtimeDependencies.server;
  delete fullDeploy.documents['baseline-artifacts'].runtimeDependencies.acs;
  await Promise.all([
    writeFile(
      fullDeploy.options.classification,
      `${JSON.stringify(fullDeploy.documents.classification)}\n`,
    ),
    writeFile(
      fullDeploy.options['baseline-artifacts'],
      `${JSON.stringify(fullDeploy.documents['baseline-artifacts'])}\n`,
    ),
  ]);
  await assert.doesNotReject(produceReleaseEvidence(fullDeploy.options));

  const kept = await fixture();
  delete kept.documents['baseline-artifacts'].runtimeDependencies.server;
  await writeFile(
    kept.options['baseline-artifacts'],
    `${JSON.stringify(kept.documents['baseline-artifacts'])}\n`,
  );
  await assert.rejects(
    produceReleaseEvidence(kept.options),
    /kept Server requires its baseline Runtime Dependency Identity/u,
  );
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
