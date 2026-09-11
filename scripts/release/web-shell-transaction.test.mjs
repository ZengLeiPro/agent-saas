import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { snapshotShell, restoreShell } from './web-shell-transaction.mjs';

const missing = () => Object.assign(new Error('absent'), { status: 404, code: 'NoSuchKey' });
function store() {
  let counter = 0;
  const objects = new Map();
  const client = {
    objects,
    writes: [],
    head: async (key) => {
      const value = objects.get(key);
      if (!value) throw missing();
      return { status: 200, res: { headers: { ...value.headers } } };
    },
    get: async (key, sink) => {
      const value = objects.get(key);
      if (!value) throw missing();
      sink.end(value.bytes);
      return { res: { status: 200, headers: { ...value.headers } } };
    },
    put: async (key, bytes, { headers }) => {
      client.writes.push(key);
      objects.set(key, {
        bytes: Buffer.from(bytes),
        headers: { ...headers, etag: String(++counter) },
      });
    },
    delete: async (key) => {
      client.writes.push('-' + key);
      objects.delete(key);
    },
  };
  return client;
}
const identity = {
  releaseId: 'rc-20260911-01',
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  runId: '1',
  runAttempt: '2',
};
const headers = {
  'content-type': 'text/javascript',
  'content-encoding': 'gzip',
  'cache-control': 'no-cache',
  'x-oss-meta-owner': 'release',
};

test('T10: restores every overwritten PWA key and metadata, removes new keys, preserves hash assets', async (t) => {
  const backup = await mkdtemp(join(tmpdir(), 'shell-rollback-'));
  t.after(() => rm(backup, { recursive: true, force: true }));
  const client = store();
  const keys = [
    'index.html',
    'release-identity.json',
    'sw.js',
    'manifest.webmanifest',
    'icons/old.png',
    'icons/new.png',
  ];
  for (const key of keys.slice(0, -1))
    await client.put(key, Buffer.from('old:' + key), { headers });
  await client.put('assets/keep.js', Buffer.from('hash asset'), { headers });
  await snapshotShell({ client, keys, backup, identity });
  for (const key of keys)
    await client.put(key, Buffer.from('new:' + key), {
      headers: { 'cache-control': 'public', 'content-type': 'text/plain' },
    });
  const restored = await restoreShell({ client, backup, identity });
  assert.equal(restored.verified, true);
  assert.equal(client.objects.has('icons/new.png'), false);
  for (const key of keys.slice(0, -1)) {
    assert.equal(client.objects.get(key).bytes.toString(), 'old:' + key);
    assert.equal(client.objects.get(key).headers['content-encoding'], 'gzip');
    assert.equal(client.objects.get(key).headers['cache-control'], 'no-cache');
  }
  assert.equal(client.objects.get('assets/keep.js').bytes.toString(), 'hash asset');
  assert.equal(client.writes.at(-1), 'index.html');
});

test('snapshot and restore fail closed on 403, corrupt backup and another attempt identity', async (t) => {
  const backup = await mkdtemp(join(tmpdir(), 'shell-closed-'));
  t.after(() => rm(backup, { recursive: true, force: true }));
  await assert.rejects(
    snapshotShell({
      client: {
        head: async () => {
          throw Object.assign(new Error('denied'), { status: 403 });
        },
      },
      keys: ['index.html'],
      backup,
      identity,
    }),
    /denied/,
  );
  const client = store();
  await client.put('index.html', Buffer.from('old'), { headers });
  const snapshot = await snapshotShell({ client, keys: ['index.html'], backup, identity });
  await assert.rejects(
    restoreShell({ client, backup, identity: { ...identity, runAttempt: '3' } }),
    /different release/,
  );
  await writeFile(join(backup, snapshot.entries[0].file), 'corrupted');
  const count = client.writes.length;
  await assert.rejects(restoreShell({ client, backup, identity }), /Corrupt shell backup/);
  assert.equal(client.writes.length, count);
  assert.equal(JSON.parse(await readFile(join(backup, 'snapshot.json'))).entries.length, 1);
});
