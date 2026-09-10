import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairWebAssetMetadata } from './repair-web-asset-metadata.mjs';

const expected = {
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Content-Type': 'font/ttf',
};
function fixture(headers = { 'content-type': 'font/sfnt' }) {
  const state = { content: Buffer.from('font bytes'), etag: '"original"', headers, copies: [] };
  const client = {
    head: async () => ({ status: 200, res: { headers: { etag: state.etag } } }),
    get: async () => ({
      content: state.content,
      res: { status: 200, headers: { ...state.headers, etag: state.etag } },
    }),
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
