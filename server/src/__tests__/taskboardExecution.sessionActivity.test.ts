import { describe, expect, it, vi } from 'vitest';

import { execution, identity, makeRig, task } from './taskboardExecutionTestRig.js';

describe('Taskboard Execution Session 活跃投影', () => {
  it('任一历史 Execution Session 仍有活动时在最新终态上投影为活跃', async () => {
    const latest = execution({ id: 'review-1', runId: 'review-run', sessionId: 'review-session', status: 'succeeded', purpose: 'review' });
    const prior = execution({ id: 'work-1', runId: 'work-run', sessionId: 'work-session', status: 'succeeded' });
    const rig = makeRig({ listExecutions: vi.fn(async () => [latest, prior]) });
    rig.runStore.hasTaskboardSessionActivity.mockResolvedValue(true);

    await expect(rig.coordinator.listExecutions(identity, task.id)).resolves.toEqual([
      { ...latest, sessionActivityActive: true }, prior,
    ]);
    expect(rig.runStore.hasTaskboardSessionActivity).toHaveBeenCalledWith(
      ['review-session', 'work-session'], identity.tenantId,
    );
  });

  it('已结束 review 的残留活动不阻断返回 work 阶段', async () => {
    const review = execution({ id: 'review-1', runId: 'review-run', sessionId: 'review-session', status: 'succeeded', purpose: 'review' });
    const work = execution({ id: 'work-1', runId: 'work-run', sessionId: 'work-session', status: 'succeeded', purpose: 'work' });
    const rig = makeRig({ listExecutions: vi.fn(async () => [review, work]) });
    rig.runStore.hasTaskboardSessionActivity.mockImplementation(async (sessionIds) => (
      sessionIds.includes('review-session')
    ));

    await expect(rig.coordinator.startExecution(
      identity, task.id, { expectedVersion: task.version, purpose: 'work' },
    )).resolves.toBeDefined();
    expect(rig.runStore.hasTaskboardSessionActivity).toHaveBeenCalledWith(
      ['work-session'], identity.tenantId,
    );
    expect(rig.store.claimExecution).toHaveBeenCalledTimes(1);
  });

  it('历史 work Session 仍有活动时拒绝跨 purpose 启动 review Execution', async () => {
    const terminal = execution({ status: 'succeeded', sessionId: 'work-session' });
    const rig = makeRig({ listExecutions: vi.fn(async () => [terminal]) });
    rig.runStore.hasTaskboardSessionActivity.mockResolvedValue(true);

    await expect(rig.coordinator.startExecution(
      identity, task.id, { expectedVersion: task.version, purpose: 'review' },
    )).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });
    expect(rig.runStore.hasTaskboardSessionActivity).toHaveBeenCalledWith(
      expect.arrayContaining(['work-session', expect.stringMatching(/^taskboard-review-/)]),
      identity.tenantId,
    );
    expect(rig.store.claimExecution).not.toHaveBeenCalled();
  });

  it('检查并结算终态 Execution 的 pending wake，不触碰活跃 Run', async () => {
    const terminal = execution({ id: 'review-1', sessionId: 'review-session', status: 'succeeded', purpose: 'review' });
    const rig = makeRig({ listExecutions: vi.fn(async () => [terminal]) });
    const pendingWakeRun = {
      runId: 'background-1', sessionId: 'child-1', tenantId: identity.tenantId,
      status: 'completed' as const, requestedAt: terminal.createdAt, updatedAt: terminal.updatedAt,
      metadata: {
        backgroundTask: true, parentSessionId: terminal.sessionId,
        topLevelSessionId: terminal.sessionId, wakeState: 'pending',
      },
    };
    const discardedWakeRun = {
      ...pendingWakeRun,
      metadata: { ...pendingWakeRun.metadata, wakeState: 'discarded' },
    };
    rig.runStore.listBackgroundTasks
      .mockResolvedValueOnce([pendingWakeRun])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingWakeRun])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    rig.runStore.claimBackgroundTaskWake.mockResolvedValueOnce(pendingWakeRun);
    rig.runStore.finishBackgroundTaskWake.mockResolvedValueOnce(discardedWakeRun);

    await expect(rig.coordinator.inspectExecutionActivity(
      identity, task.id, terminal.id,
    )).resolves.toMatchObject({
      activities: [{ runId: 'background-1', kind: 'pending_wake', wakeState: 'pending' }],
    });
    await expect(rig.coordinator.reconcileExecutionActivity(
      identity, task.id, terminal.id,
      { expectedVersion: task.version, reason: '确认无需投递', dryRun: false },
    )).resolves.toMatchObject({
      dryRun: false,
      discarded: [{ runId: 'background-1', wakeState: 'discarded' }],
      activities: [],
    });
    expect(rig.runStore.finishBackgroundTaskWake).toHaveBeenCalledWith(
      pendingWakeRun.runId,
      expect.any(String),
      'discarded',
      expect.objectContaining({
        wakeReconcileReason: '确认无需投递',
        wakeReconciledBy: identity.ownerUserId,
        wakeReconcileTaskId: task.id,
        wakeReconcileExecutionId: terminal.id,
        wakeReconcileExpectedTaskVersion: task.version,
      }),
    );
  });

  it('活跃 Execution 拒绝残留活动结算，应改用 execution.cancel', async () => {
    const active = execution({ id: 'work-1', status: 'running' });
    const rig = makeRig({ listExecutions: vi.fn(async () => [active]) });
    await expect(rig.coordinator.reconcileExecutionActivity(
      identity, task.id, active.id,
      { expectedVersion: task.version, reason: '错误操作', dryRun: false },
    )).rejects.toThrow('execution.cancel');
    expect(rig.runStore.claimBackgroundTaskWake).not.toHaveBeenCalled();
  });

  it('Execution 搜索仅在第一页投影全局最新会话活动', async () => {
    const terminal = execution({ status: 'succeeded' });
    const searchExecutions = vi.fn(async () => ({
      items: [terminal], page: 2, pageSize: 20, total: 21, hasMore: false,
    }));
    const rig = makeRig({ searchExecutions });
    rig.runStore.hasTaskboardSessionActivity.mockResolvedValue(true);

    await expect(rig.coordinator.searchExecutions(identity, task.id, { page: 2 })).resolves.toEqual({
      items: [terminal], page: 2, pageSize: 20, total: 21, hasMore: false,
    });
    expect(rig.runStore.hasTaskboardSessionActivity).not.toHaveBeenCalled();
  });
});
