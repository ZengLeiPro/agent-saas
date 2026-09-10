import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

export async function readStoredWebAsset(client, key) {
  const chunks = [];
  // ali-oss 的内存 GET 会自动解压；Writable GET 保留 OSS 实际存储字节。
  const sink = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const result = await client.get(key, sink);
  return { ...result, content: Buffer.concat(chunks) };
}

// 只迁移字节完全一致的存量对象响应头；并发内容变化由源 ETag 条件拒绝。
export async function repairWebAssetMetadata(client, key, source, expected) {
  const head = await client.head(key);
  const etag = head.res?.headers?.etag;
  if (head.status !== 200 || !etag) throw new Error(`缺少对象身份: ${key}`);
  const current = await readStoredWebAsset(client, key);
  if (
    current.res?.status !== 200 ||
    current.res?.headers?.etag !== etag ||
    !Buffer.isBuffer(current.content) ||
    !current.content.equals(source)
  ) {
    throw new Error(`存量对象字节不一致，拒绝修改响应头: ${key}`);
  }
  const headers = current.res.headers;
  if ((headers['content-encoding'] ?? '') !== (expected['Content-Encoding'] ?? '')) {
    throw new Error(`存量对象编码不一致: ${key}`);
  }
  if (
    Object.keys(headers).some((name) =>
      /^(content-disposition|content-language|expires|x-oss-meta-.+)$/i.test(name),
    )
  ) {
    throw new Error(`存量对象含未审核元数据: ${key}`);
  }
  if (Object.entries(expected).every(([name, value]) => headers[name.toLowerCase()] === value)) {
    return { key, repaired: false };
  }
  await client.copy(key, key, {
    headers: {
      ...expected,
      'x-oss-metadata-directive': 'REPLACE',
      'x-oss-copy-source-if-match': etag,
    },
  });
  const after = await readStoredWebAsset(client, key);
  if (
    after.res?.status !== 200 ||
    !Buffer.isBuffer(after.content) ||
    !after.content.equals(source) ||
    !Object.entries(expected).every(
      ([name, value]) => after.res.headers[name.toLowerCase()] === value,
    )
  ) {
    throw new Error(`存量对象响应头迁移回读失败: ${key}`);
  }
  return { key, repaired: true };
}

async function main() {
  const [
    sourcePath,
    bucket,
    key,
    region,
    cacheControl,
    contentType,
    contentEncoding,
    credentialsPath,
    modulePath,
  ] = process.argv.slice(2);
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const OSS = require(modulePath ? resolve(modulePath) : 'ali-oss');
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  const client = new OSS({
    ...credentials,
    bucket,
    region: `oss-${region.replace(/^oss-/, '')}`,
    secure: true,
  });
  const expected = { 'Cache-Control': cacheControl, 'Content-Type': contentType };
  if (contentEncoding) expected['Content-Encoding'] = contentEncoding;
  const result = await repairWebAssetMetadata(client, key, await readFile(sourcePath), expected);
  if (result.repaired) console.log(`已迁移存量资源响应头（字节不变）: ${key}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
