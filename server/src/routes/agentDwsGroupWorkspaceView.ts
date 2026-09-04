import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type {
  DwsDeliveryIntent,
  OrgAgentChannelBinding,
  OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import type { OrgAgentStore } from '../data/orgAgents/index.js';

export async function buildGroupWorkspaceView(input: {
  tenantId: string;
  account: AgentDwsAccountRecord;
  bindings: OrgAgentChannelBinding[];
  deliveries: DwsDeliveryIntent[];
  store: OrgGroupAgentStore;
  agentStore: Pick<OrgAgentStore, 'get'>;
  limit: number;
  frontdeskTools: ReadonlySet<string>;
  contextCeiling: { publishedSourceIds: string[]; channelSourceIds: string[] };
}) {
  const groupBindings = input.bindings.filter((binding) => binding.channelKind === 'group');
  const data = await input.store.loadGroupWorkspace({
    tenantId: input.tenantId,
    bindingIds: groupBindings.map((binding) => binding.bindingId),
    limitPerBinding: input.limit,
  });
  const conversationsByBinding = groupBy(data.conversations, (item) => item.bindingId);
  const attemptsByWorkOrder = groupBy(data.attempts, (item) => item.workOrderId);
  const workOrdersByConversation = groupBy(
    data.workOrders.map((item) => ({
      ...item,
      attempts: attemptsByWorkOrder.get(item.workOrderId) ?? [],
    })),
    (item) => item.workConversationId,
  );
  const memoriesByBinding = groupBy(
    data.memories.filter((item) => !item.workConversationId),
    (item) => item.bindingId ?? '',
  );
  const memoriesByConversation = groupBy(
    data.memories.filter((item) => item.workConversationId),
    (item) => item.workConversationId ?? '',
  );
  const workspaces = groupBindings.map((binding) => {
    return {
      bindingId: binding.bindingId,
      conversationSpace: {
        conversationSpaceId: binding.conversationSpaceId,
        conversationId: binding.conversationId,
      },
      workConversations: (conversationsByBinding.get(binding.bindingId) ?? []).map(
        (conversation) => ({
          ...conversation,
          workOrders: workOrdersByConversation.get(conversation.workConversationId) ?? [],
          memories: memoriesByConversation.get(conversation.workConversationId) ?? [],
        }),
      ),
      memories: memoriesByBinding.get(binding.bindingId) ?? [],
    };
  });
  return {
    bindings: input.bindings.map((binding) => {
      const agent = input.agentStore.get(binding.agentId);
      return {
        ...binding,
        effectiveConfigComputation: {
          publishedAgent: {
            skillIds: agent?.allowedSkills ?? [],
            knowledgeSkillIds: agent?.allowedKnowledge ?? [],
            sourceIds: input.contextCeiling.publishedSourceIds,
            executionMode: agent?.runtime?.executionMode ?? 'unavailable',
            enabled: agent?.enabled === true,
          },
          channelCeiling: {
            toolNames: [...input.frontdeskTools].sort(),
            contextSourceIds: input.contextCeiling.channelSourceIds,
          },
          groupNarrowing: binding.effectiveConfig,
          liveOverrides: {
            bindingEnabled: binding.enabled && binding.activationState === 'active',
            liveDeny: binding.policy.liveDeny,
            accountStatus: input.account.status,
          },
        },
      };
    }),
    workspaces,
    deliveries: input.deliveries.map(toPublicDeliveryRecord),
  };
}

function toPublicDeliveryRecord(record: DwsDeliveryIntent): Record<string, unknown> {
  const providerEvidence = sanitizeProviderEvidence(record.providerReceipt);
  return {
    deliveryId: record.deliveryId,
    inboxId: record.inboxId ?? null,
    conversationId: record.conversationId,
    workConversationId: record.workConversationId ?? null,
    source: record.source,
    deliveryKind: record.deliveryKind,
    disposition: record.disposition,
    content: record.content,
    sourceWorkOrderId: record.sourceWorkOrderId ?? null,
    sourceAttemptId: record.sourceAttemptId ?? null,
    deliveryState: record.deliveryState,
    attempt: record.attempt,
    technicalEvidence: {
      receiptPresent: Boolean(record.providerReceipt),
      ...(Object.keys(providerEvidence).length ? { provider: providerEvidence } : {}),
      ...(record.lastError ? { lastErrorCode: compactPublicErrorCode(record.lastError) } : {}),
      leaseFence: record.leaseFence,
      providerAttemptPhase: record.providerAttemptPhase,
      providerStartedAt: record.providerStartedAt ?? null,
      nextAttemptAt: record.nextAttemptAt ?? null,
    },
    lastAttemptAt: record.lastAttemptAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt ?? null,
  };
}

function sanitizeProviderEvidence(receipt?: Record<string, unknown>) {
  if (!receipt) return {};
  const allowed = new Set(['provider', 'status', 'statusCode', 'code', 'success']);
  return Object.fromEntries(
    Object.entries(receipt).flatMap(([key, value]) => {
      if (!allowed.has(key) || !['string', 'number', 'boolean'].includes(typeof value)) return [];
      return [[key, typeof value === 'string' ? value.slice(0, 120) : value]];
    }),
  ) as Record<string, string | number | boolean>;
}

function compactPublicErrorCode(error: string): string {
  return error.match(/\b[A-Z][A-Z0-9_]{2,80}\b/)?.[0] ?? 'DELIVERY_ERROR';
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = grouped.get(key);
    if (group) group.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}
