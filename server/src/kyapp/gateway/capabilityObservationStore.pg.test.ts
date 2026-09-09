import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { governanceV43KyAppSessionToolSnapshotStatements } from '../../data/governance-schema/v43KyAppSessionToolSnapshotMigration.js';
import type { AppCapabilityEntry } from './snapshot.js';
import { PgAppToolSnapshotStore, type PersistedAppToolSnapshot } from './snapshotStore.js';
import { PgKyAppCapabilityObservationReader } from './capabilityObservationStore.js';

const url = process.env.TEST_DATABASE_URL;
const digest = 'a'.repeat(64);

describe('业务系统逐用户能力观测归因', () => {
  it('多系统快照 degraded 时不把其他系统故障错误归因到当前零能力系统', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            user_id: 'u1',
            snapshot_key: `install-1:${digest}|install-2:${digest}`,
            entries: JSON.stringify([entry({ installationId: 'install-2', systemId: 'crm' })]),
            degraded: true,
            updated_at: '2026-09-08T01:00:00Z',
          },
        ],
      }),
    };
    const observations = new PgKyAppCapabilityObservationReader(pool as never);

    await expect(observations.get('tenant-a', 'install-1', 'u1', digest)).resolves.toMatchObject({
      status: 'unverified',
      enabledCapabilityCount: 0,
    });
  });
});

function entry(overrides: Partial<AppCapabilityEntry> = {}): AppCapabilityEntry {
  return {
    installationId: 'install-1',
    systemId: 'erp',
    systemName: 'ERP',
    capabilityId: 'order_search',
    toolName: 'app__erp__order_search',
    capabilityName: '查询订单',
    description: '查询订单',
    riskLevel: 'read_only',
    safeToRetry: true,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    registeredDigest: digest,
    baseUrl: 'https://api.example.com',
    ...overrides,
  };
}

function snapshot(
  sessionId: string,
  userId: string,
  overrides: Partial<PersistedAppToolSnapshot> = {},
): PersistedAppToolSnapshot {
  return {
    sessionId,
    tenantId: 'tenant-a',
    userId,
    key: `install-1:${digest}`,
    entries: [entry()],
    degraded: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

(url ? describe : describe.skip)('业务系统逐用户能力观测 PostgreSQL', () => {
  const prefix = `obs_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const snapshots = new PgAppToolSnapshotStore({ pool, tablePrefix: prefix });
  const observations = new PgKyAppCapabilityObservationReader(pool, prefix);

  beforeAll(async () => {
    for (const sql of governanceV43KyAppSessionToolSnapshotStatements(prefix)) {
      await pool.query(sql);
    }
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_ky_app_session_tool_snapshots CASCADE`);
    await pool.end();
  });

  it('从真实会话最终工具面区分可用、未投影和 /me 不可用', async () => {
    await snapshots.save(snapshot('session-ready', 'u1'));
    await snapshots.save(snapshot('session-empty', 'u2', { entries: [] }));
    await snapshots.save(snapshot('session-unavailable', 'u3', { entries: [], degraded: true }));

    expect(await observations.get('tenant-a', 'install-1', 'u1', digest)).toMatchObject({
      userId: 'u1',
      status: 'ready',
      enabledCapabilityCount: 1,
      checkedAt: expect.any(String),
    });
    expect(await observations.get('tenant-a', 'install-1', 'u2', digest)).toMatchObject({
      userId: 'u2',
      status: 'not_projected',
      enabledCapabilityCount: 0,
    });
    expect(await observations.get('tenant-a', 'install-1', 'u3', digest)).toMatchObject({
      userId: 'u3',
      status: 'unavailable',
      enabledCapabilityCount: 0,
    });
  });

  it('批量读取每个用户的最新会话事实，不把旧快照误报为可用', async () => {
    await snapshots.save(snapshot('session-old', 'u-latest'));
    await snapshots.save(snapshot('session-new', 'u-latest', { entries: [] }));
    await pool.query(
      `UPDATE ${prefix}_ky_app_session_tool_snapshots
       SET updated_at = CASE session_id
         WHEN 'session-old' THEN '2026-01-01T00:00:00Z'::timestamptz
         ELSE '2026-01-02T00:00:00Z'::timestamptz END
       WHERE session_id IN ('session-old','session-new')`,
    );

    const listed = await observations.listForInstallation('tenant-a', 'install-1', digest);
    expect(listed.filter((item) => item.userId === 'u-latest')).toEqual([
      expect.objectContaining({
        status: 'not_projected',
        enabledCapabilityCount: 0,
      }),
    ]);
  });

  it('登记 digest 变化后不复用旧会话结果', async () => {
    expect(await observations.get('tenant-a', 'install-1', 'u1', 'b'.repeat(64))).toBeNull();
  });
});
