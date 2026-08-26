import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assembleReleaseEvidence } from './assemble-release-evidence.mjs';
import { canonicalJson, digestBuffer, digestFile } from './artifact-lib.mjs';

const SHA = 'a'.repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-evidence-'));
  await writeFile(join(root, 'server.tgz'), 'server');
  await writeFile(join(root, 'web.tgz'), 'web');
  await writeFile(join(root, 'sbom.json'), '{}');
  const body = {
    schemaVersion: 1,
    sourceSha: SHA,
    artifacts: {
      serverBundle: { path: 'server.tgz', ...(await digestFile(join(root, 'server.tgz'))) },
      webAssets: { path: 'web.tgz', ...(await digestFile(join(root, 'web.tgz'))) },
    },
    sbom: { path: 'sbom.json', ...(await digestFile(join(root, 'sbom.json'))) },
    acsImage: null,
  };
  const index = { ...body, aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
  await writeFile(join(root, 'index.json'), JSON.stringify(index));
  await writeFile(
    join(root, 'authoritative.json'),
    JSON.stringify({
      ok: true,
      releaseSha: SHA,
      evidenceDigest: `sha256:${'1'.repeat(64)}`,
      productionBaselineStatus: 'known',
      integrationCandidates: [],
      sourcePullRequests: [],
      checks: {},
      productionBaseline: {},
      affectedComponents: ['web'],
      baselineArtifacts: {},
    }),
  );
  return root;
}

test('binds built artifact URIs to the internally selected release', async () => {
  const root = await fixture();
  const value = await assembleReleaseEvidence({
    authoritative: join(root, 'authoritative.json'),
    index: join(root, 'index.json'),
    sha: SHA,
    'release-id': 'rc-20260826-22',
    actor: 'operator',
    'created-at': '2026-08-26T01:00:00.000Z',
    'expires-at': '2026-08-27T01:00:00.000Z',
    'artifact-base-uri': 'oss://agent-saas-releases',
    output: join(root, 'output.json'),
  });
  assert.equal(
    value.builtArtifacts.serverBundle.uri,
    'oss://agent-saas-releases/rc-20260826-22/server.tgz',
  );
});

test('fails closed on an unknown production baseline', async () => {
  const root = await fixture();
  const path = join(root, 'authoritative.json');
  const value = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
  value.productionBaselineStatus = 'unknown';
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(
    assembleReleaseEvidence({
      authoritative: path,
      index: join(root, 'index.json'),
      sha: SHA,
      'release-id': 'rc-20260826-22',
      actor: 'operator',
      'created-at': '2026-08-26T01:00:00.000Z',
      'expires-at': '2026-08-27T01:00:00.000Z',
      'artifact-base-uri': 'oss://agent-saas-releases',
      output: join(root, 'output.json'),
    }),
    /baseline is unknown/u,
  );
});
