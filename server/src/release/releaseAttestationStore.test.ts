import { mkdtemp, rm } from 'node:fs/promises';
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
});
