import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from './runStore.js';
import { createSessionAutomationCancelRun } from './sessionAutomationCancellation.js';

function runningRun(): RunRecord {
  return {
    runId: 'automation-run-1', sessionId: 'session-1', tenantId: 'tenant-1', userId: 'user-1',
    status: 'running', requestedAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    metadata: {},
  };
}

describe('session automation canonical cancellation', () => {
  it('persists run_cancel_requested before attempting the local abort for a remote owner', async () => {
    let run = runningRun(); const order: string[] = []; const events: unknown[] = [];
    const runStore = {
      get: vi.fn(async () => run),
      cancelSteeringBeforeDispatchBySessionWithEvent: vi.fn(async (_sessionId, reason, _runId, event) => {
        order.push('durable-event'); events.push(event); run = { ...run, status: 'cancelled', statusReason: reason };
        return { cancelled: [], targetCancelled: true, event, eventCreated: true };
      }),
    };
    const cancel = createSessionAutomationCancelRun({ runStore: runStore as never, eventStore: {}, abort: () => { order.push('local-abort'); } });
    await cancel(run.runId, 'automation_clear');
    expect(order).toEqual(['durable-event', 'local-abort']);
    expect(events).toEqual([expect.objectContaining({ type: 'run_cancel_requested', runId: run.runId, reason: 'automation_clear' })]);
  });

  it('survives a crash after durable cancellation acknowledgement without duplicating the event', async () => {
    let run = runningRun(); const events: unknown[] = [];
    const runStore = {
      get: vi.fn(async () => run),
      cancelSteeringBeforeDispatchBySessionWithEvent: vi.fn(async (_sessionId, reason, _runId, event) => {
        events.push(event); run = { ...run, status: 'cancelled', statusReason: reason };
        return { cancelled: [], targetCancelled: true, event, eventCreated: true };
      }),
    };
    const crashing = createSessionAutomationCancelRun({ runStore: runStore as never, eventStore: {}, abort: () => { throw new Error('process exited'); } });
    await expect(crashing(run.runId, 'automation_clear')).rejects.toThrow('process exited');
    expect(run.status).toBe('cancelled');expect(events).toHaveLength(1);

    const abort = vi.fn();
    const restarted = createSessionAutomationCancelRun({ runStore: runStore as never, eventStore: {}, abort });
    await restarted(run.runId, 'automation_clear');
    expect(events).toHaveLength(1);expect(abort).toHaveBeenCalledWith(run.runId, 'automation_clear');
  });
});
