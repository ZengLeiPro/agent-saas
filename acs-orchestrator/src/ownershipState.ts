import { createHash } from 'node:crypto';
import type { AcsOrchestratorConfig } from './config.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import { parseRemoteFence, type RemoteAttemptFence } from './remoteAttemptProtocol.js';

export const OWNERSHIP_PROTOCOL = 1 as const;
export const OWNERSHIP_JOURNAL_NAME = 'acs-operation-ownership-v1';
export const OWNERSHIP_LIMITS = Object.freeze({ records: 128, bytes: 512 * 1024, diagnosticBytes: 2048 });
export type ResourceOwnership = 'reserved' | 'running' | 'stop_requested' | 'unknown' | 'stopped' | 'not_started' | 'background_owned';
export type OperationOutcome = 'pending' | 'success' | 'failed' | 'cancelled' | 'timed_out';
export type OperationKind = 'invocation' | 'provision' | 'ensure' | 'warmup' | 'receiver';

export interface WritableScope {
  storageId: string;
  mountSubPath: string;
  sandboxName: string;
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
}

export interface OwnershipRecord {
  protocolVersion: 1;
  operationId: string;
  attemptId: string;
  invocationId: string;
  ownerId: string;
  revision: number;
  kind: OperationKind;
  scope: WritableScope;
  resource: ResourceOwnership;
  outcome: OperationOutcome;
  phase: string;
  createdAt: string;
  updatedAt: string;
  sandboxUid?: string;
  phaseDeadlineAt?: string;
  /** An exact control-plane fence, persisted before dispatch. Contains no key. */
  remoteFence?: RemoteAttemptFence;
  /** A coordinator cannot release or forget its independently owned child work. */
  parentOperationId?: string;
  /** Fixed diagnostic code, not raw exceptions, commands, output or environment. */
  reasonCode?: string;
}

export class OwnershipBlockedError extends Error {
  readonly statusCode = 409;
  readonly code = 'ownership_unresolved';
  constructor(readonly operationId?: string) {
    super('Writable scope has unresolved or conflicting ownership');
    this.name = 'OwnershipBlockedError';
  }
}

export class OwnershipUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'ownership_unavailable';
  constructor(message = 'Ownership inventory is unavailable or incompatible') {
    super(message);
    this.name = 'OwnershipUnavailableError';
  }
}

export function writableScope(config: AcsOrchestratorConfig, ref: SandboxRef): WritableScope {
  return {
    storageId: createHash('sha256').update(`${config.namespace}:${config.pvcName ?? config.hostWorkspaceRoot ?? 'unconfigured'}`).digest('hex'),
    mountSubPath: normalizeWritablePath(ref.mountSubPath),
    sandboxName: ref.name,
    workspaceId: ref.workspaceId,
    sessionId: ref.sessionId,
    sandboxScopeId: ref.sandboxScopeId ?? ref.workspaceId,
  };
}

export function normalizeWritablePath(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) throw new OwnershipUnavailableError('Invalid writable scope');
  const parts = value.split('/');
  if (parts.some((part) => part === '..')) throw new OwnershipUnavailableError('Invalid writable scope');
  const normalized = parts.filter((part) => part && part !== '.').join('/');
  if (!normalized) throw new OwnershipUnavailableError('Invalid writable scope');
  return normalized;
}

export function scopesOverlap(left: WritableScope, right: WritableScope): boolean {
  if (left.storageId !== right.storageId) return false;
  const a = normalizeWritablePath(left.mountSubPath);
  const b = normalizeWritablePath(right.mountSubPath);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function ownershipIsTerminal(record: OwnershipRecord): boolean {
  return record.resource === 'stopped' || record.resource === 'not_started';
}

function validIdentifier(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}

export function validateOwnershipRecords(value: unknown): OwnershipRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OwnershipUnavailableError();
  const envelope = value as { protocolVersion?: unknown; records?: unknown };
  if (envelope.protocolVersion !== OWNERSHIP_PROTOCOL || !Array.isArray(envelope.records)
    || envelope.records.length > OWNERSHIP_LIMITS.records) throw new OwnershipUnavailableError();
  const ids = new Set<string>();
  const resources: ResourceOwnership[] = ['reserved', 'running', 'stop_requested', 'unknown', 'stopped', 'not_started', 'background_owned'];
  const outcomes: OperationOutcome[] = ['pending', 'success', 'failed', 'cancelled', 'timed_out'];
  const kinds: OperationKind[] = ['invocation', 'provision', 'ensure', 'warmup', 'receiver'];
  const records = envelope.records.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OwnershipUnavailableError();
    const record = raw as OwnershipRecord;
    const strings = [record.operationId, record.attemptId, record.invocationId, record.ownerId, record.phase];
    if (record.protocolVersion !== 1 || strings.some((part) => !validIdentifier(part))
      || !Number.isSafeInteger(record.revision) || record.revision < 0
      || !resources.includes(record.resource) || !outcomes.includes(record.outcome) || !kinds.includes(record.kind)
      || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))
      || !record.scope || typeof record.scope !== 'object' || Array.isArray(record.scope)) throw new OwnershipUnavailableError();
    for (const key of ['storageId', 'mountSubPath', 'sandboxName', 'workspaceId', 'sessionId', 'sandboxScopeId'] as const) {
      if (!validIdentifier(record.scope[key], 1024)) throw new OwnershipUnavailableError();
    }
    normalizeWritablePath(record.scope.mountSubPath);
    if (ids.has(record.operationId)) throw new OwnershipUnavailableError();
    ids.add(record.operationId);
    if (record.reasonCode !== undefined && !/^[a-z0-9_:-]{1,128}$/.test(record.reasonCode)) throw new OwnershipUnavailableError();
    if (record.sandboxUid !== undefined && !validIdentifier(record.sandboxUid, 128)) throw new OwnershipUnavailableError();
    if (record.phaseDeadlineAt !== undefined && !Number.isFinite(Date.parse(record.phaseDeadlineAt))) throw new OwnershipUnavailableError();
    if (record.parentOperationId !== undefined && (!validIdentifier(record.parentOperationId) || record.parentOperationId === record.operationId)) throw new OwnershipUnavailableError();
    if (record.remoteFence !== undefined) {
      const fence = parseRemoteFence(record.remoteFence);
      if (!fence || fence.operationId !== record.operationId || fence.attemptId !== record.attemptId
        || fence.ownerId !== record.ownerId || fence.sandboxUid !== record.sandboxUid) throw new OwnershipUnavailableError();
    }
    return structuredClone(record);
  });
  const byId = new Map(records.map((record) => [record.operationId, record]));
  for (const record of records) {
    const ancestors = new Set([record.operationId]);
    let parent = record.parentOperationId;
    while (parent) {
      if (ancestors.has(parent)) throw new OwnershipUnavailableError('Ownership ancestry is cyclic');
      ancestors.add(parent);
      const item = byId.get(parent);
      if (item && item.ownerId !== record.ownerId) throw new OwnershipUnavailableError('Ownership ancestry crosses owner generations');
      parent = item?.parentOperationId;
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > OWNERSHIP_LIMITS.bytes) throw new OwnershipUnavailableError('Ownership journal exceeds its byte budget');
  return records;
}
