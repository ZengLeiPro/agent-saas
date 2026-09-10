#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStoredWebAsset } from './repair-web-asset-metadata.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allowedHeader =
  /^(content-type|content-encoding|cache-control|content-disposition|content-language|expires|x-oss-meta-[a-z0-9_-]+)$/;
const metadata = (headers = {}) =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => allowedHeader.test(key.toLowerCase()))
      .map(([key, value]) => [key.toLowerCase(), String(value)])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
const safeKey = (key) =>
  typeof key === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(key) &&
  !key.split('/').some((part) => part === '..' || !part) &&
  !key.startsWith('assets/');

export async function listMutableShell(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const key = prefix + entry.name;
    if (key === 'assets') continue;
    assert(!entry.isSymbolicLink(), 'Web shell symlinks are forbidden');
    if (entry.isDirectory()) result.push(...(await listMutableShell(root, key + '/')));
    else {
      assert(entry.isFile() && safeKey(key), 'Invalid mutable Web shell path');
      result.push(key);
    }
  }
  return result.sort();
}

async function head(client, key) {
  try {
    const result = await client.head(key);
    assert.equal(Number(result.status), 200);
    assert(result.res?.headers?.etag, 'HEAD must bind a real object, not website fallback');
    return result;
  } catch (error) {
    if (Number(error.status ?? error.statusCode) === 404 && error.code === 'NoSuchKey') return null;
    throw error; // 403, timeouts, malformed HEAD are never absence.
  }
}

export async function snapshotShell({ client, keys, prefix = '', backup, identity }) {
  assert(keys.length > 0 && keys.length <= 1024 && keys.every(safeKey), 'Invalid shell key set');
  assert(new Set(keys).size === keys.length, 'Duplicate shell key');
  const entries = [];
  let total = 0;
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const key of keys) {
    const current = await head(client, prefix + key);
    if (!current) {
      entries.push({ key, existed: false });
      continue;
    }
    const stored = await readStoredWebAsset(client, prefix + key);
    assert.equal(Number(stored.res?.status), 200);
    assert.equal(
      stored.res?.headers?.etag,
      current.res.headers.etag,
      'Web shell changed during snapshot',
    );
    total += stored.content.length;
    assert(total <= 64 * 1024 * 1024, 'Mutable shell snapshot exceeds the reviewed size limit');
    const file = digest(Buffer.from(key)) + '.bin';
    await writeFile(join(backup, file), stored.content, { flag: 'wx', mode: 0o600 });
    entries.push({
      key,
      existed: true,
      file,
      digest: digest(stored.content),
      metadata: metadata(stored.res.headers),
    });
  }
  const snapshot = { schemaVersion: 1, identity, entries };
  await writeFile(join(backup, 'snapshot.json'), JSON.stringify(snapshot) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return snapshot;
}

export async function restoreShell({ client, backup, prefix = '', identity }) {
  const snapshot = JSON.parse(await readFile(join(backup, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(
    snapshot.identity,
    identity,
    'Web backup belongs to a different release operation',
  );
  assert(Array.isArray(snapshot.entries) && snapshot.entries.length <= 1024);
  // Validate the complete backup before the first restoration or removal.
  const prepared = [];
  for (const entry of snapshot.entries) {
    assert(safeKey(entry.key));
    if (!entry.existed) {
      assert.equal(entry.existed, false);
      prepared.push(entry);
      continue;
    }
    assert.equal(entry.file, digest(Buffer.from(entry.key)) + '.bin');
    assert.deepEqual(metadata(entry.metadata), entry.metadata, 'Unreviewed restoration metadata');
    const bytes = await readFile(join(backup, entry.file));
    assert.equal(digest(bytes), entry.digest, 'Corrupt shell backup');
    prepared.push({ ...entry, bytes });
  }
  // Restore the complete PWA shell before the pointer/entry HTML, retain all hash assets.
  prepared.sort((a, b) => Number(a.key === 'index.html') - Number(b.key === 'index.html'));
  const failures = [];
  for (const entry of prepared) {
    try {
      const key = prefix + entry.key;
      if (!entry.existed) {
        if (await head(client, key)) await client.delete(key);
        assert.equal(await head(client, key), null, 'New shell key was not removed');
      } else {
        await client.put(key, entry.bytes, { headers: entry.metadata });
        const current = await head(client, key);
        assert(current);
        const stored = await readStoredWebAsset(client, key);
        assert.equal(stored.res?.headers?.etag, current.res.headers.etag);
        assert.equal(digest(stored.content), entry.digest, 'Shell restoration byte mismatch');
        assert.deepEqual(
          metadata(stored.res?.headers),
          entry.metadata,
          'Shell restoration metadata mismatch',
        );
      }
    } catch {
      failures.push(entry.key);
    }
  }
  assert.equal(failures.length, 0, `Shell restoration failed for ${failures.length} key(s)`);
  return { schemaVersion: 1, restored: prepared.length, verified: true };
}

async function main() {
  const [
    mode,
    root,
    uri,
    credentialsPath,
    backup,
    releaseId,
    manifestDigest,
    runId,
    runAttempt,
    region,
  ] = process.argv.slice(2);
  const match = /^oss:\/\/([^/]+)\/?(.*)$/.exec(uri);
  assert(match, 'Expected an OSS destination');
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const OSS = require('ali-oss');
  const client = new OSS({
    ...credentials,
    bucket: match[1],
    region: `oss-${region.replace(/^oss-/, '')}`,
    secure: true,
    timeout: 60_000,
  });
  const options = {
    client,
    prefix: match[2] ? match[2].replace(/\/$/, '') + '/' : '',
    backup,
    identity: { releaseId, manifestDigest, runId, runAttempt },
  };
  if (mode === 'snapshot') await snapshotShell({ ...options, keys: await listMutableShell(root) });
  else if (mode === 'restore') await restoreShell(options);
  else throw new Error('Expected snapshot or restore');
  console.log(JSON.stringify({ status: 'verified', phase: mode }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error(
      'Web shell transaction failed; preserve the private backup and inspect operation evidence',
    );
    process.exitCode = 1;
  });
}
