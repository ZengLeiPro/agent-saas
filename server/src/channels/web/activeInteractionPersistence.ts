import type { InteractionResponse } from '../../agent/types.js';
import { findTranscriptOrMetaPathBySessionId } from '../../data/transcripts/index.js';
import { readSessionMeta } from '../../data/transcripts/meta.js';
import { FileEventStore, getRuntimeEventLogPath } from '../../runtime/fileEventStore.js';
import type { EventStore, PlatformEvent } from '../../runtime/types.js';
import type { PendingInteraction } from './interactionStore.js';
import { chatLogger } from '../../utils/logger.js';
import { appendPersistedInteractionResolved, persistedInteractionEventId } from './channelRuntimeHelpers.js';

export async function appendActiveInteractionResolved(options: {
  sessionId: string;
  interactionId: string;
  pendingInteraction: PendingInteraction;
  response: InteractionResponse;
  tenantId?: string;
  userId?: string;
  runtimeEventStoreFor?: (transcriptPath: string, tenantId: string) => EventStore;
}): Promise<Extract<PlatformEvent, { type: 'interaction_resolved' }>> {
  const { sessionId, interactionId, pendingInteraction, response, tenantId, userId } = options;
  const transcriptPath = await findTranscriptOrMetaPathBySessionId(sessionId);
  if (!transcriptPath) throw new Error(`Session transcript not found: ${sessionId}`);
  const resolvedTenantId = tenantId ?? (await readSessionMeta(transcriptPath))?.tenantId;
  if (!resolvedTenantId) throw new Error('EventStore tenantId is required');
  const eventStore = options.runtimeEventStoreFor
    ? options.runtimeEventStoreFor(transcriptPath, resolvedTenantId)
    : new FileEventStore(getRuntimeEventLogPath(transcriptPath), resolvedTenantId);
  return appendPersistedInteractionResolved(eventStore, resolvedTenantId, {
    id: persistedInteractionEventId(sessionId, interactionId),
    type: 'interaction_resolved', sessionId,
    ...(pendingInteraction.runId ? { runId: pendingInteraction.runId } : {}),
    ...(pendingInteraction.toolCallId ? { toolCallId: pendingInteraction.toolCallId } : {}),
    ...(pendingInteraction.invocationId ? { invocationId: pendingInteraction.invocationId } : {}),
    interactionId, interactionType: pendingInteraction.type,
    ...(userId ? { userId } : {}), response,
  });
}

/**
 * 交互到期的统一处置：落库 `interaction_resolved` + 下发 ws 事件。
 *
 * 从 `channel.ts` 的 `onInteraction` 内联闭包外提（该文件顶在 max-lines 棘轮上）。
 * `reason` 可由调用方覆盖 —— WP3 §6.2-2 的写操作确认超时要说
 * 「操作已取消，未写入任何数据」，而不是通用的「等待用户响应超时」。
 */
export function createInteractionExpiryHandler(options: {
  sessionId: string | undefined;
  interactionId: string;
  tenantId: string | undefined;
  userId: string | undefined;
  runtimeEventStoreFor: Parameters<typeof appendActiveInteractionResolved>[0]['runtimeEventStoreFor'];
  reason?: string;
  send: (payload: Record<string, unknown>) => void;
}): (expired: PendingInteraction) => void {
  return (expired) => {
    const { sessionId, interactionId } = options;
    if (!sessionId) return;
    const reason = options.reason ?? '等待用户响应超时，交互已过期';
    const response = { message: reason };
    void appendActiveInteractionResolved({
      sessionId,
      interactionId,
      pendingInteraction: expired,
      response,
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      runtimeEventStoreFor: options.runtimeEventStoreFor,
    }).catch((error) =>
      chatLogger.warn(
        `expired interaction persistence failed interaction=${interactionId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    options.send({
      type: 'interaction_resolved',
      sessionId,
      interactionId,
      status: 'expired',
      response,
      reason,
      retryable: false,
    });
  };
}
