import type { ChannelContext } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { RunRecord, RunStore } from '../runStore.js';
import { buildTaskNotification } from './backgroundTaskFormatting.js';
import type {
  BackgroundTaskDwsCompletionRoute,
  BackgroundTaskMetadata,
  LegacyBackgroundTaskDwsCompletionRoute,
} from './backgroundTaskMetadata.js';

const logger = createLogger('BackgroundTaskDwsCompletion');

export type ResolvedDwsCompletionRoute =
  | { version: 'none' }
  | { version: 'invalid' }
  | { version: 'exact'; route: BackgroundTaskDwsCompletionRoute };

export function resolveDwsCompletionRoute(
  parentRun: RunRecord | null | undefined,
  parentChannel: ChannelContext['channel'],
): ResolvedDwsCompletionRoute {
  if (parentChannel !== 'dingtalk') return { version: 'none' };
  const wakeMessage = parentRun?.metadata.wakeMessage;
  if (!wakeMessage || typeof wakeMessage !== 'object' || Array.isArray(wakeMessage)) return { version: 'none' };
  const wake = wakeMessage as Record<string, unknown>;
  const messageMetadata = wake.metadata;
  if (!messageMetadata || typeof messageMetadata !== 'object' || Array.isArray(messageMetadata)) {
    return { version: 'none' };
  }
  const metadata = messageMetadata as Record<string, unknown>;
  if (metadata.source !== 'agent_dws_personal_stream') return { version: 'none' };
  const accountId = typeof metadata.accountId === 'string' ? metadata.accountId : undefined;
  const profileId = typeof metadata.profileId === 'string' ? metadata.profileId : undefined;
  const corpId = typeof metadata.corpId === 'string' ? metadata.corpId : undefined;
  const dingtalkUserId = typeof metadata.dingtalkUserId === 'string' ? metadata.dingtalkUserId : undefined;
  const conversationId = typeof wake.chatId === 'string' ? wake.chatId : undefined;
  const eventType = metadata.eventType === 'user_im_message_receive_at'
    || metadata.eventType === 'user_im_message_receive_o2o_all' ? metadata.eventType : undefined;
  if (!accountId || !profileId || !corpId || !dingtalkUserId || !conversationId || !eventType
    || profileId !== `${corpId}:${dingtalkUserId}`) return { version: 'invalid' };
  return {
    version: 'exact',
    route: {
      accountId, profileId, corpId, dingtalkUserId, conversationId, eventType,
      ...(typeof metadata.messageId === 'string' ? { messageId: metadata.messageId } : {}),
      ...(typeof wake.senderId === 'string' ? { senderOpenDingtalkId: wake.senderId } : {}),
    },
  };
}

export async function deliverDwsBackgroundCompletion(input: {
  config: RawRuntimeRunDispatchConfig;
  runStore: RunStore;
  task: RunRecord;
  metadata: BackgroundTaskMetadata;
  claimToken: string;
}): Promise<boolean> {
  const { config, runStore, task, metadata, claimToken } = input;
  let route = metadata.dwsCompletionRoute;
  const legacyRoute = metadata.legacyDwsCompletionRoute;
  const routeVersion = route ? 'exact' : metadata.dwsCompletionRouteVersion;

  if (!route && !routeVersion) return false;
  if (!route && routeVersion === 'invalid') {
    return await discardUnreconciledLegacyRoute(input, 'dws_completion_route_invalid', 'invalid');
  }
  if (!task.tenantId) {
    if (legacyRoute) {
      return await discardUnreconciledLegacyRoute(input, 'dws_completion_tenant_missing', 'legacy');
    }
    await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'discarded', {
      wakeDiscardReason: 'dws_completion_tenant_missing',
    });
    return true;
  }

  if (!route && legacyRoute) {
    const reconciled = await reconcileLegacyDwsCompletionRoute(config, runStore, task, metadata, legacyRoute);
    if ('reason' in reconciled) {
      return await discardUnreconciledLegacyRoute(input, reconciled.reason, 'legacy');
    }
    route = reconciled.route;
  }
  if (!route) {
    return await discardUnreconciledLegacyRoute(input, 'dws_completion_route_invalid', routeVersion ?? 'invalid');
  }
  let workConversationId: string | undefined;
  if (metadata.workOrderId) {
    if (!config.orgGroupAgentStore || !metadata.attemptId || !metadata.attemptNo) {
      await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'discarded', {
        wakeDiscardReason: 'org_agent_completion_identity_missing',
      });
      return true;
    }
    const work = await config.orgGroupAgentStore.getWorkOrder(task.tenantId, metadata.workOrderId);
    const attempt = (await config.orgGroupAgentStore.listWorkAttempts(task.tenantId, metadata.workOrderId))
      .find(item => item.attemptId === metadata.attemptId);
    if (!work || !attempt || attempt.runtimeRunId !== task.runId
      || attempt.attemptNo !== metadata.attemptNo || work.currentAttemptNo !== attempt.attemptNo
      || work.state !== attempt.status || !['completed', 'failed', 'cancelled'].includes(work.state)) {
      await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'discarded', {
        wakeDiscardReason: 'org_agent_completion_stale_attempt',
      });
      return true;
    }
    workConversationId = work.workConversationId;
  }

  const reconciliationPatch = legacyRoute ? {
    dwsCompletionRoute: route,
    dwsCompletionReconciliation: {
      status: 'succeeded', routeVersion: 'legacy', reconciledAt: new Date().toISOString(),
    },
  } : {};
  if (!config.enqueueDwsBackgroundCompletion) {
    await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'pending', {
      ...reconciliationPatch,
      wakeDeferredReason: 'dws_completion_outbox_unavailable',
    });
    return true;
  }
  await config.enqueueDwsBackgroundCompletion({
    tenantId: task.tenantId,
    taskId: task.runId,
    ...(metadata.workOrderId ? { workOrderId: metadata.workOrderId } : {}),
    ...(metadata.attemptId ? { attemptId: metadata.attemptId } : {}),
    ...(metadata.attemptNo ? { attemptFence: metadata.attemptNo } : {}),
    ...(workConversationId ? { workConversationId } : {}),
    ...route,
    content: buildTaskNotification(task, metadata),
  });
  await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'queued', {
    ...reconciliationPatch,
    wakeRunId: `agent-dws-background-completion:${task.runId}`,
    wakeDeferredReason: null,
    lifecycleFinishedAt: new Date().toISOString(),
  });
  return true;
}

async function reconcileLegacyDwsCompletionRoute(
  config: RawRuntimeRunDispatchConfig,
  runStore: RunStore,
  task: RunRecord,
  metadata: BackgroundTaskMetadata,
  legacyRoute: LegacyBackgroundTaskDwsCompletionRoute,
): Promise<{ route: BackgroundTaskDwsCompletionRoute } | { reason: string }> {
  if (!config.resolveLegacyDwsCompletionAccount) {
    return { reason: 'dws_completion_legacy_account_store_unavailable' };
  }
  let account;
  try {
    account = await config.resolveLegacyDwsCompletionAccount(task.tenantId!, legacyRoute.accountId);
  } catch {
    return { reason: 'dws_completion_legacy_account_store_unavailable' };
  }
  if (!account) return { reason: 'dws_completion_legacy_account_missing' };
  if (account.accountId !== legacyRoute.accountId) {
    return { reason: 'dws_completion_legacy_account_identity_invalid' };
  }
  if (account.status !== 'active') return { reason: 'dws_completion_legacy_account_inactive' };
  const { profileId, corpId, dingtalkUserId } = account;
  if (!profileId || !corpId || !dingtalkUserId || profileId !== `${corpId}:${dingtalkUserId}`) {
    return { reason: 'dws_completion_legacy_account_identity_invalid' };
  }
  let parentRun: RunRecord | null;
  try {
    parentRun = await runStore.get(metadata.parentRunId);
  } catch {
    return { reason: 'dws_completion_legacy_parent_run_unavailable' };
  }
  if (!parentRun) return { reason: 'dws_completion_legacy_parent_run_missing' };
  if (parentRun.tenantId !== task.tenantId || parentRun.channel !== 'dingtalk'
    || parentRun.metadata.backgroundTask === true) {
    return { reason: 'dws_completion_legacy_parent_run_invalid' };
  }
  const parentRequestedAt = Date.parse(parentRun.requestedAt);
  const identityUpdatedAt = Date.parse(account.identityUpdatedAt ?? '');
  if (!Number.isFinite(parentRequestedAt) || !Number.isFinite(identityUpdatedAt)) {
    return { reason: 'dws_completion_legacy_identity_change_unverifiable' };
  }
  if (identityUpdatedAt > parentRequestedAt) {
    return { reason: 'dws_completion_legacy_identity_changed_since_parent_request' };
  }
  return {
    route: {
      ...legacyRoute,
      accountId: legacyRoute.accountId,
      profileId,
      corpId,
      dingtalkUserId,
    },
  };
}

async function discardUnreconciledLegacyRoute(
  input: {
    runStore: RunStore;
    task: RunRecord;
    claimToken: string;
    metadata: BackgroundTaskMetadata;
  },
  reason: string,
  routeVersion: string,
): Promise<true> {
  const accountId = input.metadata.legacyDwsCompletionRoute?.accountId
    ?? input.metadata.dwsCompletionRoute?.accountId;
  logger.warn('DWS background completion reconciliation failed', {
    reason,
    routeVersion,
    taskId: input.task.runId,
    tenantId: input.task.tenantId,
    accountId,
  });
  await input.runStore.finishBackgroundTaskWake!(input.task.runId, input.claimToken, 'discarded', {
    wakeDiscardReason: reason,
    dwsCompletionReconciliation: {
      status: 'failed', reason, routeVersion, reconciledAt: new Date().toISOString(),
    },
  });
  return true;
}
