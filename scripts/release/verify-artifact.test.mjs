import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestBuffer, digestFile } from './artifact-lib.mjs';
import { verifyArtifactIndex } from './verify-artifact.mjs';

const SHA = 'a'.repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-release-'));
  await writeFile(join(root, 'server.tgz'), 'server');
  await writeFile(join(root, 'sbom.json'), '{}');
  const body = {
    schemaVersion: 1,
    sourceSha: SHA,
    artifacts: {
      serverBundle: { path: 'server.tgz', ...(await digestFile(join(root, 'server.tgz'))) },
    },
    sbom: { path: 'sbom.json', ...(await digestFile(join(root, 'sbom.json'))) },
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

test('rejects index mutation and path traversal', async () => {
  const value = await fixture();
  const index = JSON.parse(await readFile(value.path, 'utf8'));
  index.artifacts.serverBundle.path = '../server.tgz';
  await writeFile(value.path, JSON.stringify(index));
  await assert.rejects(verifyArtifactIndex(value.path, SHA), /aggregate digest mismatch/u);
});
