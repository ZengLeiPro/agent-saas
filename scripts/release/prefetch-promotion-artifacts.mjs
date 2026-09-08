#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SELECTED = {
  serverBundle: 'server-bundle.tgz',
  webAssets: 'web-assets.tgz',
  acsOrchestrator: 'acs-orchestrator.tgz',
};

function descriptor(value) {
  if (
    !value ||
    !DIGEST.test(value.digest ?? '') ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1
  )
    throw new Error('Invalid download digest or byte size');
  return value;
}
function uri(value) {
  if (
    typeof value !== 'string' ||
    !/^(oss|https):\/\/[^\s?#]+$/u.test(value) ||
    value.split('/').includes('..')
  )
    throw new Error('Unsafe artifact download URI');
  return value;
}
async function verify(path, expected) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== expected.size)
    throw new Error('Artifact download byte size mismatch');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (`sha256:${hash.digest('hex')}` !== expected.digest)
    throw new Error('Artifact download digest mismatch');
}

/** A run-local cache contains only bytes verified against immutable descriptors.
 * Both existing artifact validators still run after this acquisition-only helper.
 */
export async function prefetchPromotionArtifacts({
  index,
  manifest,
  baseUri,
  output,
  download,
  concurrency = 4,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Download concurrency must be between 1 and 8');
  const root = resolve(output);
  const built = join(root, 'built');
  const selected = join(root, 'selected');
  const cache = join(root, 'promotion-download-cache');
  await Promise.all([built, selected, cache].map((path) => mkdir(path, { recursive: true })));
  const tasks = [];
  const destinations = new Set();
  const add = (entry, source, destination) => {
    descriptor(entry);
    uri(source);
    if (destinations.has(destination)) throw new Error('Duplicate artifact download destination');
    destinations.add(destination);
    tasks.push({ ...entry, source, destination });
  };
  const builtEntries = [
    ...Object.values(index.artifacts ?? {}),
    index.sbom,
    ...(index.schemaVersion === 2 ? [index.runtimeDependencies] : []),
  ];
  for (const entry of builtEntries) {
    if (
      !NAME.test(entry?.path ?? '') ||
      entry.path.includes('..') ||
      entry.path === 'artifact-index.json'
    )
      throw new Error('Unsafe built artifact path');
    add(entry, `${baseUri.replace(/\/$/u, '')}/${entry.path}`, join(built, entry.path));
  }
  for (const [key, name] of Object.entries(SELECTED)) {
    const entry = manifest.artifacts?.[key];
    add(entry, entry?.uri, join(selected, name));
  }
  if (manifest.schemaVersion === 2)
    for (const component of ['server', 'acs']) {
      const entry = manifest.artifacts?.runtimeDependencies?.[component];
      add(entry, entry?.uri, join(selected, `runtime-dependencies-${component}.json`));
    }
  const groups = new Map();
  for (const task of tasks) {
    const key = `${task.digest.slice(7)}-${task.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  let next = 0;
  let downloadedBytes = 0;
  let cacheHits = 0;
  let downloads = 0;
  const work = [...groups.entries()];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, work.length) }, async () => {
      while (next < work.length) {
        const [key, matches] = work[next++];
        const expected = matches[0];
        const path = join(cache, key);
        try {
          await verify(path, expected);
          cacheHits++;
        } catch {
          await rm(path, { force: true });
          const temporary = `${path}.partial`;
          await rm(temporary, { force: true });
          try {
            await download(expected.source, temporary);
            await verify(temporary, expected);
            await rename(temporary, path);
          } finally {
            await rm(temporary, { force: true });
          }
          downloads++;
          downloadedBytes += expected.size;
        }
        for (const match of matches) await copyFile(path, match.destination);
      }
    }),
  );
  await writeFile(join(built, 'artifact-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return {
    downloads,
    downloadedBytes,
    cacheHits,
    reusedCopies: tasks.length - groups.size,
    concurrency,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [, , indexPath, manifestPath, baseUri, output, region] = process.argv;
  if (!/^cn-[a-z0-9-]+$/u.test(region ?? '')) throw new Error('Invalid OSS region');
  const result = await prefetchPromotionArtifacts({
    index: JSON.parse(await readFile(indexPath, 'utf8')),
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    baseUri,
    output,
    download: async (source, destination) => {
      const command = source.startsWith('oss://') ? 'aliyun' : 'curl';
      const args = source.startsWith('oss://')
        ? ['--secure', 'oss', 'cp', source, destination, '--region', region]
        : [
            '--fail',
            '--silent',
            '--show-error',
            '--location',
            '--proto',
            '=https',
            '--proto-redir',
            '=https',
            '--retry',
            '3',
            '--connect-timeout',
            '20',
            '--max-time',
            '600',
            source,
            '-o',
            destination,
          ];
      try {
        await exec(command, args, { timeout: 660_000, maxBuffer: 1024 * 1024 });
      } catch {
        throw new Error(`Artifact transfer failed (${command}); verified cache was not published`);
      }
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
