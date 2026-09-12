import { createHash } from 'crypto';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';
import type { RunRecord, RunStore } from '../../runtime/runStore.js';
import { buildStructuredError, canonicalFailureLogRecord } from '../../runtime/structuredError.js';
import { chatLogger } from '../../utils/logger.js';
import { isPlatformAdminUser } from './channelHelpers.js';
import type { WsClient } from './wsServer.js';

type ChatSubmissionAckStatus = 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export function buildChatSubmissionUnknownFrame(clientMsgId: string): object {
  const { failure, payload } = buildStructuredError({ source: 'ws', code: 'unknown' });
  chatLogger.warn(JSON.stringify(canonicalFailureLogRecord({ failure, source: 'ws' })));
  return { type: 'error', ...payload, client_msg_id: clientMsgId, submissionState: 'unknown' };
}

export async function findDurableSubmissionForReplay(
  runStore: RunStore | undefined,
  user: WsClient['user'],
  clientMsgId: string,
): Promise<RunRecord | null | undefined> {
  if (!runStore) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const lookup = async (): Promise<RunRecord | null> => {
    let run = await runStore.findByIdempotencyKey(
      user?.tenantId ?? DEFAULT_TENANT_ID,
      user?.sub,
      clientMsgId,
    );
    if (!run && user && isPlatformAdminUser(user)) {
      run = await runStore.findUniqueByIdempotencyKeyAcrossTenants?.(user.sub, clientMsgId) ?? null;
    }
    return run;
  };
  try {
    return await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('submission_lookup_timeout')), 5_000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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
