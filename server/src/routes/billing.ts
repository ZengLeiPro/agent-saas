import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isPlatformAdmin } from '../auth/types.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import { hasPlatformCapability, isSuperAdmin } from '../auth/platformGovernance.js';
import { auditLog } from '../data/login-logs/index.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';
import type { BillingService } from '../data/billing/service.js';
import {
  CREDIT_MICRO,
  type BillingAuditSummary,
  type BillingLedgerEntry,
  type BillingMemberBudgetUsage,
  type LedgerType,
} from '../data/billing/types.js';
import {
  BillingBudgetIdempotencyConflictError,
  BillingBudgetVersionConflictError,
  BillingLedgerReversalConflictError,
  BillingPricingConflictError,
} from '../data/billing/pgBillingStore.js';

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
  alertNotifier?: Pick<AlertNotifier, 'notifyExternal'>;
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
  const { billingService, alertNotifier } = options;

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
    res.json({
      policy: access.platform && hasPlatformCapability(req.user, 'finance.read')
        ? policy
        : redactPolicy(policy),
    });
  });

  router.patch('/tenants/:tenantId/policy', requirePlatformAdmin, async (req: Request, res: Response) => {
    const parsed = tenantIdSchema.safeParse(req.params.tenantId);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid tenantId' });
    const body = policyPatchSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const current = await billingService.store.getTenantPolicy(parsed.data);
    const nextHardCapMode = body.data.hardCapMode ?? current.hardCapMode;
    const nextMaxRunCreditsMicro = body.data.maxRunCreditsMicro === undefined
      ? current.maxRunCreditsMicro
      : body.data.maxRunCreditsMicro ?? undefined;
    if (nextHardCapMode === 'stop_before_run'
      && (nextMaxRunCreditsMicro === undefined || nextMaxRunCreditsMicro <= 0)) {
      return res.status(400).json({ error: '启用积分硬封顶时必须配置正数的组织单 Run 上限' });
    }
    const actor = req.user?.username ?? req.user?.sub ?? 'admin';
    const policy = await billingService.updateTenantPolicy(parsed.data, body.data, actor);
    res.json({ policy });
  });

  router.get('/accounts', async (req, res) => {
    const parsedTenant = typeof req.query.tenantId === 'string' ? tenantIdSchema.safeParse(req.query.tenantId) : undefined;
    if (parsedTenant && !parsedTenant.success) return res.status(400).json({ error: 'Invalid tenantId' });
    const access = resolveTenantAccess(req, parsedTenant?.data);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const summary = await billingService.getSummaryForTenant(access.tenantId, {
      includeInternalMetrics: access.platform && hasPlatformCapability(req.user, 'finance.read'),
    });
    res.json({ summary });
  });

  router.post('/accounts/:tenantId/adjust', requirePlatformAdmin, async (req, res) => {
    const parsed = tenantIdSchema.safeParse(req.params.tenantId);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid tenantId' });
    const body = accountAdjustSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const delegated = !isSuperAdmin(req.user);
    if (delegated) {
      if (parsed.data === DEFAULT_TENANT_ID) {
        return res.status(403).json({ error: '万神殿账户流水仅 @admin 可操作' });
      }
      if (body.data.creditsDelta <= 0) {
        return res.status(400).json({ error: '委托管理员只能增加积分；扣减与冲正请由 @admin 执行' });
      }
      if (!['recharge', 'grant', 'refund'].includes(body.data.type ?? '')) {
        return res.status(400).json({ error: '委托管理员仅可写入充值、赠送或退款流水' });
      }
      if (!body.data.note || !body.data.businessReference || !body.data.idempotencyKey) {
        return res.status(400).json({ error: '委托管理员写入流水必须填写备注、业务依据和防重标识' });
      }
      const perTransaction = req.user?.platformCapabilityLimits?.billingMaxCreditsPerTransaction;
      const perDay = req.user?.platformCapabilityLimits?.billingMaxCreditsPerDay;
      if (!perTransaction || !perDay) {
        return res.status(403).json({ error: '当前账号未配置积分流水额度，请联系 @admin' });
      }
      if (body.data.creditsDelta > perTransaction) {
        return res.status(403).json({ error: '单笔积分超过授权上限 ' + perTransaction });
      }
    }
    const combinedNote = body.data.businessReference
      ? '[依据:' + body.data.businessReference + '] ' + (body.data.note ?? '')
      : body.data.note;
    const idempotencyKey = body.data.idempotencyKey
      ? ['manual', parsed.data, 'admin', req.user!.sub, body.data.idempotencyKey].join(':')
      : undefined;
    if (delegated && idempotencyKey) {
      const existing = await billingService.store.findLedgerByIdempotencyKey(idempotencyKey);
      if (existing) {
        const requestedType = body.data.type ?? 'adjustment';
        if (
          existing.tenantId !== parsed.data
          || existing.type !== requestedType
          || existing.creditsDeltaMicro !== Math.round(body.data.creditsDelta * CREDIT_MICRO)
          || existing.createdBy !== req.user!.username
          || (existing.note ?? undefined) !== (combinedNote ?? undefined)
        ) {
          return res.status(409).json({ error: '幂等键已被不同调账参数使用' });
        }
        return res.json({ entry: existing, idempotentReplay: true });
      }
      const dayLimit = req.user!.platformCapabilityLimits!.billingMaxCreditsPerDay!;
      const usedToday = await billingService.store.sumManualPositiveCreditsByActorSince(
        req.user!.username,
        beijingDayStartIso(),
      );
      if (usedToday + body.data.creditsDelta > dayLimit) {
        return res.status(403).json({
          error: '今日累计积分将超过授权上限 ' + dayLimit,
          usedToday,
        });
      }
    }
    let entry: BillingLedgerEntry;
    try {
      entry = await billingService.adjustAccount({
        tenantId: parsed.data,
        creditsDelta: body.data.creditsDelta,
        type: body.data.type,
        note: combinedNote,
        actor: req.user?.username ?? req.user?.sub ?? 'admin',
        idempotencyKey,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'BILLING_IDEMPOTENCY_CONFLICT') {
        return res.status(409).json({ error: err instanceof Error ? err.message : '幂等键冲突' });
      }
      throw err;
    }
    auditLog(req, 'billing_account_adjusted', JSON.stringify({
      tenantId: parsed.data,
      creditsDelta: body.data.creditsDelta,
      type: body.data.type,
      businessReference: body.data.businessReference,
      ledgerId: entry.id,
    }));
    if (delegated) {
      void alertNotifier?.notifyExternal('delegated_billing', [{
        kind: 'delegated_billing_adjustment',
        severity: 'high',
        title: req.user!.username + ' 为 ' + parsed.data + ' 增加 '
          + body.data.creditsDelta + ' 积分（' + body.data.businessReference + '）',
        occurredAt: entry.createdAt,
        entityRef: { kind: 'tenant', id: parsed.data },
        actions: ['核对业务依据与积分流水'],
        dedupeKey: entry.id,
      }]).catch(() => undefined);
    }
    res.json({ entry });
  });

  router.post('/ledger/:ledgerId/reverse', requirePlatformAdmin, async (req: Request, res: Response) => {
    if (!req.user || !hasPlatformCapability(req.user, 'billing.adjust')) {
      return res.status(403).json({ error: '缺少平台计费管理权限' });
    }
    const body = ledgerReversalSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const ledgerId = String(req.params.ledgerId || '').trim();
    if (!ledgerId) return res.status(400).json({ error: 'ledgerId 必填' });
    try {
      const entry = await billingService.reverseDebit({
        tenantId: body.data.tenantId,
        ledgerId,
        idempotencyKey: `reversal:admin:${req.user.sub}:${body.data.idempotencyKey}`,
        note: body.data.note,
        actor: req.user.username,
      });
      auditLog(req, 'billing_debit_reversed', JSON.stringify({
        tenantId: body.data.tenantId,
        originalLedgerId: ledgerId,
        reversalLedgerId: entry.id,
      }));
      res.json({ entry });
    } catch (err) {
      if (err instanceof BillingLedgerReversalConflictError) {
        return res.status(409).json({ code: 'LEDGER_REVERSAL_CONFLICT', error: err.message });
      }
      throw err;
    }
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
    if (!access.platform || !hasPlatformCapability(req.user, 'finance.read')) {
      const visibility = access.platform
        ? { showCost: false, showGrossMargin: false }
        : await resolveCostVisibility(billingService, access.tenantId);
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

  router.get('/member-budgets', async (req: Request, res: Response) => {
    const tenantIdQuery = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const parsedTenantId = tenantIdQuery ? tenantIdSchema.safeParse(tenantIdQuery) : undefined;
    if (parsedTenantId && !parsedTenantId.success) return res.status(400).json({ error: 'tenantId 不合法' });
    const access = resolveTenantAccess(req, parsedTenantId?.data);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!access.platform && req.user?.role !== 'admin') {
      return res.status(403).json({ error: '仅组织管理员可查看员工预算列表' });
    }
    if (access.platform && (!req.user || !hasPlatformCapability(req.user, 'finance.read'))) {
      return res.status(403).json({ error: '缺少平台财务读取权限' });
    }
    const userStore = billingService.userStore;
    if (!userStore) return res.status(503).json({ error: '用户目录暂不可用' });
    await billingService.ensureProjected();
    const [overview, summary] = await Promise.all([
      billingService.store.getMemberBudgetOverview(access.tenantId),
      billingService.getSummaryForTenant(access.tenantId),
    ]);
    const usageByUser = new Map(overview.items.map((item) => [item.userId, item]));
    const platformCanManage = access.platform && !!req.user && hasPlatformCapability(req.user, 'billing.adjust');
    const members = userStore.listAll()
      .filter((user) => user.tenantId === access.tenantId)
      .sort((a, b) => (a.realName || a.username).localeCompare(b.realName || b.username, 'zh-CN'))
      .map((user) => {
        const budget = formatMemberBudget(usageByUser.get(user.id) ?? {
          userId: user.id,
          enforcementMode: 'notify' as const,
          active: true,
          version: 0,
          monthUsedCreditsMicro: 0,
          monthReservedCreditsMicro: 0,
          canStartRun: true,
        });
        const canManage = access.platform
          ? platformCanManage
          : user.role !== 'admin' || user.id === req.user?.sub;
        return {
          ...budget,
          username: user.username,
          realName: user.realName,
          role: user.role,
          disabled: user.disabled,
          canManage,
        };
      });
    res.json({
      period: {
        start: overview.periodStart,
        end: overview.periodEnd,
        timezone: overview.timezone,
      },
      summary: {
        tenantBalanceCredits: summary.balanceCredits,
        monthUsedCredits: overview.monthUsedCreditsMicro / CREDIT_MICRO,
        monthReservedCredits: overview.monthReservedCreditsMicro / CREDIT_MICRO,
        budgetedUsers: members.filter((item) => item.monthlyLimitCredits !== null).length,
        enforcedUsers: members.filter((item) => item.enforcementMode === 'stop_new_runs').length,
        blockedUsers: members.filter((item) => !item.canStartRun).length,
        nearLimitUsers: members.filter((item) => item.status === 'warning').length,
        overLimitUsers: members.filter((item) => item.status === 'over').length,
        unattributedCredits: overview.unattributedCreditsMicro / CREDIT_MICRO,
      },
      items: members,
    });
  });

  router.put('/member-budgets/:userId', async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const tenantIdQuery = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const parsedTenantId = tenantIdQuery ? tenantIdSchema.safeParse(tenantIdQuery) : undefined;
    if (parsedTenantId && !parsedTenantId.success) return res.status(400).json({ error: 'tenantId 不合法' });
    const access = resolveTenantAccess(req, parsedTenantId?.data);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!access.platform && req.user.role !== 'admin') {
      return res.status(403).json({ error: '仅组织管理员可设置员工预算' });
    }
    if (access.platform && !hasPlatformCapability(req.user, 'billing.adjust')) {
      return res.status(403).json({ error: '缺少平台计费管理权限' });
    }
    const body = memberBudgetUpdateSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'Invalid body', issues: body.error.issues });
    const userStore = billingService.userStore;
    if (!userStore) return res.status(503).json({ error: '用户目录暂不可用' });
    const targetUser = userStore.findById(String(req.params.userId || ''));
    if (!targetUser || targetUser.tenantId !== access.tenantId) {
      return res.status(404).json({ error: '目标员工不存在' });
    }
    if (!access.platform && targetUser.role === 'admin' && targetUser.id !== req.user.sub) {
      return res.status(403).json({ error: '组织管理员不能修改其他管理员的预算' });
    }
    const monthlyLimitCreditsMicro = body.data.monthlyLimitCredits === null
      ? undefined
      : Math.round(body.data.monthlyLimitCredits * CREDIT_MICRO);
    if (monthlyLimitCreditsMicro !== undefined && !Number.isSafeInteger(monthlyLimitCreditsMicro)) {
      return res.status(400).json({ error: '预算金额超出安全范围' });
    }
    const perRunLimitCreditsMicro = body.data.perRunLimitCredits === undefined
      ? undefined
      : body.data.perRunLimitCredits === null
        ? null
        : Math.round(body.data.perRunLimitCredits * CREDIT_MICRO);
    if (perRunLimitCreditsMicro !== undefined && perRunLimitCreditsMicro !== null
      && !Number.isSafeInteger(perRunLimitCreditsMicro)) {
      return res.status(400).json({ error: '单 Run 上限超出安全范围' });
    }
    try {
      const result = await billingService.store.upsertMemberBudget({
        tenantId: access.tenantId,
        userId: targetUser.id,
        ...(monthlyLimitCreditsMicro === undefined ? {} : { monthlyLimitCreditsMicro }),
        ...(body.data.enforcementMode ? { enforcementMode: body.data.enforcementMode } : {}),
        ...(perRunLimitCreditsMicro === undefined ? {} : { perRunLimitCreditsMicro }),
        expectedVersion: body.data.expectedVersion,
        idempotencyKey: body.data.idempotencyKey,
        note: body.data.note,
        actorUserId: req.user.sub,
        actorUsername: req.user.username,
      });
      auditLog(req, 'billing_member_budget_updated', JSON.stringify({
        tenantId: access.tenantId,
        userId: targetUser.id,
        monthlyLimitCredits: body.data.monthlyLimitCredits,
        enforcementMode: body.data.enforcementMode,
        perRunLimitCredits: body.data.perRunLimitCredits,
        auditId: result.audit.id,
        replayed: result.replayed,
      }));
      res.json({
        budget: formatMemberBudget(result.budget),
        audit: { id: result.audit.id, createdAt: result.audit.createdAt },
        replayed: result.replayed,
      });
    } catch (err) {
      if (err instanceof BillingBudgetVersionConflictError) {
        return res.status(409).json({ code: 'BUDGET_VERSION_CONFLICT', error: err.message });
      }
      if (err instanceof BillingBudgetIdempotencyConflictError) {
        return res.status(409).json({ code: 'IDEMPOTENCY_KEY_REUSED', error: err.message });
      }
      throw err;
    }
  });

  router.get('/member-budget-audit', async (req: Request, res: Response) => {
    const query = memberBudgetAuditQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'Invalid query', issues: query.error.issues });
    const access = resolveTenantAccess(req, query.data.tenantId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    if (!access.platform && req.user?.role !== 'admin') {
      return res.status(403).json({ error: '仅组织管理员可查看预算审计' });
    }
    if (access.platform && (!req.user || !hasPlatformCapability(req.user, 'finance.read'))) {
      return res.status(403).json({ error: '缺少平台财务读取权限' });
    }
    const entries = await billingService.store.listMemberBudgetAudit(
      access.tenantId,
      query.data.userId,
      query.data.limit ?? 100,
    );
    res.json({
      entries: entries.map(({
        beforeLimitCreditsMicro,
        afterLimitCreditsMicro,
        beforePerRunLimitCreditsMicro,
        afterPerRunLimitCreditsMicro,
        ...entry
      }) => ({
        ...entry,
        beforeLimitCredits: beforeLimitCreditsMicro === undefined ? null : beforeLimitCreditsMicro / CREDIT_MICRO,
        afterLimitCredits: afterLimitCreditsMicro === undefined ? null : afterLimitCreditsMicro / CREDIT_MICRO,
        beforePerRunLimitCredits: beforePerRunLimitCreditsMicro === undefined ? null : beforePerRunLimitCreditsMicro / CREDIT_MICRO,
        afterPerRunLimitCredits: afterPerRunLimitCreditsMicro === undefined ? null : afterPerRunLimitCreditsMicro / CREDIT_MICRO,
      })),
    });
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

  router.get('/me/budget', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    await billingService.ensureProjected();
    const overview = await billingService.store.getMemberBudgetOverview(req.user.tenantId, req.user.sub);
    const budget = overview.items[0] ?? {
      userId: req.user.sub,
      enforcementMode: 'notify' as const,
      active: true,
      version: 0,
      monthUsedCreditsMicro: 0,
      monthReservedCreditsMicro: 0,
      canStartRun: true,
    };
    const { updatedBy: _updatedBy, ...memberBudget } = formatMemberBudget(budget);
    res.json({
      period: {
        start: overview.periodStart,
        end: overview.periodEnd,
        timezone: overview.timezone,
      },
      budget: memberBudget,
    });
  });

  router.get('/sessions/:sessionId/summary', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'admin'
      && !await billingService.store.isSessionOwnedByUser(req.user.tenantId, req.params.sessionId, req.user.sub)) {
      return res.status(404).json({ error: '会话不存在' });
    }
    const summary = await billingService.getSessionSummary(req.user.tenantId, req.params.sessionId);
    res.json({ summary });
  });

  router.get('/sessions/:sessionId/ledger', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'admin'
      && !await billingService.store.isSessionOwnedByUser(req.user.tenantId, req.params.sessionId, req.user.sub)) {
      return res.status(404).json({ error: '会话不存在' });
    }
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
  maxRunCreditsMicro: z.number().int().min(1).nullable().optional(),
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

const memberBudgetUpdateSchema = z.object({
  monthlyLimitCredits: z.number().finite().min(0).max(1_000_000_000).nullable(),
  enforcementMode: z.enum(['notify', 'stop_new_runs']).optional(),
  perRunLimitCredits: z.number().finite().positive().max(1_000_000_000).nullable().optional(),
  expectedVersion: z.number().int().min(0),
  idempotencyKey: z.string().trim().min(8).max(120).regex(/^[a-zA-Z0-9:_-]+$/),
  note: z.string().trim().min(2).max(200),
}).superRefine((value, ctx) => {
  if (value.enforcementMode !== 'stop_new_runs') return;
  if (value.monthlyLimitCredits === null || value.monthlyLimitCredits <= 0) {
    ctx.addIssue({ code: 'custom', path: ['monthlyLimitCredits'], message: '强制额度必须设置大于 0 的月额度' });
  }
  if (value.perRunLimitCredits === null || value.perRunLimitCredits === undefined) {
    ctx.addIssue({ code: 'custom', path: ['perRunLimitCredits'], message: '强制额度必须设置单 Run 上限' });
  }
});

const memberBudgetAuditQuerySchema = z.object({
  tenantId: tenantIdSchema.optional(),
  userId: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const accountAdjustSchema = z.object({
  creditsDelta: z.number().finite(),
  type: z.enum(['recharge', 'grant', 'refund', 'adjustment', 'expire']).optional(),
  note: z.string().trim().min(2).max(500).optional(),
  businessReference: z.string().trim().min(1).max(120).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).regex(/^[a-zA-Z0-9:_-]+$/).optional(),
});

const ledgerReversalSchema = z.object({
  tenantId: tenantIdSchema,
  idempotencyKey: z.string().trim().min(8).max(120).regex(/^[a-zA-Z0-9:_-]+$/),
  note: z.string().trim().min(2).max(500),
});

function beijingDayStartIso(now = new Date()): string {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const startUtc = Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate(),
  ) - 8 * 60 * 60 * 1000;
  return new Date(startUtc).toISOString();
}

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

function formatMemberBudget(item: BillingMemberBudgetUsage) {
  const monthlyLimitCredits = item.monthlyLimitCreditsMicro === undefined
    ? null
    : item.monthlyLimitCreditsMicro / CREDIT_MICRO;
  const monthUsedCredits = item.monthUsedCreditsMicro / CREDIT_MICRO;
  const monthReservedCredits = item.monthReservedCreditsMicro / CREDIT_MICRO;
  const committedMicro = item.monthUsedCreditsMicro + item.monthReservedCreditsMicro;
  const usageRatioBps = item.monthlyLimitCreditsMicro === undefined
    ? null
    : item.monthlyLimitCreditsMicro <= 0
      ? (committedMicro > 0 ? 10000 : 0)
      : Math.round((committedMicro / item.monthlyLimitCreditsMicro) * 10000);
  return {
    userId: item.userId,
    monthlyLimitCredits,
    monthUsedCredits,
    monthReservedCredits,
    remainingCredits: item.remainingCreditsMicro === undefined ? null : item.remainingCreditsMicro / CREDIT_MICRO,
    enforcementMode: item.enforcementMode,
    perRunLimitCredits: item.perRunLimitCreditsMicro === undefined ? null : item.perRunLimitCreditsMicro / CREDIT_MICRO,
    canStartRun: item.canStartRun,
    usageRatioBps,
    status: budgetStatus(usageRatioBps),
    active: item.active,
    version: item.version,
    lastUsedAt: item.lastUsedAt,
    updatedBy: item.updatedBy,
    updatedAt: item.updatedAt,
  };
}

function budgetStatus(usageRatioBps: number | null): 'unset' | 'normal' | 'attention' | 'warning' | 'over' {
  if (usageRatioBps === null) return 'unset';
  if (usageRatioBps >= 10000) return 'over';
  if (usageRatioBps >= 9000) return 'warning';
  if (usageRatioBps >= 7500) return 'attention';
  return 'normal';
}

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
