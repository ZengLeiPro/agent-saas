import type { AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import {
  mergeOrgAgentWorkerRuntimePolicy,
  type OrgAgentRuntimePolicy,
} from '../data/orgAgents/runtimePolicy.js';
import type { AgentRuntimeProfileResolver } from '../runtime/agentProfiles.js';
import type { BackgroundTaskRuntime } from '../runtime/background/backgroundTaskRuntime.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';

interface DispatcherValidationDeps {
  backgroundTasks?: BackgroundTaskRuntime;
  profileResolver?: AgentRuntimeProfileResolver;
  defaultModelResolver?: (tenantId: string) => { ref: string } | null | undefined;
  modelResolver?: RawRuntimeRunDispatchConfig['modelResolver'];
}

export function createOrgAgentDispatcherRuntimeValidator(deps: DispatcherValidationDeps) {
  return async (tenantId: string, policy: OrgAgentRuntimePolicy): Promise<string[]> => {
    if (policy.executionMode !== 'dispatcher') return [];
    const blockers = new Set<string>();
    if (!deps.backgroundTasks) blockers.add('DISPATCHER_BACKGROUND_RUNTIME_UNAVAILABLE');
    if (!deps.profileResolver) blockers.add('DISPATCHER_PROFILE_RUNTIME_UNAVAILABLE');
    if (!deps.profileResolver) return [...blockers];

    const orgProfile = await deps.profileResolver.resolveForSession({
      existingSession: null,
      bindingKey: 'org_agent',
    });
    if (!orgProfile.version.config.capabilities.subagents)
      blockers.add('DISPATCHER_AGENT_CAPABILITY_DISABLED');
    if (!orgProfile.version.config.capabilities.backgroundTasks)
      blockers.add('DISPATCHER_BACKGROUND_CAPABILITY_DISABLED');
    for (const tool of ['Agent', 'BackgroundTask']) {
      if (
        orgProfile.version.config.tools.allowlist &&
        !orgProfile.version.config.tools.allowlist.includes(tool)
      )
        blockers.add(`DISPATCHER_REQUIRED_TOOL_MISSING:${tool}`);
      if (orgProfile.version.config.tools.denylist.includes(tool))
        blockers.add(`DISPATCHER_REQUIRED_TOOL_DENIED:${tool}`);
    }
    for (const bindingKey of ['background_general', 'background_explore'] as const) {
      const profile = await deps.profileResolver.resolveForSession({
        existingSession: null,
        bindingKey,
      });
      const effective = mergeOrgAgentWorkerRuntimePolicy(profile.version.config, policy);
      const modelRef =
        effective.model.strategy === 'fixed'
          ? effective.model.modelRef
          : deps.defaultModelResolver?.(tenantId)?.ref;
      const resolved = modelRef ? deps.modelResolver?.(modelRef, tenantId) : null;
      const hasConnection = Boolean(
        resolved &&
        (resolved.connection?.apiKey ||
          resolved.providerOptions?.responsesTransport === 'codex_subscription' ||
          process.env.OPENAI_API_KEY),
      );
      if (!resolved || !hasConnection)
        blockers.add(`DISPATCHER_WORKER_MODEL_UNAVAILABLE:${bindingKey}`);
    }
    return [...blockers];
  };
}

type DwsBackgroundCompletionInput = Parameters<
  NonNullable<RawRuntimeRunDispatchConfig['enqueueDwsBackgroundCompletion']>
>[0];

export function createDwsBackgroundCompletionEnqueuer(
  messageStore: AgentDwsMessageStore,
  orgGroupAgentStore?: RawRuntimeRunDispatchConfig['orgGroupAgentStore'],
): NonNullable<RawRuntimeRunDispatchConfig['enqueueDwsBackgroundCompletion']> {
  return async (input: DwsBackgroundCompletionInput): Promise<void> => {
    if (input.profileId !== `${input.corpId}:${input.dingtalkUserId}`) {
      throw new Error('Agent DWS background completion account identity is invalid');
    }
    let pinnedConversation:
      | Awaited<ReturnType<NonNullable<typeof orgGroupAgentStore>['getWorkConversation']>>
      | undefined;
    let pinnedBinding:
      Awaited<ReturnType<NonNullable<typeof orgGroupAgentStore>['getBinding']>> | undefined;
    const hasOrgWorkIdentity = Boolean(
      input.workOrderId ||
      input.attemptId ||
      input.attemptFence !== undefined ||
      input.workConversationId,
    );
    if (hasOrgWorkIdentity) {
      if (
        !orgGroupAgentStore ||
        !input.workOrderId ||
        !input.attemptId ||
        input.attemptFence === undefined ||
        !input.workConversationId
      ) {
        throw new Error('Agent DWS background completion organization identity is incomplete');
      }
      const [conversation, binding, work, attempts] = await Promise.all([
        orgGroupAgentStore.getWorkConversation(input.tenantId, input.workConversationId),
        orgGroupAgentStore.getBinding(input.tenantId, input.accountId, input.conversationId),
        orgGroupAgentStore.getWorkOrder(input.tenantId, input.workOrderId),
        orgGroupAgentStore.listWorkAttempts(input.tenantId, input.workOrderId),
      ]);
      const attempt = attempts.find((candidate) => candidate.attemptId === input.attemptId);
      if (
        !conversation ||
        !binding ||
        !work ||
        !attempt ||
        conversation.bindingId !== binding.bindingId ||
        work.bindingId !== binding.bindingId ||
        work.agentId !== binding.agentId ||
        work.workConversationId !== conversation.workConversationId ||
        attempt.workOrderId !== work.workOrderId ||
        attempt.runtimeRunId !== input.taskId ||
        attempt.attemptNo !== input.attemptFence ||
        work.currentAttemptNo !== input.attemptFence ||
        work.state !== attempt.status ||
        !['completed', 'failed', 'cancelled'].includes(work.state)
      ) {
        throw new Error('Agent DWS background completion work identity is invalid');
      }
      pinnedConversation = conversation;
      pinnedBinding = binding;
    }
    const ingested = await messageStore.ingest(
      {
        tenantId: input.tenantId,
        accountId: input.accountId,
        eventId: `background-task-completion:${input.taskId}`,
        eventType: input.eventType,
        conversationId: input.conversationId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.senderOpenDingtalkId ? { senderOpenDingtalkId: input.senderOpenDingtalkId } : {}),
        content: input.content,
        eventTimestamp: new Date(),
      },
      {
        schemaVersion: 2,
        source: 'background_task_completion',
        backgroundTaskId: input.taskId,
        ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.attemptFence !== undefined ? { attemptFence: input.attemptFence } : {}),
        ...(input.workConversationId ? { workConversationId: input.workConversationId } : {}),
        accountIdentity: {
          profileId: input.profileId,
          corpId: input.corpId,
          dingtalkUserId: input.dingtalkUserId,
        },
      },
    );
    if (pinnedConversation && pinnedBinding && orgGroupAgentStore) {
      await orgGroupAgentStore.pinInboxRouting({
        inboxId: ingested.record.inboxId,
        conversationSpaceId: pinnedBinding.conversationSpaceId,
        workConversationId: pinnedConversation.workConversationId,
        policyRevision: pinnedBinding.revision,
      });
    }
  };
}
