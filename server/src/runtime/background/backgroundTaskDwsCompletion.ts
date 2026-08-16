import type { ChannelContext } from '../../types/index.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { RunRecord, RunStore } from '../runStore.js';
import { buildTaskNotification } from './backgroundTaskFormatting.js';
import type {
  BackgroundTaskDwsCompletionRoute,
  BackgroundTaskMetadata,
} from './backgroundTaskMetadata.js';

export function resolveDwsCompletionRoute(
  parentRun: RunRecord | null | undefined,
  parentChannel: ChannelContext['channel'],
): BackgroundTaskDwsCompletionRoute | undefined {
  if (parentChannel !== 'dingtalk') return undefined;
  const wakeMessage = parentRun?.metadata.wakeMessage;
  if (!wakeMessage || typeof wakeMessage !== 'object' || Array.isArray(wakeMessage)) return undefined;
  const wake = wakeMessage as Record<string, unknown>;
  const messageMetadata = wake.metadata;
  if (!messageMetadata || typeof messageMetadata !== 'object' || Array.isArray(messageMetadata)) return undefined;
  const metadata = messageMetadata as Record<string, unknown>;
  if (metadata.source !== 'agent_dws_personal_stream') return undefined;
  const accountId = typeof metadata.accountId === 'string' ? metadata.accountId : undefined;
  const conversationId = typeof wake.chatId === 'string' ? wake.chatId : undefined;
  const eventType = metadata.eventType === 'user_im_message_receive_at'
    || metadata.eventType === 'user_im_message_receive_o2o_all' ? metadata.eventType : undefined;
  if (!accountId || !conversationId || !eventType) return undefined;
  return {
    accountId, conversationId, eventType,
    ...(typeof metadata.messageId === 'string' ? { messageId: metadata.messageId } : {}),
    ...(typeof wake.senderId === 'string' ? { senderOpenDingtalkId: wake.senderId } : {}),
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
  if (!metadata.dwsCompletionRoute) return false;
  if (!task.tenantId) {
    await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'discarded', {
      wakeDiscardReason: 'dws_completion_tenant_missing',
    });
    return true;
  }
  if (!config.enqueueDwsBackgroundCompletion) {
    await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'pending', {
      wakeDeferredReason: 'dws_completion_outbox_unavailable',
    });
    return true;
  }
  await config.enqueueDwsBackgroundCompletion({
    tenantId: task.tenantId,
    taskId: task.runId,
    ...metadata.dwsCompletionRoute,
    content: buildTaskNotification(task, metadata),
  });
  await runStore.finishBackgroundTaskWake!(task.runId, claimToken, 'queued', {
    wakeRunId: `agent-dws-background-completion:${task.runId}`,
    wakeDeferredReason: null,
    lifecycleFinishedAt: new Date().toISOString(),
  });
  return true;
}
