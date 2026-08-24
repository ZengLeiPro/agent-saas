import { describe, expect, it, vi } from 'vitest';

import type {
  HandRecord,
  HandStatus,
  HandStore,
  RegisterHandInput,
} from '../runtime/handStore.js';
import { ensureRuntimeHandRegistered } from '../runtime/runtimeHandRegistration.js';

class CasMemoryHandStore implements HandStore {
  record: HandRecord | null = null;

  async register(input: RegisterHandInput): Promise<HandRecord> {
    const now = new Date().toISOString();
    this.record = {
      handId: input.handId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: input.status ?? 'ready',
      endpoint: input.endpoint,
      capabilities: input.capabilities ?? [],
      createdAt: this.record?.createdAt ?? now,
      updatedAt: now,
      metadata: { ...(this.record?.metadata ?? {}), ...(input.metadata ?? {}) },
    };
    return this.record;
  }

  async completeProvisionAttempt(
    handId: string,
    generation: string,
    status: HandStatus,
    metadata: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    if (this.record?.handId !== handId || this.record.status !== 'provisioning'
      || this.record.metadata.provisionGeneration !== generation) return null;
    return await this.updateStatus(handId, status, metadata);
  }

  async updateStatus(
    handId: string,
    status: HandStatus,
    metadata: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    if (this.record?.handId !== handId) return null;
    this.record = {
      ...this.record,
      status,
      updatedAt: new Date().toISOString(),
      metadata: { ...this.record.metadata, ...metadata },
    };
    return this.record;
  }

  async claimProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async completeProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async get(handId: string): Promise<HandRecord | null> { return this.record?.handId === handId ? this.record : null; }
  async listBySession(sessionId: string): Promise<HandRecord[]> { return this.record?.sessionId === sessionId ? [this.record] : []; }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> { return this.record?.workspaceId === workspaceId ? [this.record] : []; }
}

describe('runtime Hand normal provision generation CAS', () => {
  it('does not let an older slow failure overwrite a newer successful attempt', async () => {
    const handStore = new CasMemoryHandStore();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstProvision = vi.fn(async () => {
      markFirstStarted();
      await firstGate;
      return { status: 'error' as const, error: 'older failure' };
    });
    const secondProvision = vi.fn(async () => ({ status: 'ok' as const }));
    const base = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTarget: 'server-local' as const,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runId: 'run-1',
    };

    const first = ensureRuntimeHandRegistered({
      ...base,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [], provision: firstProvision }) } as never,
    });
    await firstStarted;
    await ensureRuntimeHandRegistered({
      ...base,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [], provision: secondProvision }) } as never,
    });
    releaseFirst();
    await expect(first).resolves.toBeUndefined();

    expect(handStore.record).toMatchObject({
      status: 'ready',
      metadata: { provisionFailure: null, provision: { lastStatus: 'ok' } },
    });
  });
});
