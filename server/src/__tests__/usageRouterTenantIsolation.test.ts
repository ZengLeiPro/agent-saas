/**
 * Usage 路由跨组织隔离测试（PR 10）
 *
 * 覆盖目标：
 *   1. GET /overview               - 平台 admin 看全公司；组织 admin 仅本组织
 *   2. GET /by-user                - 平台 admin 看全部；组织 admin 仅本组织（含 realName 防泄漏）
 *   3. GET /by-model               - tenantId 过滤
 *   4. GET /by-channel             - tenantId 过滤
 *   5. GET /trend                  - tenantId 过滤
 *   6. POST /rebuild               - 仅平台 admin（requirePlatformAdmin）
 *   7. GET /data-range             - tenantId 过滤
 *   8. 组织 admin 显式 ?tenantId=<other> → 403
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUsageRouter } from '../routes/usage.js';
import { createTokenUsageStore, type TokenUsageStore } from '../data/usage/store.js';
import { __resetBusinessDbForTest, getBusinessDb } from '../data/db/business.js';
import { runBusinessMigrations } from '../data/db/migrations.js';
import type { JwtPayload } from '../auth/types.js';
import type { UserStore } from '../data/users/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const KAIYAN_ADMIN: JwtPayload = { sub: 'u-ka', username: 'zengky', role: 'admin', tenantId: 'kaiyan' };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };

function fakeUserStore(): UserStore {
  const users = [
    { id: 'u-ka', username: 'zengky', role: 'admin' as const, tenantId: 'kaiyan', realName: '曾磊' },
    { id: 'u-ku', username: 'alice', role: 'user' as const, tenantId: 'kaiyan', realName: '艾丽丝' },
    { id: 'u-wa', username: 'wain_admin', role: 'admin' as const, tenantId: 'wain', realName: '唯恩管理员' },
    { id: 'u-wu', username: 'wain_user', role: 'user' as const, tenantId: 'wain', realName: '唯恩员工' },
  ];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    listAll: () => users.map(u => ({ ...u })),
  } as unknown as UserStore;
}

interface TestRig {
  baseUrl: string;
  store: TokenUsageStore;
  setCaller(c: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(triggerRebuild?: () => Promise<unknown>): Promise<TestRig> {
  const dataDir = await mkdtemp(join(tmpdir(), 'usage-tenant-iso-'));
  __resetBusinessDbForTest();
  const db = getBusinessDb(dataDir);
  runBusinessMigrations(db);
  const store = createTokenUsageStore(db);

  const app = express();
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/admin/usage', createUsageRouter({
    tokenUsageStore: store,
    userStore: fakeUserStore(),
    triggerRebuild,
  }));

  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    store,
    setCaller: (c) => { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      __resetBusinessDbForTest();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function todayBJ(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

describe('Usage 路由组织隔离', () => {
  let h: TestRig;

  beforeEach(async () => {
    h = await makeTestRig(async () => undefined);
  });

  afterEach(async () => {
    await h.close();
  });

  function seedCrossTenant() {
    // kaiyan: alice 100 input
    h.store.recordResult({
      username: 'alice', tenantId: 'kaiyan', channel: 'web',
      modelUsage: { 'claude-opus-4-7': { inputTokens: 100, outputTokens: 50 } },
      occurredAtMs: Date.now(),
    });
    // wain: wain_user 200 input
    h.store.recordResult({
      username: 'wain_user', tenantId: 'wain', channel: 'web',
      modelUsage: { 'claude-opus-4-7': { inputTokens: 200, outputTokens: 100 } },
      occurredAtMs: Date.now(),
    });
  }

  describe('GET /overview', () => {
    it('平台 admin 不传 tenantId → 跨组织全公司合计', async () => {
      seedCrossTenant();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/admin/usage/overview?range=today');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalInputTokens).toBe(300); // 100 + 200
      expect(body.totalOutputTokens).toBe(150);
      expect(body.activeUsers).toBe(2);
      expect(body.tenantId).toBeNull();
    });

    it('平台 admin 显式 ?tenantId=wain → 仅 wain 合计', async () => {
      seedCrossTenant();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/admin/usage/overview?range=today&tenantId=wain');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalInputTokens).toBe(200);
      expect(body.activeUsers).toBe(1);
      expect(body.tenantId).toBe('wain');
    });

    it('组织 admin (wain) → 自动限本组织', async () => {
      seedCrossTenant();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/overview?range=today');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalInputTokens).toBe(200);
      expect(body.tenantId).toBe('wain');
    });

    it('组织 admin (wain) 显式 ?tenantId=kaiyan → 403', async () => {
      seedCrossTenant();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/overview?range=today&tenantId=kaiyan');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /by-user', () => {
    it('组织 admin (wain) 仅看到本组织用户', async () => {
      seedCrossTenant();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/by-user?range=today');
      expect(res.status).toBe(200);
      const body = await res.json();
      const names = body.users.map((u: { username: string }) => u.username);
      expect(names).toEqual(['wain_user']);
      expect(names).not.toContain('alice');
    });

    it('组织 admin (wain) realName enrich 不会泄漏其他组织姓名', async () => {
      seedCrossTenant();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/by-user?range=today');
      const body = await res.json();
      for (const u of body.users) {
        // 仅 wain_user 应被 enrich
        if (u.username === 'wain_user') expect(u.realName).toBe('唯恩员工');
      }
    });

    it('平台 admin 不传 → 看全部', async () => {
      seedCrossTenant();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/admin/usage/by-user?range=today');
      const body = await res.json();
      const names = body.users.map((u: { username: string }) => u.username).sort();
      expect(names).toEqual(['alice', 'wain_user']);
    });
  });

  describe('GET /by-model & /by-channel', () => {
    it('by-model 组织 admin (wain) 仅本组织合计', async () => {
      seedCrossTenant();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/by-model?range=today');
      const body = await res.json();
      const m = body.models[0];
      expect(m.model).toBe('claude-opus-4-7');
      expect(m.inputTokens).toBe(200); // 仅 wain
    });

    it('by-channel 平台 admin ?tenantId=kaiyan 仅 kaiyan 合计', async () => {
      seedCrossTenant();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/admin/usage/by-channel?range=today&tenantId=kaiyan');
      const body = await res.json();
      const ch = body.channels[0];
      expect(ch.channel).toBe('web');
      expect(ch.inputTokens).toBe(100);
    });
  });

  describe('GET /trend', () => {
    it('组织 admin trend 看不到其他组织的用户', async () => {
      seedCrossTenant();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/trend?username=alice&range=today');
      const body = await res.json();
      // alice 是 kaiyan 用户；wain admin 限本组织后 SQL 查不到任何行
      expect(body.points.length).toBe(0);
    });
  });

  describe('POST /rebuild — requirePlatformAdmin', () => {
    it('平台 admin → 202', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/admin/usage/rebuild', { method: 'POST' });
      expect(res.status).toBe(202);
    });

    it('组织 admin (wain) → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/rebuild', { method: 'POST' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /data-range', () => {
    it('组织 admin 仅看本组织的 earliest/latest', async () => {
      // 跨组织写两天数据
      const day1 = new Date('2026-05-01T00:00:00+08:00').getTime();
      const day2 = new Date('2026-05-15T00:00:00+08:00').getTime();
      h.store.recordResult({
        username: 'alice', tenantId: 'kaiyan', channel: 'web',
        modelUsage: { 'claude-opus-4-7': { inputTokens: 1, outputTokens: 1 } },
        occurredAtMs: day1,
      });
      h.store.recordResult({
        username: 'wain_user', tenantId: 'wain', channel: 'web',
        modelUsage: { 'claude-opus-4-7': { inputTokens: 1, outputTokens: 1 } },
        occurredAtMs: day2,
      });

      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/admin/usage/data-range');
      const body = await res.json();
      expect(body.earliestDate).toBe('2026-05-15');
      expect(body.latestDate).toBe('2026-05-15');
      expect(body.tenantId).toBe('wain');
    });

    it('平台 admin 不传 → 跨组织 min/max', async () => {
      const day1 = new Date('2026-05-01T00:00:00+08:00').getTime();
      const day2 = new Date('2026-05-15T00:00:00+08:00').getTime();
      h.store.recordResult({
        username: 'alice', tenantId: 'kaiyan', channel: 'web',
        modelUsage: { 'claude-opus-4-7': { inputTokens: 1, outputTokens: 1 } },
        occurredAtMs: day1,
      });
      h.store.recordResult({
        username: 'wain_user', tenantId: 'wain', channel: 'web',
        modelUsage: { 'claude-opus-4-7': { inputTokens: 1, outputTokens: 1 } },
        occurredAtMs: day2,
      });

      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/admin/usage/data-range');
      const body = await res.json();
      expect(body.earliestDate).toBe('2026-05-01');
      expect(body.latestDate).toBe('2026-05-15');
      expect(body.tenantId).toBeNull();
    });
  });

  describe('todayBJ helper sanity', () => {
    it('todayBJ 返回 YYYY-MM-DD 格式', () => {
      expect(todayBJ()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
