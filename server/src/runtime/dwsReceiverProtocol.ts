import { createHash } from 'node:crypto';

/** This cursor describes our durable spool, never upstream DWS replay. */
export const DWS_RECEIVER_PROTOCOL = 1 as const;
export const DWS_RECEIVER_LIMITS = Object.freeze({
  frameBytes: 1024 * 1024,
  pageBytes: 2 * 1024 * 1024,
  pageRecords: 32,
  spoolBytes: 128 * 1024 * 1024,
  spoolRecords: 10_000,
  rpcMs: 15_000,
  leaseMs: 60_000,
  renewMs: 20_000,
});

export interface DwsReceiverOwner {
  tenantId: string;
  accountId: string;
  receiverId: string;
  ownerId: string;
  /** PostgreSQL bigint encoded as decimal, not a lossy JavaScript number. */
  epoch: string;
  revision: number;
  expiresAtMs: number;
}

export interface DwsReceiverSource {
  accountId: string;
  receiverId: string;
  profileId: string;
  identityUpdatedAt: string;
  eventKinds: Array<'at_me' | 'all_direct'>;
}

export interface DwsReceiverWorkspace {
  id: string;
  sessionId: string;
  sandboxScopeId: string;
  mountSubPath: string;
}

export type DwsReceiverAction = 'start' | 'adopt' | 'renew' | 'status' | 'read' | 'ack' | 'stop';
export interface DwsReceiverRequest {
  protocolVersion: 1;
  action: DwsReceiverAction;
  owner: DwsReceiverOwner;
  source: DwsReceiverSource;
  workspace: DwsReceiverWorkspace;
  after?: number;
  through?: number;
  limit?: number;
}

export interface DwsSpoolFrame {
  sequence: number;
  payloadBase64: string;
  sha256: string;
  receivedAtMs: number;
}

export interface DwsReceiverSnapshot {
  protocolVersion: 1;
  accountId: string;
  receiverId: string;
  podUid: string;
  ownerEpoch: string;
  state: 'reserved' | 'running' | 'stopping' | 'stopped' | 'unknown' | 'blocked';
  highestSequence: number;
  acknowledgedSequence: number;
  sourceReady: boolean;
  sourceAlive: boolean;
  /** Always explicit until the particular upstream CLI's replay behavior is verified. */
  upstreamReplay: 'unverified';
  needsReconciliation: boolean;
  reasonCode?: string;
  proof?: 'subreaper_no_children' | 'never_launched';
  records?: DwsSpoolFrame[];
}

export class DwsReceiverProtocolError extends Error {
  readonly statusCode: number;
  constructor(readonly code: string, statusCode = 409) {
    super(code);
    this.name = 'DwsReceiverProtocolError';
    this.statusCode = statusCode;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DwsReceiverProtocolError('invalid_control_object', 400);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\s\0]/u.test(value)) {
    throw new DwsReceiverProtocolError(`invalid_${label}`, 400);
  }
  return value;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DwsReceiverProtocolError(`invalid_${label}`, 400);
  }
  return value;
}

export function parseDwsReceiverOwner(value: unknown): DwsReceiverOwner {
  const raw = object(value);
  const epoch = identifier(raw.epoch, 'owner_epoch', 19);
  if (!/^[1-9][0-9]*$/.test(epoch) || BigInt(epoch) > 9223372036854775807n) {
    throw new DwsReceiverProtocolError('invalid_owner_epoch', 400);
  }
  const receiverId = identifier(raw.receiverId, 'receiver_id');
  if (!/^drx-[a-zA-Z0-9-]{1,100}$/.test(receiverId)) throw new DwsReceiverProtocolError('invalid_receiver_id', 400);
  return {
    tenantId: identifier(raw.tenantId, 'tenant_id'), accountId: identifier(raw.accountId, 'account_id'),
    receiverId, ownerId: identifier(raw.ownerId, 'owner_id'), epoch,
    revision: integer(raw.revision, 'account_revision', 0),
    expiresAtMs: integer(raw.expiresAtMs, 'owner_expiry', 1),
  };
}

export function parseDwsReceiverRequest(value: unknown): DwsReceiverRequest {
  const raw = object(value);
  if (raw.protocolVersion !== DWS_RECEIVER_PROTOCOL) throw new DwsReceiverProtocolError('unsupported_receiver_protocol', 426);
  const action = raw.action as DwsReceiverAction;
  if (!['start', 'adopt', 'renew', 'status', 'read', 'ack', 'stop'].includes(action)) {
    throw new DwsReceiverProtocolError('invalid_receiver_action', 400);
  }
  const owner = parseDwsReceiverOwner(raw.owner);
  const sourceRaw = object(raw.source);
  const profileId = identifier(sourceRaw.profileId, 'profile_id', 512);
  if (!/^[A-Za-z0-9._:@-]+$/.test(profileId) || profileId.startsWith('-')) {
    throw new DwsReceiverProtocolError('invalid_profile_id', 400);
  }
  const identityUpdatedAt = identifier(sourceRaw.identityUpdatedAt, 'identity_updated_at');
  if (!Number.isFinite(Date.parse(identityUpdatedAt))) throw new DwsReceiverProtocolError('invalid_identity_updated_at', 400);
  const kinds = sourceRaw.eventKinds;
  if (!Array.isArray(kinds) || kinds.length < 1 || kinds.length > 2
    || kinds.some(kind => kind !== 'at_me' && kind !== 'all_direct') || new Set(kinds).size !== kinds.length) {
    throw new DwsReceiverProtocolError('invalid_event_kinds', 400);
  }
  if (sourceRaw.accountId !== owner.accountId || sourceRaw.receiverId !== owner.receiverId) {
    throw new DwsReceiverProtocolError('source_owner_mismatch', 403);
  }
  const workspaceRaw = object(raw.workspace);
  const mountSubPath = identifier(workspaceRaw.mountSubPath, 'mount_path', 1024);
  if (mountSubPath.startsWith('/') || mountSubPath.includes('\\')
    || mountSubPath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new DwsReceiverProtocolError('invalid_mount_path', 400);
  }
  const workspace: DwsReceiverWorkspace = {
    id: identifier(workspaceRaw.id, 'workspace_id'),
    sessionId: identifier(workspaceRaw.sessionId, 'session_id'),
    sandboxScopeId: identifier(workspaceRaw.sandboxScopeId, 'sandbox_scope_id'), mountSubPath,
  };
  return {
    protocolVersion: 1, action, owner,
    source: { accountId: owner.accountId, receiverId: owner.receiverId, profileId, identityUpdatedAt,
      eventKinds: [...kinds].sort() as DwsReceiverSource['eventKinds'] },
    workspace,
    ...(raw.after !== undefined ? { after: integer(raw.after, 'cursor') } : {}),
    ...(raw.through !== undefined ? { through: integer(raw.through, 'ack_cursor') } : {}),
    ...(raw.limit !== undefined ? { limit: integer(raw.limit, 'page_limit', 1, DWS_RECEIVER_LIMITS.pageRecords) } : {}),
  };
}

export function decodeDwsSpoolFrame(value: unknown): { frame: DwsSpoolFrame; bytes: Buffer } {
  const raw = object(value);
  const sequence = integer(raw.sequence, 'sequence', 1);
  const receivedAtMs = integer(raw.receivedAtMs, 'received_at', 1);
  if (typeof raw.payloadBase64 !== 'string' || raw.payloadBase64.length > Math.ceil(DWS_RECEIVER_LIMITS.frameBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.payloadBase64)) {
    throw new DwsReceiverProtocolError('invalid_spool_payload');
  }
  const bytes = Buffer.from(raw.payloadBase64, 'base64');
  if (bytes.toString('base64') !== raw.payloadBase64 || bytes.length > DWS_RECEIVER_LIMITS.frameBytes
    || typeof raw.sha256 !== 'string' || createHash('sha256').update(bytes).digest('hex') !== raw.sha256) {
    throw new DwsReceiverProtocolError('spool_payload_integrity_failed');
  }
  return { frame: { sequence, receivedAtMs, payloadBase64: raw.payloadBase64, sha256: raw.sha256 }, bytes };
}

export function parseDwsReceiverSnapshot(value: unknown, expected: DwsReceiverOwner): DwsReceiverSnapshot {
  const raw = object(value);
  if (raw.protocolVersion !== 1 || raw.accountId !== expected.accountId || raw.receiverId !== expected.receiverId
    || raw.ownerEpoch !== expected.epoch) throw new DwsReceiverProtocolError('receiver_response_fence_mismatch');
  identifier(raw.podUid, 'pod_uid');
  const highest = integer(raw.highestSequence, 'highest_sequence');
  const acknowledged = integer(raw.acknowledgedSequence, 'acknowledged_sequence', 0, highest);
  if (!['reserved', 'running', 'stopping', 'stopped', 'unknown', 'blocked'].includes(String(raw.state))
    || typeof raw.sourceReady !== 'boolean' || typeof raw.sourceAlive !== 'boolean'
    || typeof raw.needsReconciliation !== 'boolean' || raw.upstreamReplay !== 'unverified') {
    throw new DwsReceiverProtocolError('invalid_receiver_snapshot');
  }
  if (raw.state === 'stopped' && raw.proof !== 'subreaper_no_children' && raw.proof !== 'never_launched') {
    throw new DwsReceiverProtocolError('receiver_stop_unconfirmed');
  }
  if (raw.records !== undefined) {
    if (!Array.isArray(raw.records) || raw.records.length > DWS_RECEIVER_LIMITS.pageRecords
      || Buffer.byteLength(JSON.stringify(raw.records)) > DWS_RECEIVER_LIMITS.pageBytes) {
      throw new DwsReceiverProtocolError('receiver_page_limit');
    }
    let previous = acknowledged;
    for (const candidate of raw.records) {
      const { frame } = decodeDwsSpoolFrame(candidate);
      if (frame.sequence !== previous + 1 || frame.sequence > highest) throw new DwsReceiverProtocolError('receiver_cursor_gap');
      previous = frame.sequence;
    }
  }
  return raw as unknown as DwsReceiverSnapshot;
}
