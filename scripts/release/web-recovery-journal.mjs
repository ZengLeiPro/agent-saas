#!/usr/bin/env node
// Private host journal. The caller must hold the existing production host lock.
// No credentials, application payloads, tar extraction, or network calls belong here.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, lstat, writeFile, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const JOURNAL_ROOT = '/var/lib/agent-saas-release-recovery/web';
const LIMIT = 96 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
export function validateIdentity(value) {
  assert(value && /^rc-\d{8}-\d{2,}$/u.test(value.releaseId), 'Invalid recovery release');
  assert(/^sha256:[a-f0-9]{64}$/u.test(value.manifestDigest), 'Invalid recovery manifest');
  assert(
    /^[1-9]\d*$/u.test(value.runId) && /^[1-9]\d*$/u.test(value.runAttempt),
    'Invalid recovery operation',
  );
  return value;
}
function validKey(key) {
  return (
    typeof key === 'string' &&
    key.length <= 512 &&
    keyPattern.test(key) &&
    !key.split('/').some((part) => !part || part === '..' || part === '.') &&
    key !== 'assets' &&
    !key.startsWith('assets/')
  );
}
export function validateCapsule(capsule) {
  assert(capsule?.schemaVersion === 1, 'Unsupported recovery capsule');
  const snapshot = capsule.snapshot;
  assert(
    !['.', '..'].includes(capsule.recoveryBefore?.split('/').at(-1)),
    'Invalid cold recovery target',
  );
  validateIdentity(snapshot?.identity);
  assert(
    snapshot.schemaVersion === 1 &&
      Array.isArray(snapshot.entries) &&
      snapshot.entries.length > 0 &&
      snapshot.entries.length <= 1024,
    'Invalid recovery inventory',
  );
  assert(
    /^\/opt\/agent-saas-web-recovery\/releases\/[A-Za-z0-9._-]+$/u.test(capsule.recoveryBefore),
    'Invalid cold recovery target',
  );
  const keys = new Set();
  const expectedFiles = [];
  let bytes = 0;
  for (const entry of snapshot.entries) {
    assert(validKey(entry.key) && !keys.has(entry.key), 'Invalid or duplicate recovery key');
    keys.add(entry.key);
    assert(digestPattern.test(entry.targetDigest), 'Missing intended target digest');
    assert(typeof entry.existed === 'boolean', 'Missing existence proof');
    if (!entry.existed) continue;
    assert(
      entry.file === hash(entry.key) + '.bin' && digestPattern.test(entry.digest),
      'Invalid recovery file',
    );
    assert(
      entry.metadata &&
        Object.entries(entry.metadata).every(
          ([key, value]) =>
            /^(content-type|content-encoding|cache-control|content-disposition|content-language|expires|x-oss-meta-[a-z0-9_-]+)$/u.test(
              key,
            ) &&
            typeof value === 'string' &&
            value.length <= 8192 &&
            !/[\r\n]/u.test(value),
        ),
      'Invalid recovery metadata',
    );
    const encoded = capsule.files?.[entry.file];
    assert(typeof encoded === 'string', 'Recovery bytes missing');
    const content = Buffer.from(encoded, 'base64');
    assert(
      content.toString('base64') === encoded && hash(content) === entry.digest,
      'Recovery bytes corrupt',
    );
    bytes += content.length;
    assert(bytes <= 64 * 1024 * 1024, 'Recovery bytes exceed limit');
    expectedFiles.push(entry.file);
  }
  assert.deepEqual(
    Object.keys(capsule.files ?? {}).sort(),
    expectedFiles.sort(),
    'Unexpected recovery files',
  );
  return capsule;
}
async function boundedRead(path) {
  const stat = await lstat(path);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMIT,
    'Invalid recovery file boundary',
  );
  return readFile(path);
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  assert(
    (await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink(),
    'Recovery directory must not be a symlink',
  );
  // Persist newly created directory links too, including the first operation after installation.
  for (
    let parent = resolve(path, '..');
    parent !== resolve(parent, '..');
    parent = resolve(parent, '..')
  ) {
    assert(!(await lstat(parent)).isSymbolicLink(), 'Recovery ancestors must not be symlinks');
    await syncDirectory(parent);
  }
}
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function durableWrite(path, bytes, exclusive = false) {
  // Never expose an incomplete content-addressed object after SIGKILL. Only a
  // fully fsynced temporary inode may become the immutable capsule/active pointer.
  const temporary = `${path}.${randomUUID()}.candidate`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive)
      await link(temporary, path); // atomic create-only, never clobber
    else await rename(temporary, path);
    await syncDirectory(resolve(path, '..'));
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function packCapsule(backup, recoveryBefore) {
  const snapshot = JSON.parse(await boundedRead(join(backup, 'snapshot.json')));
  const files = {};
  for (const entry of snapshot.entries) {
    if (entry.existed) {
      assert(entry.file === hash(entry.key) + '.bin', 'Invalid backup path');
      files[entry.file] = (await boundedRead(join(backup, entry.file))).toString('base64');
    }
  }
  return validateCapsule({ schemaVersion: 1, recoveryBefore, snapshot, files });
}
export async function unpackCapsule(capsule, backup) {
  validateCapsule(capsule); // Complete validation BEFORE writing anything.
  await privateDirectory(backup);
  for (const [file, bytes] of Object.entries(capsule.files))
    await writeFile(join(backup, file), Buffer.from(bytes, 'base64'), { flag: 'wx', mode: 0o600 });
  await writeFile(join(backup, 'snapshot.json'), JSON.stringify(capsule.snapshot) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return capsule.snapshot.identity;
}
export async function inspectJournal(root, releaseId, manifestDigest) {
  let active;
  try {
    active = JSON.parse(await boundedRead(join(root, 'active.json')));
  } catch (error) {
    if (error.code === 'ENOENT') return { pending: false };
    throw error;
  }
  assert(active.schemaVersion === 1, 'Unsupported recovery journal');
  validateIdentity(active.identity);
  assert(
    digestPattern.test(active.capsuleDigest) &&
      ['pending', 'committed', 'rolled_back'].includes(active.state),
    'Invalid recovery receipt',
  );
  if (active.state !== 'pending') return { ...active, pending: false };
  assert(
    active.identity.releaseId === releaseId && active.identity.manifestDigest === manifestDigest,
    'An unresolved Web transaction belongs to another release; recover that exact release first',
  );
  const bytes = await boundedRead(join(root, `${active.capsuleDigest}.json`));
  assert(hash(bytes) === active.capsuleDigest, 'Persistent Web recovery capsule is corrupt');
  const capsule = validateCapsule(JSON.parse(bytes));
  assert.deepEqual(capsule.snapshot.identity, active.identity, 'Recovery identity mismatch');
  return { pending: true, ...active, capsule };
}
export async function saveJournal(root, capsule) {
  validateCapsule(capsule);
  await privateDirectory(root);
  const identity = capsule.snapshot.identity;
  const prior = await inspectJournal(root, identity.releaseId, identity.manifestDigest);
  const bytes = Buffer.from(JSON.stringify(capsule) + '\n');
  assert(bytes.length <= LIMIT, 'Recovery capsule exceeds limit');
  const capsuleDigest = hash(bytes);
  if (prior.pending) {
    assert(
      prior.capsuleDigest === capsuleDigest,
      'Never replace the original unresolved Web snapshot',
    );
    return { pending: true, identity, capsuleDigest };
  }
  assert(
    !prior.identity ||
      prior.identity.runId !== identity.runId ||
      prior.identity.runAttempt !== identity.runAttempt ||
      prior.identity.releaseId !== identity.releaseId,
    'A completed operation cannot reopen its old snapshot; start a new attempt',
  );
  const path = join(root, `${capsuleDigest}.json`);
  try {
    await durableWrite(path, bytes, true);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert((await boundedRead(path)).equals(bytes), 'Immutable recovery capsule conflict');
  }
  const active = { schemaVersion: 1, identity, capsuleDigest, state: 'pending' };
  // active is the durable mutation barrier: it is written only after all bytes are synced.
  await durableWrite(join(root, 'active.json'), JSON.stringify(active) + '\n');
  return { pending: true, ...active };
}
export async function finishJournal(root, releaseId, manifestDigest, capsuleDigest, outcome) {
  assert(
    ['committed', 'rolled_back'].includes(outcome) && digestPattern.test(capsuleDigest),
    'Invalid recovery completion',
  );
  const prior = await inspectJournal(root, releaseId, manifestDigest);
  assert(
    prior.capsuleDigest === capsuleDigest &&
      prior.identity?.releaseId === releaseId &&
      prior.identity?.manifestDigest === manifestDigest,
    'Stale recovery completion',
  );
  if (!prior.pending) {
    assert.equal(prior.state, outcome, 'Recovery outcome cannot be rewritten');
    return prior;
  }
  const receipt = {
    schemaVersion: 1,
    identity: prior.identity,
    capsuleDigest,
    state: outcome,
    verifiedAt: new Date().toISOString(),
  };
  // One atomic, synced state transition is the commit point. Losing its acknowledgement is safe to retry.
  await durableWrite(join(root, 'active.json'), JSON.stringify(receipt) + '\n');
  await durableWrite(
    join(root, `${capsuleDigest}.${outcome}.json`),
    JSON.stringify(receipt) + '\n',
  );
  return receipt;
}
async function stdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert(size <= LIMIT, 'Recovery input exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function main() {
  const [mode, a, b, c, d] = process.argv.slice(2);
  if (mode === 'pack') {
    const capsule = await packCapsule(a, (await readFile(b, 'utf8')).trim());
    await writeFile(c, JSON.stringify(capsule) + '\n', { flag: 'wx', mode: 0o600 });
    return;
  }
  if (mode === 'unpack') {
    const capsule = validateCapsule(JSON.parse(await boundedRead(a)));
    await unpackCapsule(capsule, b);
    await writeFile(
      c,
      JSON.stringify({ ...capsule.snapshot.identity, recoveryBefore: capsule.recoveryBefore }) +
        '\n',
      { mode: 0o600 },
    );
    return;
  }
  if (mode === 'save') {
    const capsule = validateCapsule(await stdin());
    assert(
      capsule.snapshot.identity.releaseId === a && capsule.snapshot.identity.manifestDigest === b,
      'Unexpected recovery source',
    );
    console.log(JSON.stringify(await saveJournal(JOURNAL_ROOT, capsule)));
    return;
  }
  if (mode === 'finish') {
    console.log(JSON.stringify(await finishJournal(JOURNAL_ROOT, a, b, c, d)));
    return;
  }
  const state = await inspectJournal(JOURNAL_ROOT, a, b);
  if (mode === 'export') console.log(JSON.stringify(state.pending ? state.capsule : null));
  else if (mode === 'check') {
    const { capsule, ...summary } = state;
    console.log(JSON.stringify(summary));
  } else throw new Error('Unknown recovery operation');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error(
      'Web recovery journal rejected the operation; preserve private recovery data and inspect the bound receipt',
    );
    process.exitCode = 1;
  });
}
