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
