/**
 * /api/org-agents 路由权限测试（公司级专职 Agent；2026-07 唯恩批次）
 *
 * 覆盖（计划测试 2-4）：
 *   - 组织 admin 创建时 body.tenantId 强制覆写为自身租户（防伪造）
 *   - 组织 admin 跨租户读/改 403；普通用户未被指派 GET /:id 404（防枚举）
 *   - 普通用户 list 只见裁剪字段（无 instructions/guardrail/audience 泄漏）
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrgAgentsRouter, type OrgAgentsRouterDeps } from '../routes/orgAgents.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { UsageStatsSessionReader } from '../routes/orgAgentUsageStats.js';
import type {
  RuntimeSessionListQuery,
  RuntimeSessionListResult,
  RuntimeSessionProjectionRecord,
} from '../runtime/sessionProjectionStore.js';
import type {
  GuardrailEventListFilter,
  GuardrailEventRecord,
  GuardrailEventStore,
} from '../data/guardrail/pgGuardrailEventStore.js';
import type { GuardrailCheckResult } from '../agent/guardrail.js';
import type { SessionMeta } from '../data/transcripts/meta.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };
const KAIYAN_ADMIN: JwtPayload = { sub: 'u-ka', username: 'kaiyan_admin', role: 'admin', tenantId: 'kaiyan' };

interface TestRig {
  store: OrgAgentStore;
  setCaller(caller: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(overrides: Partial<OrgAgentsRouterDeps> = {}): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'org-agents-routes-'));
  const store = new OrgAgentStore(join(tmpRoot, 'org-agents.json'));
  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/org-agents', createOrgAgentsRouter({ orgAgentStore: store, ...overrides }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    store,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function sessionRecord(
  sessionId: string,
  tenantId: string,
  orgAgentId: string,
  userId: string,
  updatedAt: string,
): RuntimeSessionProjectionRecord {
  return {
    sessionId,
    tenantId,
    userId,
    username: userId,
    kind: 'user',
    updatedAt,
    metaJson: { userId, username: userId, tenantId, channel: 'web', createdAt: updatedAt, orgAgentId } as SessionMeta,
  };
}

function memorySessionReader(records: RuntimeSessionProjectionRecord[]): UsageStatsSessionReader & { lastQuery: RuntimeSessionListQuery | null } {
  const state = {
    lastQuery: null as RuntimeSessionListQuery | null,
    async list(query: RuntimeSessionListQuery = {}): Promise<RuntimeSessionListResult> {
      state.lastQuery = query;
      const items = records.filter((r) => {
        if (query.tenantId && r.tenantId !== query.tenantId) return false;
        const orgAgentId = r.metaJson.orgAgentId;
        if (query.orgAgentId && orgAgentId !== query.orgAgentId) return false;
        if (query.hasOrgAgent && !orgAgentId) return false;
        if (query.updatedFrom && r.updatedAt < query.updatedFrom) return false;
        if (query.updatedTo && r.updatedAt > query.updatedTo) return false;
        return true;
      });
      return { items };
    },
  };
  return state;
}

function memoryGuardrailEventStore(events: GuardrailEventRecord[]): GuardrailEventStore & { lastFilter: GuardrailEventListFilter | null } {
  const state = {
    lastFilter: null as GuardrailEventListFilter | null,
    async insert() { return 'ev-unused'; /* not used in tests */ },
    // 对齐 PgGuardrailEventStore：只统计 confidence 非空事件，PERCENTILE_CONT 线性插值，空集 null
    async confidencePercentiles(filter: { tenantId: string; orgAgentId?: string; from?: string; to?: string }) {
      const values = events
        .filter((e) => e.tenantId === filter.tenantId
          && (!filter.orgAgentId || e.orgAgentId === filter.orgAgentId)
          && (!filter.from || e.createdAt >= filter.from)
          && (!filter.to || e.createdAt <= filter.to)
          && typeof e.confidence === 'number')
        .map((e) => e.confidence as number)
        .sort((a, b) => a - b);
      if (values.length === 0) return null;
      const cont = (p: number): number => {
        const rank = p * (values.length - 1);
        const lo = Math.floor(rank);
        const hi = Math.ceil(rank);
        return values[lo] + (rank - lo) * (values[hi] - values[lo]);
      };
      return { p50: cont(0.5), p90: cont(0.9) };
    },
    async list(filter: GuardrailEventListFilter) {
      state.lastFilter = filter;
      const matches = events.filter((e) => {
        if (filter.tenantId && e.tenantId !== filter.tenantId) return false;
        if (filter.orgAgentId && e.orgAgentId !== filter.orgAgentId) return false;
        if (filter.verdict && e.verdict !== filter.verdict) return false;
        if (filter.from && e.createdAt < filter.from) return false;
        if (filter.to && e.createdAt > filter.to) return false;
        return true;
      });
      return { events: matches, total: matches.length };
    },
  };
  return state;
}

function postBody(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '产品选型助手',
      description: '帮助成员完成产品选型与参数查询。',
      starterPrompts: ['帮我推荐一个型号'],
      instructions: '只回答唯恩产品选型问题',
      allowedSkills: ['wain-kb'],
      audience: { exposure: 'all', usernames: [] },
      guardrail: {
        enabled: true,
        scopeDescription: '唯恩产品选型',
        rejectionMessage: '超出职责范围。',
        strictness: 'strict',
      },
      enabled: true,
      ...overrides,
    }),
  };
}

describe('org-agents 路由权限', () => {
  let h: TestRig;

  beforeEach(async () => { h = await makeTestRig(); });
  afterEach(async () => { await h.close(); });

  it('组织 admin 创建时 body.tenantId 被强制覆写为自身租户（伪造无效）', async () => {
    h.setCaller(WAIN_ADMIN);
    const res = await h.request('/api/org-agents', postBody({ tenantId: 'kaiyan' }));
    expect(res.status).toBe(201);
    const record = await res.json() as OrgAgentRecord;
    expect(record.tenantId).toBe('wain');
    expect(record.createdBy).toBe('wain_admin');
    // 平台 admin 可显式指定 tenantId
    h.setCaller(PLATFORM_ADMIN);
    const res2 = await h.request('/api/org-agents', postBody({ tenantId: 'kaiyan', name: '跨租户配置' }));
    expect(res2.status).toBe(201);
    expect((await res2.json() as OrgAgentRecord).tenantId).toBe('kaiyan');
  });

  it('组织 admin 跨租户读/改/删 403；普通用户未被指派 GET /:id 一律 404 防枚举', async () => {
    h.setCaller(WAIN_ADMIN);
    const created = await (await h.request('/api/org-agents', postBody({
      audience: { exposure: 'allow_users', usernames: ['someone_else'] },
    }))).json() as OrgAgentRecord;

    // 跨租户 admin：读 / 改 / 删 全部 403
    h.setCaller(KAIYAN_ADMIN);
    expect((await h.request(`/api/org-agents/${created.id}`)).status).toBe(403);
    expect((await h.request(`/api/org-agents/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hijacked' }),
    })).status).toBe(403);
    expect((await h.request(`/api/org-agents/${created.id}`, { method: 'DELETE' })).status).toBe(403);

    // 本租户普通用户但未被指派：404（与「不存在」不可区分，防枚举）
    h.setCaller(WAIN_USER);
    expect((await h.request(`/api/org-agents/${created.id}`)).status).toBe(404);
    // 完全不存在的 id 同样 404
    expect((await h.request('/api/org-agents/oa-not-exist')).status).toBe(404);

    // 本租户 admin 不受 audience 限制，读到全字段
    h.setCaller(WAIN_ADMIN);
    const adminRes = await h.request(`/api/org-agents/${created.id}`);
    expect(adminRes.status).toBe(200);
    expect((await adminRes.json() as OrgAgentRecord).instructions).toBe('只回答唯恩产品选型问题');
  });

  it('普通用户 list 只见裁剪字段，不泄漏 instructions/guardrail/audience', async () => {
    h.setCaller(WAIN_ADMIN);
    const created = await (await h.request('/api/org-agents', postBody())).json() as OrgAgentRecord;
    // 未被指派 / 停用的不出现在普通用户列表
    await h.request('/api/org-agents', postBody({
      name: '别人的助手',
      audience: { exposure: 'allow_users', usernames: ['someone_else'] },
    }));
    await h.request('/api/org-agents', postBody({ name: '停用的助手', enabled: false }));

    h.setCaller(WAIN_USER);
    for (const path of ['/api/org-agents', '/api/org-agents/mine']) {
      const res = await h.request(path);
      expect(res.status).toBe(200);
      const list = await res.json() as Array<Record<string, unknown>>;
      expect(list).toHaveLength(1);
      expect(Object.keys(list[0]).sort()).toEqual(['description', 'id', 'name', 'skillCount', 'starterPrompts']);
      expect(list[0].id).toBe(created.id);
      expect(list[0].description).toBe('帮助成员完成产品选型与参数查询。');
      expect(list[0].starterPrompts).toEqual(['帮我推荐一个型号']);
      expect(list[0].skillCount).toBe(1);
    }
    // 被指派用户 GET /:id 也只拿到裁剪视图
    const detail = await (await h.request(`/api/org-agents/${created.id}`)).json() as Record<string, unknown>;
    expect(detail.instructions).toBeUndefined();
    expect(detail.guardrail).toBeUndefined();
    expect(detail.audience).toBeUndefined();
  });

  it('公开资料边界：trim 输入、拒绝空白/超长/重复，并允许 PATCH 清空示例问题', async () => {
    h.setCaller(WAIN_ADMIN);
    const createdRes = await h.request('/api/org-agents', postBody({
      name: '  产品选型助手  ',
      description: '  公开说明  ',
      starterPrompts: ['  问题一  ', '问题二'],
    }));
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json() as OrgAgentRecord;
    expect(created.name).toBe('产品选型助手');
    expect(created.description).toBe('公开说明');
    expect(created.starterPrompts).toEqual(['问题一', '问题二']);

    for (const starterPrompts of [
      ['   '],
      Array.from({ length: 7 }, (_, index) => `问题${index}`),
      ['x'.repeat(201)],
      ['重复', '重复'],
    ]) {
      const res = await h.request('/api/org-agents', postBody({ starterPrompts }));
      expect(res.status).toBe(400);
    }

    const clearRes = await h.request(`/api/org-agents/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starterPrompts: [] }),
    });
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json() as OrgAgentRecord).starterPrompts).toEqual([]);
  });
});

describe('org-agents usage-stats & gate-preview', () => {
  it('GET /:id/usage-stats 30 天窗口 KPI：mentions/gateRejections/activeUsers；跨租户 403；非 admin 403', async () => {
    // 固定 now = 2026-07-18T00:00:00Z；窗口 [2026-06-18T00:00:00Z, 2026-07-18T00:00:00Z]
    const fixedNow = new Date('2026-07-18T00:00:00.000Z');
    const sessions: RuntimeSessionProjectionRecord[] = [
      sessionRecord('s-1', 'wain', '__PLACEHOLDER__', 'u-a', '2026-07-15T00:00:00.000Z'),
      sessionRecord('s-2', 'wain', '__PLACEHOLDER__', 'u-a', '2026-07-10T00:00:00.000Z'), // 同一 user，去重
      sessionRecord('s-3', 'wain', '__PLACEHOLDER__', 'u-b', '2026-07-01T00:00:00.000Z'),
      sessionRecord('s-4', 'wain', '__PLACEHOLDER__', 'u-c', '2026-05-01T00:00:00.000Z'), // 窗口外
      sessionRecord('s-5', 'kaiyan', '__PLACEHOLDER__', 'u-d', '2026-07-15T00:00:00.000Z'), // 跨租户，不应统计
    ];
    const events: GuardrailEventRecord[] = [
      { id: 'e1', tenantId: 'wain', orgAgentId: '__PLACEHOLDER__', verdict: 'off_topic', messageText: 'x', confidence: 0.9, createdAt: '2026-07-16T00:00:00.000Z' },
      { id: 'e2', tenantId: 'wain', orgAgentId: '__PLACEHOLDER__', verdict: 'off_topic', messageText: 'y', createdAt: '2026-07-01T00:00:00.000Z' }, // 旧事件无 confidence，不进百分位
      { id: 'e3', tenantId: 'wain', orgAgentId: '__PLACEHOLDER__', verdict: 'pass_flagged', messageText: 'z', confidence: 0.7, createdAt: '2026-07-16T00:00:00.000Z' }, // 非 off_topic 不计 rejections，但计 confidence
      { id: 'e4', tenantId: 'wain', orgAgentId: '__PLACEHOLDER__', verdict: 'off_topic', messageText: 'w', confidence: 0.1, createdAt: '2026-05-01T00:00:00.000Z' }, // 窗口外，不计
    ];
    const sessionStore = memorySessionReader(sessions);
    const guardStore = memoryGuardrailEventStore(events);
    const h = await makeTestRig({
      sessionProjectionStore: sessionStore,
      guardrailEventStore: guardStore,
      now: () => fixedNow,
    });
    try {
      // 建两个专家（wain 一个用于统计，kaiyan 一个用于跨租户 403）
      h.setCaller(WAIN_ADMIN);
      const wainAgent = await (await h.request('/api/org-agents', postBody({ name: '统计目标' }))).json() as OrgAgentRecord;
      h.setCaller(KAIYAN_ADMIN);
      const kyAgent = await (await h.request('/api/org-agents', postBody({ name: '开沿助手' }))).json() as OrgAgentRecord;
      // 把 orgAgentId 灌入 fixture
      for (const s of sessions) if (s.metaJson.orgAgentId === '__PLACEHOLDER__') s.metaJson.orgAgentId = s.tenantId === 'wain' ? wainAgent.id : kyAgent.id;
      for (const e of events) if (e.orgAgentId === '__PLACEHOLDER__') e.orgAgentId = wainAgent.id;

      // 本租户 admin 读通：sessions 3 条（s-1,s-2,s-3，s-4 窗口外 s-5 跨租户），users 2 位（u-a,u-b），rejections 2 次
      h.setCaller(WAIN_ADMIN);
      const res = await h.request(`/api/org-agents/${wainAgent.id}/usage-stats`);
      expect(res.status).toBe(200);
      const stats = await res.json() as {
        orgAgentId: string; tenantId: string; windowDays: number;
        mentionsCount: number; gateRejectionsCount: number; activeUsersCount: number;
        avgSessionLength: number | null;
        guardrailConfidenceP50: number | null; guardrailConfidenceP90: number | null;
      };
      expect(stats.orgAgentId).toBe(wainAgent.id);
      expect(stats.tenantId).toBe('wain');
      expect(stats.windowDays).toBe(30);
      expect(stats.mentionsCount).toBe(3);
      expect(stats.activeUsersCount).toBe(2);
      expect(stats.gateRejectionsCount).toBe(2);
      // avgSessionLength 未接入（无消息级投影）仍 null
      expect(stats.avgSessionLength).toBeNull();
      // confidence P50/P90：窗口内带 confidence 的事件 [0.7, 0.9]（e2 无值、e4 窗口外均排除）
      // PERCENTILE_CONT 线性插值：p50=0.8，p90=0.7+0.9*(0.9-0.7)=0.88
      expect(stats.guardrailConfidenceP50).toBeCloseTo(0.8, 10);
      expect(stats.guardrailConfidenceP90).toBeCloseTo(0.88, 10);
      // store 收到正确 tenantId + orgAgentId + 时间窗
      expect(sessionStore.lastQuery?.tenantId).toBe('wain');
      expect(sessionStore.lastQuery?.orgAgentId).toBe(wainAgent.id);
      expect(guardStore.lastFilter?.verdict).toBe('off_topic');
      expect(guardStore.lastFilter?.from).toBe('2026-06-18T00:00:00.000Z');

      // 自定义 windowDays 生效
      const res7 = await h.request(`/api/org-agents/${wainAgent.id}/usage-stats?windowDays=7`);
      expect(res7.status).toBe(200);
      expect(((await res7.json()) as { windowDays: number }).windowDays).toBe(7);

      // 跨租户 403（组织 admin 看不到 kaiyan 的 agent）
      const cross = await h.request(`/api/org-agents/${kyAgent.id}/usage-stats`);
      expect(cross.status).toBe(403);

      // 非 admin 403
      h.setCaller(WAIN_USER);
      const denied = await h.request(`/api/org-agents/${wainAgent.id}/usage-stats`);
      expect(denied.status).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('POST /:id/gate-preview 复用 checkTopicScope；rate limit 超限 429；guardrail 未装配 503；非 admin 403', async () => {
    const scopeCalls: Array<{ message: string; scopeDescription: string; strictness: string }> = [];
    const fakeCheck: (typeof import('../agent/guardrail.js'))['checkTopicScope'] = async (input) => {
      scopeCalls.push({
        message: input.message,
        scopeDescription: input.scopeDescription,
        strictness: input.strictness,
      });
      // 简单基于文本关键词：命中"报价"→ in_scope，命中"招聘"→ off_topic，其余 uncertain
      let verdict: GuardrailCheckResult['verdict'] = 'uncertain';
      if (input.message.includes('报价')) verdict = 'in_scope';
      else if (input.message.includes('招聘')) verdict = 'off_topic';
      return { verdict, source: 'model', model: 'guard-fake', latencyMs: 42 };
    };

    const h = await makeTestRig({
      getGuardrailModelConfigs: () => [{ model: 'guard-fake', connection: { apiKey: 'k' } }],
      checkTopicScopeImpl: fakeCheck,
      gatePreviewRateLimit: { maxPerMinute: 2 }, // 便于验证 429
    });
    try {
      h.setCaller(WAIN_ADMIN);
      const created = await (await h.request('/api/org-agents', postBody())).json() as OrgAgentRecord;

      // in_scope：inScope=true, wouldReject=false, 不带 rejectionPreview
      const inScopeRes = await h.request(`/api/org-agents/${created.id}/gate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testMessage: '这单报价的账期是否超限？' }),
      });
      expect(inScopeRes.status).toBe(200);
      const inScopeBody = await inScopeRes.json() as {
        inScope: boolean; confidence: number; reason: string; latencyMs: number;
        verdict: string; wouldReject: boolean; rejectionPreview?: string;
      };
      expect(inScopeBody.inScope).toBe(true);
      expect(inScopeBody.wouldReject).toBe(false);
      expect(inScopeBody.confidence).toBeGreaterThan(0);
      expect(inScopeBody.confidence).toBeLessThanOrEqual(1);
      expect(typeof inScopeBody.reason).toBe('string');
      expect(inScopeBody.latencyMs).toBe(42);
      expect(inScopeBody.rejectionPreview).toBeUndefined();
      // scopeDescription 来自 record 的门禁配置
      expect(scopeCalls.at(-1)?.scopeDescription).toBe('唯恩产品选型');

      // off_topic：wouldReject=true 且带 rejectionPreview（record.guardrail.rejectionMessage）
      const offTopicRes = await h.request(`/api/org-agents/${created.id}/gate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testMessage: '公司在招聘什么岗位？',
          overrideStrictness: 'lenient',
          recentUserMessages: ['先看看销售数据'],
        }),
      });
      expect(offTopicRes.status).toBe(200);
      const offTopicBody = await offTopicRes.json() as { wouldReject: boolean; rejectionPreview?: string };
      expect(offTopicBody.wouldReject).toBe(true);
      expect(offTopicBody.rejectionPreview).toBe('超出职责范围。');
      expect(scopeCalls.at(-1)?.strictness).toBe('lenient');

      // 第 3 次同 admin：rate limit=2 → 429，Retry-After 头
      const limited = await h.request(`/api/org-agents/${created.id}/gate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testMessage: '再来一发' }),
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      const limitedBody = await limited.json() as { error: string; retryAfterMs: number };
      expect(limitedBody.retryAfterMs).toBeGreaterThan(0);

      // 非 admin 403
      h.setCaller(WAIN_USER);
      const forbidden = await h.request(`/api/org-agents/${created.id}/gate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testMessage: '任何东西' }),
      });
      expect(forbidden.status).toBe(403);

      // 跨租户 admin 403
      h.setCaller(KAIYAN_ADMIN);
      const crossTenant = await h.request(`/api/org-agents/${created.id}/gate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testMessage: '任何东西' }),
      });
      expect(crossTenant.status).toBe(403);

      // 空 body 400
      h.setCaller(WAIN_ADMIN);
      const badBody = await h.request(`/api/org-agents/${created.id}/gate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(badBody.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it('POST /:id/gate-preview 门禁模型未装配 → 503', async () => {
    const h = await makeTestRig({
      // getGuardrailModelConfigs 缺省 → 视为空数组 → 503
    });
    try {
      h.setCaller(WAIN_ADMIN);
      const created = await (await h.request('/api/org-agents', postBody())).json() as OrgAgentRecord;
      const res = await h.request(`/api/org-agents/${created.id}/gate-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testMessage: '问题' }),
      });
      expect(res.status).toBe(503);
    } finally {
      await h.close();
    }
  });
});
