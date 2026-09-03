import {
  CHAT_QUEUE_SNAPSHOT_VERSION,
  type ChatQueueAttachment,
  type ChatQueueItem,
  type ChatQueueSnapshot,
  type ChatQueueStatus,
} from '@agent/shared';
import { parseCanonicalChatSubmission } from '@agent/shared';
import type { RunRecord } from '../../runtime/runStoreTypes.js';
import { projectRunLiveness, type RunLiveness } from '../../runtime/runLiveness.js';

function stringMetadata(run: RunRecord, key: string): string | undefined {
  const value = run.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberMetadata(run: RunRecord, key: string): number | undefined {
  const value = run.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function projectChatQueueStatus(run: RunRecord): ChatQueueStatus {
  if (run.status === 'completed') return 'completed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'failed' || run.status === 'orphaned') return 'failed';
  if (run.metadata?.steeringState === 'applied') return 'steered';
  if (run.status === 'running' || run.status === 'waiting_approval'
    || run.status === 'waiting_user' || run.status === 'waiting_hand') return 'running';
  return 'queued';
}

function projectAttachments(run: RunRecord): ChatQueueAttachment[] | undefined {
  const parsed = parseCanonicalChatSubmission(run.metadata?.chatSubmission);
  if (!parsed.ok || parsed.value.attachments.length === 0) return undefined;
  return parsed.value.attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    name: attachment.display.originalName,
    ...(attachment.display.size !== undefined ? { size: attachment.display.size } : {}),
    ...(attachment.display.mimeType ? { mimeType: attachment.display.mimeType } : {}),
    ...(attachment.display.isImage !== undefined ? { isImage: attachment.display.isImage } : {}),
  }));
}

/** Project one accepted chat submission; internal runs with an idempotency key are not messages. */
export type ServerChatQueueItem = ChatQueueItem & { liveness: RunLiveness };
export type ServerChatQueueSnapshot = Omit<ChatQueueSnapshot, 'items'> & { items: ServerChatQueueItem[] };

export function projectChatQueueItem(
  run: RunRecord,
  queuePosition?: number,
): ServerChatQueueItem | undefined {
  const parsed = parseCanonicalChatSubmission(run.metadata?.chatSubmission);
  const wakeMessage = run.metadata?.wakeMessage as { content?: unknown } | undefined;
  const legacyContent = typeof wakeMessage?.content === 'string' ? wakeMessage.content : undefined;
  const clientMsgId = parsed.ok
    ? parsed.value.clientMsgId
    : legacyContent !== undefined ? stringMetadata(run, 'clientMsgId') : undefined;
  if (!clientMsgId) return undefined;
  const deliveryMode = run.metadata?.deliveryMode === 'steer' ? 'steer' : 'queue';
  const targetRunId = deliveryMode === 'steer'
    ? stringMetadata(run, 'steeringTargetRunId')
    : stringMetadata(run, 'queuedBehindRunId');
  const persistedPosition = numberMetadata(run, 'queuePosition');
  const attachments = projectAttachments(run);
  const content = parsed.ok
    ? parsed.value.text
    : legacyContent;
  return {
    sessionId: run.sessionId,
    clientMsgId,
    runId: run.runId,
    sourceRunId: run.runId,
    deliveryMode,
    status: projectChatQueueStatus(run),
    ...(persistedPosition !== undefined
      ? { queuePosition: persistedPosition }
      : queuePosition !== undefined ? { queuePosition } : {}),
    ...(targetRunId ? { targetRunId } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(attachments ? { attachments } : {}),
    acceptedAt: stringMetadata(run, 'acceptedAt') ?? run.requestedAt,
    updatedAt: run.updatedAt,
    ...(run.statusReason ? { reason: run.statusReason } : {}),
    liveness: projectRunLiveness(run),
  };
}

/** Unified M20-02 snapshot. Ordering and lifecycle come only from durable RunStore records. */
export function buildChatQueueSnapshot(
  sessionId: string,
  runs: readonly RunRecord[],
  generatedAt = new Date().toISOString(),
): ServerChatQueueSnapshot {
  let pendingPosition = 0;
  const items = runs.flatMap((run) => {
    if (run.sessionId !== sessionId) return [];
    const status = projectChatQueueStatus(run);
    const item = projectChatQueueItem(run, status === 'queued' ? pendingPosition : undefined);
    if (!item) return [];
    if (status === 'queued') pendingPosition += 1;
    return [item];
  });
  return { version: CHAT_QUEUE_SNAPSHOT_VERSION, sessionId, items, generatedAt };
}
