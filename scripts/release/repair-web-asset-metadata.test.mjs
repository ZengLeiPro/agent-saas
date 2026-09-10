import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairWebAssetMetadata, readStoredWebAsset } from './repair-web-asset-metadata.mjs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

test('真实 ali-oss SDK 的流式 GET 必须保留 gzip 存储字节', async () => {
  const compressed = gzipSync(Buffer.from('console.log("exact bytes");'));
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      ETag: '"gzip"',
    });
    res.end(compressed);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const require = createRequire(new URL('../../server/package.json', import.meta.url));
    const OSS = require('ali-oss');
    const client = new OSS({
      accessKeyId: 'test',
      accessKeySecret: 'test',
      bucket: 'test-bucket',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      cname: true,
      secure: false,
    });
    const result = await readStoredWebAsset(client, 'assets/app.js');
    assert.deepEqual(result.content, compressed);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const expected = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Content-Type': 'font/ttf',
};
function fixture(headers = { 'content-type': 'font/sfnt' }) {
  const state = { content: Buffer.from('font bytes'), etag: '"original"', headers, copies: [] };
  const client = {
    head: async () => ({ status: 200, res: { headers: { etag: state.etag } } }),
    get: async (_key, sink) => {
      sink.end(state.content);
      return {
        content: state.content,
        res: { status: 200, headers: { ...state.headers, etag: state.etag } },
      };
    },
    copy: async (target, source, options) => {
      assert.equal(target, source);
      assert.equal(options.headers['x-oss-copy-source-if-match'], state.etag);
      assert.equal(options.headers['x-oss-metadata-directive'], 'REPLACE');
      state.copies.push(options);
      state.headers = Object.fromEntries(
        Object.entries(expected).map(([k, v]) => [k.toLowerCase(), v]),
      );
    },
  };
  return { state, client };
}

test('迁移生产旧字体的缺失缓存头与 MIME，保留对象字节并具备幂等性', async () => {
  const { client, state } = fixture();
  const source = Buffer.from(state.content);
  assert.equal(
    (await repairWebAssetMetadata(client, 'assets/font.ttf', source, expected)).repaired,
    true,
  );
  assert.equal(
    (await repairWebAssetMetadata(client, 'assets/font.ttf', source, expected)).repaired,
    false,
  );
  assert.equal(state.copies.length, 1);
  assert.deepEqual(state.content, source);
});

test('内容不一致、未知元数据或编码不符时绝不修改', async () => {
  for (const headers of [{ 'content-encoding': 'gzip' }, { 'x-oss-meta-private': 'yes' }]) {
    const { client, state } = fixture(headers);
    await assert.rejects(
      repairWebAssetMetadata(client, 'assets/font.ttf', state.content, expected),
    );
    assert.equal(state.copies.length, 0);
  }
  const { client, state } = fixture();
  await assert.rejects(
    repairWebAssetMetadata(client, 'assets/font.ttf', Buffer.from('different'), expected),
  );
  assert.equal(state.copies.length, 0);
});

test('并发对象替换导致条件复制失败，不能重试成无条件覆盖', async () => {
  const { client, state } = fixture();
  client.copy = async (_target, _source, options) => {
    assert.equal(options.headers['x-oss-copy-source-if-match'], '"original"');
    state.copies.push(options);
    throw new Error('PreconditionFailed: 412');
  };
  await assert.rejects(
    repairWebAssetMetadata(client, 'assets/font.ttf', state.content, expected),
    /412/,
  );
  assert.equal(state.copies.length, 1);
});

test('复制后仍核对实际字节及响应头，不能用成功回执代替回读', async () => {
  const { client, state } = fixture();
  const source = Buffer.from(state.content);
  client.copy = async () => {
    state.content = Buffer.from('changed');
  };
  await assert.rejects(
    repairWebAssetMetadata(client, 'assets/font.ttf', source, expected),
    /回读失败/,
  );
});
