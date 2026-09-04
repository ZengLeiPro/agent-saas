#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromServer = createRequire(
  fileURLToPath(new URL('../../server/package.json', import.meta.url)),
);

function loadOssClient(modulePath) {
  if (modulePath) return createRequire(import.meta.url)(resolve(modulePath));
  return requireFromServer('ali-oss');
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function putWebAssetCreateOnly({
  OSS,
  sourcePath,
  bucket,
  key,
  region,
  cacheControl,
  contentType,
  contentEncoding,
  accessKeyId,
  accessKeySecret,
}) {
  const client = new OSS({
    accessKeyId: required(accessKeyId, 'accessKeyId'),
    accessKeySecret: required(accessKeySecret, 'accessKeySecret'),
    bucket: required(bucket, 'bucket'),
    region: required(region, 'region').startsWith('oss-') ? region : `oss-${region}`,
    secure: true,
  });
  const headers = {
    'x-oss-forbid-overwrite': 'true',
    'Cache-Control': required(cacheControl, 'cacheControl'),
    'Content-Type': required(contentType, 'contentType'),
  };
  if (contentEncoding) headers['Content-Encoding'] = contentEncoding;
  await client.put(required(key, 'key'), required(sourcePath, 'sourcePath'), { headers });
}

async function main() {
  if (process.argv[2] === '--self-check') {
    const OSS = loadOssClient();
    if (typeof OSS !== 'function' || typeof OSS.prototype?.put !== 'function')
      throw new Error('ali-oss client does not expose the required put API');
    console.log('ali-oss create-only put API contract verified');
    return;
  }
  const [
    sourcePath,
    bucket,
    key,
    region,
    cacheControl,
    contentType,
    contentEncoding = '',
    credentialsPath,
    modulePath,
  ] = process.argv.slice(2);
  const credentials = JSON.parse(
    await readFile(required(credentialsPath, 'credentialsPath'), 'utf8'),
  );
  const OSS = loadOssClient(modulePath);
  try {
    await putWebAssetCreateOnly({
      OSS,
      sourcePath,
      bucket,
      key,
      region,
      cacheControl,
      contentType,
      contentEncoding,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
    });
  } catch (error) {
    if (error?.code === 'FileAlreadyExists' && Number(error?.status ?? error?.statusCode) === 409) {
      console.error('OSS_CREATE_ONLY_CONFLICT FileAlreadyExists status=409');
      process.exitCode = 17;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
