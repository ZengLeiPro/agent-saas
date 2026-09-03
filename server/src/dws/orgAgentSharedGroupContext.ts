import type { AgentDwsAccountRecord } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord } from '../data/agentDwsMessages/index.js';
import {
  type OrgAgentChannelActorRef,
  type OrgAgentChannelBinding,
  type OrgAgentMemory,
  type OrgAgentWorkConversation,
  type OrgAgentWorkOrder,
  type OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import { deriveAgentWorkspaceId } from '../runtime/workspaceIdentity.js';
import type { UserIdentity } from '../types/index.js';
import { ORG_AGENT_ROUTING_FIELD_NAMES } from './orgAgentInboxRouting.js';
import { resolveOrgAgentConversationRouteHint } from './orgAgentConversationRouting.js';

export interface SharedGroupContext {
  binding: OrgAgentChannelBinding;
  workConversation: OrgAgentWorkConversation;
  externalActor: OrgAgentChannelActorRef;
  requester: UserIdentity | null;
  completionWork?: OrgAgentWorkOrder;
  governanceRole?: 'member' | 'org_admin';
  routingClarification?: string;
  visibleWorkOrders: OrgAgentWorkOrder[];
  memories: OrgAgentMemory[];
}

export type SharedGroupResolution =
  | { state: 'legacy' }
  | { state: 'ignored' }
  | { state: 'denied'; reason: string }
  | { state: 'active'; context: SharedGroupContext };

export interface SharedGroupContextResolverOptions {
  orgGroupAgentStore?: OrgGroupAgentStore;
  resolveRequesterGovernanceRole?: (
    tenantId: string,
    userId: string,
  ) => Promise<'member' | 'org_admin' | undefined> | 'member' | 'org_admin' | undefined;
  isOrgAgentRuntimeV2Ready?: () => boolean;
}

export async function resolveSharedGroupContext(
  options: SharedGroupContextResolverOptions,
  account: AgentDwsAccountRecord,
  item: AgentDwsInboxRecord,
  requester: UserIdentity | null,
  senderName?: string,
): Promise<SharedGroupResolution> {
  if (!options.orgGroupAgentStore || item.eventType !== 'user_im_message_receive_at')
    return { state: 'legacy' };
  const store = options.orgGroupAgentStore;
  const binding = await store.ensureShadowBinding({
    tenantId: account.tenantId,
    accountId: account.accountId,
    agentId: account.agentId,
    conversationId: item.conversationId,
    channelKind: 'group',
    workspaceId: deriveAgentWorkspaceId(account.tenantId, account.agentId),
  });
  if (binding.policy.liveDeny) return { state: 'denied', reason: 'ORG_AGENT_CHANNEL_LIVE_DENY' };
  if (binding.activationState === 'disabled')
    return { state: 'denied', reason: 'ORG_AGENT_CHANNEL_DISABLED' };
  if (binding.activationState === 'shadow') return { state: 'legacy' };
  if (!binding.enabled || !binding.policy.enabled)
    return { state: 'denied', reason: 'ORG_AGENT_CHANNEL_DISABLED' };
  if (options.isOrgAgentRuntimeV2Ready?.() !== true)
    return { state: 'denied', reason: 'ORG_AGENT_RUNTIME_PROTOCOL_UNAVAILABLE' };
  const serviceEvent = item.payload.source === 'background_task_completion';
  if (!serviceEvent && !item.senderOpenDingtalkId)
    return { state: 'denied', reason: 'REQUESTER_IDENTITY_MISSING' };
  const governanceRole =
    !serviceEvent && requester
      ? await options.resolveRequesterGovernanceRole?.(binding.tenantId, requester.id)
      : undefined;
  if (!serviceEvent && requester && !governanceRole)
    return { state: 'denied', reason: 'ORG_AGENT_ACTIVE_MEMBERSHIP_REQUIRED' };
  if (
    !serviceEvent &&
    binding.effectiveConfig.access.triggerRoles.length > 0 &&
    (!governanceRole || !binding.effectiveConfig.access.triggerRoles.includes(governanceRole))
  ) {
    return { state: 'denied', reason: 'ORG_AGENT_TRIGGER_ROLE_DENIED' };
  }
  let serviceWork: OrgAgentWorkOrder | undefined;
  if (serviceEvent) {
    const workOrderId =
      typeof item.payload.workOrderId === 'string' ? item.payload.workOrderId : '';
    const attemptId = typeof item.payload.attemptId === 'string' ? item.payload.attemptId : '';
    const fence = Number.isSafeInteger(item.payload.attemptFence)
      ? Number(item.payload.attemptFence)
      : 0;
    const work = workOrderId ? await store.getWorkOrder(account.tenantId, workOrderId) : null;
    const attempt = work
      ? (await store.listWorkAttempts(account.tenantId, workOrderId)).find(
          (candidate) => candidate.attemptId === attemptId,
        )
      : undefined;
    if (
      !work ||
      !attempt ||
      work.bindingId !== binding.bindingId ||
      attempt.runtimeRunId !== item.payload.backgroundTaskId ||
      attempt.attemptNo !== fence ||
      work.currentAttemptNo !== fence ||
      work.state !== attempt.status ||
      !['completed', 'failed', 'cancelled'].includes(work.state)
    )
      return { state: 'ignored' };
    serviceWork = work;
  }
  const externalActor: OrgAgentChannelActorRef = serviceEvent
    ? {
        kind: 'service_event',
        issuer: 'runtime',
        workOrderId: String(
          item.payload.workOrderId ?? item.payload.backgroundTaskId ?? item.eventId,
        ),
        attemptId: String(item.payload.attemptId ?? item.payload.backgroundTaskId ?? item.eventId),
        fence: Number.isSafeInteger(item.payload.attemptFence)
          ? Number(item.payload.attemptFence)
          : 0,
      }
    : {
        kind: 'external_user',
        provider: 'dingtalk',
        corpId: account.corpId!,
        openId: item.senderOpenDingtalkId!,
        ...(senderName ? { displayName: senderName } : {}),
        ...(requester
          ? { mappedUserId: requester.id, role: governanceRole!, assurance: 'mapped' as const }
          : { assurance: 'unmapped' as const }),
      };
  if (
    serviceWork?.visibility === 'requester_only' &&
    (serviceWork.createdByActor.provider !== 'dingtalk' ||
      serviceWork.createdByActor.corpId !== account.corpId ||
      !serviceWork.createdByActor.openId.trim())
  )
    return { state: 'ignored' };
  const referencedMessages = routingMessageIds(item);
  const deterministicPinnedId = item.workConversationId ?? serviceWork?.workConversationId;
  const deterministicPinnedConversation = deterministicPinnedId
    ? await store.getWorkConversation(account.tenantId, deterministicPinnedId)
    : null;
  if (
    deterministicPinnedConversation &&
    deterministicPinnedConversation.bindingId !== binding.bindingId
  )
    return { state: 'denied', reason: 'ORG_AGENT_WORK_CONVERSATION_BINDING_MISMATCH' };
  const referencedConversation =
    deterministicPinnedConversation ??
    (await store.findWorkConversationByMessage({
      tenantId: account.tenantId,
      bindingId: binding.bindingId,
      accountId: account.accountId,
      conversationId: item.conversationId,
      messageIds: referencedMessages,
    }));
  const routeHint =
    externalActor.kind === 'external_user'
      ? await resolveOrgAgentConversationRouteHint({
          store,
          tenantId: account.tenantId,
          agentId: binding.agentId,
          bindingId: binding.bindingId,
          ...(referencedConversation
            ? { workConversationId: referencedConversation.workConversationId }
            : {}),
          content: item.content,
          actor: externalActor,
        })
      : {};
  const routedConversation =
    !referencedConversation && routeHint.workOrder
      ? await store.getWorkConversation(account.tenantId, routeHint.workOrder.workConversationId)
      : null;
  const pinnedConversation = referencedConversation ?? routedConversation;
  if (pinnedConversation && pinnedConversation.bindingId !== binding.bindingId)
    return { state: 'denied', reason: 'ORG_AGENT_WORK_CONVERSATION_BINDING_MISMATCH' };
  const rootKey = referencedMessages[0] ?? item.messageId ?? item.eventId;
  const workConversation =
    pinnedConversation ??
    (await store.getOrCreateWorkConversation({
      tenantId: account.tenantId,
      bindingId: binding.bindingId,
      rootKey,
      ...(item.messageId ? { rootMessageId: item.messageId } : {}),
    }));
  const [agentMemories, conversationMemories] = await Promise.all([
    store.listMemories({
      tenantId: binding.tenantId,
      agentId: binding.agentId,
      memoryScope: 'agent',
      status: 'active',
      limit: 20,
    }),
    store.listMemories({
      tenantId: binding.tenantId,
      agentId: binding.agentId,
      bindingId: binding.bindingId,
      workConversationId: workConversation.workConversationId,
      memoryScope: 'conversation',
      status: 'active',
      limit: 20,
    }),
  ]);
  const visibleWorkOrders = (await store.listWorkOrders(binding.tenantId, binding.bindingId, 30))
    .filter((work) => work.workConversationId === workConversation.workConversationId)
    .filter(
      (work) =>
        externalActor.kind === 'external_user' &&
        ((work.visibility === 'conversation' && externalActor.assurance === 'mapped') ||
          (work.createdByActor.corpId === externalActor.corpId &&
            work.createdByActor.openId === externalActor.openId)),
    );
  await store.pinInboxContext({
    inboxId: item.inboxId,
    externalActor,
    conversationSpaceId: binding.conversationSpaceId,
    workConversationId: workConversation.workConversationId,
    policyRevision: binding.revision,
  });
  return {
    state: 'active',
    context: {
      binding,
      workConversation,
      externalActor,
      requester,
      ...(serviceWork ? { completionWork: serviceWork } : {}),
      ...(governanceRole ? { governanceRole } : {}),
      ...(routeHint.clarification ? { routingClarification: routeHint.clarification } : {}),
      visibleWorkOrders,
      memories: [...agentMemories, ...conversationMemories],
    },
  };
}

function routingMessageIds(item: AgentDwsInboxRecord): string[] {
  const routing = item.payload.routing;
  if (routing && typeof routing === 'object' && !Array.isArray(routing)) {
    const record = routing as Record<string, unknown>;
    for (const key of ORG_AGENT_ROUTING_FIELD_NAMES) {
      const value = record[key];
      if (typeof value === 'string' && value) return [value];
    }
  }
  return [];
}
