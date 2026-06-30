/**
 * Token Usage API 路由测试 (/api/admin/usage/*)
 *
 * 覆盖：
 *   - rangePreset 解析（today/7d/30d/mtd/all）
 *   - 显式 from/to 优先
 *   - 参数校验与错误码
 *   - realName enrich
 *   - data-range 端点
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';

import { getBusinessDb, __resetBusinessDbForTest } from '../data/db/business.js';
import { runBusinessMigrations } from '../data/db/migrations.js';
import { createTokenUsageStore, type TokenUsageStore } from '../data/usage/store.js';
import { createUsageRouter } from '../routes/usage.js';
import { UserStore } from '../data/users/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function shiftDate(yyyyMmDd: string, deltaDays: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

interface StartOptions {
  userStore?: UserStore;
  triggerRebuild?: () => Promise<unknown>;
}

async function startServer(store: TokenUsageStore, options: StartOptions = {}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    // fixture 注入 platform admin 以便 /rebuild 通过 requirePlatformAdmin
    (req as unknown as { user: { sub: string; username: string; role: 'admin'; tenantId: string } }).user = {
      sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID,
    };
    next();
  });
  app.use('/api/admin/usage', createUsageRouter({
    tokenUsageStore: store,
    userStore: options.userStore,
    triggerRebuild: options.triggerRebuild,
  }));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: s, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

describe('/api/admin/usage routes', () => {
  let dataDir: string;
  const cleanup = new Set<string>();
  let store: TokenUsageStore;
  let server: Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'usage-routes-test-'));
    cleanup.add(dataDir);
    __resetBusinessDbForTest();
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    store = createTokenUsageStore(db);
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = null;
    }
    __resetBusinessDbForTest();
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanup.clear();
  });

  it('GET /overview 默认 range=30d', async () => {
    const today = todayBeijing();
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'claude-opus-4-7': { inputTokens: 100, outputTokens: 50, costUSD: 0.01 } },
      occurredAtMs: Date.now(),
    });
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/overview`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe('30d');
    expect(body.fromDate).toBe(shiftDate(today, -29));
    expect(body.toDate).toBe(today);
    expect(body.totalInputTokens).toBe(100);
    expect(body.totalOutputTokens).toBe(50);
    expect(body.activeUsers).toBe(1);
  });

  it('GET /overview?range=today 取北京当天', async () => {
    const today = todayBeijing();
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/overview?range=today`);
    const body = await res.json();
    expect(body.fromDate).toBe(today);
    expect(body.toDate).toBe(today);
  });

  it('GET /overview?range=7d 涵盖 7 天（含今天）', async () => {
    const today = todayBeijing();
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/overview?range=7d`);
    const body = await res.json();
    expect(body.fromDate).toBe(shiftDate(today, -6));
    expect(body.toDate).toBe(today);
  });

  it('GET /overview?range=mtd 从本月 1 号起', async () => {
    const today = todayBeijing();
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/overview?range=mtd`);
    const body = await res.json();
    expect(body.fromDate).toBe(today.slice(0, 7) + '-01');
    expect(body.toDate).toBe(today);
  });

  it('GET /overview?from=&to= 显式范围优先于 range', async () => {
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 1, outputTokens: 1 } },
      occurredAtMs: Date.parse('2026-05-15T08:00:00+08:00'),
    });
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/overview?range=today&from=2026-05-15&to=2026-05-15`);
    const body = await res.json();
    expect(body.range).toBe('custom');
    expect(body.fromDate).toBe('2026-05-15');
    expect(body.toDate).toBe('2026-05-15');
    expect(body.totalInputTokens).toBe(1);
  });

  it('GET /overview supports minute-level custom ranges', async () => {
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 10, outputTokens: 5 } },
      occurredAtMs: Date.parse('2026-05-15T09:30:00+08:00'),
    });
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 20, outputTokens: 10 } },
      occurredAtMs: Date.parse('2026-05-15T10:30:00+08:00'),
    });
    ({ server, baseUrl } = await startServer(store));

    const res = await fetch(`${baseUrl}/api/admin/usage/overview?from=2026-05-15T09:00&to=2026-05-15T09:59`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toBe('custom');
    expect(body.fromDate).toBe('2026-05-15T09:00');
    expect(body.toDate).toBe('2026-05-15T09:59');
    expect(body.totalInputTokens).toBe(10);
    expect(body.totalOutputTokens).toBe(5);
  });

  it('GET /overview rejects reversed explicit ranges', async () => {
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/overview?from=2026-05-15T10:00&to=2026-05-15T09:00`);
    expect(res.status).toBe(400);
  });

  it('GET /overview?from=非法日期 → 400', async () => {
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/overview?from=invalid`);
    expect(res.status).toBe(400);
  });

  it('GET /by-user enrich realName', async () => {
    const userFile = join(mkdtempSync(join(tmpdir(), 'usage-userstore-')), 'users.json');
    const userStore = new UserStore(userFile);
    await userStore.create({ username: 'admin', password: 'x'.repeat(8), role: 'admin', createdBy: 'system', realName: '曾磊' });
    await userStore.create({ username: 'huangyp', password: 'x'.repeat(8), role: 'user', createdBy: 'system', realName: '黄艺萍' });

    const t = Date.parse('2026-05-15T08:00:00+08:00');
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 100, outputTokens: 50 } },
      occurredAtMs: t,
    });
    store.recordResult({
      username: 'huangyp', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 50, outputTokens: 30 } },
      occurredAtMs: t,
    });

    ({ server, baseUrl } = await startServer(store, { userStore }));
    const res = await fetch(`${baseUrl}/api/admin/usage/by-user?from=2026-05-15&to=2026-05-15`);
    const body = await res.json();
    expect(body.users).toHaveLength(2);
    const admin = body.users.find((u: { username: string }) => u.username === 'admin');
    const huang = body.users.find((u: { username: string }) => u.username === 'huangyp');
    expect(admin.realName).toBe('曾磊');
    expect(huang.realName).toBe('黄艺萍');
  });

  it('GET /by-model?username=admin 按用户过滤', async () => {
    const t = Date.parse('2026-05-15T08:00:00+08:00');
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'opus': { inputTokens: 100, outputTokens: 50 } },
      occurredAtMs: t,
    });
    store.recordResult({
      username: 'huangyp', channel: 'web',
      tenantId: 'kaiyan',
      modelUsage: { 'opus': { inputTokens: 5000, outputTokens: 2000 } },
      occurredAtMs: t,
    });
    ({ server, baseUrl } = await startServer(store));

    const all = await (await fetch(`${baseUrl}/api/admin/usage/by-model?from=2026-05-15&to=2026-05-15`)).json();
    expect(all.models[0].inputTokens).toBe(5100);
    expect(all.username).toBeNull();

    const adminOnly = await (await fetch(`${baseUrl}/api/admin/usage/by-model?from=2026-05-15&to=2026-05-15&username=admin`)).json();
    expect(adminOnly.models[0].inputTokens).toBe(100);
    expect(adminOnly.username).toBe('admin');
  });

  it('GET /trend 不传 username 返回全公司日合计', async () => {
    const t = (d: string) => Date.parse(`${d}T08:00:00+08:00`);
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 100, outputTokens: 50 } },
      occurredAtMs: t('2026-05-15'),
    });
    store.recordResult({
      username: 'huangyp', channel: 'web',
      tenantId: 'kaiyan',
      modelUsage: { 'm': { inputTokens: 200, outputTokens: 100 } },
      occurredAtMs: t('2026-05-15'),
    });
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/trend?from=2026-05-15&to=2026-05-15`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBeNull();
    expect(body.realName).toBeNull();
    expect(body.points).toHaveLength(1);
    expect(body.points[0].inputTokens).toBe(300);
    expect(body.points[0].outputTokens).toBe(150);
  });

  it('GET /trend 返回日序列', async () => {
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 100, outputTokens: 50 } },
      occurredAtMs: Date.parse('2026-05-14T08:00:00+08:00'),
    });
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 200, outputTokens: 100 } },
      occurredAtMs: Date.parse('2026-05-15T08:00:00+08:00'),
    });
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/trend?username=admin&from=2026-05-14&to=2026-05-15`);
    const body = await res.json();
    expect(body.points).toHaveLength(2);
    expect(body.points[0].date).toBe('2026-05-14');
    expect(body.points[1].date).toBe('2026-05-15');
  });

  it('GET /data-range 返回数据完整性元信息', async () => {
    store.upsertRaw({
      date: '2026-04-01', username: 'a', tenantId: 'kaiyan', model: 'm', channel: 'web',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsdMicro: 0, turnDelta: 1, occurredAtMs: Date.now(),
    });
    store.upsertRaw({
      date: '2026-05-15', username: 'a', tenantId: 'kaiyan', model: 'm', channel: 'web',
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsdMicro: 12345, turnDelta: 1, occurredAtMs: Date.now(),
    });
    store.setRebuildState({
      lastRebuildAtMs: 1700000000000,
      lastFullScanMs: 1700000000000,
      jsonlMaxMtimeMs: 1700000000000,
      totalFilesScanned: 42,
      totalRowsBuilt: 7,
    });
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/data-range`);
    const body = await res.json();
    expect(body.earliestDate).toBe('2026-04-01');
    expect(body.latestDate).toBe('2026-05-15');
    expect(body.firstCostDate).toBe('2026-05-15');
    expect(body.rebuild?.totalFilesScanned).toBe(42);
  });

  it('GET /by-channel 返回 web/cron 分布', async () => {
    const t = Date.parse('2026-05-15T08:00:00+08:00');
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 100, outputTokens: 50 } },
      occurredAtMs: t,
    });
    store.recordResult({
      username: 'admin', channel: 'cron',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 20, outputTokens: 10 } },
      occurredAtMs: t,
    });
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/by-channel?from=2026-05-15&to=2026-05-15`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channels).toHaveLength(2);
    const byCh = new Map<string, { inputTokens: number }>(body.channels.map((c: { channel: string }) => [c.channel, c]));
    expect(byCh.get('web')?.inputTokens).toBe(100);
    expect(byCh.get('cron')?.inputTokens).toBe(20);
  });

  it('GET /by-channel?username=admin 按用户过滤', async () => {
    const t = Date.parse('2026-05-15T08:00:00+08:00');
    store.recordResult({
      username: 'admin', channel: 'web',
      tenantId: DEFAULT_TENANT_ID,
      modelUsage: { 'm': { inputTokens: 100, outputTokens: 50 } },
      occurredAtMs: t,
    });
    store.recordResult({
      username: 'huangyp', channel: 'web',
      tenantId: 'kaiyan',
      modelUsage: { 'm': { inputTokens: 99, outputTokens: 99 } },
      occurredAtMs: t,
    });
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/by-channel?from=2026-05-15&to=2026-05-15&username=admin`);
    const body = await res.json();
    expect(body.username).toBe('admin');
    expect(body.channels[0].inputTokens).toBe(100);
  });

  it('POST /rebuild 触发器未注入时返回 503', async () => {
    ({ server, baseUrl } = await startServer(store));
    const res = await fetch(`${baseUrl}/api/admin/usage/rebuild`, { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('POST /rebuild 异步触发并返回 202', async () => {
    let triggered = 0;
    const trigger = () => {
      triggered++;
      return new Promise((r) => setTimeout(r, 30));
    };
    ({ server, baseUrl } = await startServer(store, { triggerRebuild: trigger }));
    const res = await fetch(`${baseUrl}/api/admin/usage/rebuild`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.started).toBe(true);
    // trigger 是异步触发的，路由返回时 triggered 应已 +1（同步进入 Promise.resolve）
    expect(triggered).toBe(1);
  });

  it('POST /rebuild 并发返回 409', async () => {
    let resolveRebuild: (() => void) | undefined;
    const trigger = () => new Promise<void>((resolve) => {
      resolveRebuild = resolve;
    });
    ({ server, baseUrl } = await startServer(store, { triggerRebuild: trigger }));
    const r1 = await fetch(`${baseUrl}/api/admin/usage/rebuild`, { method: 'POST' });
    expect(r1.status).toBe(202);
    const r2 = await fetch(`${baseUrl}/api/admin/usage/rebuild`, { method: 'POST' });
    expect(r2.status).toBe(409);
    // 释放第一个 rebuild，让后续测试不悬挂
    resolveRebuild?.();
  });
});
