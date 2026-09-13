#!/usr/bin/env node
import { createRequire } from 'node:module';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reusableArtifactPlan } from './reuse-promotion-artifacts.mjs';

const requireFromServer = createRequire(fileURLToPath(new URL('../../server/package.json', import.meta.url)));
const FILENAME_TO_ARTIFACT = {
  'server-bundle.tgz': 'serverBundle',
  'acs-orchestrator.tgz': 'acsOrchestrator',
};
const EXPIRES_SECONDS = 1800;

export function parseOssUri(uri) {
  const match = /^oss:\/\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/([A-Za-z0-9._~/-]+)$/u.exec(uri ?? '');
  if (!match || uri.includes('..') || uri.includes('//', 6)) throw new Error('Unsafe OSS artifact URI');
  return { bucket: match[1], key: match[2] };
}

export function createInternalOssSigner({
  OSS,
  accessKeyId,
  accessKeySecret,
  region = 'oss-cn-shenzhen',
  expires = EXPIRES_SECONDS,
}) {
  if (!accessKeyId || !accessKeySecret) throw new Error('OSS signing credentials are required');
  if (region !== 'cn-shenzhen' && region !== 'oss-cn-shenzhen') {
    throw new Error('Promotion artifact signing is Shenzhen-only');
  }
  return (uri) => {
    const { bucket, key } = parseOssUri(uri);
    const client = new OSS({
      accessKeyId,
      accessKeySecret,
      bucket,
      region: 'oss-cn-shenzhen',
      internal: true,
      secure: true,
    });
    const url = client.signatureUrl(key, { expires, method: 'GET' });
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('OSS signer did not return an HTTPS URL');
    }
    return url;
  };
}

export function buildFetchPlan(manifest, sign) {
  if (typeof sign !== 'function') throw new Error('OSS signer is required');
  const artifacts = [];
  for (const entry of reusableArtifactPlan(manifest)) {
    const field = FILENAME_TO_ARTIFACT[entry.filename];
    const selected = manifest.artifacts?.[field];
    if (
      !field ||
      selected?.digest !== `sha256:${entry.digest}` ||
      !Number.isSafeInteger(selected.size) ||
      selected.size < 1
    ) {
      throw new Error(`Fetch plan artifact does not match Manifest: ${entry.filename}`);
    }
    artifacts.push({
      filename: entry.filename,
      digest: entry.digest,
      size: selected.size,
      source: entry.source,
      url: sign(selected.uri),
    });
  }
  return { schemaVersion: 1, artifacts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [manifestPath, region, outputPath] = process.argv.slice(2);
  if (!manifestPath || !outputPath) {
    throw new Error(
      'usage: sign-promotion-artifact-urls.mjs <manifest> <region> <output>',
    );
  }
  const OSS = requireFromServer('ali-oss');
  const sign = createInternalOssSigner({
    OSS,
    accessKeyId: process.env.ALIBABACLOUD_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIBABACLOUD_ACCESS_KEY_SECRET,
    region,
  });
  const plan = buildFetchPlan(JSON.parse(await readFile(manifestPath, 'utf8')), sign);
  await writeFile(outputPath, `${JSON.stringify(plan)}\n`);
}
