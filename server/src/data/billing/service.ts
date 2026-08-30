import { randomUUID } from 'node:crypto';

import type { AgentRunDispatch, AgentRunHooks, AgentRunOptions, SdkResultModelUsage } from '../../agent/types.js';
import type { ChannelContext, InboundMessage, OutboundEvent } from '../../types/index.js';
import type { UserStore } from '../users/store.js';
import {
  CREDIT_MICRO,
  DEFAULT_CREDIT_VALUE_YUAN_MICRO,
  type BillingAuditSummary,
  type BillingLedgerEntry,
  type BillingProjectionResult,
  type BillingRunAllowanceDecision,
  type BillingRunAllowanceInput,
  type BillingSummary,
  type FixedDebitInput,
  type ProjectedRuntimeUsageInput,
} from './types.js';
import { PgBillingStore, type BillingPolicyPatch, type RuntimeUsageEventRow } from './pgBillingStore.js';

export interface BillingServiceOptions {
  store: PgBillingStore;
  userStore?: UserStore;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
  /**
   * memory_poll run 是否对该租户扣积分（2026-07-14 曾磊拍板：默认不扣）。
   * 未配置或返回 false → memory_poll 的 usage event 记 billable=false
   * （不产生 ledger debit，用量照记内部可见）。装配层从
   * TenantSettings.features.memoryPollChargesCredits 读取。
   */
  isMemoryPollBillable?: (tenantId: string) => boolean;
}

/** Independently billed utility-model invocation. */
export interface BillingUtilityModelRun {
  runId: string;
  beforeModelCall(): Promise<void>;
  recordUsage(model: string, usage: SdkResultModelUsage): Promise<void>;
  finalize(): Promise<void>;
}

export class BillingService {
  private projectionInFlight?: Promise<BillingProjectionResult>;

  constructor(private readonly options: BillingServiceOptions) {}

  get store(): PgBillingStore {
    return this.options.store;
  }

  get userStore(): UserStore | undefined {
    return this.options.userStore;
  }

  projectRuntimeEvents(limit = 500): Promise<BillingProjectionResult> {
    if (this.projectionInFlight) return this.projectionInFlight;
    const projection = this.runRuntimeProjection(limit);
    this.projectionInFlight = projection;
    void projection.finally(() => {
      if (this.projectionInFlight === projection) this.projectionInFlight = undefined;
    }).catch(() => undefined);
    return projection;
  }

  private async runRuntimeProjection(limit: number): Promise<BillingProjectionResult> {
    let lastProjectedSequence = await this.options.store.getProjectionState('runtime_events');
    let usageEventsInserted = 0;
    let debitEntriesInserted = 0;
    const rows = await this.options.store.listUnprojectedRuntimeEvents(limit);
    const settledRunKeys = new Set<string>();
    for (const row of rows) {
      lastProjectedSequence = Math.max(lastProjectedSequence, row.globalSequence);
      let projectedModelUsage = false;
      if (
        row.eventType === 'assistant_message'
        || row.eventType === 'assistant_tool_calls'
        || row.eventType === 'image_understanding'
        || row.eventType === 'compaction_usage'
      ) {
        const inserted = await this.projectAssistantUsageEvent(row);
        if (inserted) usageEventsInserted++;
        projectedModelUsage = true;
      }
      if (row.eventType === 'model_request_finished') {
        const inserted = await this.projectFailedModelUsageEvent(row);
        if (inserted) usageEventsInserted++;
        projectedModelUsage = true;
      }
      if (projectedModelUsage) {
        const runId = typeof row.eventJson.runId === 'string' ? row.eventJson.runId : undefined;
        if (runId) {
          const debit = await this.options.store.settleRunDebit(row.tenantId, runId);
          if (debit) debitEntriesInserted++;
          settledRunKeys.add(`${row.tenantId}\u0000${runId}`);
        }
      }
      if (row.eventType === 'metered_tool_usage') {
        const projected = await this.projectMeteredToolUsage(row);
        if (projected.usageInserted) usageEventsInserted++;
        if (projected.debitInserted) debitEntriesInserted++;
      }
      if (row.eventType === 'run_finished' || shouldSettleOnRunState(row.eventJson)) {
        const runId = typeof row.eventJson.runId === 'string' ? row.eventJson.runId : undefined;
        if (runId && !settledRunKeys.has(`${row.tenantId}\u0000${runId}`)) {
          const debit = await this.options.store.settleRunDebit(row.tenantId, runId);
          if (debit) debitEntriesInserted++;
        }
      }
    }
    if (lastProjectedSequence > 0) await this.options.store.setProjectionState('runtime_events', lastProjectedSequence);
    return { usageEventsInserted, debitEntriesInserted, lastProjectedSequence };
  }

  private async drainRuntimeProjection(limit = 2_000, maxBatches = 50): Promise<void> {
    let previous = await this.options.store.getProjectionState('runtime_events');
    for (let batch = 0; batch < maxBatches; batch += 1) {
      await this.projectRuntimeEvents(limit);
      const current = await this.options.store.getProjectionState('runtime_events');
      if (current <= previous) return;
      previous = current;
    }
    throw new Error(`billing projection backlog exceeds ${limit * maxBatches} events`);
  }

  async ensureProjected(): Promise<void> {
    await this.drainRuntimeProjection().catch((err) => {
      this.options.logger?.warn?.(`billing projection failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async getSummaryForTenant(tenantId: string, options: { includeInternalMetrics?: boolean } = {}): Promise<BillingSummary> {
    await this.ensureProjected();
    const [account, policy, pricing] = await Promise.all([
      this.options.store.getAccount(tenantId),
      this.options.store.getTenantPolicy(tenantId),
      this.options.store.getActivePricingVersion(),
    ]);
    const monthStart = currentMonthStartIso();
    const month = await this.options.store.getMonthlyLedgerSummary(tenantId, monthStart);
    return {
      tenantId,
      balanceCredits: account.balanceCreditsMicro / CREDIT_MICRO,
      lowBalance: policy.lowBalanceThresholdCreditsMicro > 0
        && account.balanceCreditsMicro <= policy.lowBalanceThresholdCreditsMicro,
      billingEnabled: policy.billingEnabled,
      billingMode: policy.billingMode,
      pricingVersion: policy.pricingVersion,
      policyVersion: policy.policyVersion,
      creditValueYuan: pricing.creditValueYuanMicro / 1_000_000,
      currentMonthCreditsUsed: month.creditsUsedMicro / CREDIT_MICRO,
      currentMonthRevenueYuan: month.revenueYuanMicro / 1_000_000,
      ...(options.includeInternalMetrics || policy.showCost ? { currentMonthActualCostYuan: month.actualCostYuanMicro / 1_000_000 } : {}),
      ...(options.includeInternalMetrics || policy.showGrossMargin ? { currentMonthGrossMarginBps: month.grossMarginBps ?? undefined } : {}),
    };
  }

  async reverseDebit(input: {
    tenantId: string;
    ledgerId: string;
    idempotencyKey: string;
    note: string;
    actor: string;
  }): Promise<BillingLedgerEntry> {
    return await this.options.store.reverseDebit(input);
  }

  async getSessionSummary(tenantId: string, sessionId: string): Promise<{ sessionId: string; creditsUsed: number; revenueYuan: number; actualCostYuan?: number; childSessionCount: number }> {
    await this.ensureProjected();
    const [policy, tree] = await Promise.all([
      this.options.store.getTenantPolicy(tenantId),
      this.options.store.getSessionTreeLedgerSummary(tenantId, sessionId),
    ]);
    return {
      sessionId,
      creditsUsed: tree.creditsUsedMicro / CREDIT_MICRO,
      revenueYuan: tree.revenueYuanMicro / 1_000_000,
      ...(policy.showCost ? { actualCostYuan: tree.actualCostYuanMicro / 1_000_000 } : {}),
      childSessionCount: tree.childSessionCount,
    };
  }

  async listLedgerForTenant(tenantId: string, query: {
    sessionId?: string;
    runId?: string;
    type?: import('./types.js').LedgerType;
    cursor?: { createdAt: string; id: string };
    limit?: number;
    from?: string;
    to?: string;
  } = {}): Promise<{ entries: BillingLedgerEntry[]; nextCursor?: { createdAt: string; id: string } }> {
    await this.ensureProjected();
    return await this.options.store.listLedger({ tenantId, ...query });
  }

  async updateTenantPolicy(tenantId: string, patch: BillingPolicyPatch, actor: string) {
    return await this.options.store.updateTenantPolicy(tenantId, patch, actor);
  }

  async createPricingVersion(input: {
    version: string;
    name: string;
    status?: 'draft' | 'active';
    effectiveFrom?: string;
    creditValueYuanMicro: number;
    defaultTargetMarginBps: number;
    fxRateToCny?: number;
  }, actor: string) {
    return await this.options.store.createPricingVersion({ ...input, createdBy: actor });
  }

  async updatePricingVersion(version: string, patch: {
    name?: string;
    status?: 'draft' | 'active' | 'retired';
    effectiveFrom?: string;
    effectiveTo?: string | null;
    creditValueYuanMicro?: number;
    defaultTargetMarginBps?: number;
    fxRateToCny?: number;
  }, actor: string) {
    return await this.options.store.updatePricingVersion(version, { ...patch, updatedBy: actor });
  }

  async adjustAccount(input: { tenantId: string; creditsDelta: number; type?: 'recharge' | 'grant' | 'refund' | 'adjustment' | 'expire'; note?: string; actor: string; idempotencyKey?: string }) {
    return await this.options.store.adjustAccount({
      tenantId: input.tenantId,
      type: input.type ?? 'adjustment',
      creditsDeltaMicro: Math.round(input.creditsDelta * CREDIT_MICRO),
      note: input.note,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async deleteTenantData(tenantId: string): Promise<{ usageEvents: number; creditLedger: number; creditAccounts: number; tenantPolicies: number }> {
    const store = this.options.store as unknown as {
      deleteTenantData?: (tenantId: string) => Promise<{ usageEvents: number; creditLedger: number; creditAccounts: number; tenantPolicies: number }>;
    };
    if (!store.deleteTenantData) {
      return { usageEvents: 0, creditLedger: 0, creditAccounts: 0, tenantPolicies: 0 };
    }
    return await store.deleteTenantData(tenantId);
  }

  async getAuditSummary(query: { tenantId?: string; days?: number; includeDaily?: boolean }): Promise<BillingAuditSummary> {
    await this.ensureProjected();
    const audit = await this.options.store.getAuditSummary({ tenantId: query.tenantId, days: query.days });
    if (query.includeDaily) {
      audit.daily = await this.options.store.getDailyAuditBreakdown({ tenantId: query.tenantId, days: audit.days });
    }
    return audit;
  }

  async authorizeRun(input: BillingRunAllowanceInput): Promise<BillingRunAllowanceDecision> {
    await this.drainRuntimeProjection();
    await this.options.store.settleRunDebit(input.tenantId, input.runId);
    return await this.options.store.authorizeRun(input);
  }

  async beginUtilityModelRun(input: {
    tenantId: string;
    userId?: string;
    username: string;
    sessionId?: string;
    channel: 'guardrail' | 'title' | 'memory_embedding' | 'automation_evaluator';
  }): Promise<BillingUtilityModelRun> {
    const runId = `utility-${input.channel}-${randomUUID()}`;
    const initial = await this.authorizeRun({
      tenantId: input.tenantId,
      ...(input.userId ? { userId: input.userId } : {}),
      runId,
    });
    if (!initial.ok) throw new Error(`[${initial.code}] ${initial.reason}`);

    let requestIndex = 0;
    let finalized = false;
    const pendingUsage: Array<{ model: string; usage: SdkResultModelUsage; requestIndex: number; occurredAt: string }> = [];
    const flushPendingUsage = async () => {
      while (pendingUsage.length > 0) {
        const pending = pendingUsage[0]!;
        await this.options.store.insertUsageEvent({
          idempotencyKey: `usage:utility:v1:${runId}:${pending.requestIndex}`,
          tenantId: input.tenantId,
          ...(input.userId ? { userId: input.userId } : {}),
          username: input.username,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          runId,
          channel: input.channel,
          modelValue: pending.model,
          requestIndex: pending.requestIndex,
          usage: pending.usage,
          rawUsageJson: pending.usage,
          occurredAt: pending.occurredAt,
        });
        pendingUsage.shift();
      }
    };
    return {
      runId,
      beforeModelCall: async () => {
        requestIndex++;
        await flushPendingUsage();
        const allowed = await this.authorizeRun({
          tenantId: input.tenantId,
          ...(input.userId ? { userId: input.userId } : {}),
          runId,
        });
        if (!allowed.ok) throw new Error(`[${allowed.code}] ${allowed.reason}`);
      },
      recordUsage: async (model, usage) => {
        pendingUsage.push({
          model,
          usage,
          requestIndex: Math.max(1, requestIndex),
          occurredAt: new Date().toISOString(),
        });
        await flushPendingUsage();
      },
      finalize: async () => {
        if (finalized) return;
        await flushPendingUsage();
        await this.options.store.settleRunDebit(input.tenantId, runId);
        finalized = true;
      },
    };
  }

  async authorizeFixedFee(
    input: BillingRunAllowanceInput & { creditsMicro: number },
  ): Promise<BillingRunAllowanceDecision> {
    await this.drainRuntimeProjection();
    await this.options.store.settleRunDebit(input.tenantId, input.runId);
    return await this.options.store.authorizeFixedFee(input);
  }

  async chargeFixedDebit(input: FixedDebitInput): Promise<BillingLedgerEntry | null> {
    return await this.options.store.chargeFixedDebit(input);
  }

  async assertTenantCanStartRun(tenantId: string): Promise<{ ok: true } | { ok: false; code: 'BILLING_ORG_BALANCE_EXHAUSTED' | 'BILLING_RUN_LIMIT_NOT_CONFIGURED'; reason: string }> {
    const [account, policy] = await Promise.all([
      this.options.store.getAccount(tenantId),
      this.options.store.getTenantPolicy(tenantId),
    ]);
    if (!policy.billingEnabled || policy.billingMode === 'internal' || policy.hardCapMode === 'none') return { ok: true };
    if (policy.maxRunCreditsMicro === undefined || policy.maxRunCreditsMicro <= 0) {
      return {
        ok: false,
        code: 'BILLING_RUN_LIMIT_NOT_CONFIGURED',
        reason: '组织已启用积分硬封顶，但尚未配置正数的组织单 Run 上限。',
      };
    }
    const effectiveAvailable = account.balanceCreditsMicro;
    if (effectiveAvailable > 0) return { ok: true };
    if (policy.allowNegativeBalance && Math.abs(effectiveAvailable) < policy.negativeLimitCreditsMicro) return { ok: true };
    return { ok: false, code: 'BILLING_ORG_BALANCE_EXHAUSTED', reason: '组织积分余额不足，当前计费策略已启用硬封顶。' };
  }

  /**
   * 按次固定扣费预检（2026-07-15 GenerateImage 批次）：metered 工具在真正调
   * 外部 API 之前调用。镜像 assertTenantCanStartRun 的豁免语义
   * （internal / billingEnabled=false / hardCapMode='none' 放行、尊重
   * allowNegativeBalance 信用额度），差别在于感知即将发生的固定费用 N：
   * 要求可用余额扣除 N 后仍在允许范围内。run 级 preflight 不够——长 run
   * 中途余额可能被烧穿，工具内必须再查一次。
   */
  async assertTenantCanAffordFixedFee(tenantId: string, creditsMicro: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const required = Math.max(0, Math.trunc(creditsMicro));
    if (required <= 0) return { ok: true };
    const [account, policy] = await Promise.all([
      this.options.store.getAccount(tenantId),
      this.options.store.getTenantPolicy(tenantId),
    ]);
    if (!policy.billingEnabled || policy.billingMode === 'internal' || policy.hardCapMode === 'none') return { ok: true };
    const effectiveAvailable = account.balanceCreditsMicro;
    if (effectiveAvailable >= required) return { ok: true };
    if (policy.allowNegativeBalance && required - effectiveAvailable < policy.negativeLimitCreditsMicro) return { ok: true };
    return { ok: false, reason: '组织积分余额不足，当前计费策略已启用硬封顶。' };
  }

  /** 该租户是否实际产生积分扣费（internal / 未开计费 → false）。metered 工具用于回显扣费口径。 */
  async isTenantBillable(tenantId: string): Promise<boolean> {
    const policy = await this.options.store.getTenantPolicy(tenantId);
    return policy.billingEnabled && policy.billingMode !== 'internal';
  }

  wrapDispatch(dispatch: AgentRunDispatch): AgentRunDispatch {
    return async function* billingWrappedDispatch(
      this: BillingService,
      message: InboundMessage,
      context: ChannelContext,
      options?: AgentRunOptions,
      hooks?: AgentRunHooks,
    ): AsyncGenerator<OutboundEvent> {
      // 新 Run、Steering 与恢复路径都在 raw dispatch 内按真实 runId 检查实际用量。
      // 每次真实模型请求前还会再次检查，避免只在任务起点判断。
      try {
        yield* dispatch(message, context, options, hooks);
      } finally {
        // enqueue-only、失败及 scheduler 路径都可能异步落 runtime_events；退出时统一触发一次投影。
        void this.projectRuntimeEvents().catch((err) => {
          this.options.logger?.warn?.(`billing projection after dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }.bind(this);
  }

  private async projectAssistantUsageEvent(row: RuntimeUsageEventRow): Promise<boolean> {
    const event = row.eventJson;
    const usage = isUsageObject(event.usage) ? event.usage : undefined;
    if (!usage) return false;
    const modelValue =
      (typeof event.model === 'string' && event.model)
      || row.runModel
      || (typeof event.actualModel === 'string' ? event.actualModel : undefined)
      || 'unknown';
    return await this.insertRuntimeUsageEvent(row, {
      idempotencyKey: `usage:event:v1:${row.eventId}`,
      modelValue,
      ...(typeof event.actualModel === 'string' ? { actualModel: event.actualModel } : {}),
      usage,
      rawUsageJson: usage,
    });
  }

  /**
   * Responses 失败终态不会产生 assistant_message/tool_calls，但 provider 仍可能返回
   * 应计费 usage。以 attemptId 为幂等键投影，随后由同 run 的 run_finished/state 结算。
   * completed attempt 继续只认 assistant 事件，避免成功轮次重复计费。
   */
  private async projectFailedModelUsageEvent(row: RuntimeUsageEventRow): Promise<boolean> {
    const diagnostic = asRecord(row.eventJson.diagnostic);
    if (diagnostic?.type !== 'finished' || diagnostic.outcome === 'completed') return false;
    const usage = isUsageObject(diagnostic.usage) ? diagnostic.usage : undefined;
    if (!usage) return false;
    const attemptId = typeof diagnostic.attemptId === 'string' && diagnostic.attemptId
      ? diagnostic.attemptId
      : row.eventId;
    return await this.insertRuntimeUsageEvent(row, {
      idempotencyKey: `usage:model-attempt:v1:${attemptId}`,
      modelValue: row.runModel ?? 'unknown',
      usage,
      rawUsageJson: {
        usage,
        ...(typeof diagnostic.modelRequestId === 'string' ? { modelRequestId: diagnostic.modelRequestId } : {}),
        ...(typeof diagnostic.attemptId === 'string' ? { attemptId: diagnostic.attemptId } : {}),
        ...(typeof diagnostic.attempt === 'number' ? { attempt: diagnostic.attempt } : {}),
        ...(typeof diagnostic.outcome === 'string' ? { outcome: diagnostic.outcome } : {}),
        ...(typeof diagnostic.errorCode === 'string' ? { errorCode: diagnostic.errorCode } : {}),
      },
    });
  }

  private async insertRuntimeUsageEvent(
    row: RuntimeUsageEventRow,
    inputFields: {
      idempotencyKey: string;
      modelValue: string;
      actualModel?: string;
      usage: ProjectedRuntimeUsageInput['usage'];
      rawUsageJson: unknown;
    },
  ): Promise<boolean> {
    const event = row.eventJson;
    const runId = typeof event.runId === 'string' ? event.runId : undefined;
    const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
    const user = row.runUserId ? this.options.userStore?.findById(row.runUserId) : undefined;
    // 后台记忆 profile 计费豁免（2026-07-14 memory_poll；2026-07-29 扩展
    // memory_consolidate）：租户未显式开启扣费时 billable=false。
    const memoryPollExempt = (row.runToolProfile === 'memory_poll' || row.runToolProfile === 'memory_consolidate')
      && this.options.isMemoryPollBillable?.(row.tenantId) !== true;
    const input: ProjectedRuntimeUsageInput = {
      idempotencyKey: inputFields.idempotencyKey,
      tenantId: row.tenantId,
      ...(memoryPollExempt ? { billable: false } : {}),
      ...(row.runUserId ? { userId: row.runUserId } : {}),
      username: user?.username ?? row.runUserId ?? 'unknown',
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      channel: row.runChannel ?? 'web',
      modelValue: inputFields.modelValue,
      ...(inputFields.actualModel ? { actualModel: inputFields.actualModel } : {}),
      requestIndex: row.globalSequence,
      usage: inputFields.usage,
      rawUsageJson: inputFields.rawUsageJson,
      occurredAt: row.timestamp,
    };
    const inserted = await this.options.store.insertUsageEvent(input);
    return !!inserted;
  }

  /**
   * metered_tool_usage 投影（2026-07-15 GenerateImage 批次）：
   *   ① usage 事实行——token 全 0、raw_usage_json 存 SKU 规格、真实成本走固定
   *      成本旁路。**billable=false 是防双重扣费的关键**：settleRunDebit 只认
   *      billable 标志不认识 SKU（记 true 会被 run 终态按 cost-plus 再扣一次）。
   *   ② 同一投影批次内写独立固定 debit（source='tool:*'，幂等键锚定 eventId，
   *      投影重跑/事件重放不重复扣）。internal / 未开计费租户在 store 内跳过。
   */
  private async projectMeteredToolUsage(row: RuntimeUsageEventRow): Promise<{ usageInserted: boolean; debitInserted: boolean }> {
    const event = row.eventJson;
    const toolId = typeof event.toolId === 'string' && event.toolId ? event.toolId : 'unknown_tool';
    const sku = typeof event.sku === 'string' && event.sku ? event.sku : toolId;
    const quantity = isFiniteNumber(event.quantity) ? Math.max(1, Math.floor(event.quantity)) : 1;
    const unitCreditsMicro = isFiniteNumber(event.unitCreditsMicro) ? Math.max(0, Math.trunc(event.unitCreditsMicro)) : 0;
    const unitCostYuanMicro = isFiniteNumber(event.unitCostYuanMicro) ? Math.max(0, Math.trunc(event.unitCostYuanMicro)) : 0;
    const runId = typeof event.runId === 'string' && event.runId ? event.runId : undefined;
    const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : undefined;
    const note = typeof event.note === 'string' && event.note ? event.note : undefined;
    const holdKey = typeof event.holdKey === 'string' && event.holdKey ? event.holdKey : undefined;
    const billingChargeKey = typeof event.billingChargeKey === 'string' && event.billingChargeKey
      ? event.billingChargeKey
      : undefined;
    const user = row.runUserId ? this.options.userStore?.findById(row.runUserId) : undefined;
    const totalCostYuanMicro = quantity * unitCostYuanMicro;
    const usage = await this.options.store.insertUsageEvent({
      idempotencyKey: `usage:event:v1:${row.eventId}`,
      tenantId: row.tenantId,
      billable: false,
      ...(row.runUserId ? { userId: row.runUserId } : {}),
      username: user?.username ?? row.runUserId ?? 'unknown',
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      channel: row.runChannel ?? 'web',
      modelValue: sku,
      requestIndex: row.globalSequence,
      usage: { inputTokens: 0, outputTokens: 0, apiRequestCount: quantity },
      rawUsageJson: { toolId, sku, quantity, unitCreditsMicro, unitCostYuanMicro, ...(note ? { note } : {}) },
      occurredAt: row.timestamp,
      fixedCostYuanMicro: totalCostYuanMicro,
    });
    const debit = await this.options.store.chargeFixedDebit({
      tenantId: row.tenantId,
      ...(row.runUserId ? { userId: row.runUserId } : {}),
      ...(user?.username ? { username: user.username } : {}),
      idempotencyKey: billingChargeKey
        ?? (holdKey ? `debit:tool:hold:v1:${holdKey}` : `debit:tool:v1:${row.eventId}`),
      source: METERED_TOOL_LEDGER_SOURCES[toolId] ?? `tool:${toolId}`,
      creditsMicro: quantity * unitCreditsMicro,
      actualCostYuanMicro: totalCostYuanMicro,
      relatedUsageEventIds: usage ? [usage.id] : [],
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      note: `${toolId} ${sku} ×${quantity}${note ? ` (${note})` : ''}`,
    });
    return { usageInserted: !!usage, debitInserted: !!debit };
  }
}

/** 平台内置 metered 工具 → ledger source（账单可读性；未登记的工具回退 `tool:${toolId}`）。 */
const METERED_TOOL_LEDGER_SOURCES: Record<string, string> = {
  GenerateImage: 'tool:image_gen',
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUsageObject(value: unknown): value is ProjectedRuntimeUsageInput['usage'] {
  return !!value && typeof value === 'object'
    && (
      typeof (value as { inputTokens?: unknown }).inputTokens === 'number'
      || typeof (value as { outputTokens?: unknown }).outputTokens === 'number'
    );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function shouldSettleOnRunState(event: Record<string, unknown>): boolean {
  if (event.type !== 'run_state_changed') return false;
  return event.status === 'completed'
    || event.status === 'failed'
    || event.status === 'cancelled'
    || event.status === 'orphaned';
}

function currentMonthStartIso(): string {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const startUtc = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), 1) - 8 * 60 * 60 * 1000;
  return new Date(startUtc).toISOString();
}
