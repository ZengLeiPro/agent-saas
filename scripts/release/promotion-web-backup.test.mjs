import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { snapshotShell } from './web-shell-transaction.mjs';

const identity = { releaseId: 'rc-20260911-01', manifestDigest: 'sha256:' + 'a'.repeat(64), runId: '1', runAttempt: '1' };
const notFound = () => Object.assign(new Error('absent'), { status: 404, code: 'NoSuchKey' });

test('shell backup uses exact Head/GetObject rather than ACL or prefix listing', async (t) => {
  const backup = await mkdtemp(join(tmpdir(), 'web-backup-'));
  t.after(() => rm(backup, { recursive: true, force: true }));
  const calls = [];
  const client = {
    head: async (key) => { calls.push(key); if (key !== 'index.html') throw notFound(); return { status: 200, res: { headers: { etag: 'old', 'content-type': 'text/html' } } }; },
    get: async (key, sink) => { assert.equal(key, 'index.html'); sink.end('old index'); return { res: { status: 200, headers: { etag: 'old', 'content-type': 'text/html' } } }; },
  };
  const result = await snapshotShell({ client, backup, identity, keys: ['index.html', 'release-identity.json'] });
  assert.deepEqual(calls, ['index.html', 'release-identity.json']);
  assert.equal(result.entries[1].existed, false);
  assert.equal(await readFile(join(backup, result.entries[0].file), 'utf8'), 'old index');
});

for (const operation of ['head', 'get']) test(`shell backup propagates ${operation} AccessDenied and never arms rollback`, async (t) => {
  const backup = await mkdtemp(join(tmpdir(), 'web-denied-'));
  t.after(() => rm(backup, { recursive: true, force: true }));
  const client = {
    head: async () => ({ status: 200, res: { headers: { etag: 'old' } } }),
    get: async () => ({ res: { status: 200, headers: { etag: 'old' } } }),
    [operation]: async () => { throw Object.assign(new Error('AccessDenied'), { status: 403 }); },
  };
  await assert.rejects(snapshotShell({ client, backup, identity, keys: ['index.html'] }), /AccessDenied/);
  await assert.rejects(readFile(join(backup, 'snapshot.json')), { code: 'ENOENT' });
});

test('production snapshots the whole shell before enabling rollback or writing hash/entry objects', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/promote-release.yml', import.meta.url), 'utf8');
  const snapshot = workflow.indexOf('web-shell-transaction.mjs snapshot');
  const armed = workflow.indexOf('web_backup_ready=true', snapshot);
  assert.ok(snapshot > 0 && armed > snapshot);
  assert.ok(workflow.indexOf('web-shell-transaction.mjs restore', snapshot) > snapshot);
  assert.ok(workflow.indexOf('run_with_web_lock aliyun --secure oss cp "$RUNNER_TEMP/web-shell/"', armed) > armed);
});
