/**
 * PgConnectorDictionaryStore 真 PG 契约测试。
 *
 * 需要真实 PG：设置 MEMORY_CONSOLIDATION_TEST_PG_URL 启用，否则整体 skip。
 *
 * 为什么必须有这个文件：2026-08-03 上线首日，建表 SQL 用了 PG 保留字
 * `binary` 作列名，init() 在生产 syntax error 后被 catch 静默吞掉、回落
 * 内置种子——所有内存/mock 测试全绿，只有真 PG 能抓到这类错误。
 * 本测试覆盖的就是那条逃逸路径：init 建表 → 播种 → 改 → 重启不覆盖 → reset。
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgConnectorDictionaryStore } from '../data/connectorDictionaryStore.js';
import { cloneBuiltinConnectorDictionary } from '../agent/connectorDictionary.js';

const connectionString = process.env.MEMORY_CONSOLIDATION_TEST_PG_URL;
const describePg = connectionString ? describe : describe.skip;
const prefix = `cdict_test_${randomUUID().replaceAll('-', '_').slice(0, 16)}`;
const pool = connectionString ? new pg.Pool({ connectionString }) : null;
const store = pool ? new PgConnectorDictionaryStore(pool, { tablePrefix: prefix }) : null;

describePg('PgConnectorDictionaryStore contract', () => {
  beforeAll(async () => {
    // 双实例并发 init：advisory lock 下建表+播种必须幂等
    const second = new PgConnectorDictionaryStore(pool!, { tablePrefix: prefix });
    await Promise.all([store!.init(), second.init()]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${store!.table}`);
    await pool.end();
  });

  it('init 真实建表并播种内置词典（保留字列名逃逸的回归锚点）', async () => {
    const entries = await store!.listPlatform();
    const builtin = cloneBuiltinConnectorDictionary();
    expect(entries.length).toBe(builtin.length);
    const dws = entries.find((entry) => entry.binary === 'dws');
    expect(dws?.systemName).toBe('钉钉');
    expect(dws?.updatedBy).toBe('bootstrap');
    expect(dws?.actionVerbs.create).toEqual({ name: '创建', write: true });
  });

  it('upsert 改条目后重启（再次 init）不得覆盖运营改动', async () => {
    const dws = (await store!.listPlatform()).find((entry) => entry.binary === 'dws')!;
    await store!.upsert({ ...dws, systemName: '钉钉TEST' }, 'test-admin');
    await store!.init(); // 模拟重启：ON CONFLICT DO NOTHING 不得覆盖
    const after = (await store!.listPlatform()).find((entry) => entry.binary === 'dws');
    expect(after?.systemName).toBe('钉钉TEST');
    expect(after?.updatedBy).toBe('test-admin');
  });

  it('upsert 新 binary、remove、resetToBuiltin 全链路', async () => {
    await store!.upsert(
      {
        binary: 'testcli',
        systemName: '测试系统',
        enabled: true,
        modules: { todo: '待办' },
        actionVerbs: { create: { name: '创建', write: true } },
        excludePatterns: [],
        urlWhitelist: ['example.com'],
      },
      'test-admin',
    );
    expect((await store!.listPlatform()).some((entry) => entry.binary === 'testcli')).toBe(true);
    expect(await store!.remove('testcli', 'test-admin')).toBe(true);
    expect(await store!.remove('testcli', 'test-admin')).toBe(false);

    const reset = await store!.resetToBuiltin('test-admin');
    const dws = reset.find((entry) => entry.binary === 'dws');
    expect(dws?.systemName).toBe('钉钉'); // upsert 过的「钉钉TEST」被重置回内置
    expect(reset.length).toBe(cloneBuiltinConnectorDictionary().length);
  });
});
