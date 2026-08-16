import { createHash } from 'crypto';
import type { RunRecord } from '../../runtime/runStore.js';

type ChatSubmissionAckStatus = 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export function deriveSubmissionSessionId(userScope: string, clientMessageId: string): string {
  const hex = createHash('sha256')
    .update(userScope)
    .update('\0')
    .update(clientMessageId)
    .digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function resolveAuthoritativeSubmissionState(run: RunRecord): {
  status: ChatSubmissionAckStatus;
  deliveryMode: 'queue' | 'steer';
  streamId?: string;
  queuedTargetRunId?: string;
} {
  const deliveryMode = run.metadata?.deliveryMode === 'steer' ? 'steer' : 'queue';
  const streamId = typeof run.metadata?.streamId === 'string' && run.metadata.streamId
    ? run.metadata.streamId
    : undefined;
  if (run.status === 'completed') return { status: 'completed', deliveryMode, ...(streamId ? { streamId } : {}) };
  if (run.status === 'cancelled') return { status: 'cancelled', deliveryMode, ...(streamId ? { streamId } : {}) };
  if (run.status === 'failed' || run.status === 'orphaned') {
    return { status: 'failed', deliveryMode, ...(streamId ? { streamId } : {}) };
  }
  if (run.status !== 'pending') return { status: 'running', deliveryMode, ...(streamId ? { streamId } : {}) };

  const steeringTargetRunId = typeof run.metadata?.steeringTargetRunId === 'string'
    && run.metadata.steeringState === 'pending'
    ? run.metadata.steeringTargetRunId
    : undefined;
  const queuedBehindRunId = typeof run.metadata?.queuedBehindRunId === 'string'
    ? run.metadata.queuedBehindRunId
    : undefined;
  const queuedTargetRunId = steeringTargetRunId ?? queuedBehindRunId;
  return {
    status: queuedTargetRunId ? 'queued' : 'accepted',
    deliveryMode,
    ...(streamId ? { streamId } : {}),
    ...(queuedTargetRunId ? { queuedTargetRunId } : {}),
  };
}
