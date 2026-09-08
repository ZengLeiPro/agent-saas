import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestBuffer, digestFile } from './artifact-lib.mjs';
import { verifyArtifactIndex } from './verify-artifact.mjs';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
} from './runtime-dependency.mjs';

const SHA = 'a'.repeat(40);

import {
  writePreparedRelease,
  verifyPreparedRelease,
  consumePreparedRelease,
} from './prepared-release.mjs';
async function fixture({ schemaVersion = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-release-'));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'test-lock');
  await writeFile(join(root, 'acs.tgz'), 'acs');
  await writeFile(join(root, 'server.tgz'), 'server');
  await writeFile(join(root, 'web.tgz'), 'web');
  const runtimeIdentity = createRuntimeDependencyIdentity(
    await loadRuntimeDependencyContract(),
    SHA,
  );
  await writeFile(
    join(root, 'sbom.json'),
    `${canonicalJson({
      schemaVersion,
      sourceSha: SHA,
      lockfile: await digestFile(join(root, 'pnpm-lock.yaml')),
      ...(schemaVersion === 2
        ? {
            runtimeDependencies: {
              sourceSha: SHA,
              identityDigest: runtimeIdentity.identityDigest,
              contractDigest: runtimeIdentity.contractDigest,
              dependencyDigest: runtimeIdentity.dependencyDigest,
            },
          }
        : {}),
      packages: [],
    })}\n`,
  );
  await writeFile(join(root, 'runtime-dependencies.json'), `${canonicalJson(runtimeIdentity)}\n`);
  const runtimeDependencyArtifact = await digestFile(join(root, 'runtime-dependencies.json'));
  const body = {
    schemaVersion,
    sourceSha: SHA,
    artifacts: {
      serverBundle: { path: 'server.tgz', ...(await digestFile(join(root, 'server.tgz'))) },
      webAssets: { path: 'web.tgz', ...(await digestFile(join(root, 'web.tgz'))) },
    },
    sbom: { path: 'sbom.json', ...(await digestFile(join(root, 'sbom.json'))) },
    ...(schemaVersion === 2
      ? {
          runtimeDependencies: {
            path: 'runtime-dependencies.json',
            ...runtimeDependencyArtifact,
            sourceSha: SHA,
            identityDigest: runtimeIdentity.identityDigest,
            contractDigest: runtimeIdentity.contractDigest,
            dependencyDigest: runtimeIdentity.dependencyDigest,
          },
        }
      : {}),
    acsImage: null,
  };
  const index = { ...body, aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
  const path = join(root, 'artifact-index.json');
  await writeFile(path, JSON.stringify(index));
  return { root, path };
}

const ENV = {
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/ci.yml@refs/heads/main',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: SHA,
};
async function preparedFixture(t, overrides = {}) {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writePreparedRelease({
    directory: value.root,
    root: value.root,
    sourceSha: SHA,
    acsOrchestrator: { path: 'acs.tgz', ...(await digestFile(join(value.root, 'acs.tgz'))) },
    env: { ...ENV, ...overrides },
  });
  return value;
}
function consumeOptions(value, overrides = {}) {
  return {
    directory: value.root,
    root: value.root,
    output: join(value.root, 'sealed'),
    sourceSha: SHA,
    repository: 'owner/repo',
    runId: 123,
    runAttempt: 2,
    ...overrides,
  };
}
test('CI prepared package seals the exact same App/Web/ACS bytes with the immutable image', async (t) => {
  const value = await preparedFixture(t);
  const prior = await verifyPreparedRelease({
    directory: value.root,
    sourceSha: SHA,
    root: value.root,
  });
  const sealed = await consumePreparedRelease(
    consumeOptions(value, { acsImage: `registry.example/acs@sha256:${'a'.repeat(64)}` }),
  );
  assert.deepEqual(sealed.artifacts.serverBundle, prior.index.artifacts.serverBundle);
  assert.deepEqual(sealed.artifacts.webAssets, prior.index.artifacts.webAssets);
  assert.deepEqual(sealed.artifacts.acsOrchestrator, prior.prepared.acsOrchestrator);
  assert.notEqual(sealed.aggregateDigest, prior.index.aggregateDigest);
});
test('kept ACS consumes only App/Web and does not relax index image pairing', async (t) => {
  const value = await preparedFixture(t);
  const sealed = await consumePreparedRelease(consumeOptions(value));
  assert.equal(sealed.acsImage, null);
  assert.equal(sealed.artifacts.acsOrchestrator, undefined);
});
for (const [label, overrides] of Object.entries({
  'PR producer': { GITHUB_EVENT_NAME: 'pull_request' },
  'other branch': { GITHUB_REF: 'refs/heads/other' },
  'other attempt': { GITHUB_RUN_ATTEMPT: '1' },
  'other run': { GITHUB_RUN_ID: '124' },
})) {
  test(`rejects ${label} even with a valid package checksum`, async (t) => {
    const value = await preparedFixture(t, overrides);
    await assert.rejects(consumePreparedRelease(consumeOptions(value)), /producer .* mismatch/u);
  });
}
test('rejects changed payload, lockfile, envelope and mutable image', async (t) => {
  const value = await preparedFixture(t);
  await assert.rejects(
    consumePreparedRelease(consumeOptions(value, { acsImage: 'registry.example/acs:latest' })),
    /immutable ACS/u,
  );
  await writeFile(join(value.root, 'acs.tgz'), 'tampered');
  await assert.rejects(consumePreparedRelease(consumeOptions(value)), /bytes differ/u);
  await writeFile(join(value.root, 'acs.tgz'), 'acs');
  await writeFile(join(value.root, 'pnpm-lock.yaml'), 'changed-lock');
  await assert.rejects(consumePreparedRelease(consumeOptions(value)), /lockfile differs/u);
  const preparedPath = join(value.root, 'prepared-release.json');
  const envelope = JSON.parse(await readFile(preparedPath, 'utf8'));
  envelope.producer.runAttempt = 100;
  await writeFile(preparedPath, JSON.stringify(envelope));
  await assert.rejects(consumePreparedRelease(consumeOptions(value)), /envelope digest/u);
});
