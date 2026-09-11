import { mkdir, open, opendir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertPrivateTreePath, fingerprintFile, sha256,
  snapshotDigest, snapshotRecoveryTree, MAINTENANCE_LIMITS } from './recovery-maintenance-files.mjs';
import { readEvidenceFile, readEvidenceJson } from './evidence-file.mjs';

async function writePrivate(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path) {
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}
const contains = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('..' + sep));
};
const sameSnapshot = (a, b) => a.digest === b.digest &&
  JSON.stringify(a.files.map(({ path, stamp }) => ({ path, stamp }))) ===
  JSON.stringify(b.files.map(({ path, stamp }) => ({ path, stamp })));

/** Copy-only archival. The trusted parent must be private; destination must not exist.
 * Source must be quiesced/locked by the caller. Partial output intentionally survives failures.
 * No source writes, pruning, rm, service changes, network, or default retention decision.
 */
export async function archiveRecovery(sourceInput, destinationInput) {
  const source = await assertPrivateTreePath(sourceInput);
  const destination = resolve(destinationInput);
  await assertPrivateTreePath(dirname(destination));
  if (contains(source, destination) || contains(destination, source))
    throw new Error('Archive and source must be disjoint');
  const before = await snapshotRecoveryTree(source);
  await mkdir(destination, { mode: 0o700 }); // Exclusive creation; never merge or overwrite.
  const payload = join(destination, 'files');
  await mkdir(payload, { mode: 0o700 });
  const directories = before.directories.map((item) => item.path).filter(Boolean)
    .sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b, 'en'));
  for (const directory of directories) await mkdir(join(payload, directory), { mode: 0o700 });
  for (const entry of before.files) {
    const output = await open(join(payload, entry.path), 'wx', 0o600);
    let copied;
    try {
      copied = await fingerprintFile(join(source, entry.path), MAINTENANCE_LIMITS.fileBytes,
        (bytes) => output.writeFile(bytes));
      await output.sync();
    } finally { await output.close(); }
    if (copied.digest !== entry.digest || copied.stamp !== entry.stamp)
      throw new Error('Source changed during archive');
  }
  const after = await snapshotRecoveryTree(source);
  if (!sameSnapshot(before, after)) throw new Error('Source changed during archive');
  const readback = await snapshotRecoveryTree(payload);
  if (readback.digest !== before.digest) throw new Error('Archive readback mismatch');
  const manifest = { schemaVersion: 1, snapshotDigest: before.digest,
    files: before.files.map(({ path, bytes, digest }) => ({ path, bytes, digest })),
    directories: before.directories.map(({ path }) => ({ path })) };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  if (Buffer.byteLength(manifestBytes) > 4194304) throw new Error('Archive manifest exceeds limit');
  await writePrivate(join(destination, 'archive-manifest.json'), manifestBytes);
  for (const directory of [...directories].reverse()) await syncDirectory(join(payload, directory));
  await syncDirectory(payload);
  const receipt = { schemaVersion: 1, mode: 'copy-only', sourceSnapshotDigest: before.digest,
    manifestDigest: sha256(manifestBytes), files: before.files.length, bytes: before.bytes,
    verifiedAt: new Date().toISOString(), sourceDeleted: false };
  // This is the completion marker, written only AFTER payload readback and fsync.
  await writePrivate(join(destination, 'archive-receipt.json'), JSON.stringify(receipt) + '\n');
  await syncDirectory(destination);
  await syncDirectory(dirname(destination));
  return receipt;
}

/** Requires an independent expected snapshot digest; a self-consistent archive is not enough. */
export async function verifyRecoveryArchive(input, expectedDigest) {
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedDigest))
    throw new Error('Independent expected archive digest required');
  const root = await assertPrivateTreePath(input);
  const names = [];
  for await (const entry of await opendir(root)) {
    names.push(entry.name);
    if (names.length > 3) throw new Error('Unrecognized archive content');
  }
  if (names.sort().join(',') !== 'archive-manifest.json,archive-receipt.json,files')
    throw new Error('Incomplete archive');
  const bytes = await readEvidenceFile(join(root, 'archive-manifest.json'), 4194304);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const receipt = await readEvidenceJson(join(root, 'archive-receipt.json'));
  const manifestDigest = sha256(bytes);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) ||
    manifest.files.length > MAINTENANCE_LIMITS.entries ||
    !Array.isArray(manifest.directories) || manifest.snapshotDigest !== expectedDigest ||
    snapshotDigest(manifest.files, manifest.directories) !== expectedDigest ||
    receipt?.schemaVersion !== 1 || receipt.mode !== 'copy-only' || receipt.sourceDeleted !== false ||
    receipt.sourceSnapshotDigest !== expectedDigest || receipt.manifestDigest !== manifestDigest)
    throw new Error('Archive manifest or receipt mismatch');
  const payload = await snapshotRecoveryTree(join(root, 'files'));
  if (payload.digest !== expectedDigest || receipt.files !== payload.files.length || receipt.bytes !== payload.bytes)
    throw new Error('Archive payload mismatch');
  if (typeof receipt.verifiedAt !== 'string' || !Number.isFinite(Date.parse(receipt.verifiedAt)))
    throw new Error('Invalid archive time');
  return { schemaVersion: 1, mode: 'copy-only', verified: true, sourceDeleted: false,
    sourceSnapshotDigest: expectedDigest, manifestDigest,
    files: payload.files.length, bytes: payload.bytes, verifiedAt: new Date(receipt.verifiedAt).toISOString() };
}
