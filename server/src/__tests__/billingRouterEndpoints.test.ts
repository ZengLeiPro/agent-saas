/**
 * Billing 路由端点覆盖测试（财务正确性方向，2026-07-19）
 *
 * 与现有 billing 测试的分工：
 *   - billingService.test.ts        : BillingService 投影/汇总业务逻辑
 *   - billingRouterRedact.test.ts   : GET /ledger、GET /audit 的组织 admin 成本/毛利脱敏
 *   - billingStoreCoverage.test.ts  : PgBillingStore settleRunDebit/adjustAccount 金额计算
 *   - billingConcurrency.test.ts    : 并发结算幂等
 *   本文件补齐其余未覆盖端点与路由层纯逻辑：
 *   1. resolveTenantAccess 三态：未登录 401 / 组织 admin 跨租户 403 / 平台 admin 透传 tenantId
 *   2. redactPolicy：组织 admin 读 policy 时 margin/multiplier 归零、showCost/showGrossMargin 强制 false
 *   3. pricing-versions 三端点：参数校验、actor 落章、BillingPricingConflictError→409、
 *      「active 版本不能直接退役」→400
 *   4. project-now / policy PATCH / accounts / accounts adjust / usage-events / sessions|runs summary
 *   5. decodeCursor/encodeCursor：非法 base64、缺字段 → undefined 不炸列表；合法 cursor round-trip
 *   6. 用户侧三端点：401 守卫 + /sessions/:id/ledger 字段裁剪（不漏 cost 内部字段）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import { createAdminBillingRouter, createBillingRouter } from '../routes/billing.js';
import { BillingPricingConflictError } from '../data/billing/pgBillingStore.js';
import type { BillingService } from '../data/billing/service.js';
import type { BillingLedgerEntry, TenantBillingPolicy } from '../data/billing/types.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'root', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_MEMBER: JwtPayload = { sub: 'u-member', username: 'bob', role: 'user', tenantId: 'wain' };

function fullPolicy(): TenantBillingPolicy {
  return {
    tenantId: 'wain',
    policyVersion: 'pol-v7',
    billingEnabled: true,
    pricingVersion: 'price-v1',
    billingMode: 'prepaid',
    defaultTargetMarginBps: 6000,
    organizationMultiplierBps: 12000,
    allowNegativeBalance: false,
    negativeLimitCreditsMicro: 0,
    lowBalanceThresholdCreditsMicro: 50_000_000,
    hardCapMode: 'stop_before_run',
    showBalance: true,
    showUsageCredits: true,
    showCost: true,
    showGrossMargin: true,
    updatedBy: 'ops',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

function fullLedgerEntry(): BillingLedgerEntry {
  return {
    id: 'led-1',
    idempotencyKey: 'idem-1',
    tenantId: 'wain',
    accountId: 'acc-wain',
    type: 'debit',
    source: 'usage_event',
    relatedUsageEventIds: ['ue-1'],
    sessionId: 'sess-1',
    runId: 'run-1',
    creditsDeltaMicro: -12_345_000,
    balanceBeforeMicro: 500_000_000,
    balanceAfterMicro: 487_655_000,
    creditValueYuanMicro: 10_000,
    revenueYuanMicro: 123_450,
    actualCostYuanMicro: 49_380,
    grossProfitYuanMicro: 74_070,
    grossMarginBps: 6000,
    pricingVersion: 'price-v1',
    billingPolicyVersion: 'pol-v7',
    note: '扣费',
    createdAt: '2026-07-13T10:00:00.000Z',
  };
}

function makeFns() {
  return {
    ensureProjected: vi.fn(async () => undefined),
    projectRuntimeEvents: vi.fn(async (_limit: number) => ({ projected: 3, lastGlobalSequence: 42 })),
    createPricingVersion: vi.fn(async (input: Record<string, unknown>, actor: string) => ({ ...input, createdBy: actor })),
    updatePricingVersion: vi.fn(async (version: string, patch: Record<string, unknown>, actor: string) => ({ version, ...patch, updatedBy: actor })),
    updateTenantPolicy: vi.fn(async (tenantId: string, patch: Record<string, unknown>, actor: string) => ({ ...fullPolicy(), tenantId, ...patch, updatedBy: actor })),
    getSummaryForTenant: vi.fn(async (tenantId: string, options?: { includeInternalMetrics?: boolean }) => ({
      tenantId,
      balanceCredits: 487.655,
      ...(options?.includeInternalMetrics ? { actualCostYuan: 12.3 } : {}),
    })),
    adjustAccount: vi.fn(async (input: Record<string, unknown>) => ({ id: 'led-adj', ...input })),
    listLedgerForTenant: vi.fn(async (_tenantId: string, _query: Record<string, unknown>) => ({
      entries: [fullLedgerEntry()],
      nextCursor: undefined as { createdAt: string; id: string } | undefined,
    })),
    getSessionSummary: vi.fn(async (_tenantId: string, sessionId: string) => ({
      sessionId, creditsUsed: 12.345, revenueYuan: 0.12345, childSessionCount: 0,
    })),
    store: {
      listPricingVersions: vi.fn(async () => [{ version: 'price-v1', status: 'active', creditValueYuanMicro: 10_000 }]),
      getTenantPolicy: vi.fn(async () => fullPolicy()),
      listUsageEvents: vi.fn(async () => [{ id: 'ue-1', actualCostYuanMicro: 49_380 }]),
    },
  };
}

type Fns = ReturnType<typeof makeFns>;

interface Rig {
  fns: Fns;
  request(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  setCaller(caller: JwtPayload | null): void;
  close(): Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const fns = makeFns();
  const billingService = fns as unknown as BillingService;
  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload | null = PLATFORM_ADMIN;
  app.use((req, _res, next) => {
    if (currentCaller) req.user = currentCaller;
    next();
  });
  app.use('/api/admin/billing', createAdminBillingRouter({ billingService }));
  app.use('/api/billing', createBillingRouter({ billingService }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    fns,
    request: (path, init) => fetch(`${baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    setCaller: (caller) => { currentCaller = caller; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('Billing 路由端点', () => {
  const rigs: Rig[] = [];

  afterEach(async () => {
    while (rigs.length > 0) await rigs.pop()!.close();
  });

  async function newRig(caller: JwtPayload | null = PLATFORM_ADMIN): Promise<Rig> {
    const rig = await makeRig();
    rig.setCaller(caller);
    rigs.push(rig);
    return rig;
  }

  describe('resolveTenantAccess 三态', () => {
    it('未登录访问 policy / accounts → 401', async () => {
      const rig = await newRig(null);
      const policyRes = await rig.request('/api/admin/billing/tenants/wain/policy');
      expect(policyRes.status).toBe(401);
      expect((await policyRes.json()).error).toBe('Authentication required');
      const accountsRes = await rig.request('/api/admin/billing/accounts');
      expect(accountsRes.status).toBe(401);
    });

    it('组织 admin 跨租户读 policy / accounts → 403', async () => {
      const rig = await newRig(WAIN_ADMIN);
      const policyRes = await rig.request('/api/admin/billing/tenants/other-org/policy');
      expect(policyRes.status).toBe(403);
      expect((await policyRes.json()).error).toBe('跨组织访问被拒绝');
      const accountsRes = await rig.request('/api/admin/billing/accounts?tenantId=other-org');
      expect(accountsRes.status).toBe(403);
      expect(rig.fns.getSummaryForTenant).not.toHaveBeenCalled();
    });

    it('平台 admin 透传请求的 tenantId；未传时回落到自身 tenant', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      expect((await rig.request('/api/admin/billing/accounts?tenantId=wain')).status).toBe(200);
      expect(rig.fns.getSummaryForTenant).toHaveBeenLastCalledWith('wain', { includeInternalMetrics: true });
      expect((await rig.request('/api/admin/billing/accounts')).status).toBe(200);
      expect(rig.fns.getSummaryForTenant).toHaveBeenLastCalledWith(DEFAULT_TENANT_ID, { includeInternalMetrics: true });
    });

    it('组织 admin 读自己 accounts → includeInternalMetrics=false，摘要不含内部成本', async () => {
      const rig = await newRig(WAIN_ADMIN);
      const res = await rig.request('/api/admin/billing/accounts');
      expect(res.status).toBe(200);
      expect(rig.fns.getSummaryForTenant).toHaveBeenCalledWith('wain', { includeInternalMetrics: false });
      const body = await res.json();
      expect(body.summary.balanceCredits).toBe(487.655);
      expect(body.summary).not.toHaveProperty('actualCostYuan');
    });

    it('非法 tenantId（大写/超短）→ 400', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      expect((await rig.request('/api/admin/billing/tenants/UPPERCASE/policy')).status).toBe(400);
      expect((await rig.request('/api/admin/billing/accounts?tenantId=X')).status).toBe(400);
    });
  });

  describe('GET /tenants/:tenantId/policy 脱敏（redactPolicy）', () => {
    it('组织 admin：margin/multiplier 归零，showCost/showGrossMargin 强制 false，客户口径字段保留', async () => {
      const rig = await newRig(WAIN_ADMIN);
      const res = await rig.request('/api/admin/billing/tenants/wain/policy');
      expect(res.status).toBe(200);
      const { policy } = await res.json();
      // 源数据是 6000 / 12000 / true / true，证明确实被抹掉而非本来就是 0
      expect(policy.defaultTargetMarginBps).toBe(0);
      expect(policy.organizationMultiplierBps).toBe(0);
      expect(policy.showCost).toBe(false);
      expect(policy.showGrossMargin).toBe(false);
      // 客户口径字段原样保留
      expect(policy.billingMode).toBe('prepaid');
      expect(policy.billingEnabled).toBe(true);
      expect(policy.pricingVersion).toBe('price-v1');
      expect(policy.lowBalanceThresholdCreditsMicro).toBe(50_000_000);
    });

    it('平台 admin：margin/multiplier/可见性原样透传', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const { policy } = await (await rig.request('/api/admin/billing/tenants/wain/policy')).json();
      expect(policy.defaultTargetMarginBps).toBe(6000);
      expect(policy.organizationMultiplierBps).toBe(12000);
      expect(policy.showCost).toBe(true);
      expect(policy.showGrossMargin).toBe(true);
      expect(rig.fns.store.getTenantPolicy).toHaveBeenCalledWith('wain');
    });
  });

  describe('pricing-versions 三端点', () => {
    it('GET：平台 admin 返回列表且先投影；组织 admin → 403', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const res = await rig.request('/api/admin/billing/pricing-versions');
      expect(res.status).toBe(200);
      expect((await res.json()).pricingVersions).toEqual([
        { version: 'price-v1', status: 'active', creditValueYuanMicro: 10_000 },
      ]);
      expect(rig.fns.ensureProjected).toHaveBeenCalledTimes(1);

      rig.setCaller(WAIN_ADMIN);
      expect((await rig.request('/api/admin/billing/pricing-versions')).status).toBe(403);
    });

    it('POST：合法 body 透传 + actor 取 username；非法 body → 400', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const res = await rig.request('/api/admin/billing/pricing-versions', {
        method: 'POST',
        body: { version: 'v2026.08', name: '2026Q3 定价', status: 'draft', creditValueYuanMicro: 10_000, defaultTargetMarginBps: 6000 },
      });
      expect(res.status).toBe(200);
      expect(rig.fns.createPricingVersion).toHaveBeenCalledWith(
        { version: 'v2026.08', name: '2026Q3 定价', status: 'draft', creditValueYuanMicro: 10_000, defaultTargetMarginBps: 6000 },
        'root',
      );
      expect((await res.json()).pricingVersion.creditValueYuanMicro).toBe(10_000);

      const bad = await rig.request('/api/admin/billing/pricing-versions', {
        method: 'POST',
        body: { version: 'v2026.09', creditValueYuanMicro: 10_000, defaultTargetMarginBps: 6000 }, // 缺 name
      });
      expect(bad.status).toBe(400);
      expect(rig.fns.createPricingVersion).toHaveBeenCalledTimes(1);
    });

    it('POST：BillingPricingConflictError → 409', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      rig.fns.createPricingVersion.mockRejectedValueOnce(
        new BillingPricingConflictError('已有另一个 active 价格版本，请刷新后重试'),
      );
      const res = await rig.request('/api/admin/billing/pricing-versions', {
        method: 'POST',
        body: { version: 'v2026.08', name: 'x', status: 'active', creditValueYuanMicro: 10_000, defaultTargetMarginBps: 6000 },
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('已有另一个 active 价格版本，请刷新后重试');
    });

    it('PATCH：合法 patch 透传；conflict → 409；active 退役 → 400；非法 version id → 400', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const ok = await rig.request('/api/admin/billing/pricing-versions/v2026.08', {
        method: 'PATCH',
        body: { status: 'active', creditValueYuanMicro: 20_000 },
      });
      expect(ok.status).toBe(200);
      expect(rig.fns.updatePricingVersion).toHaveBeenCalledWith('v2026.08', { status: 'active', creditValueYuanMicro: 20_000 }, 'root');

      rig.fns.updatePricingVersion.mockRejectedValueOnce(
        new BillingPricingConflictError('已有另一个 active 价格版本，请刷新后重试'),
      );
      const conflict = await rig.request('/api/admin/billing/pricing-versions/v2026.08', {
        method: 'PATCH', body: { status: 'active' },
      });
      expect(conflict.status).toBe(409);

      rig.fns.updatePricingVersion.mockRejectedValueOnce(
        new Error('当前 active 版本不能直接退役或改成 draft，请先激活另一个版本。'),
      );
      const retire = await rig.request('/api/admin/billing/pricing-versions/v2026.08', {
        method: 'PATCH', body: { status: 'retired' },
      });
      expect(retire.status).toBe(400);
      expect((await retire.json()).error).toContain('active 版本不能直接退役');

      const badId = await rig.request('/api/admin/billing/pricing-versions/BADID', {
        method: 'PATCH', body: { name: 'x' },
      });
      expect(badId.status).toBe(400);
      expect((await badId.json()).error).toBe('Invalid version id');
    });
  });

  describe('POST /project-now', () => {
    it('平台 admin：以 limit=2000 触发投影并回显结果；组织 admin → 403', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const res = await rig.request('/api/admin/billing/project-now', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projected: 3, lastGlobalSequence: 42 });
      expect(rig.fns.projectRuntimeEvents).toHaveBeenCalledWith(2000);

      rig.setCaller(WAIN_ADMIN);
      expect((await rig.request('/api/admin/billing/project-now', { method: 'POST' })).status).toBe(403);
    });
  });

  describe('PATCH /tenants/:tenantId/policy', () => {
    it('平台 admin：合法 patch 透传 + actor 落章；越界 margin → 400；组织 admin → 403', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const ok = await rig.request('/api/admin/billing/tenants/wain/policy', {
        method: 'PATCH',
        body: { defaultTargetMarginBps: 7000, showCost: true },
      });
      expect(ok.status).toBe(200);
      expect(rig.fns.updateTenantPolicy).toHaveBeenCalledWith('wain', { defaultTargetMarginBps: 7000, showCost: true }, 'root');

      const outOfRange = await rig.request('/api/admin/billing/tenants/wain/policy', {
        method: 'PATCH',
        body: { defaultTargetMarginBps: 9600 }, // > 9500 上限
      });
      expect(outOfRange.status).toBe(400);

      rig.setCaller(WAIN_ADMIN);
      const forbidden = await rig.request('/api/admin/billing/tenants/wain/policy', {
        method: 'PATCH', body: { showCost: true },
      });
      expect(forbidden.status).toBe(403);
      expect(rig.fns.updateTenantPolicy).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /accounts/:tenantId/adjust', () => {
    it('平台 admin：creditsDelta/type/note/actor 精确透传', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const res = await rig.request('/api/admin/billing/accounts/wain/adjust', {
        method: 'POST',
        body: { creditsDelta: 250.5, type: 'grant', note: '活动补偿' },
      });
      expect(res.status).toBe(200);
      expect(rig.fns.adjustAccount).toHaveBeenCalledWith({
        tenantId: 'wain',
        creditsDelta: 250.5,
        type: 'grant',
        note: '活动补偿',
        actor: 'root',
      });
      expect((await res.json()).entry.creditsDelta).toBe(250.5);
    });

    it('非法 body（creditsDelta 非数值）→ 400；组织 admin → 403', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const bad = await rig.request('/api/admin/billing/accounts/wain/adjust', {
        method: 'POST', body: { creditsDelta: '100' },
      });
      expect(bad.status).toBe(400);
      expect(rig.fns.adjustAccount).not.toHaveBeenCalled();

      rig.setCaller(WAIN_ADMIN);
      const forbidden = await rig.request('/api/admin/billing/accounts/wain/adjust', {
        method: 'POST', body: { creditsDelta: 100 },
      });
      expect(forbidden.status).toBe(403);
    });
  });

  describe('GET /ledger cursor 编解码', () => {
    it('非法 base64 cursor → 200 且不带 cursor 查询（不炸列表）', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const res = await rig.request('/api/admin/billing/ledger?cursor=!!!!');
      expect(res.status).toBe(200);
      const query = rig.fns.listLedgerForTenant.mock.calls[0]![1] as Record<string, unknown>;
      expect(query).not.toHaveProperty('cursor');
    });

    it('base64 合法但缺 id 字段 → 忽略 cursor', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const partial = Buffer.from(JSON.stringify({ createdAt: '2026-07-01T00:00:00.000Z' }), 'utf8').toString('base64url');
      const res = await rig.request(`/api/admin/billing/ledger?cursor=${partial}`);
      expect(res.status).toBe(200);
      const query = rig.fns.listLedgerForTenant.mock.calls[0]![1] as Record<string, unknown>;
      expect(query).not.toHaveProperty('cursor');
    });

    it('合法 cursor 解码透传；nextCursor 编码可 round-trip 回原对象', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const cursorIn = { createdAt: '2026-07-01T00:00:00.000Z', id: 'led-9' };
      const cursorOut = { createdAt: '2026-07-02T00:00:00.000Z', id: 'led-10' };
      rig.fns.listLedgerForTenant.mockResolvedValueOnce({ entries: [], nextCursor: cursorOut });
      const encoded = Buffer.from(JSON.stringify(cursorIn), 'utf8').toString('base64url');
      const res = await rig.request(`/api/admin/billing/ledger?cursor=${encoded}&limit=10`);
      expect(res.status).toBe(200);
      const query = rig.fns.listLedgerForTenant.mock.calls[0]![1] as Record<string, unknown>;
      expect(query.cursor).toEqual(cursorIn);
      expect(query.limit).toBe(10);
      const body = await res.json();
      expect(JSON.parse(Buffer.from(body.nextCursor, 'base64url').toString('utf8'))).toEqual(cursorOut);
    });
  });

  describe('GET /usage-events', () => {
    it('平台 admin：billable/unpricedOnly/limit 类型强转后透传；组织 admin → 403', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      const res = await rig.request('/api/admin/billing/usage-events?tenantId=wain&billable=true&unpricedOnly=false&limit=5');
      expect(res.status).toBe(200);
      expect(rig.fns.store.listUsageEvents).toHaveBeenCalledWith({
        tenantId: 'wain', billable: true, unpricedOnly: false, limit: 5,
      });
      expect(rig.fns.ensureProjected).toHaveBeenCalled();
      expect((await res.json()).events).toHaveLength(1);

      rig.setCaller(WAIN_ADMIN);
      expect((await rig.request('/api/admin/billing/usage-events')).status).toBe(403);
    });

    it('limit=0 越界 → 400', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      expect((await rig.request('/api/admin/billing/usage-events?limit=0')).status).toBe(400);
      expect(rig.fns.store.listUsageEvents).not.toHaveBeenCalled();
    });
  });

  describe('admin sessions/runs summary', () => {
    it('GET /sessions/:id/summary：tenantId 必填 → 400；带 tenantId → summary+ledger(limit=200)', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      expect((await rig.request('/api/admin/billing/sessions/sess-1/summary')).status).toBe(400);

      const res = await rig.request('/api/admin/billing/sessions/sess-1/summary?tenantId=wain');
      expect(res.status).toBe(200);
      expect(rig.fns.getSessionSummary).toHaveBeenCalledWith('wain', 'sess-1');
      expect(rig.fns.listLedgerForTenant).toHaveBeenCalledWith('wain', { sessionId: 'sess-1', limit: 200 });
      const body = await res.json();
      expect(body.summary.creditsUsed).toBe(12.345);
      expect(body.ledger).toHaveLength(1);
    });

    it('GET /runs/:id/summary：tenantId 必填 → 400；带 tenantId → ledger(limit=100)+usageEvents(limit=1000)', async () => {
      const rig = await newRig(PLATFORM_ADMIN);
      expect((await rig.request('/api/admin/billing/runs/run-9/summary')).status).toBe(400);

      const res = await rig.request('/api/admin/billing/runs/run-9/summary?tenantId=wain');
      expect(res.status).toBe(200);
      expect(rig.fns.listLedgerForTenant).toHaveBeenCalledWith('wain', { runId: 'run-9', limit: 100 });
      expect(rig.fns.store.listUsageEvents).toHaveBeenCalledWith({ tenantId: 'wain', runId: 'run-9', limit: 1000 });
      const body = await res.json();
      expect(body.ledger).toHaveLength(1);
      expect(body.usageEvents).toHaveLength(1);
    });
  });

  describe('用户侧路由（createBillingRouter）', () => {
    it('三端点未登录一律 401', async () => {
      const rig = await newRig(null);
      expect((await rig.request('/api/billing/me/summary')).status).toBe(401);
      expect((await rig.request('/api/billing/sessions/sess-1/summary')).status).toBe(401);
      expect((await rig.request('/api/billing/sessions/sess-1/ledger')).status).toBe(401);
    });

    it('/me/summary 与 /sessions/:id/summary 固定使用调用者自己的 tenant', async () => {
      const rig = await newRig(WAIN_MEMBER);
      expect((await rig.request('/api/billing/me/summary')).status).toBe(200);
      // 用户侧不传 includeInternalMetrics（内部口径仅平台 admin 可见）
      expect(rig.fns.getSummaryForTenant).toHaveBeenCalledWith('wain');

      expect((await rig.request('/api/billing/sessions/sess-1/summary')).status).toBe(200);
      expect(rig.fns.getSessionSummary).toHaveBeenCalledWith('wain', 'sess-1');
    });

    it('/sessions/:id/ledger 只暴露客户口径五字段，成本/余额/毛利内部字段全部裁剪', async () => {
      const rig = await newRig(WAIN_MEMBER);
      const res = await rig.request('/api/billing/sessions/sess-1/ledger');
      expect(res.status).toBe(200);
      expect(rig.fns.listLedgerForTenant).toHaveBeenCalledWith('wain', { sessionId: 'sess-1', limit: 50 });
      const { entries } = await res.json();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      // 白名单字段 + micro→credit 换算（-12_345_000 micro = -12.345 积分）
      expect(Object.keys(entry).sort()).toEqual(['createdAt', 'creditsDelta', 'id', 'note', 'type']);
      expect(entry).toEqual({
        id: 'led-1',
        type: 'debit',
        creditsDelta: -12.345,
        createdAt: '2026-07-13T10:00:00.000Z',
        note: '扣费',
      });
      // 内部字段确实不存在（而非值为 null）
      expect(entry).not.toHaveProperty('actualCostYuanMicro');
      expect(entry).not.toHaveProperty('grossProfitYuanMicro');
      expect(entry).not.toHaveProperty('grossMarginBps');
      expect(entry).not.toHaveProperty('revenueYuanMicro');
      expect(entry).not.toHaveProperty('creditsDeltaMicro');
      expect(entry).not.toHaveProperty('balanceBeforeMicro');
      expect(entry).not.toHaveProperty('balanceAfterMicro');
      expect(entry).not.toHaveProperty('creditValueYuanMicro');
      expect(entry).not.toHaveProperty('idempotencyKey');
      expect(entry).not.toHaveProperty('accountId');
      expect(entry).not.toHaveProperty('billingPolicyVersion');
    });
  });
});
