import type { PlatformEvent } from './types.js';
import type { RunRecord } from './runStoreTypes.js';
import { normalizeRunPersistenceState } from './runStoreRecord.js';

export function serializeRuntimeEvent(event: PlatformEvent): string {
  const serialized = JSON.stringify(event, (_key, value) => (
    typeof value === 'string' && value.includes('\u0000')
      ? value.replaceAll('\u0000', '\\u0000')
      : value
  ));
  if (serialized === undefined) throw new Error('runtime event 无法序列化为 JSON');
  return serialized;
}

export function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
export function parseCount(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}
export function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function normalizeRunRecord(raw: any): RunRecord {
  return {
    runId: raw.run_id ?? raw.runId,
    sessionId: raw.session_id ?? raw.sessionId,
    userId: raw.user_id ?? raw.userId ?? undefined,
    submitterUserId: raw.submitter_scope ?? raw.submitterUserId ?? undefined,
    tenantId: raw.tenant_id ?? raw.tenantId ?? undefined,
    status: raw.status,
    statusReason: raw.status_reason ?? raw.statusReason ?? undefined,
    model: raw.model ?? undefined,
    channel: raw.channel ?? undefined,
    requestedAt: new Date(raw.requested_at ?? raw.requestedAt).toISOString(),
    startedAt: raw.started_at ? new Date(raw.started_at).toISOString() : raw.startedAt ?? undefined,
    updatedAt: new Date(raw.updated_at ?? raw.updatedAt).toISOString(),
    completedAt: raw.completed_at ? new Date(raw.completed_at).toISOString() : raw.completedAt ?? undefined,
    failedAt: raw.failed_at ? new Date(raw.failed_at).toISOString() : raw.failedAt ?? undefined,
    cancelledAt: raw.cancelled_at ? new Date(raw.cancelled_at).toISOString() : raw.cancelledAt ?? undefined,
    workerId: raw.worker_id ?? raw.workerId ?? undefined,
    leaseExpiresAt: raw.lease_expires_at ? new Date(raw.lease_expires_at).toISOString() : raw.leaseExpiresAt ?? undefined,
    idempotencyKey: raw.idempotency_key ?? raw.idempotencyKey ?? undefined,
    executionTarget: raw.execution_target ?? raw.executionTarget ?? undefined,
    workspaceId: raw.workspace_id ?? raw.workspaceId ?? undefined,
    ...normalizeRunPersistenceState(raw),
  };
}
