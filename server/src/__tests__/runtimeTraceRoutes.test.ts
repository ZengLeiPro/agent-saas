/**
 * Agent 运行监测读 API 路由测试（/api/admin/runtime/trace）
 *
 * 覆盖：
 *   - 权限（2026-07-10 起 resolveTenant 模式）：未认证 401 / 平台 admin 全量 /
 *     组织 admin 锁本租户（query 指定他人 tenantId → 403；他租户 run → 404）
 *   - 成本脱敏：组织 admin 且 policy.showCost !== true → billing/efficiency 裁剪 ¥ 字段
 *     并标 costRedacted；showCost=true 放行；getTenantPolicy 未注入/抛错 fail-closed
 *   - GET /runs/:runId/events
 *     - run 不存在 → 404
 *     - 正常返回 shape（run + billing + events），billing 明细按 requestIndex 升序
 *     - 默认排除 assistant_stream_event；types 白名单可显式包含
 *     - maxContentLength 截断生效且事件对象标 truncated: true
 *   - GET /recent-runs：status 白名单外值 → 400；过滤参数正确透传
 *   - GET /efficiency：days 超上限 → 400；正常透传 days/tenantId（fake query）
 *   - RuntimeEfficiencyQuery：mock pool 断言关键 SQL 参数 + rows→response 纯转换
 *
 * 模式：仿 runtimeAuditRoutes.test.ts —— 手工 express + 注入 fake req.user +
 * 真 router + listen(0) + fetch；PG 不真连库（fake store / mock pool）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import {
  createRuntimeTraceRouter,
  pickRunSummary,
  redactBillingSummary,
  redactEfficiencyCost,
  sanitizeTraceEvent,
  summarizeRunBilling,
  truncateTraceEvent,
  type RuntimeTraceRouterOptions,
} from '../routes/runtimeTrace.js';
import {
  RuntimeEfficiencyQuery,
  buildCostSection,
  buildOutcomeSection,
  buildRepeatedFileReadsSection,
  normalizeRecentRunRow,
  parseReadToolFilePath,
  type EfficiencyQueryOptions,
  type EfficiencyReport,
  type RecentRunsQueryOptions,
  type RecentRunSummary,
} from '../runtime/efficiencyQuery.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { BillingUsageEvent } from '../data/billing/types.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const RUN_ID = 'run-trace-1';

const PLATFORM_ADMIN: JwtPayload = {
  sub: 'admin-1',
  username: 'admin',
  role: 'admin',
  tenantId: DEFAULT_TENANT_ID,
};
const PLATFORM_OPERATOR: JwtPayload = {
  sub: 'operator-1',
  username: 'ops',
  role: 'admin',
  tenantId: DEFAULT_TENANT_ID,
  platformCapabilities: [],
};
const ORG_ADMIN: JwtPayload = {
  sub: 'admin-2',
  username: 'org-admin',
  role: 'admin',
  tenantId: 'kaiyan',
};

const RUN_RECORD: RunRecord = {
  runId: RUN_ID,
  sessionId: SESSION,
  userId: 'user-1',
  tenantId: 'kaiyan',
  status: 'completed',
  model: 'gpt-5.5',
  channel: 'web',
  requestedAt: '2026-07-03T01:00:00.000Z',
  startedAt: '2026-07-03T01:00:01.000Z',
  updatedAt: '2026-07-03T01:05:00.000Z',
  completedAt: '2026-07-03T01:05:00.000Z',
  executionTarget: 'server-local',
  workspaceId: 'ws-1',
  metadata: {},
  cumulativeInputTokens: 1234,
};

/** 他租户 run：组织 admin 访问应 404（不泄露存在性） */
const OTHER_RUN_ID = 'run-trace-other';
const OTHER_RUN_RECORD: RunRecord = {
  ...RUN_RECORD,
  runId: OTHER_RUN_ID,
  tenantId: 'other-co',
};

const LONG_TEXT = 'x'.repeat(120);

const EVENTS: PlatformEvent[] = [
  {
    id: 'evt-1',
    timestamp: '2026-07-03T01:00:01.000Z',
    type: 'user_message',
    runId: RUN_ID,
    sessionId: SESSION,
    content: LONG_TEXT,
  },
  {
    id: 'evt-2',
    timestamp: '2026-07-03T01:00:02.000Z',
    type: 'assistant_stream_event',
    runId: RUN_ID,
    sessionId: SESSION,
    blockType: 'text',
    phase: 'delta',
    content: 'delta',
  },
  {
    id: 'evt-3',
    timestamp: '2026-07-03T01:00:03.000Z',
    type: 'assistant_tool_calls',
    runId: RUN_ID,
    sessionId: SESSION,
    content: '',
    toolCalls: [{ id: 'call-1', name: 'Read', arguments: JSON.stringify({ path: `/tmp/${'y'.repeat(200)}` }) }],
  },
  {
    id: 'evt-4',
    timestamp: '2026-07-03T01:00:04.000Z',
    type: 'run_finished',
    runId: RUN_ID,
    sessionId: SESSION,
    subtype: 'success',
    numTurns: 3,
  },
];

function makeUsageEvent(patch: Partial<BillingUsageEvent>): BillingUsageEvent {
  return {
    id: 'usage-1',
    idempotencyKey: 'idem-1',
    tenantId: 'kaiyan',
    username: 'user-1',
    channel: 'web',
    billable: true,
    modelValue: 'gpt-5.5-fallback',
    requestIndex: 1,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheStorageTokens: 0,
    cacheStorageHours: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    apiRequestCount: 1,
    inputSegment: 'default',
    usageAccounting: 'billed',
    pricingVersion: 'v1',
    costCurrency: 'CNY',
    fxRateToCny: 1,
    actualCostYuanMicro: 0,
    rawUsageJson: {},
    createdAt: '2026-07-03T01:00:10.000Z',
    ...patch,
  };
}

// listUsageEvents 真实实现按 created_at DESC 返回——故意倒序喂给 router，验证响应重排升序
const USAGE_EVENTS: BillingUsageEvent[] = [
  makeUsageEvent({
    id: 'usage-2',
    requestIndex: 2,
    actualModel: 'gpt-5.5',
    inputTokens: 2000,
    cachedInputTokens: 1500,
    outputTokens: 100,
    reasoningTokens: 20,
    actualCostYuanMicro: 290_000,
    createdAt: '2026-07-03T01:00:20.000Z',
  }),
  makeUsageEvent({
    id: 'usage-1',
    requestIndex: 1,
    actualModel: 'gpt-5.5',
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 50,
    reasoningTokens: 10,
    actualCostYuanMicro: 500_000,
    createdAt: '2026-07-03T01:00:10.000Z',
  }),
];

interface FakeOverrides {
  user?: JwtPayload | null;
  options?: Partial<RuntimeTraceRouterOptions>;
}

interface RecordedCalls {
  recentRuns: RecentRunsQueryOptions[];
  efficiency: EfficiencyQueryOptions[];
}

const EMPTY_REPORT: EfficiencyReport = {
  range: { from: '2026-06-26T00:00:00.000Z', to: '2026-07-03T00:00:00.000Z', days: 7 },
  tenantId: null,
  outcome: { totalRuns: 0, success: 0, error: 0, interrupted: 0, completionRate: null, errorReasons: [] },
  tools: { byTool: [], handFailures: 0 },
  cost: { totalCostYuan: 0, byModel: [], perRun: { p50: null, p90: null, p99: null }, failedRunsCostYuan: 0, cacheHitRate: null },
  longTail: { slowestRuns: [], mostTurns: [] },
  approvals: { count: 0, resolvedCount: 0, waitP50Ms: null, waitP90Ms: null, byTool: [] },
  waste: {
    duplicateToolCalls: { affectedRuns: 0, totalDuplicateCalls: 0, topOffenders: [] },
    repeatedFileReads: { affectedRuns: 0, topFiles: [] },
    unmodifiedRetries: { count: 0, byTool: [] },
  },
};

async function startServer(overrides: FakeOverrides = {}): Promise<{
  server: Server;
  baseUrl: string;
  calls: RecordedCalls;
}> {
  const calls: RecordedCalls = { recentRuns: [], efficiency: [] };
  const options: RuntimeTraceRouterOptions = {
    runStore: {
      get: async (runId) => {
        if (runId === RUN_ID) return RUN_RECORD;
        if (runId === OTHER_RUN_ID) return OTHER_RUN_RECORD;
        return null;
      },
    },
    eventStore: { listByRun: async () => EVENTS },
    billingStore: { listUsageEvents: async () => USAGE_EVENTS },
    // 缺省注入 showCost=false（生产默认口径）；用例可覆盖
    getTenantPolicy: async () => ({ showCost: false }),
    userStore: {
      findById: (id: string) => id === 'user-1'
        ? { id, username: 'alice', realName: 'Alice Chen', tenantId: 'kaiyan' }
        : undefined,
    } as any,
    efficiencyQuery: {
      listRecentRuns: async (opts) => {
        calls.recentRuns.push(opts);
        const run: RecentRunSummary = {
          runId: RUN_ID,
          sessionId: SESSION,
          tenantId: 'kaiyan',
          userId: 'user-1',
          status: 'completed',
          statusReason: null,
          model: 'gpt-5.5',
          channel: 'web',
          requestedAt: '2026-07-03T01:00:00.000Z',
          startedAt: '2026-07-03T01:00:01.000Z',
          completedAt: '2026-07-03T01:05:00.000Z',
          failedAt: null,
          cancelledAt: null,
          durationMs: 299_000,
        };
        return [run];
      },
      getEfficiency: async (opts) => {
        calls.efficiency.push(opts);
        return { ...EMPTY_REPORT, range: { ...EMPTY_REPORT.range, days: opts.days }, tenantId: opts.tenantId ?? null };
      },
    },
    ...overrides.options,
  };

  const app = express();
  app.use((req, _res, next) => {
    // user === null 表示"未认证"（不注入 req.user）
    if (overrides.user !== null) {
      req.user = overrides.user ?? PLATFORM_ADMIN;
    }
    next();
  });
  app.use('/api/admin/runtime/trace', createRuntimeTraceRouter(options));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server: s, baseUrl: `http://127.0.0.1:${port}`, calls });
    });
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

describe('/api/admin/runtime/trace', () => {
  let server: Server | null = null;
  let baseUrl = '';

  afterEach(async () => {
    if (server) {
      await stopServer(server);
      server = null;
    }
  });

  describe('权限', () => {
    it('未认证 → 401', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer({ user: null }));
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/recent-runs`);
      expect(res.status).toBe(401);
      expect(calls.recentRuns).toHaveLength(0);
    });

    it('组织 admin → 200，且 recent-runs/efficiency 强制锁本租户', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer({ user: ORG_ADMIN }));
      for (const path of [`/runs/${RUN_ID}/events`, '/recent-runs', '/efficiency']) {
        const res = await fetch(`${baseUrl}/api/admin/runtime/trace${path}`);
        expect(res.status).toBe(200);
      }
      expect(calls.recentRuns[0]).toMatchObject({ tenantId: 'kaiyan' });
      expect(calls.efficiency[0]).toMatchObject({ tenantId: 'kaiyan' });
    });

    it('组织 admin query 指定他人 tenantId → 403', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer({ user: ORG_ADMIN }));
      for (const path of ['/recent-runs', '/efficiency']) {
        const res = await fetch(`${baseUrl}/api/admin/runtime/trace${path}?tenantId=other-co`);
        expect(res.status).toBe(403);
      }
      expect(calls.recentRuns).toHaveLength(0);
      expect(calls.efficiency).toHaveLength(0);
    });

    it('组织 admin 访问他租户 run → 404（不泄露存在性）', async () => {
      ({ server, baseUrl } = await startServer({ user: ORG_ADMIN }));
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${OTHER_RUN_ID}/events`);
      expect(res.status).toBe(404);
    });

    it('平台 admin → 200，query tenantId 任意透传', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer());
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/recent-runs?tenantId=other-co`);
      expect(res.status).toBe(200);
      expect(calls.recentRuns[0]).toMatchObject({ tenantId: 'other-co' });
      const other = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${OTHER_RUN_ID}/events`);
      expect(other.status).toBe(200);
    });

    it('委托平台管理员可看运行骨架，正文、工具参数和成本均脱敏', async () => {
      ({ server, baseUrl } = await startServer({ user: PLATFORM_OPERATOR }));
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.contentRedacted).toBe(true);
      expect(body.billing.costRedacted).toBe(true);
      expect(body.billing.totalCostYuan).toBeUndefined();
      const userMessage = body.events.find((event: { type: string }) => event.type === 'user_message');
      expect(userMessage.content).toBe('（内容已脱敏）');
      const toolCall = body.events.find((event: { type: string }) => event.type === 'assistant_tool_calls');
      expect(toolCall.toolCalls[0].arguments).toBe('（参数已脱敏）');
      expect(JSON.stringify(body)).not.toContain('/tmp/');
    });
  });

  describe('成本脱敏（policy.showCost）', () => {
    it('组织 admin + showCost=false → billing/efficiency 裁剪 ¥ 字段并标 costRedacted', async () => {
      ({ server, baseUrl } = await startServer({ user: ORG_ADMIN }));

      const runRes = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events`);
      const runBody = await runRes.json();
      expect(runBody.billing.costRedacted).toBe(true);
      expect(runBody.billing.totalCostYuan).toBeUndefined();
      expect(runBody.billing.requests[0].costYuan).toBeUndefined();
      // token 口径保留
      expect(runBody.billing.inputTokens).toBe(3000);
      expect(runBody.billing.requestCount).toBe(2);

      const effRes = await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency`);
      const effBody = await effRes.json();
      expect(effBody.costRedacted).toBe(true);
      expect(effBody.cost.totalCostYuan).toBeUndefined();
      expect(effBody.cost.perRun).toBeUndefined();
      expect(effBody.cost.failedRunsCostYuan).toBeUndefined();
    });

    it('组织 admin + showCost=true → 不脱敏', async () => {
      ({ server, baseUrl } = await startServer({
        user: ORG_ADMIN,
        options: { getTenantPolicy: async () => ({ showCost: true }) },
      }));
      const runRes = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events`);
      const runBody = await runRes.json();
      expect(runBody.billing.costRedacted).toBeUndefined();
      expect(runBody.billing.totalCostYuan).toBe(0.79);
      const effRes = await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency`);
      const effBody = await effRes.json();
      expect(effBody.costRedacted).toBeUndefined();
      expect(effBody.cost.totalCostYuan).toBe(0);
    });

    it('getTenantPolicy 未注入或抛错 → fail-closed 脱敏', async () => {
      ({ server, baseUrl } = await startServer({
        user: ORG_ADMIN,
        options: { getTenantPolicy: undefined },
      }));
      const res1 = await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency`);
      expect((await res1.json()).costRedacted).toBe(true);
      await stopServer(server!);

      ({ server, baseUrl } = await startServer({
        user: ORG_ADMIN,
        options: { getTenantPolicy: async () => { throw new Error('pg down'); } },
      }));
      const res2 = await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency`);
      expect((await res2.json()).costRedacted).toBe(true);
    });

    it('平台 admin 永不脱敏', async () => {
      ({ server, baseUrl } = await startServer());
      const runRes = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events`);
      const runBody = await runRes.json();
      expect(runBody.billing.costRedacted).toBeUndefined();
      expect(runBody.billing.totalCostYuan).toBe(0.79);
    });
  });

  describe('GET /runs/:runId/events', () => {
    it('run 不存在 → 404', async () => {
      ({ server, baseUrl } = await startServer());
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/run-missing/events`);
      expect(res.status).toBe(404);
    });

    it('正常返回 run + billing + events，默认排除 assistant_stream_event', async () => {
      ({ server, baseUrl } = await startServer());
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.runId).toBe(RUN_ID);
      expect(body.sessionId).toBe(SESSION);
      expect(body.run).toEqual({
        status: 'completed',
        statusReason: null,
        model: 'gpt-5.5',
        channel: 'web',
        tenantId: 'kaiyan',
        userId: 'user-1',
        requestedAt: '2026-07-03T01:00:00.000Z',
        startedAt: '2026-07-03T01:00:01.000Z',
        completedAt: '2026-07-03T01:05:00.000Z',
        failedAt: null,
        cancelledAt: null,
        executionTarget: 'server-local',
        workspaceId: 'ws-1',
        cumulativeInputTokens: 1234,
      });

      // billing：总额=微元求和/1e6，明细按 requestIndex 升序（喂入是 DESC）
      expect(body.billing.totalCostYuan).toBe(0.79);
      expect(body.billing.requestCount).toBe(2);
      expect(body.billing.inputTokens).toBe(3000);
      expect(body.billing.cachedInputTokens).toBe(1500);
      expect(body.billing.outputTokens).toBe(150);
      expect(body.billing.reasoningTokens).toBe(30);
      expect(body.billing.models).toEqual(['gpt-5.5']);
      expect(body.billing.requests.map((r: { requestIndex: number }) => r.requestIndex)).toEqual([1, 2]);
      expect(body.billing.requests[0].costYuan).toBe(0.5);

      // events：默认排除 assistant_stream_event；信封字段原样保留
      const types = body.events.map((e: { type: string }) => e.type);
      expect(types).toEqual(['user_message', 'assistant_tool_calls', 'run_finished']);
      expect(body.events[0].id).toBe('evt-1');
      expect(body.events[0].timestamp).toBe('2026-07-03T01:00:01.000Z');
      // 默认 maxContentLength=4000 → 无截断
      expect(body.events[0].truncated).toBeUndefined();
      expect(body.events[0].content).toBe(LONG_TEXT);
    });

    it('types 白名单可显式包含 assistant_stream_event', async () => {
      ({ server, baseUrl } = await startServer());
      const res = await fetch(
        `${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events?types=assistant_stream_event,run_finished`,
      );
      const body = await res.json();
      expect(body.events.map((e: { type: string }) => e.type)).toEqual(['assistant_stream_event', 'run_finished']);
    });

    it('maxContentLength 截断生效且标 truncated', async () => {
      ({ server, baseUrl } = await startServer());
      const res = await fetch(
        `${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events?maxContentLength=16`,
      );
      const body = await res.json();
      const userMsg = body.events.find((e: { type: string }) => e.type === 'user_message');
      expect(userMsg.truncated).toBe(true);
      expect(userMsg.content.startsWith('x'.repeat(16))).toBe(true);
      expect(userMsg.content).toContain('[truncated');
      // toolCalls[].arguments 也被截断
      const toolCalls = body.events.find((e: { type: string }) => e.type === 'assistant_tool_calls');
      expect(toolCalls.truncated).toBe(true);
      expect(toolCalls.toolCalls[0].arguments).toContain('[truncated');
      // 小事件不受影响
      const finished = body.events.find((e: { type: string }) => e.type === 'run_finished');
      expect(finished.truncated).toBeUndefined();
      expect(finished.subtype).toBe('success');
    });

    it('maxContentLength 超上限 → 400', async () => {
      ({ server, baseUrl } = await startServer());
      const res = await fetch(
        `${baseUrl}/api/admin/runtime/trace/runs/${RUN_ID}/events?maxContentLength=99999`,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('GET /recent-runs', () => {
    it('status 白名单外值 → 400', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer());
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/recent-runs?status=bogus`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('bogus');
      expect(calls.recentRuns).toHaveLength(0);
    });

    it('hours 超上限 → 400', async () => {
      ({ server, baseUrl } = await startServer());
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/recent-runs?hours=721`);
      expect(res.status).toBe(400);
    });

    it('正常过滤：status/hours/limit/tenantId 透传，缺省 hours=24 limit=50', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer());

      const res1 = await fetch(`${baseUrl}/api/admin/runtime/trace/recent-runs`);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.runs).toHaveLength(1);
      expect(body1.runs[0].runId).toBe(RUN_ID);
      expect(body1.runs[0]).toMatchObject({ username: 'alice', realName: 'Alice Chen' });
      expect(body1.runs[0].durationMs).toBe(299_000);
      expect(calls.recentRuns[0]).toEqual({ hours: 24, limit: 50 });

      const res2 = await fetch(
        `${baseUrl}/api/admin/runtime/trace/recent-runs?status=completed,failed&hours=48&limit=10&tenantId=kaiyan`,
      );
      expect(res2.status).toBe(200);
      expect(calls.recentRuns[1]).toEqual({
        statuses: ['completed', 'failed'],
        hours: 48,
        limit: 10,
        tenantId: 'kaiyan',
      });
    });
  });

  describe('GET /efficiency', () => {
    it('days 超上限 → 400', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer());
      const res = await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency?days=31`);
      expect(res.status).toBe(400);
      expect(calls.efficiency).toHaveLength(0);
    });

    it('正常返回：days 缺省 7，tenantId 透传', async () => {
      let calls: RecordedCalls;
      ({ server, baseUrl, calls } = await startServer());

      const res1 = await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency`);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.range.days).toBe(7);
      expect(body1.tenantId).toBeNull();
      expect(calls.efficiency[0]).toEqual({ days: 7 });

      const res2 = await fetch(`${baseUrl}/api/admin/runtime/trace/efficiency?days=30&tenantId=kaiyan`);
      const body2 = await res2.json();
      expect(body2.range.days).toBe(30);
      expect(body2.tenantId).toBe('kaiyan');
      expect(calls.efficiency[1]).toEqual({ days: 30, tenantId: 'kaiyan' });
    });
  });
});

// ────────────────────────── 纯转换函数单测 ──────────────────────────

describe('runtimeTrace 纯转换函数', () => {
  it('pickRunSummary：可选字段缺失归 null / cumulativeInputTokens 归 0', () => {
    const minimal: RunRecord = {
      runId: 'r',
      sessionId: 's',
      status: 'pending',
      requestedAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
      metadata: {},
    };
    const summary = pickRunSummary(minimal);
    expect(summary.statusReason).toBeNull();
    expect(summary.userId).toBeNull();
    expect(summary.completedAt).toBeNull();
    expect(summary.cumulativeInputTokens).toBe(0);
  });

  it('summarizeRunBilling：空列表 → 全 0', () => {
    const summary = summarizeRunBilling([]);
    expect(summary.totalCostYuan).toBe(0);
    expect(summary.requestCount).toBe(0);
    expect(summary.models).toEqual([]);
    expect(summary.requests).toEqual([]);
  });

  it('summarizeRunBilling：actualModel 缺失 fallback modelValue', () => {
    const summary = summarizeRunBilling([makeUsageEvent({ actualCostYuanMicro: 123_456 })]);
    expect(summary.models).toEqual(['gpt-5.5-fallback']);
    expect(summary.totalCostYuan).toBe(0.123456);
  });

  it('redactBillingSummary：去 ¥ 字段保留 token 口径，标 costRedacted', () => {
    const redacted = redactBillingSummary(summarizeRunBilling(USAGE_EVENTS));
    expect(redacted.costRedacted).toBe(true);
    expect((redacted as Record<string, unknown>).totalCostYuan).toBeUndefined();
    expect(redacted.inputTokens).toBe(3000);
    expect(redacted.requests).toHaveLength(2);
    expect((redacted.requests[0] as Record<string, unknown>).costYuan).toBeUndefined();
    expect(redacted.requests[0]!.inputTokens).toBe(1000);
  });

  it('redactEfficiencyCost：cost 区只留 byModel token 聚合 + cacheHitRate', () => {
    const report: EfficiencyReport = {
      ...EMPTY_REPORT,
      cost: {
        totalCostYuan: 9.9,
        byModel: [{ model: 'm', costYuan: 9.9, requests: 3, inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, cacheHitRate: 0.4 }],
        perRun: { p50: 1, p90: 2, p99: 3 },
        failedRunsCostYuan: 0.5,
        cacheHitRate: 0.4,
      },
    };
    const redacted = redactEfficiencyCost(report);
    expect(redacted.costRedacted).toBe(true);
    const cost = redacted.cost as Record<string, unknown>;
    expect(cost.totalCostYuan).toBeUndefined();
    expect(cost.perRun).toBeUndefined();
    expect(cost.failedRunsCostYuan).toBeUndefined();
    expect(cost.cacheHitRate).toBe(0.4);
    expect((redacted.cost.byModel[0] as Record<string, unknown>).costYuan).toBeUndefined();
    expect(redacted.cost.byModel[0]!.inputTokens).toBe(100);
  });

  it('truncateTraceEvent：非字符串大对象（approval input）序列化后截断', () => {
    const event = {
      id: 'e', timestamp: 't', type: 'approval_requested',
      runId: 'r', sessionId: 's', approvalId: 'a', toolCallId: 'c',
      toolId: 'Shell', toolName: 'Shell',
      input: { command: 'z'.repeat(100) },
    } as PlatformEvent;
    const out = truncateTraceEvent(event, 20);
    expect(out.truncated).toBe(true);
    expect(typeof out.input).toBe('string');
    expect(String(out.input)).toContain('[truncated');
    // 信封字段不动
    expect(out.id).toBe('e');
    expect(out.type).toBe('approval_requested');
  });

  it('sanitizeTraceEvent：保留诊断信封，移除原始内容与工具参数', () => {
    const out = sanitizeTraceEvent(EVENTS[2]!);
    expect(out).toMatchObject({
      id: 'evt-3',
      type: 'assistant_tool_calls',
      contentRedacted: true,
    });
    expect((out.toolCalls as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'call-1',
      name: 'Read',
      arguments: '（参数已脱敏）',
    });
    expect(JSON.stringify(out)).not.toContain('/tmp/');
  });

  it('sanitizeTraceEvent：错误与原因只保留发生事实，不返回原文', () => {
    const out = sanitizeTraceEvent({
      id: 'evt-sensitive-error',
      type: 'tool_result',
      timestamp: '2026-07-20T08:00:00.000Z',
      runId: 'run-sensitive-error',
      sessionId: 'session-sensitive-error',
      toolCallId: 'call-sensitive-error',
      toolName: 'Read',
      content: '客户合同原文',
      isError: true,
      error: '客户手机号 13800138000，读取 /secret/customer.txt 失败',
      reason: '审批备注含客户合同原文',
    } as PlatformEvent);

    expect(out).toMatchObject({
      isError: true,
      error: '执行失败（详细错误已脱敏）',
      reason: '原因已脱敏',
      content: '（内容已脱敏）',
      contentRedacted: true,
    });
    expect(JSON.stringify(out)).not.toContain('13800138000');
    expect(JSON.stringify(out)).not.toContain('/secret/customer.txt');
    expect(JSON.stringify(out)).not.toContain('合同原文');
  });
});

describe('efficiencyQuery 纯转换函数', () => {
  it('parseReadToolFilePath：兼容 path / file_path，非法 JSON 返回 undefined', () => {
    expect(parseReadToolFilePath('{"path":"/a.ts"}')).toBe('/a.ts');
    expect(parseReadToolFilePath('{"file_path":"/b.ts"}')).toBe('/b.ts');
    expect(parseReadToolFilePath('{"offset":1}')).toBeUndefined();
    expect(parseReadToolFilePath('{"path":"/a.ts", trunc')).toBeUndefined();
    expect(parseReadToolFilePath(undefined)).toBeUndefined();
  });

  it('buildRepeatedFileReadsSection：同文件不同参数 hash 合并计数，>=3 才计入', () => {
    const rows = [
      // run-1 读 /a.ts：2 + 1 = 3 次（不同 offset 分散在两个 hash 组）
      { run_id: 'run-1', sample_arguments: '{"path":"/a.ts"}', repeats: '2' },
      { run_id: 'run-1', sample_arguments: '{"path":"/a.ts","offset":10}', repeats: '1' },
      // run-1 读 /b.ts 仅 2 次 → 不计入
      { run_id: 'run-1', sample_arguments: '{"path":"/b.ts"}', repeats: '2' },
      // run-2 读 /c.ts 5 次
      { run_id: 'run-2', sample_arguments: '{"file_path":"/c.ts"}', repeats: '5' },
      // 非法 JSON 跳过
      { run_id: 'run-3', sample_arguments: '{"path":', repeats: '9' },
    ];
    const section = buildRepeatedFileReadsSection(rows);
    expect(section.affectedRuns).toBe(2);
    expect(section.topFiles).toEqual([
      { filePath: '/c.ts', repeats: 5, runId: 'run-2' },
      { filePath: '/a.ts', repeats: 3, runId: 'run-1' },
    ]);
  });

  it('buildOutcomeSection：completionRate 防 0；空数据为 null', () => {
    expect(buildOutcomeSection([], []).completionRate).toBeNull();
    const outcome = buildOutcomeSection(
      [
        { subtype: 'success', count: '97' },
        { subtype: 'error', count: '2' },
        { subtype: 'interrupted', count: '1' },
      ],
      [{ reason: 'boom', count: '2', sample_run_id: 'run-e' }],
    );
    expect(outcome.totalRuns).toBe(100);
    expect(outcome.completionRate).toBe(0.97);
    expect(outcome.errorReasons).toEqual([{ reason: 'boom', count: 2, sampleRunId: 'run-e' }]);
  });

  it('buildCostSection：微元→元、cacheHitRate input=0 时 null、空分位为 null', () => {
    const cost = buildCostSection(
      [
        { model: 'gpt-5.5', requests: '10', cost_micro: '790000', input_tokens: '1000', cached_input_tokens: '400', output_tokens: '50' },
        { model: 'embed-1', requests: '3', cost_micro: '1000', input_tokens: '0', cached_input_tokens: '0', output_tokens: '0' },
      ],
      { p50_micro: '100000', p90_micro: '500000', p99_micro: null },
      { cost_micro: '250000' },
    );
    expect(cost.totalCostYuan).toBe(0.791);
    expect(cost.byModel[0]!.cacheHitRate).toBe(0.4);
    expect(cost.byModel[1]!.cacheHitRate).toBeNull();
    expect(cost.perRun).toEqual({ p50: 0.1, p90: 0.5, p99: null });
    expect(cost.failedRunsCostYuan).toBe(0.25);
    expect(cost.cacheHitRate).toBe(0.4);
  });

  it('normalizeRecentRunRow：durationMs 按终态时间戳能算则算', () => {
    const completed = normalizeRecentRunRow({
      run_id: 'r1', session_id: 's1', tenant_id: 'kaiyan', user_id: 'u1',
      status: 'completed', status_reason: null, model: 'm', channel: 'web',
      requested_at: new Date('2026-07-03T00:00:00Z'),
      started_at: new Date('2026-07-03T00:00:01Z'),
      completed_at: new Date('2026-07-03T00:00:11Z'),
      failed_at: null, cancelled_at: null,
    });
    expect(completed.durationMs).toBe(10_000);
    const running = normalizeRecentRunRow({
      run_id: 'r2', session_id: 's2', tenant_id: 'kaiyan', user_id: null,
      status: 'running', status_reason: null, model: null, channel: null,
      requested_at: new Date('2026-07-03T00:00:00Z'),
      started_at: new Date('2026-07-03T00:00:01Z'),
      completed_at: null, failed_at: null, cancelled_at: null,
    });
    expect(running.durationMs).toBeUndefined();
    expect(running.model).toBeNull();
  });
});

// ────────────────────────── RuntimeEfficiencyQuery（mock pool） ──────────────────────────

class MockPool {
  readonly calls: Array<{ text: string; params?: unknown[] }> = [];
  constructor(private readonly rowsByMarker: Record<string, Array<Record<string, unknown>>>) {}

  async query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ text, params });
    for (const [marker, rows] of Object.entries(this.rowsByMarker)) {
      if (text.includes(`eff:${marker}`)) return { rows };
    }
    return { rows: [] };
  }
}

function makeQuery(pool: MockPool): RuntimeEfficiencyQuery {
  return new RuntimeEfficiencyQuery({
    pool,
    eventsTable: 'runtime_events',
    runsTable: 'runtime_runs',
    billingUsageEventsTable: 'runtime_billing_usage_events',
  });
}

describe('RuntimeEfficiencyQuery（mock pool）', () => {
  it('构造时校验表名 identifier，拒绝注入', () => {
    expect(() => new RuntimeEfficiencyQuery({
      pool: new MockPool({}),
      eventsTable: 'runtime_events; DROP TABLE users',
      runsTable: 'runtime_runs',
      billingUsageEventsTable: 'runtime_billing_usage_events',
    })).toThrow(/非法 PG identifier/);
  });

  it('listRecentRuns：SQL 参数化（hours/statuses/tenantId/limit）+ 行转换', async () => {
    const pool = new MockPool({
      recent_runs: [{
        run_id: 'r1', session_id: 's1', tenant_id: 'kaiyan', user_id: 'u1',
        status: 'failed', status_reason: 'model error', model: 'm', channel: 'dingtalk',
        requested_at: new Date('2026-07-03T00:00:00Z'),
        started_at: new Date('2026-07-03T00:00:01Z'),
        completed_at: null,
        failed_at: new Date('2026-07-03T00:00:31Z'),
        cancelled_at: null,
      }],
    });
    const runs = await makeQuery(pool).listRecentRuns({
      statuses: ['failed'], hours: 48, limit: 20, tenantId: 'kaiyan',
    });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.params).toEqual([48, ['failed'], 'kaiyan', 20]);
    expect(pool.calls[0]!.text).not.toContain('kaiyan'); // 用户输入不进 SQL 文本
    expect(runs).toEqual([{
      runId: 'r1', sessionId: 's1', tenantId: 'kaiyan', userId: 'u1',
      status: 'failed', statusReason: 'model error', model: 'm', channel: 'dingtalk',
      requestedAt: '2026-07-03T00:00:00.000Z',
      startedAt: '2026-07-03T00:00:01.000Z',
      completedAt: null,
      failedAt: '2026-07-03T00:00:31.000Z',
      cancelledAt: null,
      durationMs: 30_000,
    }]);
  });

  it('getEfficiency：所有 SQL 带时间窗 + tenant 参数；rows→report 全链路', async () => {
    const pool = new MockPool({
      outcome: [
        { subtype: 'success', count: '8' },
        { subtype: 'error', count: '2' },
      ],
      error_reasons: [{ reason: 'timeout', count: '2', sample_run_id: 'run-x' }],
      tools: [{ tool_name: 'Shell', calls: '10', errors: '2', total_duration_ms: '5000' }],
      hand_failures: [{ count: '1' }],
      cost_by_model: [{ model: 'gpt-5.5', requests: '26', cost_micro: '790000', input_tokens: '10000', cached_input_tokens: '4000', output_tokens: '900' }],
      cost_per_run: [{ p50_micro: 10000, p90_micro: 90000, p99_micro: 99000 }],
      cost_failed_runs: [{ cost_micro: '120000' }],
      slowest_runs: [{ run_id: 'r-slow', session_id: 's', tenant_id: 'kaiyan', status: 'completed', model: 'm', duration_ms: '60000' }],
      most_turns: [{ run_id: 'r-turns', session_id: 's', tenant_id: 'kaiyan', turns: '42' }],
      approvals_summary: [{ count: '4', resolved_count: '3', wait_p50_ms: 1500.4, wait_p90_ms: 9000.9 }],
      approvals_by_tool: [{ tool_name: 'Write', count: '4', avg_wait_ms: '2000.6' }],
      waste_duplicates: [{ affected_runs: '2', total_duplicate_calls: '5', top_offenders: [{ toolName: 'Read', duplicates: 3 }] }],
      waste_read_groups: [{ run_id: 'r1', sample_arguments: '{"path":"/hot.ts"}', repeats: '4' }],
      waste_retries: [{ count: '3', by_tool: [{ toolName: 'Shell', count: 3 }] }],
    });
    const before = Date.now();
    const report = await makeQuery(pool).getEfficiency({ days: 7, tenantId: 'kaiyan' });

    // 每条 SQL 都是 [fromIso, tenantId] 参数化；from ≈ now - 7d
    expect(pool.calls.length).toBe(14);
    for (const call of pool.calls) {
      expect(call.params).toHaveLength(2);
      expect(call.params?.[1]).toBe('kaiyan');
      const fromMs = Date.parse(String(call.params?.[0]));
      expect(Math.abs(fromMs - (before - 7 * 24 * 60 * 60 * 1000))).toBeLessThan(60_000);
      expect(call.text).not.toContain('kaiyan');
    }

    expect(report.range.days).toBe(7);
    expect(report.tenantId).toBe('kaiyan');
    expect(report.outcome).toEqual({
      totalRuns: 10, success: 8, error: 2, interrupted: 0,
      completionRate: 0.8,
      errorReasons: [{ reason: 'timeout', count: 2, sampleRunId: 'run-x' }],
    });
    expect(report.tools).toEqual({
      byTool: [{ toolName: 'Shell', calls: 10, errors: 2, errorRate: 0.2, totalDurationMs: 5000, avgDurationMs: 500 }],
      handFailures: 1,
    });
    expect(report.cost).toEqual({
      totalCostYuan: 0.79,
      byModel: [{ model: 'gpt-5.5', costYuan: 0.79, requests: 26, inputTokens: 10000, cachedInputTokens: 4000, outputTokens: 900, cacheHitRate: 0.4 }],
      perRun: { p50: 0.01, p90: 0.09, p99: 0.099 },
      failedRunsCostYuan: 0.12,
      cacheHitRate: 0.4,
    });
    expect(report.longTail).toEqual({
      slowestRuns: [{ runId: 'r-slow', sessionId: 's', tenantId: 'kaiyan', durationMs: 60000, status: 'completed', model: 'm' }],
      mostTurns: [{ runId: 'r-turns', sessionId: 's', tenantId: 'kaiyan', turns: 42 }],
    });
    expect(report.approvals).toEqual({
      count: 4, resolvedCount: 3, waitP50Ms: 1500, waitP90Ms: 9001,
      byTool: [{ toolName: 'Write', count: 4, avgWaitMs: 2001 }],
    });
    expect(report.waste).toEqual({
      duplicateToolCalls: { affectedRuns: 2, totalDuplicateCalls: 5, topOffenders: [{ toolName: 'Read', duplicates: 3 }] },
      repeatedFileReads: { affectedRuns: 1, topFiles: [{ filePath: '/hot.ts', repeats: 4, runId: 'r1' }] },
      unmodifiedRetries: { count: 3, byTool: [{ toolName: 'Shell', count: 3 }] },
    });
  });

  it('getEfficiency：全空数据 → 除法防 0（rate/分位全 null，计数全 0）', async () => {
    const pool = new MockPool({
      outcome: [], error_reasons: [], tools: [], hand_failures: [{ count: '0' }],
      cost_by_model: [], cost_per_run: [{ p50_micro: null, p90_micro: null, p99_micro: null }],
      cost_failed_runs: [{ cost_micro: '0' }], slowest_runs: [], most_turns: [],
      approvals_summary: [{ count: '0', resolved_count: '0', wait_p50_ms: null, wait_p90_ms: null }],
      approvals_by_tool: [],
      waste_duplicates: [{ affected_runs: '0', total_duplicate_calls: '0', top_offenders: [] }],
      waste_read_groups: [],
      waste_retries: [{ count: '0', by_tool: [] }],
    });
    const report = await makeQuery(pool).getEfficiency({ days: 30 });
    expect(report.tenantId).toBeNull();
    expect(report.outcome.completionRate).toBeNull();
    expect(report.cost.cacheHitRate).toBeNull();
    expect(report.cost.perRun).toEqual({ p50: null, p90: null, p99: null });
    expect(report.approvals.waitP50Ms).toBeNull();
    expect(report.waste.duplicateToolCalls.totalDuplicateCalls).toBe(0);
    // tenantId 未传 → 每条 SQL 第二参数为 null
    for (const call of pool.calls) {
      expect(call.params?.[1]).toBeNull();
    }
  });
});
