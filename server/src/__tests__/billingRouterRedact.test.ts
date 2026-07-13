/**
 * Admin Billing 路由组织 admin 脱敏测试（2026-07-14）
 *
 * 覆盖目标：
 *   1. GET /ledger  - 组织 admin：actualCostYuanMicro / grossProfitYuanMicro / grossMarginBps
 *                     按 showCost / showGrossMargin fail-closed 剥离；平台 admin 原样返回
 *   2. GET /audit   - 组织 admin：聚合与 daily 分桶同样剥离；alerts 清空；daily 对组织 admin 开放
 *   3. 毛利以 showCost 为前提（showGrossMargin=true 但 showCost=false 时毛利仍隐藏）
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';

import { createAdminBillingRouter } from '../routes/billing.js';
import type { BillingService } from '../data/billing/service.js';
import type { BillingAuditSummary, BillingLedgerEntry } from '../data/billing/types.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };

function sampleLedgerEntry(): BillingLedgerEntry {
  return {
    id: 'led-1',
    idempotencyKey: 'idem-1',
    tenantId: 'wain',
    accountId: 'acc-wain',
    type: 'debit',
    source: 'runtime',
    relatedUsageEventIds: ['ue-1'],
    sessionId: 'sess-1',
    runId: 'run-1',
    creditsDeltaMicro: -12_000_000,
    balanceBeforeMicro: 500_000_000,
    balanceAfterMicro: 488_000_000,
    creditValueYuanMicro: 10_000,
    revenueYuanMicro: 120_000,
    actualCostYuanMicro: 48_000,
    grossProfitYuanMicro: 72_000,
    grossMarginBps: 6000,
    pricingVersion: 'v1',
    billingPolicyVersion: 'p1',
    createdAt: '2026-07-13T10:00:00.000Z',
  };
}

function sampleAudit(): BillingAuditSummary {
  return {
    tenantId: 'wain',
    days: 7,
    actualCostYuanMicro: 480_000,
    revenueYuanMicro: 1_200_000,
    creditsChargedMicro: 120_000_000,
    grossProfitYuanMicro: 720_000,
    grossMarginBps: 6000,
    unpricedUsageEvents: 0,
    lowBalanceTenants: [],
    alerts: ['wain 毛利异常样例告警'],
    daily: [
      {
        date: '2026-07-13',
        actualCostYuanMicro: 48_000,
        revenueYuanMicro: 120_000,
        creditsChargedMicro: 12_000_000,
        grossProfitYuanMicro: 72_000,
      },
    ],
  };
}

interface Rig {
  request(path: string): Promise<Response>;
  setCaller(caller: JwtPayload): void;
  close(): Promise<void>;
  lastAuditQuery: () => { tenantId?: string; days?: number; includeDaily?: boolean } | null;
}

async function makeRig(policy: { showCost?: boolean; showGrossMargin?: boolean } | 'throws'): Promise<Rig> {
  let auditQuery: { tenantId?: string; days?: number; includeDaily?: boolean } | null = null;
  const fakeService = {
    store: {
      getTenantPolicy: async () => {
        if (policy === 'throws') throw new Error('policy backend down');
        return { showCost: policy.showCost === true, showGrossMargin: policy.showGrossMargin === true };
      },
    },
    listLedgerForTenant: async () => ({ entries: [sampleLedgerEntry()], nextCursor: undefined }),
    getAuditSummary: async (query: { tenantId?: string; days?: number; includeDaily?: boolean }) => {
      auditQuery = query;
      return sampleAudit();
    },
  } as unknown as BillingService;

  const app = express();
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/admin/billing', createAdminBillingRouter({ billingService: fakeService }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    request: (path) => fetch(`${baseUrl}${path}`),
    setCaller: (caller) => { currentCaller = caller; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    lastAuditQuery: () => auditQuery,
  };
}

describe('Admin Billing 路由组织 admin 脱敏', () => {
  const rigs: Rig[] = [];

  afterEach(async () => {
    while (rigs.length > 0) await rigs.pop()!.close();
  });

  async function rigWith(policy: Parameters<typeof makeRig>[0]): Promise<Rig> {
    const rig = await makeRig(policy);
    rigs.push(rig);
    return rig;
  }

  describe('GET /ledger', () => {
    it('组织 admin + showCost=false → 剥离成本/毛利并标记 costRedacted', async () => {
      const rig = await rigWith({ showCost: false, showGrossMargin: true });
      rig.setCaller(WAIN_ADMIN);
      const body = await (await rig.request('/api/admin/billing/ledger')).json();
      expect(body.costRedacted).toBe(true);
      const entry = body.entries[0];
      expect(entry.actualCostYuanMicro).toBeUndefined();
      // 毛利以 showCost 为前提：showGrossMargin=true 但 showCost=false 仍隐藏
      expect(entry.grossProfitYuanMicro).toBeUndefined();
      expect(entry.grossMarginBps).toBeUndefined();
      // 客户口径字段保留
      expect(entry.creditsDeltaMicro).toBe(-12_000_000);
      expect(entry.revenueYuanMicro).toBe(120_000);
    });

    it('组织 admin + showCost=true 且 showGrossMargin=false → 成本可见、毛利隐藏', async () => {
      const rig = await rigWith({ showCost: true, showGrossMargin: false });
      rig.setCaller(WAIN_ADMIN);
      const body = await (await rig.request('/api/admin/billing/ledger')).json();
      expect(body.costRedacted).toBeUndefined();
      const entry = body.entries[0];
      expect(entry.actualCostYuanMicro).toBe(48_000);
      expect(entry.grossProfitYuanMicro).toBeUndefined();
      expect(entry.grossMarginBps).toBeUndefined();
    });

    it('组织 admin + policy 查询抛错 → fail-closed 全部剥离', async () => {
      const rig = await rigWith('throws');
      rig.setCaller(WAIN_ADMIN);
      const body = await (await rig.request('/api/admin/billing/ledger')).json();
      expect(body.costRedacted).toBe(true);
      expect(body.entries[0].actualCostYuanMicro).toBeUndefined();
    });

    it('平台 admin → 原样返回', async () => {
      const rig = await rigWith({ showCost: false });
      rig.setCaller(PLATFORM_ADMIN);
      const body = await (await rig.request('/api/admin/billing/ledger')).json();
      expect(body.costRedacted).toBeUndefined();
      const entry = body.entries[0];
      expect(entry.actualCostYuanMicro).toBe(48_000);
      expect(entry.grossProfitYuanMicro).toBe(72_000);
      expect(entry.grossMarginBps).toBe(6000);
    });
  });

  describe('GET /audit', () => {
    it('组织 admin：daily 开放但成本/毛利剥离，alerts 清空', async () => {
      const rig = await rigWith({ showCost: false });
      rig.setCaller(WAIN_ADMIN);
      const body = await (await rig.request('/api/admin/billing/audit?days=7')).json();
      const audit = body.audit;
      expect(audit.costRedacted).toBe(true);
      expect(audit.actualCostYuanMicro).toBeUndefined();
      expect(audit.grossProfitYuanMicro).toBeUndefined();
      expect(audit.grossMarginBps).toBeUndefined();
      expect(audit.alerts).toEqual([]);
      // 客户口径保留：积分消耗 + 收入
      expect(audit.creditsChargedMicro).toBe(120_000_000);
      expect(audit.revenueYuanMicro).toBe(1_200_000);
      // daily 对组织 admin 开放（积分趋势数据源），逐行剥离
      expect(audit.daily).toHaveLength(1);
      expect(audit.daily[0].creditsChargedMicro).toBe(12_000_000);
      expect(audit.daily[0].actualCostYuanMicro).toBeUndefined();
      expect(audit.daily[0].grossProfitYuanMicro).toBeUndefined();
      // includeDaily 确实传给了 service
      expect(rig.lastAuditQuery()?.includeDaily).toBe(true);
    });

    it('组织 admin + showCost/showGrossMargin 全开 → 全量可见', async () => {
      const rig = await rigWith({ showCost: true, showGrossMargin: true });
      rig.setCaller(WAIN_ADMIN);
      const body = await (await rig.request('/api/admin/billing/audit?days=7')).json();
      const audit = body.audit;
      expect(audit.costRedacted).toBeUndefined();
      expect(audit.actualCostYuanMicro).toBe(480_000);
      expect(audit.grossMarginBps).toBe(6000);
      expect(audit.daily[0].actualCostYuanMicro).toBe(48_000);
      // alerts 仍为平台口径，组织 admin 一律不下发
      expect(audit.alerts).toEqual([]);
    });

    it('平台 admin → 原样返回（含 alerts）', async () => {
      const rig = await rigWith({ showCost: false });
      rig.setCaller(PLATFORM_ADMIN);
      const body = await (await rig.request('/api/admin/billing/audit?days=7')).json();
      expect(body.audit.actualCostYuanMicro).toBe(480_000);
      expect(body.audit.alerts).toHaveLength(1);
      expect(body.audit.daily).toHaveLength(1);
    });
  });
});
