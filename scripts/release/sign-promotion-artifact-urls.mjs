#!/usr/bin/env node
import { createRequire } from 'node:module';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reusableArtifactPlan } from './reuse-promotion-artifacts.mjs';

const requireFromServer = createRequire(fileURLToPath(new URL('../../server/package.json', import.meta.url)));
const FILENAME_TO_ARTIFACT = {
  'server-bundle.tgz': 'serverBundle',
  'acs-orchestrator.tgz': 'acsOrchestrator',
  'web-assets.tgz': 'webAssets',
};
const STAGING_MANIFEST_FILES = [
  ['server-bundle.tgz', 'serverBundle', 'api', 'artifactDigest'],
  ['acs-orchestrator.tgz', 'acsOrchestrator', 'acs', 'orchestratorArtifactDigest'],
  ['web-assets.tgz', 'webAssets', 'web', 'artifactDigest'],
];
const STAGING_RELEASE_ROOT = '/opt/agent-saas-staging/releases';
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

function requireSizedDigest(selected, filename) {
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(selected?.digest ?? '') ||
    !Number.isSafeInteger(selected.size) ||
    selected.size < 1
  ) {
    throw new Error(`Fetch plan artifact does not match Manifest: ${filename}`);
  }
  parseOssUri(selected.uri);
  return selected;
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

export function stagingFetchExtras(manifest, index, artifactBaseUri) {
  if (!/^rc-[0-9]{8}-[0-9]{2,}$/u.test(manifest.releaseId ?? '')) {
    throw new Error('Invalid staging releaseId');
  }
  const extras = [];
  for (const [filename, field, component, digestField] of STAGING_MANIFEST_FILES) {
    const selected = requireSizedDigest(manifest.artifacts?.[field], filename);
    if (selected.digest !== manifest.components?.[component]?.[digestField]) {
      throw new Error(`Fetch plan artifact does not match Manifest: ${filename}`);
    }
    extras.push({
      filename,
      uri: selected.uri,
      digest: selected.digest,
      size: selected.size,
    });
  }
  const runtime = index?.artifacts?.stagingRuntimeAssets;
  if (runtime?.path !== 'staging-runtime-assets.tgz') {
    throw new Error('Staging runtime assets path is invalid');
  }
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(runtime.digest ?? '') ||
    !Number.isSafeInteger(runtime.size) ||
    runtime.size < 1
  ) {
    throw new Error('Staging runtime assets identity is invalid');
  }
  const uri = `${String(artifactBaseUri ?? '').replace(/\/$/u, '')}/${manifest.releaseId}/${runtime.path}`;
  parseOssUri(uri);
  extras.push({
    filename: 'staging-runtime-assets.tgz',
    uri,
    digest: runtime.digest,
    size: runtime.size,
  });
  return extras;
}

export function buildStagingFetchPlan(manifest, index, artifactBaseUri, sign) {
  if (typeof sign !== 'function') throw new Error('OSS signer is required');
  const extras = stagingFetchExtras(manifest, index, artifactBaseUri);
  return {
    schemaVersion: 1,
    artifacts: extras.map((extra) => ({
      filename: extra.filename,
      digest: extra.digest.slice(7),
      size: extra.size,
      source: join(STAGING_RELEASE_ROOT, manifest.releaseId, '.release', extra.filename),
      url: sign(extra.uri),
    })),
  };
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // 凭据只来自 runner 私有文件（与 put/get-web-object 同一契约）；不读 process.env，
  // 避免 deployment/scripts env 名预算扩张，也不把长期 AK 写进 ECS 载荷。
  const [manifestPath, region, outputPath, credentialsPath, indexPath, artifactBaseUri] =
    process.argv.slice(2);
  if (!manifestPath || !outputPath || !credentialsPath || Boolean(indexPath) !== Boolean(artifactBaseUri)) {
    throw new Error(
      'usage: sign-promotion-artifact-urls.mjs <manifest> <region> <output> <credentials> [<artifact-index> <artifact-base-uri>]',
    );
  }
  const credentials = JSON.parse(await readFile(required(credentialsPath, 'credentialsPath'), 'utf8'));
  const OSS = requireFromServer('ali-oss');
  const sign = createInternalOssSigner({
    OSS,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    region,
  });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const plan = indexPath
    ? buildStagingFetchPlan(
        manifest,
        JSON.parse(await readFile(indexPath, 'utf8')),
        artifactBaseUri,
        sign,
      )
    : buildFetchPlan(manifest, sign);
  await writeFile(outputPath, `${JSON.stringify(plan)}\n`);
}
