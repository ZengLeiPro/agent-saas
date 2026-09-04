import { describe, expect, it, vi } from 'vitest';

import {
  RunStateTrackingEventStore,
  releaseWakeLeaseForDrainHandoff,
  type RawRuntimeRunDispatchConfig,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RunRecord, RunStatus, RunStore } from '../runtime/runStore.js';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import {
  MemoryEventStore as SchedulerMemoryEventStore,
  MemoryRunStore,
} from './runtimeScheduler.testHelpers.js';
import { MemoryEventStore } from './runtimeWake.testHelpers.js';

const TENANT_ID = 'pantheon';

describe('runtime drain handoff', () => {
  it('does not terminalize a run when a safe handoff is refused', async () => {
    const runStore = new MemoryRunStore();
    const eventStore = new SchedulerMemoryEventStore();
    const releaseLease = runStore.releaseLease.bind(runStore);
    const releaseSpy = vi.spyOn(runStore, 'releaseLease').mockImplementation(async (...args) => {
      if (args[4]?.handoff) return null;
      return releaseLease(...args);
    });
    await runStore.createPending({
      runId: 'run-handoff-refused',
      sessionId: 'session-handoff-refused',
    });
    const scheduler = new RuntimeScheduler({
      runStore,
      eventStore,
      workerId: 'worker-handoff-refused',
      pollIntervalMs: 60_000,
      autoWake: true,
      wake: async (_record, lease) => lease.handoff('server_drain_handoff'),
    });

    await scheduler.tick();
    await vi.waitFor(async () => {
      await expect(runStore.get('run-handoff-refused')).resolves.toMatchObject({
        statusReason: 'external_tool_outcome_unknown',
      });
    });
    await scheduler.stop();

    await expect(runStore.get('run-handoff-refused')).resolves.toMatchObject({
      status: 'running',
      statusReason: 'external_tool_outcome_unknown',
      workerId: undefined,
      leaseExpiresAt: undefined,
    });
    expect(releaseSpy).toHaveBeenCalledTimes(2);
    expect(releaseSpy.mock.calls.some((call) => call[2] === 'failed')).toBe(false);
    expect(eventStore.events.map((event) => event.type)).toEqual(['run_lease_acquired']);
  });

  it('keeps transient steering recovery handoffs recoverable below the retry limit', async () => {
    const now = new Date().toISOString();
    let current: RunRecord = {
      runId: 'target-steering-retry',
      sessionId: 'session-steering-retry',
      tenantId: TENANT_ID,
      status: 'running',
      requestedAt: now,
      updatedAt: now,
      metadata: {},
    };
    const runStore = {
      get: vi.fn(async () => current),
      markStatus: vi.fn(
        async (_runId: string, status: RunStatus, reason?: string, metadata = {}) => {
          current = {
            ...current,
            status,
            statusReason: reason,
            metadata: { ...current.metadata, ...metadata },
          };
          return current;
        },
      ),
    } as unknown as RunStore;
    const eventStore = new MemoryEventStore();
    const markSessionStatus = vi.fn(async () => undefined);
    const renewLease = vi.fn(async () => undefined);
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const handoffs: Array<{ reason: string; metadata: Record<string, unknown> }> = [];

    await releaseWakeLeaseForDrainHandoff({
      config: { agentCwd: '/tmp', runStore } as RawRuntimeRunDispatchConfig,
      eventStore,
      sessionCatalog: { markStatus: markSessionStatus } as unknown as SessionCatalog,
      run: current,
      lease: {
        runId: current.runId,
        workerId: 'worker-1',
        renew: renewLease,
        handoff: async (reason, metadata = {}) => {
          handoffs.push({ reason, metadata });
        },
        release: async (status, reason) => {
          releases.push({ status, reason });
        },
      },
      drainHandoff: { requested: true, reason: 'steering_reserved_apply_failed' },
    });

    expect(renewLease).toHaveBeenCalledOnce();
    expect(handoffs).toEqual([
      {
        reason: 'steering_reserved_apply_failed',
        metadata: expect.objectContaining({
          drainHandoffAttempts: 1,
          drainHandoffWorkerId: 'worker-1',
        }),
      },
    ]);
    expect(eventStore.events).toEqual([]);
    expect(markSessionStatus).toHaveBeenCalledWith('session-steering-retry', 'running');
    expect(releases).toEqual([]);
  });

  it('terminalizes the target and surfaces an error after repeated steering recovery failures', async () => {
    const now = new Date().toISOString();
    let current: RunRecord = {
      runId: 'target-steering-recovery',
      sessionId: 'session-steering-recovery',
      userId: 'user-1',
      tenantId: TENANT_ID,
      status: 'running',
      requestedAt: now,
      updatedAt: now,
      metadata: { drainHandoffAttempts: 2 },
    };
    const runStore = {
      get: vi.fn(async () => current),
      markStatus: vi.fn(
        async (_runId: string, status: RunStatus, reason?: string, metadata = {}) => {
          current = {
            ...current,
            status,
            statusReason: reason,
            updatedAt: new Date().toISOString(),
            metadata: { ...current.metadata, ...metadata },
          };
          return current;
        },
      ),
    } as unknown as RunStore;
    const innerEventStore = new MemoryEventStore();
    const eventStore = new RunStateTrackingEventStore(innerEventStore, runStore, TENANT_ID);
    const markSessionStatus = vi.fn(async () => undefined);
    const releases: Array<{ status?: RunStatus; reason?: string }> = [];
    const outbound: string[] = [];

    await expect(
      releaseWakeLeaseForDrainHandoff({
        config: { agentCwd: '/tmp', runStore } as RawRuntimeRunDispatchConfig,
        eventStore,
        sessionCatalog: { markStatus: markSessionStatus } as unknown as SessionCatalog,
        run: current,
        lease: {
          runId: current.runId,
          workerId: 'worker-1',
          renew: async () => undefined,
          release: async (status, reason) => {
            releases.push({ status, reason });
          },
        },
        drainHandoff: { requested: true, reason: 'steering_reserved_apply_failed' },
        onOutboundEvent: async (event) => {
          outbound.push(event.type);
        },
      }),
    ).resolves.toBe(true);

    expect(current).toMatchObject({
      status: 'failed',
      statusReason: '会话恢复连续失败，本次运行已结束，请重试。',
      metadata: { drainHandoffAttempts: 3 },
    });
    expect(innerEventStore.events.map((event) => event.type)).toEqual([
      'run_state_changed',
      'run_finished',
      'run_state_changed',
    ]);
    expect(innerEventStore.events.at(-1)).toMatchObject({
      type: 'run_state_changed',
      runId: 'target-steering-recovery',
      status: 'failed',
    });
    expect(markSessionStatus).toHaveBeenCalledWith('session-steering-recovery', 'error');
    expect(outbound).toEqual(['error']);
    expect(releases).toEqual([
      {
        status: 'failed',
        reason: '会话恢复连续失败，本次运行已结束，请重试。',
      },
    ]);
  });
});
