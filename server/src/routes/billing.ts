import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isPlatformAdmin } from '../auth/types.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import type { BillingService } from '../data/billing/service.js';
import {
  CREDIT_MICRO,
  type BillingAuditSummary,
  type BillingLedgerEntry,
  type LedgerType,
} from '../data/billing/types.js';
import { BillingPricingConflictError } from '../data/billing/pgBillingStore.js';

function decodeCursor(value?: string): { createdAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return undefined;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

function encodeCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export interface BillingRouterOptions {
  billingService: BillingService;
}

const tenantIdSchema = z.string().min(2).max(31).regex(/^[a-z][a-z0-9-]{1,30}$/);

function resolveTenantAccess(req: Request, requestedTenantId?: string):
  | { ok: true; tenantId: string; platform: boolean }
  | { ok: false; status: 401 | 403; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'Authentication required' };
  if (isPlatformAdmin(req.user)) {
    const tenantId = requestedTenantId || req.user.tenantId;
    return { ok: true, tenantId, platform: true };
  }
  if (requestedTenantId && requestedTenantId !== req.user.tenantId) {
    return { ok: false, status: 403, error: '跨组织访问被拒绝' };
  }
  return { ok: true, tenantId: req.user.tenantId, platform: false };
}

export function createAdminBillingRouter(options: BillingRouterOptions): Router {
  const router = Router();
  const { billingService } = options;

  router.get('/pricing-versions', requirePlatformAdmin, async (_req, res) => {
    await billingService.ensureProjected();
    res.json({ pricingVersions: await billingService.store.listPricingVersions() });
  });

  router.post('/pricing-versions', requirePlatformAdmin, async (req: Request, res: Response) => {
    const body = pricingVersionCreateSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const actor = req.user?.username ?? req.user?.sub ?? 'admin';
    try {
      const pricingVersion = await billingService.createPricingVersion(body.data, actor);
      res.json({ pricingVersion });
    } catch (err) {
      if (err instanceof BillingPricingConflictError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  });

  router.patch('/pricing-versions/:version', requirePlatformAdmin, async (req: Request, res: Response) => {
    const versionId = String(req.params.version || '').trim();
    if (!/^[a-z0-9][a-z0-9.\-]{1,99}$/.test(versionId)) {
      return res.status(400).json({ error: 'Invalid version id' });
    }
    const body = pricingVersionPatchSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const actor = req.user?.username ?? req.user?.sub ?? 'admin';
    try {
      const pricingVersion = await billingService.updatePricingVersion(versionId, body.data, actor);
      res.json({ pricingVersion });
    } catch (err) {
      if (err instanceof BillingPricingConflictError) {
        return res.status(409).json({ error: err.message });
      }
      if (err instanceof Error && err.message.includes('active 版本不能直接退役')) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });

  router.post('/project-now', requirePlatformAdmin, async (_req, res) => {
    const result = await billingService.projectRuntimeEvents(2000);
    res.json(result);
  });

  router.get('/tenants/:tenantId/policy', async (req, res) => {
    const parsed = tenantIdSchema.safeParse(req.params.tenantId);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid tenantId' });
    const access = resolveTenantAccess(req, parsed.data);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const policy = await billingService.store.getTenantPolicy(access.tenantId);
    res.json({ policy: access.platform ? policy : redactPolicy(policy) });
  });

  router.patch('/tenants/:tenantId/policy', requirePlatformAdmin, async (req: Request, res: Response) => {
    const parsed = tenantIdSchema.safeParse(req.params.tenantId);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid tenantId' });
    const body = policyPatchSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const actor = req.user?.username ?? req.user?.sub ?? 'admin';
    const policy = await billingService.updateTenantPolicy(parsed.data, body.data, actor);
    res.json({ policy });
  });

  router.get('/accounts', async (req, res) => {
    const parsedTenant = typeof req.query.tenantId === 'string' ? tenantIdSchema.safeParse(req.query.tenantId) : undefined;
    if (parsedTenant && !parsedTenant.success) return res.status(400).json({ error: 'Invalid tenantId' });
    const access = resolveTenantAccess(req, parsedTenant?.data);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const summary = await billingService.getSummaryForTenant(access.tenantId, { includeInternalMetrics: access.platform });
    res.json({ summary });
  });

  router.post('/accounts/:tenantId/adjust', requirePlatformAdmin, async (req, res) => {
    const parsed = tenantIdSchema.safeParse(req.params.tenantId);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid tenantId' });
    const body = accountAdjustSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const entry = await billingService.adjustAccount({
      tenantId: parsed.data,
      creditsDelta: body.data.creditsDelta,
      type: body.data.type,
      note: body.data.note,
      actor: req.user?.username ?? req.user?.sub ?? 'admin',
    });
    res.json({ entry });
  });

  router.get('/ledger', async (req, res) => {
    const query = ledgerQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid query', issues: query.error.issues });
    const access = resolveTenantAccess(req, query.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const { cursor: rawCursor, ...rest } = query.data;
    const cursor = decodeCursor(rawCursor);
    const { entries, nextCursor } = await billingService.listLedgerForTenant(access.tenantId, {
      ...rest,
      ...(cursor ? { cursor } : {}),
    });
    // 组织 admin：实际成本/毛利是平台内部口径，按 showCost/showGrossMargin fail-closed 剥离（2026-07-14）
    if (!access.platform) {
      const visibility = await resolveCostVisibility(billingService, access.tenantId);
      res.json({
        entries: entries.map((entry) => redactLedgerEntry(entry, visibility)),
        ...(visibility.showCost ? {} : { costRedacted: true }),
        ...(nextCursor ? { nextCursor: encodeCursor(nextCursor) } : {}),
      });
      return;
    }
    res.json({
      entries,
      ...(nextCursor ? { nextCursor: encodeCursor(nextCursor) } : {}),
    });
  });

  router.get('/usage-events', requirePlatformAdmin, async (req, res) => {
    const query = usageQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid query', issues: query.error.issues });
    await billingService.ensureProjected();
    const events = await billingService.store.listUsageEvents(query.data);
    res.json({ events });
  });

  router.get('/audit', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const query = auditQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid query', issues: query.error.issues });
    const platform = isPlatformAdmin(req.user);
    // 平台管理员未传 tenantId → 跨租户聚合；普通用户必须 fallback 到自己的 tenant
    let tenantId: string | undefined;
    if (platform) {
      tenantId = query.data.tenantId;
    } else {
      if (query.data.tenantId && query.data.tenantId !== req.user.tenantId) {
        return res.status(403).json({ error: '跨组织访问被拒绝' });
      }
      tenantId = req.user.tenantId;
    }
    // 2026-07-14：日分桶对组织 admin 也开放（用于租户分析页的积分日消耗趋势），
    // 但实际成本/毛利字段按 showCost/showGrossMargin fail-closed 剥离。
    const audit = await billingService.getAuditSummary({
      tenantId,
      days: query.data.days,
      includeDaily: true,
    });
    if (!platform) {
      const visibility = await resolveCostVisibility(billingService, req.user.tenantId);
      res.json({ audit: redactAuditSummary(audit, visibility) });
      return;
    }
    res.json({ audit });
  });

  router.get('/sessions/:sessionId/summary', requirePlatformAdmin, async (req: Request, res: Response) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
    const parsed = tenantIdSchema.safeParse(tenantId);
    if (!parsed.success) return res.status(400).json({ error: 'tenantId 查询参数必填' });
    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'sessionId 必填' });
    const summary = await billingService.getSessionSummary(parsed.data, sessionId);
    const { entries: ledger } = await billingService.listLedgerForTenant(parsed.data, { sessionId, limit: 200 });
    res.json({ summary, ledger });
  });

  router.get('/runs/:runId/summary', requirePlatformAdmin, async (req: Request, res: Response) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
    const parsed = tenantIdSchema.safeParse(tenantId);
    if (!parsed.success) return res.status(400).json({ error: 'tenantId 查询参数必填' });
    const runId = String(req.params.runId || '').trim();
    if (!runId) return res.status(400).json({ error: 'runId 必填' });
    const { entries: ledger } = await billingService.listLedgerForTenant(parsed.data, { runId, limit: 100 });
    const usageEvents = await billingService.store.listUsageEvents({ tenantId: parsed.data, runId, limit: 1000 });
    res.json({ ledger, usageEvents });
  });

  return router;
}

export function createBillingRouter(options: BillingRouterOptions): Router {
  const router = Router();
  const { billingService } = options;

  router.get('/me/summary', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const summary = await billingService.getSummaryForTenant(req.user.tenantId);
    res.json({ summary });
  });

  router.get('/sessions/:sessionId/summary', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const summary = await billingService.getSessionSummary(req.user.tenantId, req.params.sessionId);
    res.json({ summary });
  });

  router.get('/sessions/:sessionId/ledger', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const { entries } = await billingService.listLedgerForTenant(req.user.tenantId, {
      sessionId: req.params.sessionId,
      limit: 50,
    });
    res.json({ entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      creditsDelta: entry.creditsDeltaMicro / CREDIT_MICRO,
      createdAt: entry.createdAt,
      note: entry.note,
    })) });
  });

  return router;
}

const policyPatchSchema = z.object({
  billingEnabled: z.boolean().optional(),
  billingMode: z.enum(['prepaid', 'postpaid', 'trial', 'internal']).optional(),
  pricingVersion: z.string().min(1).optional(),
  defaultTargetMarginBps: z.number().int().min(0).max(9500).optional(),
  organizationMultiplierBps: z.number().int().min(1).max(100000).optional(),
  allowNegativeBalance: z.boolean().optional(),
  negativeLimitCreditsMicro: z.number().int().min(0).optional(),
  lowBalanceThresholdCreditsMicro: z.number().int().min(0).optional(),
  // 2026-06-28：摘除 reserve_then_run，仅保留 none / stop_before_run
  hardCapMode: z.enum(['none', 'stop_before_run']).optional(),
  showBalance: z.boolean().optional(),
  showUsageCredits: z.boolean().optional(),
  showCost: z.boolean().optional(),
  showGrossMargin: z.boolean().optional(),
});

const pricingVersionCreateSchema = z.object({
  version: z.string().min(3).max(100).regex(/^[a-z0-9][a-z0-9.\-]*$/),
  name: z.string().min(1).max(200),
  status: z.enum(['draft', 'active']).optional(),
  effectiveFrom: z.string().datetime().optional(),
  creditValueYuanMicro: z.number().int().min(1).max(1_000_000_000),
  defaultTargetMarginBps: z.number().int().min(0).max(9500),
  fxRateToCny: z.number().positive().max(50).optional(),
});

const pricingVersionPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['draft', 'active', 'retired']).optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().nullable().optional(),
  creditValueYuanMicro: z.number().int().min(1).max(1_000_000_000).optional(),
  defaultTargetMarginBps: z.number().int().min(0).max(9500).optional(),
  fxRateToCny: z.number().positive().max(50).optional(),
});

const accountAdjustSchema = z.object({
  creditsDelta: z.number().finite(),
  type: z.enum(['recharge', 'grant', 'refund', 'adjustment', 'expire', 'reversal']).optional(),
  note: z.string().max(500).optional(),
});

const ledgerTypeEnum = z.enum([
  'recharge', 'grant', 'debit', 'refund', 'adjustment', 'expire', 'reversal', 'reserve', 'release',
]);

const ledgerQuerySchema = z.object({
  tenantId: tenantIdSchema.optional(),
  sessionId: z.string().min(1).max(100).optional(),
  runId: z.string().min(1).max(160).optional(),
  type: ledgerTypeEnum.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const usageQuerySchema = z.object({
  tenantId: tenantIdSchema.optional(),
  sessionId: z.string().min(1).max(100).optional(),
  runId: z.string().min(1).max(160).optional(),
  billable: z.preprocess((value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean()).optional(),
  unpricedOnly: z.preprocess((value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }, z.boolean()).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const auditQuerySchema = z.object({
  tenantId: tenantIdSchema.optional(),
  days: z.coerce.number().int().min(1).max(90).optional(),
});

function redactPolicy<T extends { showCost: boolean; showGrossMargin: boolean; defaultTargetMarginBps: number; organizationMultiplierBps: number }>(policy: T) {
  return {
    ...policy,
    defaultTargetMarginBps: 0,
    organizationMultiplierBps: 0,
    showCost: false,
    showGrossMargin: false,
  };
}

// ────────── 组织 admin 成本可见性（2026-07-14）──────────
// 实际成本（actualCost*）与毛利（grossProfit*/grossMargin*）是平台内部经营口径。
// 组织 admin 默认不可见；showCost=true 放行实际成本，
// 毛利需 showCost && showGrossMargin 同时为 true（毛利+收入可反推成本，故毛利以 showCost 为前提）。
// policy 查询异常时 fail-closed 全部隐藏。

interface CostVisibility {
  showCost: boolean;
  showGrossMargin: boolean;
}

async function resolveCostVisibility(billingService: BillingService, tenantId: string): Promise<CostVisibility> {
  try {
    const policy = await billingService.store.getTenantPolicy(tenantId);
    const showCost = policy?.showCost === true;
    return { showCost, showGrossMargin: showCost && policy?.showGrossMargin === true };
  } catch {
    return { showCost: false, showGrossMargin: false };
  }
}

function redactLedgerEntry(entry: BillingLedgerEntry, visibility: CostVisibility): Record<string, unknown> {
  const { actualCostYuanMicro, grossProfitYuanMicro, grossMarginBps, ...rest } = entry;
  return {
    ...rest,
    ...(visibility.showCost ? { actualCostYuanMicro } : {}),
    ...(visibility.showGrossMargin ? { grossProfitYuanMicro, grossMarginBps } : {}),
  };
}

function redactAuditSummary(audit: BillingAuditSummary, visibility: CostVisibility): Record<string, unknown> {
  const { actualCostYuanMicro, grossProfitYuanMicro, grossMarginBps, alerts: _alerts, daily, ...rest } = audit;
  return {
    ...rest,
    ...(visibility.showCost ? { actualCostYuanMicro } : {}),
    ...(visibility.showGrossMargin ? { grossProfitYuanMicro, grossMarginBps } : {}),
    // alerts 是平台运营告警口径（毛利异常等），不下发组织 admin
    alerts: [],
    ...(daily
      ? {
          daily: daily.map((point) => {
            const { actualCostYuanMicro: dayCost, grossProfitYuanMicro: dayProfit, ...dayRest } = point;
            return {
              ...dayRest,
              ...(visibility.showCost ? { actualCostYuanMicro: dayCost } : {}),
              ...(visibility.showGrossMargin ? { grossProfitYuanMicro: dayProfit } : {}),
            };
          }),
        }
      : {}),
    ...(visibility.showCost ? {} : { costRedacted: true }),
  };
}
