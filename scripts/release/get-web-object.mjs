#!/usr/bin/env node
// Authenticated, byte-exact readback of one Web bucket object.
//
// ossutil 2.1.2 `cp` and aliyun CLI `oss cp` both let the Go HTTP transport transparently
// gunzip `Content-Encoding: gzip` objects and then fail their own CRC64 check against the
// stored bytes ("crc is inconsistent"), so neither can read back immutable gzip assets.
// The ali-oss SDK GET sends no Accept-Encoding and writes exactly the stored bytes.
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

export async function getWebObject({
  OSS,
  bucket,
  key,
  region,
  output,
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
  // The bucket serves a static-website fallback: GET of a missing key answers 200 with index.html
  // even on the API endpoint, while HEAD answers 404. HEAD first, then bind GET to the same ETag.
  const head = await client.head(required(key, 'key'));
  const expectedEtag = head?.res?.headers?.etag;
  if (Number(head?.status) !== 200 || !expectedEtag)
    throw new Error(`OSS HEAD did not return an object ETag for ${key}`);
  const result = await client.get(key, required(output, 'output'));
  const status = Number(result?.res?.status);
  if (status !== 200) throw new Error(`OSS GET returned HTTP ${status} for ${key}`);
  const headers = result.res.headers ?? {};
  if (headers.etag !== expectedEtag)
    throw new Error(`OSS GET returned a different object than HEAD for ${key} (website fallback?)`);
  return {
    key,
    etag: expectedEtag,
    contentEncoding: headers['content-encoding'] ?? null,
    contentType: headers['content-type'] ?? null,
  };
}

async function main() {
  // Credentials come only from a runner-private credentials file (same contract as the put helper);
  // never from argv, and not from the environment so the deployment env-name budget stays untouched.
  const [bucket, key, region, output, credentialsPath, modulePath = ''] = process.argv.slice(2);
  const credentials = JSON.parse(
    await readFile(required(credentialsPath, 'credentialsPath'), 'utf8'),
  );
  const OSS = loadOssClient(modulePath);
  const summary = await getWebObject({
    OSS,
    bucket,
    key,
    region,
    output,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
  });
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
