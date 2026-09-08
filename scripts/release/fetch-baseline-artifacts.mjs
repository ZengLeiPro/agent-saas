#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBaselineArtifacts } from './resolve-baseline-artifacts.mjs';

const exec = promisify(execFile);
const RC = /^rc-\d{8}-\d{2,}$/u;

export async function listAllObjects(prefix, listPage, pageSize = 1000) {
  const result = [];
  let marker = '';
  for (let page = 0; page < 10000; page++) {
    const objects = await listPage(prefix, marker, pageSize);
    if (
      !Array.isArray(objects) ||
      objects.length > pageSize ||
      objects.some((uri) => !uri.startsWith(prefix) || /\s/u.test(uri))
    )
      throw new Error('OSS returned an invalid baseline listing page');
    if (objects.length && marker && objects[0].split('/').slice(3).join('/') <= marker)
      throw new Error('OSS baseline pagination did not advance');
    for (let i = 1; i < objects.length; i++)
      if (objects[i] <= objects[i - 1]) throw new Error('OSS baseline listing is not ordered');
    result.push(...objects);
    if (objects.length < pageSize) return result;
    marker = objects.at(-1).split('/').slice(3).join('/');
  }
  throw new Error(
    'OSS baseline listing exceeded its explicit page bound; refusing incomplete results',
  );
}

async function mapLimited(values, apply, concurrency = 4) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) await apply(values[cursor++]);
    }),
  );
}

/** Fast hints only locate candidates; existing SHA/digest/runtime checks remain authoritative. */
export async function fetchBaselineArtifacts({ production, baseUri, readJson, listPage }) {
  const root = baseUri.replace(/\/$/u, '');
  if (!/^oss:\/\/[a-z0-9-]+(?:\/[A-Za-z0-9/_-]+)?$/u.test(root))
    throw new Error('Invalid release object root');
  const indexes = new Map();
  const visited = new Set();
  const fetchIndex = async (uri) => {
    if (visited.has(uri)) return;
    visited.add(uri);
    const index = await readJson(uri);
    if (!index) return;
    // records/ contains metadata, while the immutable packages live at <root>/<rc>/.
    const relative = uri.slice(root.length + 1);
    const parts = relative.split('/');
    const indexUri =
      parts[0] === 'records' && RC.test(parts[1] ?? '') && parts[2] === 'artifact-index.json'
        ? `${root}/${parts[1]}/artifact-index.json`
        : uri;
    indexes.set(indexUri, { ...index, indexUri });
  };
  const direct = new Set();
  if (RC.test(production.releaseId ?? '')) {
    direct.add(`${root}/${production.releaseId}/artifact-index.json`);
    const manifest = await readJson(`${root}/records/${production.releaseId}/manifest.json`);
    if (manifest?.releaseId === production.releaseId) {
      for (const name of ['serverBundle', 'webAssets', 'acsOrchestrator']) {
        const uri = manifest.artifacts?.[name]?.uri;
        if (typeof uri === 'string' && uri.startsWith(`${root}/`) && !/\s|\.\./u.test(uri))
          direct.add(`${uri.slice(0, uri.lastIndexOf('/') + 1)}artifact-index.json`);
      }
    }
  }
  const c = production.components;
  for (const [prefix, sourceSha, digest] of [
    ['app', c?.api?.gitSha, c?.api?.artifactDigest],
    ['web', c?.web?.gitSha, c?.web?.artifactDigest],
    ['acs', c?.acs?.gitSha, c?.acs?.orchestratorArtifactDigest],
  ]) {
    if (!/^[a-f0-9]{40}$/u.test(sourceSha ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(digest ?? ''))
      throw new Error('Invalid production component baseline identity');
    direct.add(`${root}/baselines/${prefix}-${sourceSha}-${digest.slice(7)}/artifact-index.json`);
  }
  await mapLimited([...direct], fetchIndex);
  try {
    return {
      artifacts: resolveBaselineArtifacts({ production, indexes: [...indexes.values()] }),
      metrics: { mode: 'exact', indexReads: visited.size },
    };
  } catch (error) {
    if (!/^No immutable/u.test(error.message)) throw error;
  }
  const all = (
    await Promise.all(
      ['baselines', 'records'].map((prefix) => listAllObjects(`${root}/${prefix}/`, listPage)),
    )
  ).flat();
  await mapLimited(
    [...new Set(all.filter((uri) => uri.endsWith('/artifact-index.json')))],
    fetchIndex,
  );
  return {
    artifacts: resolveBaselineArtifacts({ production, indexes: [...indexes.values()] }),
    metrics: {
      mode: 'complete-history-fallback',
      indexReads: visited.size,
      listedObjects: all.length,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , productionPath, baseUri, region, output] = process.argv;
  if (!/^cn-[a-z0-9-]+$/u.test(region ?? '')) throw new Error('Invalid OSS region');
  const temporary = await mkdtemp(join(tmpdir(), 'baseline-metadata-'));
  let counter = 0;
  const aliyun = (...args) =>
    exec('aliyun', ['--secure', 'oss', ...args, '--region', region], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
  try {
    const result = await fetchBaselineArtifacts({
      production: JSON.parse(await readFile(productionPath, 'utf8')),
      baseUri,
      readJson: async (uri) => {
        const file = join(temporary, `${counter++}.json`);
        try {
          await aliyun('cp', uri, file);
        } catch (error) {
          if (
            /NoSuchKey|StatusCode[=: ]+404|status code[=: ]+404/iu.test(
              `${error.stdout}\n${error.stderr}`,
            )
          )
            return null;
          throw new Error(`Unable to read baseline metadata ${uri}; OSS request failed`);
        }
        return JSON.parse(await readFile(file, 'utf8'));
      },
      listPage: async (prefix, marker, limit) => {
        const args = ['ls', prefix, '--short-format', '--limited-num', String(limit)];
        if (marker) args.push('--marker', marker);
        const { stdout } = await aliyun(...args);
        return stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('oss://'));
      },
    });
    await writeFile(output, `${JSON.stringify(result.artifacts, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify(result.metrics)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
