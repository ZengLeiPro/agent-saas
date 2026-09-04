import { describe, expect, it, vi } from 'vitest';

import { HandHealthScanner } from '../runtime/handHealthScanner.js';
import {
  PROVISION_ATTEMPT_LEASE_MS,
  PROVISION_ATTEMPT_RENEW_INTERVAL_MS,
  type HandRecord,
  type HandStatus,
  type HandStore,
  type RegisterHandInput,
} from '../runtime/handStore.js';
import { ensureRuntimeHandRegistered } from '../runtime/runtimeHandRegistration.js';

class LeaseMemoryHandStore implements HandStore {
  readonly records = new Map<string, HandRecord>();
  rejectRenewals = false;

  async register(input: RegisterHandInput): Promise<HandRecord> {
    const previous = this.records.get(input.handId);
    const now = new Date().toISOString();
    const record: HandRecord = {
      handId: input.handId,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: input.status ?? 'ready',
      endpoint: input.endpoint,
      capabilities: input.capabilities ?? [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      metadata: { ...(previous?.metadata ?? {}), ...(input.metadata ?? {}) },
    };
    this.records.set(input.handId, record);
    return record;
  }

  async updateStatus(handId: string, status: HandStatus, patch: Record<string, unknown> = {}): Promise<HandRecord | null> {
    const record = this.records.get(handId);
    if (!record) return null;
    const updated = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...patch },
    };
    this.records.set(handId, updated);
    return updated;
  }

  async renewProvisionAttemptLease(handId: string, generation: string, owner: string): Promise<HandRecord | null> {
    if (this.rejectRenewals) return null;
    const record = this.records.get(handId);
    if (!record || record.status !== 'provisioning'
      || record.metadata.provisionGeneration !== generation
      || record.metadata.provisionAttemptOwner !== owner
      || typeof record.metadata.provisionAttemptLeaseExpiresAtMs !== 'number'
      || record.metadata.provisionAttemptLeaseExpiresAtMs <= Date.now()) return null;
    return await this.updateStatus(handId, 'provisioning', {
      provisionAttemptLeaseExpiresAtMs: Date.now() + PROVISION_ATTEMPT_LEASE_MS,
    });
  }

  async completeProvisionAttempt(
    handId: string,
    generation: string,
    status: HandStatus,
    patch: Record<string, unknown> = {},
    _tenantId?: string,
    owner?: string,
  ): Promise<HandRecord | null> {
    const record = this.records.get(handId);
    if (!record || record.status !== 'provisioning' || record.metadata.provisionGeneration !== generation
      || (owner && (record.metadata.provisionAttemptOwner !== owner
        || typeof record.metadata.provisionAttemptLeaseExpiresAtMs !== 'number'
        || record.metadata.provisionAttemptLeaseExpiresAtMs <= Date.now()))) return null;
    return await this.updateStatus(handId, status, {
      ...patch,
      provisionAttemptOwner: null,
      provisionAttemptClaimedAtMs: null,
      provisionAttemptLeaseExpiresAtMs: null,
    });
  }

  async claimProvisionRecovery(
    handId: string,
    token: string,
    patch: Record<string, unknown> = {},
    expectedUpdatedAt?: string,
    expectedGeneration?: string,
  ): Promise<HandRecord | null> {
    const record = this.records.get(handId);
    if (!record || !['provisioning', 'ready', 'unhealthy'].includes(record.status)
      || record.metadata.reconcileRequired === true
      || (expectedUpdatedAt && record.updatedAt !== expectedUpdatedAt)
      || (expectedGeneration && record.metadata.provisionGeneration !== expectedGeneration)) return null;
    if (record.status === 'provisioning') {
      const owner = record.metadata.provisionAttemptOwner;
      const expiresAt = record.metadata.provisionAttemptLeaseExpiresAtMs;
      if (typeof owner === 'string' && (typeof expiresAt !== 'number' || expiresAt >= Date.now())) return null;
    }
    return await this.updateStatus(handId, 'unhealthy', {
      ...patch,
      provisionRecoveryToken: token,
      provisionRecoveryClaimedAtMs: Date.now(),
      provisionAttemptOwner: null,
      provisionAttemptClaimedAtMs: null,
      provisionAttemptLeaseExpiresAtMs: null,
    });
  }

  async completeProvisionRecovery(handId: string, token: string, status: HandStatus, patch: Record<string, unknown> = {}) {
    const record = this.records.get(handId);
    if (!record || record.status !== 'unhealthy' || record.metadata.provisionRecoveryToken !== token) return null;
    return await this.updateStatus(handId, status, {
      ...patch,
      provisionRecoveryToken: null,
      provisionRecoveryClaimedAtMs: null,
    });
  }

  async get(handId: string) { return this.records.get(handId) ?? null; }
  async listBySession(sessionId: string) { return [...this.records.values()].filter((record) => record.sessionId === sessionId); }
  async listByWorkspace(workspaceId: string) { return [...this.records.values()].filter((record) => record.workspaceId === workspaceId); }
  async listByType(type: HandRecord['type'], options?: { status?: HandStatus }) {
    return [...this.records.values()].filter((record) => record.type === type
      && (!options?.status || record.status === options.status));
  }
}

function registrationParams(handStore: LeaseMemoryHandStore, provision: () => Promise<{ status: 'ok' | 'error'; error?: string }>) {
  return {
    handStore,
    eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
    executionTransportRegistry: {
      has: () => true,
      get: () => ({ listInternalTools: () => [], provision }),
    } as never,
    executionTarget: 'server-remote' as const,
    sessionId: 'lease-session',
    workspaceId: 'lease-workspace',
    tenantId: 'lease-tenant',
  };
}

describe('runtime Hand provision owner lease', () => {
  it('renews beyond the original five minutes, blocks scanner takeover, and persists late transport failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-02T00:00:00.000Z'));
    try {
      const store = new LeaseMemoryHandStore();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const provision = vi.fn(async () => { await gate; throw new Error('late transport failure'); });
      const registration = ensureRuntimeHandRegistered(registrationParams(store, provision));
      await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(PROVISION_ATTEMPT_LEASE_MS + PROVISION_ATTEMPT_RENEW_INTERVAL_MS);
      const inFlight = [...store.records.values()][0]!;
      expect(inFlight.metadata.provisionAttemptLeaseExpiresAtMs).toBeGreaterThan(Date.now());
      const fetchImpl = vi.fn() as never;
      const scanner = new HandHealthScanner({ handStore: store, fetchImpl });
      expect(await scanner.scanOnce()).toEqual({ scanned: 1, flipped: 0 });
      expect(store.records.get(inFlight.handId)?.status).toBe('provisioning');
      expect(fetchImpl).not.toHaveBeenCalled();

      release();
      await expect(registration).rejects.toThrow('HAND_PROVISION_FAILED:late transport failure');
      expect(store.records.get(inFlight.handId)).toMatchObject({
        status: 'unhealthy', metadata: { provisionFailure: 'late transport failure', provisionAttemptOwner: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows scanner recovery only after renewal stops and the owner lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-02T01:00:00.000Z'));
    try {
      const store = new LeaseMemoryHandStore();
      const now = new Date().toISOString();
      store.records.set('stopped-owner', {
        handId: 'stopped-owner', tenantId: 'lease-tenant', workspaceId: 'lease-workspace',
        type: 'server-remote', status: 'provisioning', capabilities: [], createdAt: now, updatedAt: now,
        metadata: {
          provisionGeneration: 'stopped-generation', provisionAttemptOwner: 'dead-process',
          provisionAttemptLeaseExpiresAtMs: Date.now() + PROVISION_ATTEMPT_LEASE_MS,
        },
      });
      const scanner = new HandHealthScanner({ handStore: store, fetchImpl: vi.fn() as never });
      expect(await scanner.scanOnce()).toEqual({ scanned: 1, flipped: 0 });
      expect(store.records.get('stopped-owner')?.status).toBe('provisioning');

      await vi.advanceTimersByTimeAsync(PROVISION_ATTEMPT_LEASE_MS + 1);
      expect(await scanner.scanOnce()).toEqual({ scanned: 1, flipped: 0 });
      expect(store.records.get('stopped-owner')).toMatchObject({
        status: 'unhealthy', metadata: { provisionRecoveryToken: expect.any(String), provisionAttemptOwner: null },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the original transport discovers renewal ownership loss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-02T02:00:00.000Z'));
    try {
      const store = new LeaseMemoryHandStore();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const provision = vi.fn(async () => { await gate; return { status: 'ok' as const }; });
      const registration = ensureRuntimeHandRegistered(registrationParams(store, provision));
      await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce());
      store.rejectRenewals = true;
      await vi.advanceTimersByTimeAsync(PROVISION_ATTEMPT_RENEW_INTERVAL_MS);
      release();

      await expect(registration).rejects.toThrow('HAND_PROVISION_AUTHORITY_LOST:lease renewal rejected');
      expect([...store.records.values()][0]?.status).toBe('provisioning');
    } finally {
      vi.useRealTimers();
    }
  });
});
