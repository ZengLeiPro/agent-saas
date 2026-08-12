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

  async get(runId: string): Promise<RunRecord | null> {
    return this.records.get(runId) ?? null;
  }

  async findByIdempotencyKey(userId: string | undefined, key: string): Promise<RunRecord | null> {
    return [...this.records.values()].find(
      (record) => record.idempotencyKey === key && record.userId === userId,
    ) ?? null;
  }

  async listRecoverable(): Promise<RunRecord[]> {
    return [];
  }

  async getActiveBySession(sessionId: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) =>
      record.sessionId === sessionId
      && ['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(record.status),
    ) ?? null;
  }
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
