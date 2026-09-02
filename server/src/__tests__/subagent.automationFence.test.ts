import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HandRecord, HandStatus, RegisterHandInput } from '../runtime/handStore.js';
import { SUBAGENT_TYPES } from '../runtime/subagent/agentTypes.js';
import { SubagentLimiter } from '../runtime/subagent/subagentLimits.js';
import { runSubagent } from '../runtime/subagent/subagentRunner.js';
import { TextOnlyAdapter } from './helpers/subagentModelAdapters.js';
import { makeFixture, runnerDeps } from './helpers/subagentTestFixture.js';
import { MemoryRunStore } from './webChannelTestHelpers.js';

describe('runSubagent automation fence races', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('clear落在live check→durable lease后：真实runner终态化child并释放launch resource', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({
      runId: fixture.parentRunId,
      sessionId: fixture.parentSessionId,
      tenantId: fixture.tenantId,
      model: 'mock-model',
    });
    await runStore.markStatus(fixture.parentRunId, 'running');
    let live = true;
    const acquireLease = vi.fn(async () => { live = false; return true; });
    fixture.config.runStore = Object.assign(runStore, { acquireLease }) as never;
    fixture.config.resolveRuntimeRunCapacity = async () => ({ maxConcurrentRuns: 8 }) as never;
    const child = { childSessionId: 'lease-race-session', childRunId: 'lease-race-run' };
    const released = vi.fn(async () => undefined);
    const markSessionStatus = vi.spyOn(fixture.config.sessionCatalog!, 'markStatus');

    await expect(runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 'lease race', prompt: 'must not run', includeCompanyInfo: false },
      preparedChildIdentity: child,
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new TextOnlyAdapter(),
      acquireChildLaunchAuthority: async () => undefined,
      beforeChildSideEffects: async () => { if (!live) throw new Error('automation cleared'); },
      onChildLaunchError: released,
    })).rejects.toThrow('automation cleared');

    expect(acquireLease).toHaveBeenCalled();
    expect((await runStore.get(child.childRunId))?.status).toBe('failed');
    expect(markSessionStatus).toHaveBeenCalledWith(child.childSessionId, 'error');
    expect(released).toHaveBeenCalledOnce();
  });

  it('clear落在live check→Hand注册后：真实runner销毁Hand、终态化child并释放resource', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const runStore = new MemoryRunStore();
    await runStore.upsertPending({
      runId: fixture.parentRunId,
      sessionId: fixture.parentSessionId,
      tenantId: fixture.tenantId,
      model: 'mock-model',
    });
    await runStore.markStatus(fixture.parentRunId, 'running');
    fixture.config.runStore = Object.assign(runStore, { acquireLease: vi.fn(async () => true) }) as never;
    fixture.config.resolveRuntimeRunCapacity = async () => ({ maxConcurrentRuns: 8 }) as never;
    let live = true;
    const hands: HandRecord[] = [];
    const handStore = {
      get: async () => null,
      register: async (input: RegisterHandInput) => {
        const now = new Date().toISOString();
        const hand = {
          ...input,
          tenantId: fixture.tenantId,
          status: input.status ?? 'provisioning',
          metadata: input.metadata ?? {},
          createdAt: now,
          updatedAt: now,
        } as HandRecord;
        hands.push(hand);
        return hand;
      },
      updateStatus: async (handId: string, status: HandStatus) => {
        const hand = hands.find(item => item.handId === handId) ?? null;
        if (hand) hand.status = status;
        return hand;
      },
      listBySession: async (sessionId: string) => hands.filter(hand => hand.sessionId === sessionId),
      listByWorkspace: async () => hands,
      claimProvisionRecovery: async () => null,
      completeProvisionAttempt: async (handId: string) => {
        const hand = hands.find(item => item.handId === handId) ?? null;
        if (hand) hand.status = 'ready';
        live = false;
        return hand;
      },
      completeProvisionRecovery: async () => null,
    };
    fixture.config.handStore = handStore as never;
    const child = { childSessionId: 'hand-race-session', childRunId: 'hand-race-run' };
    const released = vi.fn(async () => undefined);
    const markSessionStatus = vi.spyOn(fixture.config.sessionCatalog!, 'markStatus');

    await expect(runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 'hand race', prompt: 'must not run', includeCompanyInfo: false },
      preparedChildIdentity: child,
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new TextOnlyAdapter(),
      acquireChildLaunchAuthority: async () => undefined,
      beforeChildSideEffects: async () => {
        if (!live) throw new Error('automation cleared after hand registration');
      },
      onChildLaunchError: released,
    })).rejects.toThrow('automation cleared after hand registration');

    expect(hands).toHaveLength(1);
    expect(hands[0]?.status).toBe('destroyed');
    expect((await runStore.get(child.childRunId))?.status).toBe('failed');
    expect(markSessionStatus).toHaveBeenCalledWith(child.childSessionId, 'error');
    expect(released).toHaveBeenCalledOnce();
  });
});
