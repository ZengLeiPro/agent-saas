#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { verifyArtifactIndex } from './verify-artifact.mjs';

export async function publishReleaseRecord({ manifestPath, indexPath, recordsRoot }) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  if (!/^rc-\d{8}-\d{2,}$/u.test(manifest.releaseId ?? '')) throw new Error('Invalid releaseId');
  const index = await verifyArtifactIndex(indexPath, manifest.releaseSha);
  const manifestDigest = digestBuffer(Buffer.from(canonicalJson(manifest)));
  const target = join(resolve(recordsRoot), manifest.releaseId);
  const lockPath = `${target}.lock`;
  await mkdir(dirname(target), { recursive: true });
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    try {
      const existing = JSON.parse(await readFile(join(target, 'record.json'), 'utf8'));
      if (
        existing.manifestDigest === manifestDigest &&
        existing.artifactDigest === index.aggregateDigest
      )
        return existing;
      throw new Error('Immutable release record already exists with different content');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const staging = `${target}.candidate-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const record = {
      schemaVersion: 1,
      releaseId: manifest.releaseId,
      releaseSha: manifest.releaseSha,
      manifestDigest,
      artifactDigest: index.aggregateDigest,
      manifestFile: basename(manifestPath),
      artifactIndexFile: basename(indexPath),
    };
    await writeFile(join(staging, 'manifest.json'), `${canonicalJson(manifest)}\n`, { flag: 'wx' });
    await writeFile(join(staging, 'artifact-index.json'), `${canonicalJson(index)}\n`, {
      flag: 'wx',
    });
    await writeFile(join(staging, 'record.json'), `${canonicalJson(record)}\n`, { flag: 'wx' });
    await rename(staging, target);
    return record;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, indexPath, recordsRoot] = process.argv.slice(2);
  if (!manifestPath || !indexPath || !recordsRoot)
    throw new Error('usage: publish-release-record.mjs <manifest> <index> <records-root>');
  publishReleaseRecord({ manifestPath, indexPath, recordsRoot }).then((record) =>
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`),
  );
}
