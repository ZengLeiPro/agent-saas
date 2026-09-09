export interface RemoteAttemptFence {
  protocolVersion: 1;
  operationId: string;
  attemptId: string;
  ownerId: string;
  sandboxUid: string;
  podUid: string;
  /** Admission expiry only; never the execution or deployment-drain deadline. */
  startBeforeMs: number;
}

export interface RemoteAttemptReceipt {
  protocolVersion: 1;
  fence: RemoteAttemptFence;
  resource: 'reserved' | 'running' | 'stop_requested' | 'unknown' | 'stopped' | 'not_started' | 'background_owned';
  observedAtMs: number;
  proof?: 'subreaper_no_children' | 'background_inventory' | 'never_launched';
  background?: { kind: 'shell' | 'dws'; tasks?: Array<{ taskId: string; pid: number; startTime: string }>; protectedUntil?: string; receiverId?: string };
}

export const REMOTE_ATTEMPT_CAPABILITIES = ['isolated-attempt-v1', 'durable-receipt-v1'] as const;
export const REMOTE_CONTROL_FRAME_BYTES = 4 * 1024 * 1024;

export function sameRemoteFence(left: RemoteAttemptFence, right: RemoteAttemptFence): boolean {
  return left.protocolVersion === 1 && right.protocolVersion === 1
    && left.operationId === right.operationId && left.attemptId === right.attemptId
    && left.ownerId === right.ownerId && left.sandboxUid === right.sandboxUid
    && left.podUid === right.podUid && left.startBeforeMs === right.startBeforeMs;
}

export function parseRemoteReceipt(value: unknown, fence: RemoteAttemptFence): RemoteAttemptReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.protocolVersion !== 1 || !raw.fence || typeof raw.fence !== 'object'
    || !sameRemoteFence(raw.fence as RemoteAttemptFence, fence)
    || typeof raw.observedAtMs !== 'number' || !Number.isSafeInteger(raw.observedAtMs)
    || !['reserved', 'running', 'stop_requested', 'unknown', 'stopped', 'not_started', 'background_owned'].includes(String(raw.resource))) return null;
  if (raw.resource === 'stopped' && raw.proof !== 'subreaper_no_children') return null;
  if (raw.resource === 'not_started' && raw.proof !== 'never_launched') return null;
  if (raw.resource === 'background_owned' && (raw.proof !== 'background_inventory' || !raw.background)) return null;
  return raw as unknown as RemoteAttemptReceipt;
}
