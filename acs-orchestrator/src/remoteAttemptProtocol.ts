import { createHmac, timingSafeEqual } from 'node:crypto';

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

export interface RemoteProcessIdentity {
  pid: number;
  startTime: string;
}

export interface RemoteAttemptReceipt {
  protocolVersion: 1;
  fence: RemoteAttemptFence;
  resource: 'reserved' | 'running' | 'stop_requested' | 'unknown' | 'stopped' | 'not_started' | 'background_owned';
  observedAtMs: number;
  proof?: 'subreaper_no_children' | 'background_inventory' | 'never_launched';
  background?: {
    kind: 'shell' | 'dws';
    tasks?: Array<RemoteProcessIdentity & { taskId: string }>;
    protectedUntil?: string;
    receiverId?: string;
    source?: RemoteProcessIdentity;
  };
}

export interface RemoteReceiptEnvelope {
  envelopeVersion: 1;
  payload: string;
  signature: string;
}

export const REMOTE_ATTEMPT_CAPABILITIES = [
  'isolated-attempt-v1', 'durable-receipt-v1', 'signed-receipt-v1',
] as const;
export const REMOTE_CONTROL_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const ID_KEYS = ['operationId', 'attemptId', 'ownerId', 'sandboxUid', 'podUid'] as const;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}

export function parseRemoteFence(value: unknown): RemoteAttemptFence | null {
  if (!object(value) || value.protocolVersion !== 1
    || ID_KEYS.some((key) => !identity(value[key]))
    || typeof value.startBeforeMs !== 'number' || !Number.isSafeInteger(value.startBeforeMs)
    || value.startBeforeMs <= 0) return null;
  return {
    protocolVersion: 1, operationId: value.operationId as string, attemptId: value.attemptId as string,
    ownerId: value.ownerId as string, sandboxUid: value.sandboxUid as string,
    podUid: value.podUid as string, startBeforeMs: value.startBeforeMs,
  };
}

export function sameRemoteFence(left: RemoteAttemptFence, right: RemoteAttemptFence): boolean {
  const a = parseRemoteFence(left);
  const b = parseRemoteFence(right);
  return Boolean(a && b && ID_KEYS.every((key) => a[key] === b[key]) && a.startBeforeMs === b.startBeforeMs);
}

/**
 * Recoverable across ACS restarts without persisting credentials in the journal.
 * Only this per-attempt derivative crosses the control pipe; the ACS bearer token
 * never enters the sandbox. Rotation of that token requires the documented
 * reader/receipt-key migration, not treating unverifiable receipts as empty.
 */
export function deriveRemoteReceiptKey(authToken: string, fence: RemoteAttemptFence): string {
  if (!authToken || !parseRemoteFence(fence)) throw new Error('Remote receipt authority is unavailable');
  const input = JSON.stringify([1, ...ID_KEYS.map((key) => fence[key]), fence.startBeforeMs]);
  return createHmac('sha256', authToken).update('acs-remote-receipt-v1\0').update(input).digest('hex');
}

/** Shared by the TypeScript reader and the sandbox's standard-library writer. */
export function signRemoteDocument(value: unknown, key: string): RemoteReceiptEnvelope {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid receipt key');
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('Receipt exceeds its byte budget');
  const payload = bytes.toString('base64');
  return {
    envelopeVersion: 1, payload,
    signature: createHmac('sha256', Buffer.from(key, 'hex')).update(payload, 'ascii').digest('hex'),
  };
}

export function authenticateRemoteDocument(value: unknown, key: string | undefined): Record<string, unknown> | null {
  if (!key || !/^[a-f0-9]{64}$/.test(key) || !object(value) || value.envelopeVersion !== 1
    || typeof value.payload !== 'string' || value.payload.length === 0
    || value.payload.length > Math.ceil(MAX_RECEIPT_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.payload)
    || typeof value.signature !== 'string' || !/^[a-f0-9]{64}$/.test(value.signature)) return null;
  const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(value.payload, 'ascii').digest();
  if (!timingSafeEqual(expected, Buffer.from(value.signature, 'hex'))) return null;
  try {
    const bytes = Buffer.from(value.payload, 'base64');
    if (bytes.length > MAX_RECEIPT_BYTES || bytes.toString('base64') !== value.payload) return null;
    const decoded: unknown = JSON.parse(bytes.toString('utf8'));
    return object(decoded) ? decoded : null;
  } catch { return null; }
}

function processIdentity(value: unknown): value is RemoteProcessIdentity {
  return object(value) && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 1
    && typeof value.startTime === 'string' && /^[0-9]{1,32}$/.test(value.startTime);
}

function validBackground(value: unknown): value is NonNullable<RemoteAttemptReceipt['background']> {
  if (!object(value) || typeof value.protectedUntil !== 'string'
    || !Number.isFinite(Date.parse(value.protectedUntil))) return false;
  if (value.kind === 'shell') {
    return Array.isArray(value.tasks) && value.tasks.length > 0 && value.tasks.length <= 128
      && value.tasks.every((task) => processIdentity(task) && object(task)
        && typeof task.taskId === 'string' && /^shell-bg-[A-Za-z0-9_-]{1,160}$/.test(task.taskId));
  }
  return value.kind === 'dws' && typeof value.receiverId === 'string'
    && /^drx-[A-Za-z0-9-]{1,100}$/.test(value.receiverId) && processIdentity(value.source);
}

/** An unsigned, malformed or foreign document can only retain a blocker. */
export function parseRemoteReceipt(value: unknown, fence: RemoteAttemptFence, key?: string): RemoteAttemptReceipt | null {
  const raw = authenticateRemoteDocument(value, key);
  if (!raw || raw.protocolVersion !== 1 || !object(raw.fence)
    || !sameRemoteFence(raw.fence as unknown as RemoteAttemptFence, fence)
    || typeof raw.observedAtMs !== 'number' || !Number.isSafeInteger(raw.observedAtMs) || raw.observedAtMs <= 0
    || typeof raw.resource !== 'string'
    || !['reserved', 'running', 'stop_requested', 'unknown', 'stopped', 'not_started', 'background_owned'].includes(raw.resource)) return null;
  if (raw.resource === 'stopped' && raw.proof !== 'subreaper_no_children') return null;
  if (raw.resource === 'not_started' && raw.proof !== 'never_launched') return null;
  if (raw.resource === 'background_owned' && (raw.proof !== 'background_inventory' || !validBackground(raw.background))) return null;
  if (raw.resource !== 'background_owned' && raw.background !== undefined) return null;
  return raw as unknown as RemoteAttemptReceipt;
}
