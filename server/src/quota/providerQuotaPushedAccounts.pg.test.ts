/**
 * 推送型来源的账号发现（真实 PG）：Claude 订阅账号不在平台配置里声明，
 * 看板完全依据这条 SQL 从快照表里发现账号，因此必须打真实 PG 而不是 FakePool。
 * 设置 TEST_DATABASE_URL 启用，否则整体 skip。
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ProviderQuotaSnapshot } from '@agent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

function snapshot(
  overrides: Partial<ProviderQuotaSnapshot> &
    Pick<ProviderQuotaSnapshot, 'accountKey' | 'collectedAt'>,
): ProviderQuotaSnapshot {
  return {
    sourceKind: 'claude_subscription',
    accountLabel: overrides.accountKey,
    windows: [],
    limitReached: false,
    ok: true,
    ...overrides,
  };
}

describePg('推送型账号发现', () => {
  const prefix = `quota_pushed_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: pg.Pool;
  let store: PgProviderQuotaSnapshotStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
    store = new PgProviderQuotaSnapshotStore(pool, { tablePrefix: prefix });
    await store.init();
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.planExpiryTable}, ${store.table}`);
    } finally {
      await pool.end();
    }
  });

  it('按账号取最新标签、只认指定来源、超出保留窗口的账号自动消失', async () => {
    const now = Date.now();
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    await store.append([
      // 同一账号两条：标签以最新一条为准（邮箱改名/大小写变化时不会留下旧标签）。
      snapshot({
        accountKey: 'claude:a@example.com',
        accountLabel: '旧标签',
        collectedAt: iso(-60_000),
      }),
      snapshot({
        accountKey: 'claude:a@example.com',
        accountLabel: 'a@example.com',
        collectedAt: iso(-1_000),
      }),
      // 失败快照同样算「账号存在」，否则采集端一出错账号就从看板消失。
      snapshot({
        accountKey: 'claude:b@example.com',
        collectedAt: iso(-2_000),
        ok: false,
        error: 'boom',
      }),
      // 其他来源不应混入。
      snapshot({
        accountKey: 'codex:x',
        sourceKind: 'codex_subscription',
        collectedAt: iso(-1_000),
      }),
      // 超出 staleDays：账号已停止上报，自动摘除。
      snapshot({ accountKey: 'claude:gone@example.com', collectedAt: iso(-9 * 24 * 3_600_000) }),
    ]);

    const found = await store.pushedAccounts('claude_subscription', 7);
    expect(found).toEqual([
      { accountKey: 'claude:a@example.com', accountLabel: 'a@example.com' },
      { accountKey: 'claude:b@example.com', accountLabel: 'claude:b@example.com' },
    ]);

    // 放宽窗口后停报账号重新出现，证明过滤条件确实是时间而不是别的。
    const wide = await store.pushedAccounts('claude_subscription', 30);
    expect(wide.map((item) => item.accountKey)).toContain('claude:gone@example.com');

    expect(await store.pushedAccounts('volcengine_ark_plan', 7)).toEqual([]);
  });

  it('标签为空白时回退到账号键，不产生空标题卡片', async () => {
    await store.append([
      snapshot({
        accountKey: 'claude:blank@example.com',
        accountLabel: '   ',
        collectedAt: new Date().toISOString(),
      }),
    ]);
    const found = await store.pushedAccounts('claude_subscription', 7);
    expect(found).toContainEqual({
      accountKey: 'claude:blank@example.com',
      accountLabel: 'claude:blank@example.com',
    });
  });
});
