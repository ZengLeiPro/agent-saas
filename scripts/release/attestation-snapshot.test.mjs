import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAttestationSnapshot, selectAttestationSnapshot } from './attestation-snapshot.mjs';

const RELEASE_ID = 'rc-20260827-01';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const entry = (state, operationKey, second) => ({
  id: operationKey,
  releaseId: RELEASE_ID,
  manifestDigest: DIGEST,
  state,
  operationKey,
  actor: 'release-bot',
  recordedAt: `2026-08-27T00:00:0${second}.000Z`,
});

test('creates immutable snapshots and restores the sole longest prefix chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attestation-snapshot-'));
  const log = join(root, 'log.jsonl');
  await writeFile(log, `${JSON.stringify(entry('built', 'build', 1))}\n`);
  const first = await createAttestationSnapshot(log, join(root, 'snapshots'));
  await writeFile(log, `${JSON.stringify(entry('staging_deployed', 'staging', 2))}\n`, {
    flag: 'a',
  });
  const second = await createAttestationSnapshot(log, join(root, 'snapshots'));
  const restored = join(root, 'restored.jsonl');
  const selected = await selectAttestationSnapshot([first.path, second.path], restored);
  assert.equal(selected.sequence, 2);
  assert.equal((await readFile(restored, 'utf8')).split('\n').filter(Boolean).length, 2);
});

test('rejects a fork instead of silently choosing one history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'attestation-fork-'));
  const first = join(root, 'first.jsonl');
  const fork = join(root, 'fork.jsonl');
  await writeFile(first, `${JSON.stringify(entry('built', 'build-a', 1))}\n`);
  await writeFile(fork, `${JSON.stringify(entry('built', 'build-b', 1))}\n`);
  await assert.rejects(
    selectAttestationSnapshot([first, fork], join(root, 'restored.jsonl')),
    /fork detected/u,
  );
});
