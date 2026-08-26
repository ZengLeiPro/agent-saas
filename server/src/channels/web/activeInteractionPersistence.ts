import type { InteractionResponse } from '../../agent/types.js';
import { findTranscriptOrMetaPathBySessionId } from '../../data/transcripts/index.js';
import { readSessionMeta } from '../../data/transcripts/meta.js';
import { FileEventStore, getRuntimeEventLogPath } from '../../runtime/fileEventStore.js';
import type { EventStore, PlatformEvent } from '../../runtime/types.js';
import type { PendingInteraction } from './interactionStore.js';
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
