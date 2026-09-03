import type { RunRecord, RunStatus, RunStore, UpsertRunInput } from '../runtime/runStore.js';
import {
  SCHEDULER_STATE_METADATA_KEY,
  SCHEDULER_STATE_READY,
  SCHEDULER_STATE_STAGED,
} from '../runtime/scheduler.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

const TEST_TENANT_ID = 'test-tenant';

export class MemoryRunStore implements RunStore {
  records = new Map<string, RunRecord>();

  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      userId: input.userId,
      tenantId: input.tenantId ?? TEST_TENANT_ID,
      status: 'pending',
      model: input.model,
      channel: input.channel,
      requestedAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      executionTarget: input.executionTarget,
      workspaceId: input.workspaceId,
      metadata: input.metadata ?? {},
    };
    this.records.set(record.runId, record);
    return record;
  }

  async createPending(input: UpsertRunInput): Promise<{ record: RunRecord; created: boolean }> {
    const existing = this.records.get(input.runId);
    if (existing) return { record: existing, created: false };
    return { record: await this.upsertPending(input), created: true };
  }

  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    const updated = { ...record, status, statusReason: reason, updatedAt: new Date().toISOString(), metadata: { ...record.metadata, ...metadataPatch } };
    this.records.set(runId, updated);
    return updated;
  }

  async activateStagedRun(runId: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    if (
      record.status !== 'pending'
      || record.metadata?.[SCHEDULER_STATE_METADATA_KEY] !== SCHEDULER_STATE_STAGED
    ) return record;
    const updated: RunRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_READY },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async stagePendingRun(runId: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    if (
      record.status !== 'pending'
      || record.metadata?.taskboardExecution !== true
      || record.metadata?.[SCHEDULER_STATE_METADATA_KEY] !== undefined
    ) return record;
    const updated: RunRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, [SCHEDULER_STATE_METADATA_KEY]: SCHEDULER_STATE_STAGED },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async cancelPendingTaskboardRun(runId: string, reason: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    if (
      record.status !== 'pending'
      || record.metadata?.taskboardExecution !== true
    ) return record;
    const now = new Date().toISOString();
    const { wakeMessage: _wakeMessage, ...metadata } = record.metadata;
    const updated: RunRecord = {
      ...record,
      status: 'cancelled',
      statusReason: reason,
      updatedAt: now,
      cancelledAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
      metadata,
    };
    this.records.set(runId, updated);
    return updated;
  }

  async get(runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }

  async findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) =>
      record.idempotencyKey === idempotencyKey && record.userId === userId,
    ) ?? null;
  }

  async listRecoverable(): Promise<RunRecord[]> {
    return [...this.records.values()]
      .filter((record) => (
        (record.status === 'pending' || record.status === 'running')
        && !(record.status === 'pending'
          && record.metadata?.[SCHEDULER_STATE_METADATA_KEY] === SCHEDULER_STATE_STAGED)
        && !(record.metadata?.backgroundTaskVersion === 2
          && record.metadata?.backgroundTaskReady !== true)
      ))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async listStaleWaitingApproval(cutoff: Date, limit = 50): Promise<RunRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'waiting_approval' && new Date(record.updatedAt) < cutoff)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }

  async cancelStaleWaitingApproval(
    runId: string,
    cutoff: Date,
    reason: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.status !== 'waiting_approval' || new Date(record.updatedAt) >= cutoff) return null;
    const now = new Date().toISOString();
    const updated: RunRecord = {
      ...record,
      status: 'cancelled',
      statusReason: reason,
      updatedAt: now,
      cancelledAt: now,
      workerId: undefined,
      leaseExpiresAt: undefined,
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async acquireLease(runId: string, workerId: string, leaseMs: number, now = new Date()): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    // 忠实复刻 pgRunStore.acquireLease 的原子 CAS 守卫（runStore.ts:433-437）：
    //   status='pending' OR (status='running' AND (lease_expires_at IS NULL OR lease_expires_at < now))
    // 只有满足其一才能夺得 lease；running 且 lease 未过期 → 返回 null（互斥）。
    const leaseExpired =
      record.leaseExpiresAt === undefined ||
      record.leaseExpiresAt === null ||
      new Date(record.leaseExpiresAt) < now;
    const acquirable = record.status === 'pending' || (record.status === 'running' && leaseExpired);
    const stagedPending = record.status === 'pending'
      && record.metadata?.[SCHEDULER_STATE_METADATA_KEY] === SCHEDULER_STATE_STAGED;
    const stagedBackgroundTask = record.metadata?.backgroundTaskVersion === 2
      && record.metadata?.backgroundTaskReady !== true;
    if (!acquirable || stagedPending || stagedBackgroundTask) return null;
    const updated: RunRecord = {
      ...record,
      status: 'running',
      workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    this.records.set(runId, updated);
    return updated;
  }

  async renewLease(runId: string, workerId: string, leaseMs: number, now = new Date()): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.workerId !== workerId) return null;
    const requestedExpiry = now.getTime() + leaseMs;
    const currentExpiry = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : Number.NEGATIVE_INFINITY;
    const updated = {
      ...record,
      leaseExpiresAt: new Date(Math.max(currentExpiry, requestedExpiry)).toISOString(),
      updatedAt: new Date(Math.max(Date.parse(record.updatedAt), now.getTime())).toISOString(),
    };
    this.records.set(runId, updated);
    return updated;
  }

  async releaseLease(runId: string, workerId: string, finalStatus?: RunStatus, reason?: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.workerId !== workerId) return null;
    const updated: RunRecord = {
      ...record,
      status: finalStatus ?? record.status,
      statusReason: reason,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(runId, updated);
    return updated;
  }
}

export class MemoryEventStore implements EventStore {
  events: PlatformEvent[] = [];
  private readonly eventsByTenant = new Map<string, PlatformEvent[]>();
  appendContexts: Array<Parameters<EventStore['append']>[1]> = [];
  async append(event: PlatformEventInput, ctx: Parameters<EventStore['append']>[1]): Promise<PlatformEvent> {
    const full = { ...event, id: `e${this.events.length + 1}`, timestamp: new Date().toISOString() } as PlatformEvent;
    this.appendContexts.push(ctx);
    this.events.push(full);
    const tenantEvents = this.eventsByTenant.get(ctx.tenantId) ?? [];
    tenantEvents.push(full);
    this.eventsByTenant.set(ctx.tenantId, tenantEvents);
    return full;
  }
  async list(tenantId: string, sessionId: string): Promise<PlatformEvent[]> {
    return (this.eventsByTenant.get(tenantId) ?? []).filter((event) => event.sessionId === sessionId);
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
