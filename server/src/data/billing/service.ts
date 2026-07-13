import type { AgentRunDispatch, AgentRunHooks, AgentRunOptions } from '../../agent/types.js';
import type { ChannelContext, InboundMessage, OutboundEvent } from '../../types/index.js';
import type { UserStore } from '../users/store.js';
import {
  CREDIT_MICRO,
  DEFAULT_CREDIT_VALUE_YUAN_MICRO,
  type BillingAuditSummary,
  type BillingLedgerEntry,
  type BillingProjectionResult,
  type BillingSummary,
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
}

export class BillingService {
  private projectionInFlight = false;

  constructor(private readonly options: BillingServiceOptions) {}

  get store(): PgBillingStore {
    return this.options.store;
  }

  async projectRuntimeEvents(limit = 500): Promise<BillingProjectionResult> {
    if (this.projectionInFlight) {
      const last = await this.options.store.getProjectionState('runtime_events');
      return { usageEventsInserted: 0, debitEntriesInserted: 0, lastProjectedSequence: last };
    }
    this.projectionInFlight = true;
    let lastProjectedSequence = await this.options.store.getProjectionState('runtime_events');
    let usageEventsInserted = 0;
    let debitEntriesInserted = 0;
    try {
      const rows = await this.options.store.listUnprojectedRuntimeEvents(limit);
      for (const row of rows) {
        lastProjectedSequence = Math.max(lastProjectedSequence, row.globalSequence);
        if (row.eventType === 'assistant_message' || row.eventType === 'assistant_tool_calls') {
          const inserted = await this.projectAssistantUsageEvent(row);
          if (inserted) usageEventsInserted++;
        }
        if (row.eventType === 'run_finished' || shouldSettleOnRunState(row.eventJson)) {
          const tenantId = row.tenantId;
          const runId = typeof row.eventJson.runId === 'string' ? row.eventJson.runId : undefined;
          if (runId) {
            const debit = await this.options.store.settleRunDebit(tenantId, runId);
            if (debit) debitEntriesInserted++;
          }
        }
      }
      if (lastProjectedSequence > 0) await this.options.store.setProjectionState('runtime_events', lastProjectedSequence);
      return { usageEventsInserted, debitEntriesInserted, lastProjectedSequence };
    } finally {
      this.projectionInFlight = false;
    }
  }

  async ensureProjected(): Promise<void> {
    await this.projectRuntimeEvents().catch((err) => {
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
      reservedCredits: account.reservedCreditsMicro / CREDIT_MICRO,
      lowBalance: policy.lowBalanceThresholdCreditsMicro > 0 && account.balanceCreditsMicro <= policy.lowBalanceThresholdCreditsMicro,
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

  async adjustAccount(input: { tenantId: string; creditsDelta: number; type?: 'recharge' | 'grant' | 'refund' | 'adjustment' | 'expire' | 'reversal'; note?: string; actor: string }) {
    return await this.options.store.adjustAccount({
      tenantId: input.tenantId,
      type: input.type ?? 'adjustment',
      creditsDeltaMicro: Math.round(input.creditsDelta * CREDIT_MICRO),
      note: input.note,
      actor: input.actor,
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

  async assertTenantCanStartRun(tenantId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [account, policy] = await Promise.all([
      this.options.store.getAccount(tenantId),
      this.options.store.getTenantPolicy(tenantId),
    ]);
    if (!policy.billingEnabled || policy.billingMode === 'internal' || policy.hardCapMode === 'none') return { ok: true };
    const effectiveAvailable = account.balanceCreditsMicro - account.reservedCreditsMicro;
    if (effectiveAvailable > 0) return { ok: true };
    if (policy.allowNegativeBalance && Math.abs(effectiveAvailable) < policy.negativeLimitCreditsMicro) return { ok: true };
    return { ok: false, reason: '组织积分余额不足，当前计费策略已启用硬封顶。' };
  }

  wrapDispatch(dispatch: AgentRunDispatch): AgentRunDispatch {
    return async function* billingWrappedDispatch(
      this: BillingService,
      message: InboundMessage,
      context: ChannelContext,
      options?: AgentRunOptions,
      hooks?: AgentRunHooks,
    ): AsyncGenerator<OutboundEvent> {
      const tenantId = context.user?.tenantId ?? context.sessionOwner?.tenantId;
      if (tenantId) {
        const allowed = await this.assertTenantCanStartRun(tenantId);
        if (!allowed.ok) {
          yield { type: 'error', error: allowed.reason };
          return;
        }
      }
      yield* dispatch(message, context, options, hooks);
      // enqueue-only / scheduler 路径会异步落 runtime_events，这里 fire-and-forget 触发一次投影。
      void this.projectRuntimeEvents().catch((err) => {
        this.options.logger?.warn?.(`billing projection after dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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
    const runId = typeof event.runId === 'string' ? event.runId : undefined;
    const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
    const user = row.runUserId ? this.options.userStore?.findById(row.runUserId) : undefined;
    const input: ProjectedRuntimeUsageInput = {
      idempotencyKey: `usage:event:v1:${row.eventId}`,
      tenantId: row.tenantId,
      ...(row.runUserId ? { userId: row.runUserId } : {}),
      username: user?.username ?? row.runUserId ?? 'unknown',
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      channel: row.runChannel ?? 'web',
      modelValue,
      ...(typeof event.actualModel === 'string' ? { actualModel: event.actualModel } : {}),
      requestIndex: row.globalSequence,
      usage,
      rawUsageJson: usage,
      occurredAt: row.timestamp,
    };
    const inserted = await this.options.store.insertUsageEvent(input);
    return !!inserted;
  }
}

function isUsageObject(value: unknown): value is ProjectedRuntimeUsageInput['usage'] {
  return !!value && typeof value === 'object'
    && (
      typeof (value as { inputTokens?: unknown }).inputTokens === 'number'
      || typeof (value as { outputTokens?: unknown }).outputTokens === 'number'
    );
}

function shouldSettleOnRunState(event: Record<string, unknown>): boolean {
  if (event.type !== 'run_state_changed') return false;
  return event.status === 'waiting_user'
    || event.status === 'waiting_approval'
    || event.status === 'waiting_hand'
    || event.status === 'completed'
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
