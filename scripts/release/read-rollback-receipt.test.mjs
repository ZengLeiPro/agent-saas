import assert from 'node:assert/strict';
import test from 'node:test';
import { readRollbackReceipt } from './read-rollback-receipt.mjs';
const expected = {
  component: 'acs',
  state: 'succeeded',
  releaseId: 'rc-20260911-01',
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  runId: '12',
  runAttempt: '2',
};
const good = { schemaVersion: 1, ...expected };
const io = (value) => ({
  lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
  readFile: async () => JSON.stringify(value),
});
test('T14: receipt absence, permission failure, malformed and stale identity are distinct', async () => {
  for (const [code, state] of [
    ['ENOENT', 'absent'],
    ['EACCES', 'unreadable'],
    ['EIO', 'unreadable'],
  ]) {
    assert.equal(
      (
        await readRollbackReceipt('file', expected, {
          lstat: async () => {
            throw Object.assign(new Error(), { code });
          },
        })
      ).state,
      state,
    );
  }
  assert.equal((await readRollbackReceipt('file', expected, io(good))).state, 'present');
  for (const key of Object.keys(expected)) {
    assert.equal(
      (await readRollbackReceipt('file', expected, io({ ...good, [key]: 'stale' }))).state,
      'invalid',
    );
  }
  assert.equal((await readRollbackReceipt('file', expected, io(null))).state, 'invalid');
});

test('ACS pre-change recovery remains bound to the exact run attempt', async () => {
  const recoveryExpected = { ...expected, state: 'prechange_recovered' };
  const recovery = { schemaVersion: 1, ...recoveryExpected };
  assert.equal(
    (await readRollbackReceipt('file', recoveryExpected, io(recovery))).state,
    'present',
  );
  assert.equal(
    (await readRollbackReceipt('file', { ...recoveryExpected, runAttempt: '3' }, io(recovery)))
      .state,
    'invalid',
  );
});
