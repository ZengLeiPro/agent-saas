import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { digestBuffer } from './artifact-lib.mjs';
import { prefetchPromotionArtifacts } from './prefetch-promotion-artifacts.mjs';

function fixture() {
  const blobs = new Map();
  const entry = (name, content) => {
    const body = Buffer.from(content);
    const uri = `oss://release/rc-20260908-01/${name}`;
    blobs.set(uri, body);
    return { path: name, uri, digest: digestBuffer(body), size: body.length };
  };
  const server = entry('server-bundle.tgz', 'server');
  const web = entry('web-assets.tgz', 'web');
  const acs = entry('acs-orchestrator.tgz', 'acs');
  const runtime = entry('runtime-dependencies.json', 'runtime');
  const sbom = entry('sbom.json', 'sbom');
  return {
    blobs,
    index: {
      schemaVersion: 2,
      artifacts: { serverBundle: server, webAssets: web, acsOrchestrator: acs },
      runtimeDependencies: runtime,
      sbom,
    },
    manifest: {
      schemaVersion: 2,
      artifacts: {
        serverBundle: server,
        webAssets: web,
        acsOrchestrator: acs,
        runtimeDependencies: { server: runtime, acs: runtime },
      },
    },
  };
}
async function withDirectory(run) {
  const output = await mkdtemp(join(tmpdir(), 'prefetch-promotion-test-'));
  try {
    await run(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

test('built and selected identities share verified bytes, with bounded parallelism and cache revalidation', () =>
  withDirectory(async (output) => {
    const f = fixture();
    let active = 0,
      peak = 0,
      transfers = 0;
    const download = async (uri, path) => {
      active++;
      peak = Math.max(peak, active);
      transfers++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(path, f.blobs.get(uri));
      active--;
    };
    const args = {
      ...f,
      output,
      baseUri: 'oss://release/rc-20260908-01',
      download,
      concurrency: 2,
    };
    const result = await prefetchPromotionArtifacts(args);
    assert.equal(result.downloads, 5);
    assert.equal(result.reusedCopies, 5);
    assert.equal(peak, 2);
    assert.equal(
      (await readFile(join(output, 'selected/runtime-dependencies-acs.json'))).toString(),
      'runtime',
    );
    assert.equal((await prefetchPromotionArtifacts(args)).downloads, 0);
    assert.equal(transfers, 5);
    const server = f.index.artifacts.serverBundle;
    await writeFile(
      join(output, 'promotion-download-cache', `${server.digest.slice(7)}-${server.size}`),
      'broken',
    );
    assert.equal((await prefetchPromotionArtifacts(args)).downloads, 1);
    assert.equal(transfers, 6);
  }));

test('kept baseline bytes are downloaded independently from new built bytes', () =>
  withDirectory(async (output) => {
    const f = fixture();
    const body = Buffer.from('old verified web');
    const uri = 'oss://release/rc-20260901-01/web-assets.tgz';
    f.blobs.set(uri, body);
    f.manifest.artifacts.webAssets = { uri, digest: digestBuffer(body), size: body.length };
    const result = await prefetchPromotionArtifacts({
      ...f,
      output,
      baseUri: 'oss://release/rc-20260908-01',
      download: async (uri, path) => writeFile(path, f.blobs.get(uri)),
    });
    assert.equal(result.downloads, 6);
    assert.equal(
      (await readFile(join(output, 'selected/web-assets.tgz'))).toString(),
      'old verified web',
    );
    assert.equal((await readFile(join(output, 'built/web-assets.tgz'))).toString(), 'web');
  }));

test('corrupt transfer and unsafe paths fail before publishing selected bytes', () =>
  withDirectory(async (output) => {
    const f = fixture();
    const args = {
      ...f,
      output,
      baseUri: 'oss://release/rc-20260908-01',
      concurrency: 1,
      download: async (_uri, path) => writeFile(path, 'broken'),
    };
    await assert.rejects(prefetchPromotionArtifacts(args), /digest mismatch|byte size mismatch/);
    await assert.rejects(readFile(join(output, 'selected/server-bundle.tgz')), { code: 'ENOENT' });
    f.index.artifacts.serverBundle.path = '../escaped';
    await assert.rejects(prefetchPromotionArtifacts(args), /Unsafe built/);
  }));
