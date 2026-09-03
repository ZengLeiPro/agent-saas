#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
import { verifyArtifactIndex } from './verify-artifact.mjs';
import { verifySelectedReleaseArtifacts } from './verify-selected-release-artifacts.mjs';
import {
  assertManifestIndexBindings,
  validateReleaseManifestAuthoritatively,
  verifyReleaseRecordFiles,
} from './verify-release-record.mjs';

export async function publishReleaseRecord({
  manifestPath,
  indexPath,
  recordsRoot,
  selectedDirectory,
}) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  if (!/^rc-\d{8}-\d{2,}$/u.test(manifest.releaseId ?? '')) throw new Error('Invalid releaseId');
  validateReleaseManifestAuthoritatively(manifestPath, manifest.releaseId);
  if (!selectedDirectory)
    throw new Error('Selected Release artifacts must be verified before publishing a record');
  await verifySelectedReleaseArtifacts({
    manifestPath,
    directory: selectedDirectory,
  });
  const index = await verifyArtifactIndex(indexPath, manifest.releaseSha);
  assertManifestIndexBindings(manifest, index);
  const { digest: manifestDigest, ...manifestContent } = manifest;
  const calculatedManifestDigest = digestBuffer(
    Buffer.concat([
      Buffer.from(`agent-saas-release-manifest-v${manifest.schemaVersion}\0`),
      Buffer.from(canonicalJson(manifestContent)),
    ]),
  );
  if (manifestDigest !== calculatedManifestDigest)
    throw new Error('Release Manifest digest does not match canonical domain-separated content');
  const manifestFileDigest = digestBuffer(Buffer.from(canonicalJson(manifest)));
  const target = join(resolve(recordsRoot), manifest.releaseId);
  const lockPath = `${target}.lock`;
  await mkdir(dirname(target), { recursive: true });
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    try {
      const existing = await verifyReleaseRecordFiles({
        recordPath: join(target, 'record.json'),
        manifestPath: join(target, 'manifest.json'),
        indexPath: join(target, 'artifact-index.json'),
        validateManifest: false,
      });
      if (
        existing.manifestDigest === manifestDigest &&
        existing.manifestFileDigest === manifestFileDigest &&
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
      manifestFileDigest,
      artifactDigest: index.aggregateDigest,
      manifestFile: basename(manifestPath),
      artifactIndexFile: basename(indexPath),
    };
    await writeFile(join(staging, 'manifest.json'), `${canonicalJson(manifest)}\n`, { flag: 'wx' });
    await writeFile(join(staging, 'artifact-index.json'), `${canonicalJson(index)}\n`, {
      flag: 'wx',
    });
    await writeFile(join(staging, 'record.json'), `${canonicalJson(record)}\n`, { flag: 'wx' });
    await verifyReleaseRecordFiles({
      recordPath: join(staging, 'record.json'),
      manifestPath: join(staging, 'manifest.json'),
      indexPath: join(staging, 'artifact-index.json'),
      validateManifest: false,
    });
    await rename(staging, target);
    return record;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, indexPath, recordsRoot, selectedDirectory] = process.argv.slice(2);
  if (!manifestPath || !indexPath || !recordsRoot || !selectedDirectory)
    throw new Error(
      'usage: publish-release-record.mjs <manifest> <index> <records-root> <selected-directory>',
    );
  publishReleaseRecord({ manifestPath, indexPath, recordsRoot, selectedDirectory }).then((record) =>
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`),
  );
}
