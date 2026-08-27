import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReleaseAttestationStore } from './releaseAttestationStore.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = new Date('2026-08-26T08:00:00.000Z');

describe('ReleaseAttestationStore', () => {
  const directories: string[] = [];
  afterEach(async () =>
    Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
  );

  it('persists an append-only log and preserves idempotent operation keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-attestations-'));
    directories.push(root);
    const store = new ReleaseAttestationStore(root, { now: () => NOW });
    const input = {
      state: 'built' as const,
      operationKey: 'build-1',
      actor: 'release-bot',
      manifestDigest: DIGEST,
    };
    const first = await store.append('rc-20260826-01', DIGEST, input);
    await expect(store.append('rc-20260826-01', DIGEST, input)).resolves.toEqual(first);
    const restored = await store.read('rc-20260826-01', DIGEST);
    expect(restored.list()).toEqual([first]);
  });

  it('rejects cross-manifest reads and divergent operation-key reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-attestations-'));
    directories.push(root);
    const store = new ReleaseAttestationStore(root, { now: () => NOW });
    await store.append('rc-20260826-01', DIGEST, {
      state: 'built',
      operationKey: 'build-1',
      actor: 'release-bot',
      manifestDigest: DIGEST,
    });
    await expect(store.read('rc-20260826-01', `sha256:${'b'.repeat(64)}`)).rejects.toThrow(
      /digest/,
    );
    await expect(
      store.append('rc-20260826-01', DIGEST, {
        state: 'rejected',
        operationKey: 'build-1',
        actor: 'release-bot',
        manifestDigest: DIGEST,
      }),
    ).rejects.toThrow(/already used/);
  });

  it('serializes concurrent appends across store instances before validating transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-attestations-'));
    directories.push(root);
    const firstStore = new ReleaseAttestationStore(root, { now: () => NOW });
    const secondStore = new ReleaseAttestationStore(root, { now: () => NOW });
    const input = {
      state: 'built' as const,
      operationKey: 'build-concurrent',
      actor: 'release-bot',
      manifestDigest: DIGEST,
    };

    const results = await Promise.allSettled([
      firstStore.append('rc-20260826-01', DIGEST, input),
      secondStore.append('rc-20260826-01', DIGEST, input),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const restored = await firstStore.read('rc-20260826-01', DIGEST);
    expect(restored.list()).toHaveLength(1);
    expect(restored.currentState()).toBe('built');
  });

  it('allows only one of two divergent concurrent transitions and leaves a replayable log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-attestations-'));
    directories.push(root);
    const firstStore = new ReleaseAttestationStore(root, { now: () => NOW });
    const secondStore = new ReleaseAttestationStore(root, { now: () => NOW });
    const input = (operationKey: string) => ({
      state: 'built' as const,
      operationKey,
      actor: 'release-bot',
      manifestDigest: DIGEST,
    });

    const results = await Promise.allSettled([
      firstStore.append('rc-20260826-01', DIGEST, input('build-a')),
      secondStore.append('rc-20260826-01', DIGEST, input('build-b')),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(firstStore.read('rc-20260826-01', DIGEST)).resolves.toMatchObject({});
    expect((await firstStore.read('rc-20260826-01', DIGEST)).list()).toHaveLength(1);
  });

  it('recovers a same-host lock whose owner process no longer exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-attestations-'));
    directories.push(root);
    const releaseId = 'rc-20260826-01';
    const lockPath = join(root, `${releaseId}.jsonl.lock`);
    await writeFile(
      lockPath,
      JSON.stringify({
        token: 'abandoned-owner',
        pid: 424_242,
        hostname: 'release-host',
        acquiredAt: '2026-08-26T07:59:00.000Z',
      }),
    );
    const store = new ReleaseAttestationStore(root, {
      now: () => NOW,
      lockHostname: 'release-host',
      lockProcessExists: () => false,
      lockTimeoutMs: 100,
      lockRetryMs: 1,
    });

    await expect(
      store.append(releaseId, DIGEST, {
        state: 'built',
        operationKey: 'build-after-crash',
        actor: 'release-bot',
        manifestDigest: DIGEST,
      }),
    ).resolves.toMatchObject({ state: 'built' });
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.read(releaseId, DIGEST)).list()).toHaveLength(1);
  });

  it('does not steal a lock while its same-host owner is still alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-attestations-'));
    directories.push(root);
    const releaseId = 'rc-20260826-01';
    const lockPath = join(root, `${releaseId}.jsonl.lock`);
    await writeFile(
      lockPath,
      JSON.stringify({
        token: 'live-owner',
        pid: 101,
        hostname: 'release-host',
        acquiredAt: '2026-08-26T07:59:00.000Z',
      }),
    );
    const store = new ReleaseAttestationStore(root, {
      now: () => NOW,
      lockHostname: 'release-host',
      lockProcessExists: () => true,
      lockTimeoutMs: 20,
      lockRetryMs: 1,
    });

    await expect(
      store.append(releaseId, DIGEST, {
        state: 'built',
        operationKey: 'build-blocked',
        actor: 'release-bot',
        manifestDigest: DIGEST,
      }),
    ).rejects.toThrow(/Timed out acquiring attestation lock/u);
    await expect(access(lockPath)).resolves.toBeUndefined();
  });
});
