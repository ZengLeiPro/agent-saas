import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import type { BillingService } from '../data/billing/service.js';
import type {
  BillingLedgerEntry,
  BillingSummary,
  BillingUsageEvent,
} from '../data/billing/types.js';
import type { DatabaseConnectionStore } from '../data/databaseConnections/index.js';
import type { ExternalConversationStore } from '../data/externalConversations/index.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';

const querySchema = z.object({
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
  clientId: z.string().trim().min(1).max(128).optional(),
  connectionId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

interface UsageAggregate {
  key: string;
  executionCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  apiRequestCount: number;
  chargedCreditsMicro: number;
  revenueYuanMicro: number;
  actualCostYuanMicro: number;
}

function aggregateFor(map: Map<string, UsageAggregate>, key: string): UsageAggregate {
  let value = map.get(key);
  if (!value) {
    value = {
      key,
      executionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      apiRequestCount: 0,
      chargedCreditsMicro: 0,
      revenueYuanMicro: 0,
      actualCostYuanMicro: 0,
    };
    map.set(key, value);
  }
  return value;
}

function addUsage(target: UsageAggregate, events: BillingUsageEvent[]): void {
  for (const event of events) {
    target.inputTokens += event.inputTokens;
    target.outputTokens += event.outputTokens;
    target.cachedInputTokens += event.cachedInputTokens;
    target.reasoningTokens += event.reasoningTokens;
    target.apiRequestCount += event.apiRequestCount;
    target.actualCostYuanMicro += event.actualCostYuanMicro;
  }
}

function addLedger(target: UsageAggregate, entries: BillingLedgerEntry[]): void {
  for (const entry of entries) {
    if (entry.type !== 'debit') continue;
    target.chargedCreditsMicro += Math.abs(entry.creditsDeltaMicro);
    target.revenueYuanMicro += entry.revenueYuanMicro;
  }
}

function usageView(value: UsageAggregate, includeActualCost: boolean) {
  return {
    key: value.key,
    executionCount: value.executionCount,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cachedInputTokens: value.cachedInputTokens,
    reasoningTokens: value.reasoningTokens,
    apiRequestCount: value.apiRequestCount,
    chargedCredits: value.chargedCreditsMicro / 1_000_000,
    revenueYuan: value.revenueYuanMicro / 1_000_000,
    ...(includeActualCost ? { actualCostYuan: value.actualCostYuanMicro / 1_000_000 } : {}),
  };
}

export function createExternalAgentOperationsAdminRouter(deps: {
  conversations?: ExternalConversationStore;
  databaseConnections?: DatabaseConnectionStore;
  billingService?: Pick<BillingService, 'ensureProjected' | 'getSummaryForTenant'> & {
    store: Pick<
      BillingService['store'],
      'listUsageEvents' | 'listLedger' | 'getMemberBudgetOverview'
    >;
  };
}): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (!req.user) return void res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'admin')
      return void res.status(403).json({ error: 'Admin access required' });
    next();
  });

  router.get('/', async (req: Request, res: Response) => {
    if (!deps.conversations || !deps.databaseConnections) {
      return void res.status(503).json({
        error: 'External Agent operations unavailable',
        code: 'external_agent_unavailable',
      });
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success)
      return void res.status(400).json({ error: 'Invalid query', issues: parsed.error.issues });
    const tenantId = isPlatformAdmin(req.user) ? parsed.data.tenantId : req.user!.tenantId;
    if (!tenantId)
      return void res.status(400).json({ error: 'tenantId required', code: 'tenant_id_required' });
    const [conversations, executions, queryAudit] = await Promise.all([
      deps.conversations.listConversations({
        tenantId,
        ...(parsed.data.clientId ? { clientId: parsed.data.clientId } : {}),
        limit: parsed.data.limit,
      }),
      deps.conversations.listExecutions({
        tenantId,
        ...(parsed.data.clientId ? { clientId: parsed.data.clientId } : {}),
        limit: parsed.data.limit,
      }),
      deps.databaseConnections.listQueryAudit({
        tenantId,
        ...(parsed.data.connectionId ? { connectionId: parsed.data.connectionId } : {}),
        limit: parsed.data.limit,
      }),
    ]);
    const platform = isPlatformAdmin(req.user);
    let usageSummary: Record<string, unknown> | null = null;
    let billingSummary: BillingSummary | null = null;
    let budgetAlerts: Array<Record<string, unknown>> = [];
    if (deps.billingService) {
      await deps.billingService.ensureProjected();
      const conversationById = new Map(conversations.map((item) => [item.conversationId, item]));
      const billableExecutions = executions.filter((item) => item.runId);
      const missingConversationIds = [
        ...new Set(
          billableExecutions
            .map((item) => item.conversationId)
            .filter((id) => !conversationById.has(id)),
        ),
      ];
      for (const record of await Promise.all(
        missingConversationIds.map((id) => deps.conversations!.getConversation(id)),
      )) {
        if (record?.tenantId === tenantId) conversationById.set(record.conversationId, record);
      }
      const billingRows = await Promise.all(
        billableExecutions.map(async (execution) => ({
          execution,
          usage: await deps.billingService!.store.listUsageEvents({
            tenantId,
            runId: execution.runId,
            limit: 1000,
          }),
          ledger: (
            await deps.billingService!.store.listLedger({
              tenantId,
              runId: execution.runId,
              type: 'debit',
              limit: 100,
            })
          ).entries,
        })),
      );
      const dimensions = {
        organization: new Map<string, UsageAggregate>(),
        client: new Map<string, UsageAggregate>(),
        account: new Map<string, UsageAggregate>(),
        model: new Map<string, UsageAggregate>(),
        connection: new Map<string, UsageAggregate>(),
      };
      for (const row of billingRows) {
        const conversation = conversationById.get(row.execution.conversationId);
        const common = [
          aggregateFor(dimensions.organization, tenantId),
          aggregateFor(dimensions.client, row.execution.clientId),
          aggregateFor(dimensions.account, row.execution.serviceAccountUserId),
          ...(conversation?.databaseConnectionId
            ? [aggregateFor(dimensions.connection, conversation.databaseConnectionId)]
            : []),
        ];
        for (const target of common) {
          target.executionCount += 1;
          addUsage(target, row.usage);
          addLedger(target, row.ledger);
        }
        const eventsByModel = new Map<string, BillingUsageEvent[]>();
        for (const event of row.usage) {
          const model = event.actualModel || event.modelValue || 'unknown';
          eventsByModel.set(model, [...(eventsByModel.get(model) ?? []), event]);
        }
        for (const [model, events] of eventsByModel) {
          const target = aggregateFor(dimensions.model, model);
          target.executionCount += 1;
          addUsage(target, events);
        }
      }
      usageSummary = Object.fromEntries(
        Object.entries(dimensions).map(([name, values]) => [
          name,
          [...values.values()].map((value) => usageView(value, platform)),
        ]),
      );
      const [summary, budget] = await Promise.all([
        deps.billingService.getSummaryForTenant(tenantId, { includeInternalMetrics: platform }),
        deps.billingService.store.getMemberBudgetOverview(tenantId),
      ]);
      billingSummary = summary;
      const serviceAccountIds = new Set(executions.map((item) => item.serviceAccountUserId));
      budgetAlerts = [
        ...(summary.lowBalance
          ? [{ type: 'organization_low_balance', tenantId, balanceCredits: summary.balanceCredits }]
          : []),
        ...budget.items
          .filter((item) => serviceAccountIds.has(item.userId) && !item.canStartRun)
          .map((item) => ({
            type: 'service_account_budget_exhausted',
            userId: item.userId,
            remainingCredits:
              item.remainingCreditsMicro === undefined
                ? null
                : item.remainingCreditsMicro / 1_000_000,
            enforcementMode: item.enforcementMode,
          })),
      ];
    }
    res.json({
      conversations: conversations.map((record) => ({
        conversationId: record.conversationId,
        clientId: record.clientId,
        tenantId: record.tenantId,
        serviceAccountUserId: record.serviceAccountUserId,
        externalConversationId: record.externalConversationId,
        sessionId: record.sessionId ?? null,
        databaseConnectionId: record.databaseConnectionId ?? null,
        agentId: record.agentId ?? null,
        status: record.status,
        metadata: record.metadata,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
      executions: executions.map((record) => ({
        executionId: record.executionId,
        conversationId: record.conversationId,
        clientId: record.clientId,
        tenantId: record.tenantId,
        serviceAccountUserId: record.serviceAccountUserId,
        runId: record.runId ?? null,
        sessionId: record.sessionId ?? null,
        submissionStatus: record.submissionStatus,
        requestedModel: record.requestedModel ?? null,
        requestedReasoningEffort: record.requestedReasoningEffort ?? null,
        errorCode: record.errorCode ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
      queryAudit,
      usageSummary,
      billingSummary,
      budgetAlerts,
    });
  });
  return router;
}
