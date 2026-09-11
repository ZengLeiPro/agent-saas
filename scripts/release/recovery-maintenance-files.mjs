import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, parse, resolve } from 'node:path';
import { readEvidenceFile } from './evidence-file.mjs';

export const MAINTENANCE_LIMITS = Object.freeze({
  entries: 4096, depth: 4, fileBytes: 100663296, totalBytes: 536870912,
});
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
const safeName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(name) && name !== '..';

/** No symlink ancestor is accepted. Callers must own/lock the private input directory. */
export async function assertPrivateTreePath(input) {
  const path = resolve(input);
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Unsafe directory boundary');
  }
  return path;
}
export function snapshotDigest(files, directories) {
  return sha256(JSON.stringify({
    files: files.map(({ path, bytes, digest }) => ({ path, bytes, digest })),
    directories: directories.map(({ path }) => path).sort(),
  }));
}
export async function fingerprintFile(path, byteLimit, sink) {
  await assertPrivateTreePath(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > byteLimit)
      throw new Error('Unsafe or oversized evidence file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, byteLimit - bytes + 1), null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > byteLimit) throw new Error('Evidence byte limit exceeded');
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      if (sink) await sink(chunk);
    }
    const after = await file.stat();
    const linked = await lstat(path);
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(linked) || bytes !== after.size)
      throw new Error('Evidence changed during read');
    return { bytes, digest: hash.digest('hex'), modifiedAt: new Date(after.mtimeMs).toISOString(),
      stamp: stamp(after) };
  } finally { await file.close(); }
}
export async function snapshotRecoveryTree(input, overrides = {}) {
  const limits = { ...MAINTENANCE_LIMITS, ...overrides };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(MAINTENANCE_LIMITS, key) || !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 || limits[key] > MAINTENANCE_LIMITS[key]) throw new Error('Invalid inventory limit');
  }
  const root = await assertPrivateTreePath(input);
  const files = [], directories = [];
  let entries = 0, bytes = 0;
  async function visit(relative, depth) {
    if (depth > limits.depth) throw new Error('Inventory depth limit exceeded');
    const path = join(root, relative);
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Unsafe directory boundary');
    for await (const entry of await opendir(path)) {
      if (++entries > limits.entries) throw new Error('Inventory entry limit exceeded');
      if (!safeName(entry.name)) throw new Error('Unsafe inventory entry');
      const child = join(relative, entry.name);
      const stat = await lstat(join(root, child));
      if (stat.isSymbolicLink()) throw new Error('Unsafe inventory entry');
      if (stat.isDirectory()) await visit(child, depth + 1);
      else {
        const fingerprint = await fingerprintFile(join(root, child),
          Math.min(limits.fileBytes, limits.totalBytes - bytes));
        bytes += fingerprint.bytes;
        files.push({ path: child, ...fingerprint });
      }
    }
    if (stamp(before) !== stamp(await lstat(path))) throw new Error('Directory changed during inventory');
    directories.push({ path: relative, stamp: stamp(before) });
  }
  await visit('', 0);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const entry of [...files, ...directories])
    if (stamp(await lstat(join(root, entry.path))) !== entry.stamp)
      throw new Error('Evidence changed during inventory');
  return { schemaVersion: 1, digest: snapshotDigest(files, directories), files, directories, bytes, entries };
}
export async function readSnapshotJson(root, snapshot, path) {
  const entry = snapshot.files.find((file) => file.path === path);
  if (!entry) throw new Error('Required evidence unavailable');
  await assertPrivateTreePath(dirname(join(root, path)));
  const bytes = await readEvidenceFile(join(root, path), 4194304);
  if (sha256(bytes) !== entry.digest) throw new Error('Evidence changed after inventory');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid evidence encoding'); }
}
