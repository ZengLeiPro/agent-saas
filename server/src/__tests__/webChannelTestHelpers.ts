import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { TenantStore } from '../data/tenants/store.js';
import type { RunRecord, RunStatus, RunStore, UpsertRunInput } from '../runtime/runStore.js';

export class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: Array<{ data: any; eventId?: number }> = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
}

export class MemoryRunStore implements RunStore {
  records = new Map<string, RunRecord>();

  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      userId: input.userId,
      submitterUserId: input.submitterUserId ?? input.userId,
      tenantId: input.tenantId,
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
    this.records.set(input.runId, record);
    return record;
  }

  async markStatus(
    runId: string,
    status: RunStatus,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    const updated = {
      ...record,
      status,
      statusReason: reason,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async claimPersistedInteractionResume(
    runId: string,
    expectedStatuses: readonly RunStatus[],
    reason: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || !expectedStatuses.includes(record.status)) return null;
    const updated = {
      ...record,
      status: 'pending' as const,
      statusReason: reason,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch, schedulerState: 'staged' },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async listStagedPersistedInteractionResumes(limit = 50): Promise<RunRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.status === 'pending'
        && record.metadata?.schedulerState === 'staged'
        && record.metadata?.persistedInteractionResumeClaim
        && typeof record.metadata.persistedInteractionResumeClaim === 'object')
      .slice(0, limit);
  }

  async activatePersistedInteractionResume(runId: string, claim: Record<string, unknown>, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (
      !record || record.status !== 'pending' || record.metadata?.schedulerState !== 'staged'
      || !claimMatches(record.metadata?.persistedInteractionResumeClaim, claim)
    ) return null;
    const updated = {
      ...record,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch, schedulerState: 'ready' },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async rollbackPersistedInteractionResume(
    runId: string,
    claim: Record<string, unknown>,
    waitingStatus: 'waiting_user' | 'waiting_approval',
    reason?: string,
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (
      !record || record.status !== 'pending' || record.metadata?.schedulerState !== 'staged'
      || !claimMatches(record.metadata?.persistedInteractionResumeClaim, claim)
    ) return null;
    const {
      schedulerState: _schedulerState,
      persistedInteractionResumeClaim: _claim,
      resumeInteraction: _resumeInteraction,
      resumeApproval: _resumeApproval,
      resumeInteractionConsumedAt: _resumeInteractionConsumedAt,
      resumeInteractionConsumedId: _resumeInteractionConsumedId,
      resumeApprovalConsumedAt: _resumeApprovalConsumedAt,
      resumeApprovalConsumedId: _resumeApprovalConsumedId,
      ...metadata
    } = record.metadata ?? {};
    const updated = {
      ...record,
      status: waitingStatus,
      statusReason: reason,
      workerId: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
      metadata,
    };
    this.records.set(runId, updated);
    return updated;
  }

  async markStatusIfCurrent(
    runId: string,
    expectedStatuses: readonly RunStatus[],
    status: RunStatus,
    reason?: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || !expectedStatuses.includes(record.status)) return null;
    const updated = {
      ...record,
      status,
      statusReason: reason,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.records.set(runId, updated);
    return updated;
  }

  async get(runId: string): Promise<RunRecord | null> {
    return this.records.get(runId) ?? null;
  }

  async findByIdempotencyKey(userId: string | undefined, key: string): Promise<RunRecord | null> {
    const scope = userId ?? '__anonymous__';
    return [...this.records.values()].find(
      (record) => record.idempotencyKey === key
        && (record.submitterUserId ?? record.userId ?? '__anonymous__') === scope,
    ) ?? null;
  }

  async listRecoverable(): Promise<RunRecord[]> {
    return [...this.records.values()].filter((record) => (
      (record.status === 'pending' || record.status === 'running')
      && !(record.status === 'pending' && record.metadata?.schedulerState === 'staged')
    ));
  }

  async getActiveBySession(sessionId: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) =>
      record.sessionId === sessionId
      && ['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(record.status),
    ) ?? null;
  }
}

function claimMatches(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => (actual as Record<string, unknown>)[key] === value);
}

export function wsClient(
  ws: FakeWebSocket,
  user?: { sub: string; username: string; role: 'user' | 'admin'; tenantId: string },
) {
  return {
    ws: ws as any,
    user,
    alive: true,
    connectedAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

export function chatMessage(overrides: Record<string, unknown>) {
  return {
    action: 'chat' as const,
    client_msg_id: `cov-msg-${randomUUID().slice(0, 12)}`,
    message: 'hi',
    ...overrides,
  } as any;
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

export function enabledTenantStore(): TenantStore {
  return {
    findById: (id: string) => ({ id, name: id, disabled: false }),
    getSettings: () => ({ features: {}, models: {} }),
  } as unknown as TenantStore;
}
