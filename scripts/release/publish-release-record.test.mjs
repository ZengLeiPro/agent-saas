import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestBuffer, digestFile } from './artifact-lib.mjs';
import { publishReleaseRecord } from './publish-release-record.mjs';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
} from './runtime-dependency.mjs';

const SHA = 'b'.repeat(40);

test('publishes once and makes the same operation idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-record-'));
  const artifact = join(root, 'server.tgz');
  const sbom = join(root, 'sbom.json');
  await writeFile(artifact, 'server');
  const runtimeIdentity = createRuntimeDependencyIdentity(
    await loadRuntimeDependencyContract(),
    SHA,
  );
  await writeFile(
    sbom,
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
  const runtimeDependencies = join(root, 'runtime-dependencies.json');
  await writeFile(runtimeDependencies, `${canonicalJson(runtimeIdentity)}\n`);
  const body = {
    schemaVersion: 1,
    sourceSha: SHA,
    artifacts: { serverBundle: { path: 'server.tgz', ...(await digestFile(artifact)) } },
    sbom: { path: 'sbom.json', ...(await digestFile(sbom)) },
    runtimeDependencies: {
      path: 'runtime-dependencies.json',
      ...(await digestFile(runtimeDependencies)),
      contractDigest: runtimeIdentity.contractDigest,
      dependencyDigest: runtimeIdentity.dependencyDigest,
    },
    acsImage: null,
  };
  const index = { ...body, aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
  const indexPath = join(root, 'artifact-index.json');
  const manifestPath = join(root, 'manifest.json');
  await writeFile(indexPath, JSON.stringify(index));
  const manifestBody = { releaseId: 'rc-20260826-01', releaseSha: SHA };
  const manifestDigest = digestBuffer(
    Buffer.concat([
      Buffer.from('agent-saas-release-manifest-v1\0'),
      Buffer.from(canonicalJson(manifestBody)),
    ]),
  );
  await writeFile(manifestPath, JSON.stringify({ ...manifestBody, digest: manifestDigest }));
  const args = { manifestPath, indexPath, recordsRoot: join(root, 'records') };
  const first = await publishReleaseRecord(args);
  const second = await publishReleaseRecord(args);
  assert.deepEqual(second, first);
  assert.equal(first.manifestDigest, manifestDigest);
});
