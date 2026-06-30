/**
 * Token Usage 聚合查询测试（getOverview / getByUser / getByModel / getTrend / getDataRange）
 *
 * 与基础写入测试（tokenUsage.test.ts）分开放，便于按职责定位失败。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getBusinessDb, __resetBusinessDbForTest } from '../data/db/business.js';
import { runBusinessMigrations } from '../data/db/migrations.js';
import { createTokenUsageStore, type TokenUsageStore } from '../data/usage/store.js';

function seedFixture(store: TokenUsageStore): void {
  // 三个用户、三天、两个模型、混合 web/cron channel
  // admin 2026-05-14 web claude-opus-4-7: in=1000 out=500 cr=10000 cc=200 cost=$0.10
  // admin 2026-05-15 web claude-opus-4-7: in=2000 out=1000 cr=20000 cc=400 cost=$0.20
  // admin 2026-05-15 web claude-haiku-4-5: in=500 out=200 cr=0 cc=0 cost=$0.01
  // huangyp 2026-05-15 web claude-opus-4-7: in=300 out=150 cr=3000 cc=100 cost=$0.05
  // huangyp 2026-05-16 cron claude-opus-4-7: in=100 out=50 cr=1000 cc=20 cost=$0.02
  // yangyh 2026-05-16 web claude-opus-4-7: in=200 out=100 cr=2000 cc=50 cost=$0.03
  const t = (date: string) => Date.parse(`${date}T08:00:00+08:00`);

  store.recordResult({
    username: 'admin', channel: 'web',
    tenantId: 'kaiyan',
    modelUsage: { 'claude-opus-4-7': { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 10000, cacheCreationInputTokens: 200, costUSD: 0.10 } },
    occurredAtMs: t('2026-05-14'),
  });
  store.recordResult({
    username: 'admin', channel: 'web',
    tenantId: 'kaiyan',
    modelUsage: { 'claude-opus-4-7': { inputTokens: 2000, outputTokens: 1000, cacheReadInputTokens: 20000, cacheCreationInputTokens: 400, costUSD: 0.20 } },
    occurredAtMs: t('2026-05-15'),
  });
  store.recordResult({
    username: 'admin', channel: 'web',
    tenantId: 'kaiyan',
    modelUsage: { 'claude-haiku-4-5': { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } },
    occurredAtMs: t('2026-05-15'),
  });
  store.recordResult({
    username: 'huangyp', channel: 'web',
    tenantId: 'kaiyan',
    modelUsage: { 'claude-opus-4-7': { inputTokens: 300, outputTokens: 150, cacheReadInputTokens: 3000, cacheCreationInputTokens: 100, costUSD: 0.05 } },
    occurredAtMs: t('2026-05-15'),
  });
  store.recordResult({
    username: 'huangyp', channel: 'cron',
    tenantId: 'kaiyan',
    modelUsage: { 'claude-opus-4-7': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 20, costUSD: 0.02 } },
    occurredAtMs: t('2026-05-16'),
  });
  store.recordResult({
    username: 'yangyh', channel: 'web',
    tenantId: 'kaiyan',
    modelUsage: { 'claude-opus-4-7': { inputTokens: 200, outputTokens: 100, cacheReadInputTokens: 2000, cacheCreationInputTokens: 50, costUSD: 0.03 } },
    occurredAtMs: t('2026-05-16'),
  });
}

describe('token usage aggregation', () => {
  const cleanupDirs = new Set<string>();
  let dataDir: string;
  let store: TokenUsageStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'token-usage-agg-test-'));
    cleanupDirs.add(dataDir);
    __resetBusinessDbForTest();
    const db = getBusinessDb(dataDir);
    runBusinessMigrations(db);
    store = createTokenUsageStore(db);
    seedFixture(store);
  });

  afterEach(async () => {
    __resetBusinessDbForTest();
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  describe('getOverview', () => {
    it('aggregates full range correctly', () => {
      const o = store.getOverview('2026-05-14', '2026-05-16');
      // 总和：
      // in = 1000+2000+500+300+100+200 = 4100
      // out = 500+1000+200+150+50+100 = 2000
      // cr = 10000+20000+0+3000+1000+2000 = 36000
      // cc = 200+400+0+100+20+50 = 770
      // cost 按本地 pricing.ts（claude-opus-4-7: 5/25/10/0.5，claude-haiku-4-5: 1/5/2/0.1）
      //   opus-4-7  (1000,500,10000,200):  5*1000 + 25*500 + 0.5*10000 + 10*200  = 24500
      //   opus-4-7  (2000,1000,20000,400): 5*2000 + 25*1000 + 0.5*20000 + 10*400 = 49000
      //   haiku-4-5 (500,200,0,0):         1*500  + 5*200                         =  1500
      //   opus-4-7  (300,150,3000,100):    5*300  + 25*150 + 0.5*3000 + 10*100   =  7750
      //   opus-4-7  (100,50,1000,20):      5*100  + 25*50  + 0.5*1000 + 10*20    =  2450
      //   opus-4-7  (200,100,2000,50):     5*200  + 25*100 + 0.5*2000 + 10*50    =  5000
      //   合计 = 90200 micro = $0.0902
      // turns = 6
      // active_users = 3
      expect(o.totalInputTokens).toBe(4100);
      expect(o.totalOutputTokens).toBe(2000);
      expect(o.totalCacheReadTokens).toBe(36000);
      expect(o.totalCacheCreationTokens).toBe(770);
      expect(o.totalTokens).toBe(4100 + 2000 + 36000 + 770);
      expect(o.totalCostUsd).toBeCloseTo(0.0902, 4);
      expect(o.totalTurns).toBe(6);
      expect(o.activeUsers).toBe(3);
      // cacheHitRatio = 36000 / (4100 + 36000 + 770) = 36000 / 40870
      expect(o.cacheHitRatio).toBeCloseTo(36000 / 40870, 6);
    });

    it('narrows by date range', () => {
      const o = store.getOverview('2026-05-15', '2026-05-15');
      expect(o.activeUsers).toBe(2);  // admin + huangyp
      // admin: in=2000+500, out=1000+200, cr=20000+0, cc=400+0
      // huangyp: in=300, out=150, cr=3000, cc=100
      expect(o.totalInputTokens).toBe(2000 + 500 + 300);
      expect(o.totalOutputTokens).toBe(1000 + 200 + 150);
    });

    it('narrows by minute range when from/to include time', () => {
      const o = store.getOverview('2026-05-15T00:00', '2026-05-15T23:59');
      expect(o.activeUsers).toBe(2);
      expect(o.totalInputTokens).toBe(2000 + 500 + 300);
      expect(o.totalOutputTokens).toBe(1000 + 200 + 150);

      const empty = store.getOverview('2026-05-15T08:01', '2026-05-15T08:59');
      expect(empty.totalTokens).toBe(0);
      expect(empty.activeUsers).toBe(0);
    });

    it('returns null hit ratio when no input', () => {
      const o = store.getOverview('2026-01-01', '2026-01-01');  // 空范围
      expect(o.totalTokens).toBe(0);
      expect(o.activeUsers).toBe(0);
      expect(o.cacheHitRatio).toBeNull();
    });
  });

  describe('getByUser', () => {
    it('orders by total tokens desc', () => {
      const rows = store.getByUser('2026-05-14', '2026-05-16');
      expect(rows.map(r => r.username)).toEqual(['admin', 'huangyp', 'yangyh']);
    });

    it('includes lastActiveDate per user', () => {
      const rows = store.getByUser('2026-05-14', '2026-05-16');
      const huang = rows.find(r => r.username === 'huangyp')!;
      expect(huang.lastActiveDate).toBe('2026-05-16');
      const admin = rows.find(r => r.username === 'admin')!;
      expect(admin.lastActiveDate).toBe('2026-05-15');
    });

    it('includes minute-level lastActiveDate for time ranges', () => {
      const rows = store.getByUser('2026-05-15T00:00', '2026-05-15T23:59');
      const admin = rows.find(r => r.username === 'admin')!;
      expect(admin.lastActiveDate).toBe('2026-05-15T08:00');
    });

    it('respects date filter', () => {
      const rows = store.getByUser('2026-05-16', '2026-05-16');
      expect(rows.map(r => r.username).sort()).toEqual(['huangyp', 'yangyh']);
    });

    it('cacheHitRatio per user', () => {
      const rows = store.getByUser('2026-05-14', '2026-05-16');
      const admin = rows.find(r => r.username === 'admin')!;
      // admin: in=1000+2000+500=3500, cr=10000+20000+0=30000, cc=200+400+0=600
      // ratio = 30000 / (3500 + 30000 + 600) = 30000 / 34100
      expect(admin.cacheHitRatio).toBeCloseTo(30000 / 34100, 6);
    });
  });

  describe('getByModel', () => {
    it('aggregates across all users', () => {
      const rows = store.getByModel('2026-05-14', '2026-05-16');
      const byModel = new Map(rows.map(r => [r.model, r]));
      // claude-opus-4-7: 5 行（admin*2 + huangyp*2 + yangyh*1）
      // claude-haiku-4-5: 1 行（admin*1）
      expect(byModel.get('claude-opus-4-7')?.totalTurns).toBe(5);
      expect(byModel.get('claude-haiku-4-5')?.totalTurns).toBe(1);
    });

    it('filters by username when given', () => {
      const rows = store.getByModel('2026-05-14', '2026-05-16', 'admin');
      expect(rows).toHaveLength(2);
      const byModel = new Map(rows.map(r => [r.model, r]));
      expect(byModel.get('claude-opus-4-7')?.inputTokens).toBe(3000);
      expect(byModel.get('claude-haiku-4-5')?.inputTokens).toBe(500);
    });

    it('returns empty for unknown user', () => {
      const rows = store.getByModel('2026-05-14', '2026-05-16', 'nonexistent');
      expect(rows).toHaveLength(0);
    });
  });

  describe('getTrend', () => {
    it('returns daily points ordered ascending', () => {
      const points = store.getTrend('admin', '2026-05-14', '2026-05-16');
      expect(points.map(p => p.date)).toEqual(['2026-05-14', '2026-05-15']);
      expect(points[0].inputTokens).toBe(1000);
      // 5-15 admin 两个模型合计：in=2000+500=2500
      expect(points[1].inputTokens).toBe(2500);
    });

    it('returns empty for missing user', () => {
      const points = store.getTrend('nobody', '2026-05-14', '2026-05-16');
      expect(points).toEqual([]);
    });
  });

  describe('getTrendAll', () => {
    it('aggregates across all users by date', () => {
      const points = store.getTrendAll('2026-05-14', '2026-05-16');
      const byDate = new Map(points.map(p => [p.date, p]));
      // 5-14: 只有 admin opus，in=1000 out=500
      expect(byDate.get('2026-05-14')?.inputTokens).toBe(1000);
      expect(byDate.get('2026-05-14')?.outputTokens).toBe(500);
      // 5-15: admin opus + admin haiku + huangyp opus
      //   in=2000+500+300=2800, out=1000+200+150=1350
      expect(byDate.get('2026-05-15')?.inputTokens).toBe(2800);
      expect(byDate.get('2026-05-15')?.outputTokens).toBe(1350);
      // 5-16: huangyp cron opus + yangyh opus
      //   in=100+200=300, out=50+100=150
      expect(byDate.get('2026-05-16')?.inputTokens).toBe(300);
      expect(byDate.get('2026-05-16')?.outputTokens).toBe(150);
    });

    it('orders ascending', () => {
      const points = store.getTrendAll('2026-05-14', '2026-05-16');
      expect(points.map(p => p.date)).toEqual(['2026-05-14', '2026-05-15', '2026-05-16']);
    });
  });

  describe('getByChannel', () => {
    it('separates web and cron rows', () => {
      const rows = store.getByChannel('2026-05-14', '2026-05-16');
      const byCh = new Map(rows.map(r => [r.channel, r]));
      // web: admin(3) + huangyp(1) + yangyh(1) = 5 turns
      // cron: huangyp(1) = 1 turn
      expect(byCh.get('web')?.totalTurns).toBe(5);
      expect(byCh.get('cron')?.totalTurns).toBe(1);
      // web in tokens: 1000+2000+500+300+200 = 4000
      expect(byCh.get('web')?.inputTokens).toBe(4000);
      // cron in tokens: 100
      expect(byCh.get('cron')?.inputTokens).toBe(100);
    });

    it('filters by username', () => {
      const rows = store.getByChannel('2026-05-14', '2026-05-16', 'huangyp');
      const byCh = new Map(rows.map(r => [r.channel, r]));
      expect(byCh.get('web')?.totalTurns).toBe(1);
      expect(byCh.get('cron')?.totalTurns).toBe(1);
    });

    it('returns empty for unknown user', () => {
      const rows = store.getByChannel('2026-05-14', '2026-05-16', 'nobody');
      expect(rows).toHaveLength(0);
    });
  });

  describe('getDataRange', () => {
    it('reports min/max dates and first cost date', () => {
      const r = store.getDataRange();
      expect(r.earliestDate).toBe('2026-05-14');
      expect(r.latestDate).toBe('2026-05-16');
      // 所有 fixture 都有 cost > 0，所以 firstCostDate = earliest
      expect(r.firstCostDate).toBe('2026-05-14');
    });

    it('firstCostDate is null when no cost data', async () => {
      // 用 upsertRaw 写一行 cost=0 的数据替代真实 fixture
      store.clearAll();
      store.upsertRaw({
        date: '2026-05-01', username: 'a', tenantId: 'kaiyan', model: 'm', channel: 'web',
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUsdMicro: 0, turnDelta: 1, occurredAtMs: Date.now(),
      });
      const r = store.getDataRange();
      expect(r.earliestDate).toBe('2026-05-01');
      expect(r.firstCostDate).toBeNull();
    });

    it('returns nulls when table is empty', () => {
      store.clearAll();
      const r = store.getDataRange();
      expect(r.earliestDate).toBeNull();
      expect(r.latestDate).toBeNull();
      expect(r.firstCostDate).toBeNull();
    });
  });
});
