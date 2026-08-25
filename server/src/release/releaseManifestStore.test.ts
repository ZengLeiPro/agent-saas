import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { calculateManifestDigest, ReleaseManifestStore } from './releaseManifestStore.js';

const SHA = 'a'.repeat(40);
const BASELINE = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;

function manifestFor(releaseId = 'rc-20260825-01') {
  const unsigned = {
    releaseId,
    releaseSha: SHA,
    productionBaseline: { web: BASELINE, api: BASELINE, runtimeWorker: BASELINE, acs: BASELINE },
    components: {
      web: { action: 'deploy' as const, sourceSha: SHA },
      api: { action: 'deploy' as const, sourceSha: SHA },
      runtimeWorker: { action: 'keep' as const, sourceSha: BASELINE },
      acs: { action: 'keep' as const, sourceSha: BASELINE },
    },
    rollbackTargets: { web: BASELINE, api: BASELINE, runtimeWorker: BASELINE, acs: BASELINE },
    artifacts: [{ id: 'server-bundle', component: 'api' as const, uri: 'file:///releases/server.tgz', digest: DIGEST }],
  };
  return { ...unsigned, digest: calculateManifestDigest(unsigned) };
}

describe('ReleaseManifestStore', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  it('creates and reads a digest-verified canonical manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-manifest-'));
    directories.push(root);
    const store = new ReleaseManifestStore(root);
    const created = await store.create(manifestFor());
    expect(created.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(store.read('rc-20260825-01')).resolves.toEqual(created);
  });

  it('refuses to overwrite an existing manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-manifest-'));
    directories.push(root);
    const store = new ReleaseManifestStore(root);
    await store.create(manifestFor());
    await expect(store.create(manifestFor())).rejects.toThrow(/immutable/);
  });

  it('rejects a digest mismatch both before write and on read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-manifest-'));
    directories.push(root);
    const store = new ReleaseManifestStore(root);
    await expect(store.create({ ...manifestFor(), digest: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(/digest/);
    const good = manifestFor();
    await writeFile(join(root, 'rc-20260825-01.json'), JSON.stringify({ ...good, artifacts: [{ ...good.artifacts![0], uri: 'file:///releases/tampered.tgz' }] }));
    await expect(store.read('rc-20260825-01')).rejects.toThrow(/digest/);
  });
});
