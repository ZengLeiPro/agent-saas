import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgImageBlobStore } from '../runtime/imageBlobStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('模型图片 blob PostgreSQL 契约', () => {
  const prefix = `imgblob_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgImageBlobStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgImageBlobStore({ pool, tablePrefix: prefix });
    // 并发 init 必须幂等：蓝绿两个实例会同时建表
    await Promise.all([store.init(), new PgImageBlobStore({ pool, tablePrefix: prefix }).init()]);
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.table}`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('写入后可按 (workspace, blobKey) 原样读回二进制', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    await store.put({ workspaceKey: '/ws/a', blobKey: 'aa-v1.png', mimeType: 'image/png', bytes });

    const record = await store.get('/ws/a', 'aa-v1.png');
    expect(record?.mimeType).toBe('image/png');
    expect(record?.sizeBytes).toBe(bytes.byteLength);
    expect(Buffer.compare(record!.bytes, bytes)).toBe(0);
  });

  it('同键重复写入幂等，且不覆盖既有字节', async () => {
    const original = Buffer.from([255, 216, 255, 1]);
    await store.put({ workspaceKey: '/ws/b', blobKey: 'bb-v1.jpg', mimeType: 'image/jpeg', bytes: original });
    await store.put({
      workspaceKey: '/ws/b',
      blobKey: 'bb-v1.jpg',
      mimeType: 'image/jpeg',
      bytes: Buffer.from([9, 9, 9, 9, 9, 9]),
    });

    const record = await store.get('/ws/b', 'bb-v1.jpg');
    expect(Buffer.compare(record!.bytes, original)).toBe(0);
  });

  it('workspace 隔离：同名 blobKey 不跨工作区可见', async () => {
    await store.put({
      workspaceKey: '/ws/tenant-1',
      blobKey: 'shared-v1.png',
      mimeType: 'image/png',
      bytes: Buffer.from([1, 1, 1]),
    });
    expect(await store.get('/ws/tenant-2', 'shared-v1.png')).toBeUndefined();
  });

  it('超过单图上限的对象不入库', async () => {
    await store.put({
      workspaceKey: '/ws/c',
      blobKey: 'huge-v1.png',
      mimeType: 'image/png',
      bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    expect(await store.get('/ws/c', 'huge-v1.png')).toBeUndefined();
  });
});


describe('PgImageBlobStore init 竞态恢复', () => {
  it('42710 且目标表已存在时视为并发建表成功', async () => {
    const duplicateType = Object.assign(new Error('type already exists'), { code: '42710' });
    const query = vi.fn()
      .mockRejectedValueOnce(duplicateType)
      .mockResolvedValueOnce({ rows: [{ oid: 'imgblob_race_image_blobs' }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query } as unknown as InstanceType<typeof Pool>;
    const store = new PgImageBlobStore({ pool, tablePrefix: 'imgblob_race' });

    await expect(store.init()).resolves.toBeUndefined();
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT to_regclass($1)::text AS oid',
      ['imgblob_race_image_blobs'],
    );
  });
});
