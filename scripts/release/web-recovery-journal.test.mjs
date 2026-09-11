import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { snapshotShell, restoreShell } from './web-shell-transaction.mjs';
import {
  packCapsule,
  unpackCapsule,
  validateCapsule,
  saveJournal,
  inspectJournal,
  finishJournal,
} from './web-recovery-journal.mjs';

const identity = {
  releaseId: 'rc-20260911-01',
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  runId: '123',
  runAttempt: '1',
};
const cold = '/opt/agent-saas-web-recovery/releases/old-release';
const absent = () => Object.assign(new Error('absent'), { status: 404, code: 'NoSuchKey' });
function store() {
  let sequence = 0;
  const objects = new Map();
  const client = {
    objects,
    writes: [],
    async head(key) {
      const item = objects.get(key);
      if (!item) throw absent();
      return { status: 200, res: { headers: item.headers } };
    },
    async get(key, sink) {
      const item = objects.get(key);
      if (!item) throw absent();
      sink.end(item.bytes);
      return { res: { status: 200, headers: item.headers } };
    },
    async put(key, bytes, { headers }) {
      client.writes.push(key);
      objects.set(key, {
        bytes: Buffer.from(bytes),
        headers: { ...headers, etag: String(++sequence) },
      });
    },
    async delete(key) {
      client.writes.push('-' + key);
      objects.delete(key);
    },
  };
  return client;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'web-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = join(root, 'runner-one'),
    targetRoot = join(root, 'target'),
    host = join(root, 'host');
  await mkdir(targetRoot);
  const client = store();
  const keys = ['index.html', 'sw.js', 'manifest.webmanifest', 'new-icon.png'];
  for (const key of keys) {
    await writeFile(join(targetRoot, key), 'new:' + key);
    if (key !== 'new-icon.png')
      await client.put(key, Buffer.from('old:' + key), {
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-cache' },
      });
  }
  await client.put('assets/old.js', Buffer.from('immutable'), { headers: {} });
  await snapshotShell({ client, keys, backup, identity, targetRoot });
  return { root, backup, targetRoot, host, client, keys, capsule: await packCapsule(backup, cold) };
}

test('T17: a fresh runner restores complete old bytes, metadata and absence from host-only durable capsule', async (t) => {
  const f = await fixture(t);
  const receipt = await saveJournal(f.host, f.capsule);
  // Simulate the original runner disappearing after part or all of its mutable writes.
  for (const key of f.keys)
    await f.client.put(key, await readFile(join(f.targetRoot, key)), {
      headers: { 'cache-control': 'public' },
    });
  await rm(f.backup, { recursive: true });
  const recovered = await inspectJournal(f.host, identity.releaseId, identity.manifestDigest);
  assert.equal(recovered.pending, true);
  assert.equal(recovered.capsuleDigest, receipt.capsuleDigest);
  const backup = join(f.root, 'runner-two');
  await unpackCapsule(recovered.capsule, backup);
  await restoreShell({ client: f.client, backup, identity: recovered.identity, verifyOnly: true });
  await restoreShell({ client: f.client, backup, identity: recovered.identity });
  for (const key of f.keys.slice(0, -1)) {
    assert.equal(f.client.objects.get(key).bytes.toString(), 'old:' + key);
    assert.equal(f.client.objects.get(key).headers['cache-control'], 'no-cache');
  }
  assert.equal(f.client.objects.has('new-icon.png'), false);
  assert.equal(f.client.objects.get('assets/old.js').bytes.toString(), 'immutable');
  assert.equal(f.client.writes.at(-1), 'index.html');
  await finishJournal(
    f.host,
    identity.releaseId,
    identity.manifestDigest,
    receipt.capsuleDigest,
    'rolled_back',
  );
  assert.equal(
    (await inspectJournal(f.host, identity.releaseId, identity.manifestDigest)).pending,
    false,
  );
  assert.equal((await stat(join(f.host, `${receipt.capsuleDigest}.json`))).mode & 0o777, 0o600);
});

test('T17: repeat after backup/commit acknowledgement loss is idempotent and never replaces an unresolved snapshot', async (t) => {
  const f = await fixture(t);
  const first = await saveJournal(f.host, f.capsule);
  assert.equal((await saveJournal(f.host, f.capsule)).capsuleDigest, first.capsuleDigest);
  const another = structuredClone(f.capsule);
  another.snapshot.identity.runAttempt = '2';
  await assert.rejects(saveJournal(f.host, another), /original unresolved/);
  const result = await finishJournal(
    f.host,
    identity.releaseId,
    identity.manifestDigest,
    first.capsuleDigest,
    'committed',
  );
  assert.equal(
    (
      await finishJournal(
        f.host,
        identity.releaseId,
        identity.manifestDigest,
        first.capsuleDigest,
        'committed',
      )
    ).verifiedAt,
    result.verifiedAt,
  );
  await assert.rejects(
    finishJournal(
      f.host,
      identity.releaseId,
      identity.manifestDigest,
      first.capsuleDigest,
      'rolled_back',
    ),
    /cannot be rewritten/,
  );
  await assert.rejects(saveJournal(f.host, f.capsule), /cannot reopen/);
  await saveJournal(f.host, another);
  await assert.rejects(
    finishJournal(
      f.host,
      identity.releaseId,
      identity.manifestDigest,
      first.capsuleDigest,
      'committed',
    ),
    /Stale/,
  );
});

test('T17: another RC or manifest is blocked before mutations while a Web transaction is unresolved', async (t) => {
  const f = await fixture(t);
  await saveJournal(f.host, f.capsule);
  await assert.rejects(
    inspectJournal(f.host, 'rc-20260911-02', identity.manifestDigest),
    /another release/,
  );
  await assert.rejects(
    inspectJournal(f.host, identity.releaseId, 'sha256:' + 'b'.repeat(64)),
    /another release/,
  );
});

for (const change of ['corrupt', 'missing', 'symlink'])
  test(`T17: ${change} persistent recovery capsule fails closed`, async (t) => {
    const f = await fixture(t);
    const receipt = await saveJournal(f.host, f.capsule);
    const path = join(f.host, receipt.capsuleDigest + '.json');
    if (change === 'corrupt') await writeFile(path, '{}');
    else {
      await rm(path);
      if (change === 'symlink') await symlink(join(f.backup, 'snapshot.json'), path);
    }
    await assert.rejects(inspectJournal(f.host, identity.releaseId, identity.manifestDigest));
  });

test('T17: unexpected current bytes cause zero restoring writes, while partial restoration can safely resume', async (t) => {
  const f = await fixture(t);
  await f.client.put('sw.js', Buffer.from('new:sw.js'), { headers: {} });
  await f.client.put('index.html', Buffer.from('unrelated release'), { headers: {} });
  const before = f.client.writes.length;
  await assert.rejects(
    restoreShell({ client: f.client, backup: f.backup, identity }),
    /outside the original/,
  );
  assert.equal(f.client.writes.length, before);
  await f.client.put('index.html', Buffer.from('old:index.html'), { headers: {} });
  await restoreShell({ client: f.client, backup: f.backup, identity });
  await restoreShell({ client: f.client, backup: f.backup, identity });
  assert.equal(f.client.objects.get('sw.js').bytes.toString(), 'old:sw.js');
});

for (const mutation of [
  (c) => {
    c.snapshot.entries[0].key = '../escape';
  },
  (c) => {
    c.snapshot.entries.push(c.snapshot.entries[0]);
  },
  (c) => {
    c.snapshot.entries[0].targetDigest = '';
  },
  (c) => {
    c.snapshot.entries[0].metadata.authorization = 'private';
  },
  (c) => {
    c.files[c.snapshot.entries[0].file] = Buffer.from('tampered').toString('base64');
  },
  (c) => {
    c.recoveryBefore = '/opt/agent-saas-web-recovery/releases/../secrets';
  },
])
  test('capsule rejects unbound paths, inventory, target bytes, metadata or stored bytes before export', async (t) => {
    const f = await fixture(t);
    mutation(f.capsule);
    assert.throws(() => validateCapsule(f.capsule));
  });

for (const state of ['pending', 'committed'])
  test(
    `T17: durable ${state} state survives an actual SIGKILL and a fresh process`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const capsuleFile = join(f.root, 'input.json');
      await writeFile(capsuleFile, JSON.stringify(f.capsule), { mode: 0o600 });
      const moduleUrl = new URL('./web-recovery-journal.mjs', import.meta.url).href;
      const program = `
      import { readFile } from 'node:fs/promises';
      import { saveJournal, finishJournal } from ${JSON.stringify(moduleUrl)};
      const [root, capsulePath, state] = process.argv.slice(1);
      const capsule = JSON.parse(await readFile(capsulePath, 'utf8'));
      const receipt = await saveJournal(root, capsule);
      if (state === 'committed') await finishJournal(root, capsule.snapshot.identity.releaseId,
        capsule.snapshot.identity.manifestDigest, receipt.capsuleDigest, 'committed');
      process.stdout.write('BARRIER_DURABLE');
      setInterval(() => {}, 1000); // parent kills us before any simulated caller acknowledgement
    `;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', program, f.host, capsuleFile, state],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const closed = once(child, 'close');
      t.after(() => child.kill('SIGKILL'));
      const [chunk] = await once(child.stdout, 'data');
      assert.equal(chunk.toString(), 'BARRIER_DURABLE');
      assert.equal(child.kill('SIGKILL'), true);
      assert.equal((await closed)[1], 'SIGKILL');
      await rm(f.backup, { recursive: true }); // all original runner recovery material is gone
      const inspected = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { inspectJournal } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await inspectJournal(...process.argv.slice(1))));
    `,
          f.host,
          identity.releaseId,
          identity.manifestDigest,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      const recovered = JSON.parse(inspected);
      assert.equal(recovered.state, state);
      assert.equal(recovered.pending, state === 'pending');
      if (state === 'pending') assert.deepEqual(recovered.capsule, f.capsule);
      else
        await assert.rejects(
          finishJournal(
            f.host,
            identity.releaseId,
            identity.manifestDigest,
            recovered.capsuleDigest,
            'rolled_back',
          ),
          /cannot be rewritten/,
        );
    },
  );

test('orphan temporary files after interrupted writes do not block a fresh durable attempt', async (t) => {
  const f = await fixture(t);
  await mkdir(f.host);
  await writeFile(join(f.host, `active.json.${process.pid}.candidate`), 'incomplete');
  const saved = await saveJournal(f.host, f.capsule);
  assert.equal(
    (await inspectJournal(f.host, identity.releaseId, identity.manifestDigest)).capsuleDigest,
    saved.capsuleDigest,
  );
});
