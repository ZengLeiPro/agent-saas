import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-release-'));
  await writeFile(join(root, 'server.tgz'), 'server');
  const runtimeIdentity = createRuntimeDependencyIdentity(
    await loadRuntimeDependencyContract(),
    SHA,
  );
  await writeFile(
    join(root, 'sbom.json'),
    `${canonicalJson({
      schemaVersion: 1,
      sourceSha: SHA,
      runtimeDependencies: {
        contractDigest: runtimeIdentity.contractDigest,
        dependencyDigest: runtimeIdentity.dependencyDigest,
      },
      packages: [],
    })}\n`,
  );
  await writeFile(join(root, 'runtime-dependencies.json'), `${canonicalJson(runtimeIdentity)}\n`);
  const runtimeDependencyArtifact = await digestFile(join(root, 'runtime-dependencies.json'));
  const body = {
    schemaVersion: 1,
    sourceSha: SHA,
    artifacts: {
      serverBundle: { path: 'server.tgz', ...(await digestFile(join(root, 'server.tgz'))) },
    },
    sbom: { path: 'sbom.json', ...(await digestFile(join(root, 'sbom.json'))) },
    runtimeDependencies: {
      path: 'runtime-dependencies.json',
      ...runtimeDependencyArtifact,
      contractDigest: runtimeIdentity.contractDigest,
      dependencyDigest: runtimeIdentity.dependencyDigest,
    },
    acsImage: null,
  };
  const index = { ...body, aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
  const path = join(root, 'artifact-index.json');
  await writeFile(path, JSON.stringify(index));
  return { root, path };
}

test('verifies content-addressed artifacts and exact source SHA', async () => {
  const value = await fixture();
  assert.equal((await verifyArtifactIndex(value.path, SHA)).sourceSha, SHA);
});

test('rejects one-byte artifact mutation', async () => {
  const value = await fixture();
  await writeFile(join(value.root, 'server.tgz'), 'server!');
  await assert.rejects(verifyArtifactIndex(value.path, SHA), /verification failed/u);
});

test('rejects runtime dependency manifest tampering', async () => {
  const value = await fixture();
  const identity = JSON.parse(
    await readFile(join(value.root, 'runtime-dependencies.json'), 'utf8'),
  );
  identity.node.version = '22.23.2';
  await writeFile(join(value.root, 'runtime-dependencies.json'), JSON.stringify(identity));
  await assert.rejects(verifyArtifactIndex(value.path, SHA), /verification failed/u);
});

test('rejects a content-addressed SBOM that conflicts with the runtime identity', async () => {
  const value = await fixture();
  const sbomPath = join(value.root, 'sbom.json');
  const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
  sbom.runtimeDependencies.dependencyDigest = `sha256:${'0'.repeat(64)}`;
  await writeFile(sbomPath, `${canonicalJson(sbom)}\n`);
  const index = JSON.parse(await readFile(value.path, 'utf8'));
  index.sbom = { path: 'sbom.json', ...(await digestFile(sbomPath)) };
  const { aggregateDigest: _aggregateDigest, ...body } = index;
  index.aggregateDigest = digestBuffer(Buffer.from(canonicalJson(body)));
  await writeFile(value.path, JSON.stringify(index));
  await assert.rejects(verifyArtifactIndex(value.path, SHA), /SBOM runtime dependency identity/u);
});

test('rejects runtime digests removed from both SBOM and artifact index', async () => {
  const value = await fixture();
  const sbomPath = join(value.root, 'sbom.json');
  const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
  delete sbom.runtimeDependencies.contractDigest;
  delete sbom.runtimeDependencies.dependencyDigest;
  await writeFile(sbomPath, `${canonicalJson(sbom)}\n`);
  const index = JSON.parse(await readFile(value.path, 'utf8'));
  index.sbom = { path: 'sbom.json', ...(await digestFile(sbomPath)) };
  delete index.runtimeDependencies.contractDigest;
  delete index.runtimeDependencies.dependencyDigest;
  const { aggregateDigest: _aggregateDigest, ...body } = index;
  index.aggregateDigest = digestBuffer(Buffer.from(canonicalJson(body)));
  await writeFile(value.path, JSON.stringify(index));
  await assert.rejects(
    verifyArtifactIndex(value.path, SHA),
    /Artifact index runtime dependency digests/u,
  );
});

test('rejects index mutation and path traversal', async () => {
  const value = await fixture();
  const index = JSON.parse(await readFile(value.path, 'utf8'));
  index.artifacts.serverBundle.path = '../server.tgz';
  await writeFile(value.path, JSON.stringify(index));
  await assert.rejects(verifyArtifactIndex(value.path, SHA), /aggregate digest mismatch/u);
});
