/**
 * WP3：v43 会话工具快照表的 PostgreSQL 合约（规范 §6.1）。
 *
 * 钉死三件生产语义：
 * 1. 跨进程读回逐字节相同的工具面（`prompt_cache_key` 稳定的前提）；
 * 2. 并发建快照 = 首个写入者获胜，后到者收敛到同一份；
 * 3. `installation.*` 事件按安装实例批量失效。
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { governanceV43KyAppSessionToolSnapshotStatements } from '../../data/governance-schema/v43KyAppSessionToolSnapshotMigration.js';
import type { AppCapabilityEntry } from './snapshot.js';
import { PgAppToolSnapshotStore, type PersistedAppToolSnapshot } from './snapshotStore.js';

const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
const { Pool } = pg;

function entry(overrides: Partial<AppCapabilityEntry> = {}): AppCapabilityEntry {
  return {
    installationId: 'iid-1',
    systemId: 'demo_erp',
    systemName: '演示 ERP',
    capabilityId: 'order_search',
    toolName: 'app__demo_erp__order_search',
    capabilityName: '查订单',
    description: '按条件查订单',
    riskLevel: 'read_only',
    safeToRetry: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    registeredDigest: 'a'.repeat(64),
    baseUrl: 'https://erp.example.com',
    ...overrides,
  };
}

function snapshot(overrides: Partial<PersistedAppToolSnapshot> = {}): PersistedAppToolSnapshot {
  return {
    sessionId: 'sess-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    key: `iid-1:${'a'.repeat(64)}`,
    entries: [entry()],
    degraded: false,
    createdAt: Date.parse('2026-09-06T00:00:00.000Z'),
    ...overrides,
  };
}

describePg('会话工具快照表（v43）PostgreSQL 合约', () => {
  const prefix = `ky_app_snap_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgAppToolSnapshotStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    for (const statement of governanceV43KyAppSessionToolSnapshotStatements(prefix)) {
      await pool.query(statement);
    }
    store = new PgAppToolSnapshotStore({ pool, tablePrefix: prefix });
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_ky_app_session_tool_snapshots CASCADE`);
    await pool.end();
  });

  it('写入后另一个进程读回逐字节相同的能力条目', async () => {
    const written = snapshot({ sessionId: 'sess-readback' });
    await store.save(written);
    // 另一个进程 = 另一个 store 实例（同一张表）。
    const other = new PgAppToolSnapshotStore({ pool, tablePrefix: prefix });
    const loaded = await other.load('sess-readback');
    expect(loaded).not.toBeNull();
    expect(loaded!.key).toBe(written.key);
    expect(loaded!.degraded).toBe(false);
    expect(JSON.stringify(loaded!.entries)).toBe(JSON.stringify(written.entries));
  });

  it('同会话同 key 并发写：首个写入者获胜，后到者读回先到者那一份', async () => {
    const first = snapshot({ sessionId: 'sess-race', entries: [entry({ capabilityId: 'a1' })] });
    const second = snapshot({ sessionId: 'sess-race', entries: [entry({ capabilityId: 'b2' })] });
    await store.save(first);
    const settled = await store.save(second);
    expect(settled.entries.map((item) => item.capabilityId)).toEqual(['a1']);
    const loaded = await store.load('sess-race');
    expect(loaded!.entries.map((item) => item.capabilityId)).toEqual(['a1']);
  });

  it('registeredDigest 变化（key 变化）时覆盖为新快照', async () => {
    const before = snapshot({ sessionId: 'sess-digest', key: `iid-1:${'a'.repeat(64)}` });
    await store.save(before);
    const after = snapshot({
      sessionId: 'sess-digest',
      key: `iid-1:${'b'.repeat(64)}`,
      entries: [entry({ capabilityId: 'renamed', registeredDigest: 'b'.repeat(64) })],
    });
    const settled = await store.save(after);
    expect(settled.key).toBe(`iid-1:${'b'.repeat(64)}`);
    expect(settled.entries.map((item) => item.capabilityId)).toEqual(['renamed']);
  });

  it('installation.* 事件按安装实例批量删除，不误伤别的实例', async () => {
    await store.save(
      snapshot({ sessionId: 'sess-inv-1', entries: [entry({ installationId: 'iid-x' })] }),
    );
    await store.save(
      snapshot({ sessionId: 'sess-inv-2', entries: [entry({ installationId: 'iid-x' })] }),
    );
    await store.save(
      snapshot({ sessionId: 'sess-keep', entries: [entry({ installationId: 'iid-y' })] }),
    );
    expect(await store.deleteByInstallation('iid-x')).toBe(2);
    expect(await store.load('sess-inv-1')).toBeNull();
    expect(await store.load('sess-inv-2')).toBeNull();
    expect(await store.load('sess-keep')).not.toBeNull();
    expect(await store.deleteBySession('sess-keep')).toBe(1);
  });

  it('degraded 快照（首个 run 未取到 /me）也落库，恢复路径不会凭空长出工具', async () => {
    await store.save(
      snapshot({ sessionId: 'sess-degraded', entries: [], degraded: true, key: '' }),
    );
    const loaded = await store.load('sess-degraded');
    expect(loaded!.degraded).toBe(true);
    expect(loaded!.entries).toEqual([]);
  });
});
