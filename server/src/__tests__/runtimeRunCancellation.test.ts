import { describe, expect, it, vi } from 'vitest';
import { cancelRuntimeRun } from '../runtime/runtimeRunCancellation.js';
import type { RunRecord } from '../runtime/runStore.js';

function run(status: RunRecord['status']): RunRecord {
  return {
    runId: 'runtime-run-1', sessionId: 'session-1', tenantId: 'tenant-1', userId: 'user-1',
    channel: 'cron', status, requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

describe('Runtime canonical cancellation', () => {
  it('默认不把尚未落库的 Runtime Run 当成已取消', async () => {
    const store = { get: vi.fn(async () => null) };
    await expect(cancelRuntimeRun(store, 'runtime-run-1', 'cron_timeout')).rejects.toThrow('取消结果不确定');
  });

  it('仅允许已有 fencing 的调用方显式把 missing 视为取消完成', async () => {
    const store = { get: vi.fn(async () => null) };
    await expect(cancelRuntimeRun(store, 'runtime-run-1', 'taskboard_cancel', { missingIsCancelled: true }))
      .resolves.toEqual({ kind: 'cancelled', run: null });
  });

  it('missing Runtime 可先 create-only 预留同一身份再 canonical cancel', async () => {
    const pending = run('pending');
    const cancelled = run('cancelled');
    const createPending = vi.fn(async () => ({ created: true, record: pending }));
    const cancel = vi.fn(async () => ({ cancelled: [], targetCancelled: true, eventCreated: true }));
    const store = { get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(cancelled),
      createPending, cancelSteeringBeforeDispatchBySessionWithEvent: cancel };
    await expect(cancelRuntimeRun(store, pending.runId, 'cron_timeout', {
      reserveIfMissing: { runId: pending.runId, sessionId: pending.sessionId, tenantId: pending.tenantId,
        userId: pending.userId, channel: 'cron', metadata: { cancellationReservation: true } },
    })).resolves.toEqual({ kind: 'cancelled', run: cancelled });
    expect(createPending).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('Runtime 已终态时不重复写 cancel 事件', async () => {
    const cancel = vi.fn();
    const store = { get: vi.fn(async () => run('completed')), cancelSteeringBeforeDispatchBySessionWithEvent: cancel };
    await expect(cancelRuntimeRun(store, 'runtime-run-1', 'late_cancel'))
      .resolves.toMatchObject({ kind: 'runtime_terminal', run: { status: 'completed' } });
    expect(cancel).not.toHaveBeenCalled();
  });
});
