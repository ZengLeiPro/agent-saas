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
});
