import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RunCreateConflictError } from '../runtime/runStore.js';
import type { PlatformEvent } from '../runtime/types.js';
import { TaskboardValidationError, type TaskboardIdentity } from '../taskboard/types.js';

import { comment, execution, identity, makeRig, task } from './taskboardExecutionTestRig.js';

describe('TaskboardExecutionCoordinator reconciliation', () => {
  it('后台对账使用 single-flight，不阻塞或叠加 Scheduler tick', async () => {
    let resolveCandidates!: (value: []) => void;
    const candidates = new Promise<[]>((resolve) => { resolveCandidates = resolve; });
    const rig = makeRig({
      claimExecutionReconcileCandidates: vi.fn(() => candidates),
    });

    rig.coordinator.wakeReconciliation();
    rig.coordinator.wakeReconciliation();
    await vi.waitFor(() => {
      expect(rig.store.claimExecutionReconcileCandidates).toHaveBeenCalledTimes(1);
    });
    resolveCandidates([]);
    await rig.coordinator.stop();

    expect(rig.store.claimExecutionReconcileCandidates).toHaveBeenCalledTimes(1);
  });

  it('Runtime 终态 session 不匹配时拒绝读取回执或完成 Execution', async () => {
    const rig = makeRig();

    await expect(rig.coordinator.handleRuntimeEvent({
      id: 'event-mismatch',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: 'run-1',
      sessionId: 'other-session',
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent)).rejects.toThrow('session');

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
  });

  it('定时对账会补写遗漏的 Runtime 成功终态', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-1',
      executionId: 'execution-1',
      sessionId: 'session-1',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });
    vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([{
      id: 'event-1',
      timestamp: '2026-08-01T00:01:00.000Z',
      type: 'assistant_message',
      runId: 'run-1',
      sessionId: 'session-1',
      content: '漏事件后的交付结果',
    } as PlatformEvent]);

    await rig.coordinator.reconcile();

    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'succeeded',
        commentBody: 'Agent 交付\n\n漏事件后的交付结果',
        reviewExecution: expect.objectContaining({ purpose: 'review' }),
      }),
      'reconcile-lease',
    );
  });

  it('对账发现 Run metadata 与 Execution 不匹配时按失败收口且不读取回执', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-1',
      executionId: 'execution-1',
      sessionId: 'session-1',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-1',
      sessionId: 'session-1',
      status: 'completed',
      requestedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
      metadata: { taskboardExecution: true, taskboardExecutionId: 'other-execution' },
    });

    await rig.coordinator.reconcile();

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'failed',
        error: 'Runtime Run 与任务看板 Execution 关联校验失败',
      }),
      'reconcile-lease',
    );
  });

  it('刚进入终态的 Run 保留 live 事件宽限期，不抢先写无文本回执', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'run-fresh',
      executionId: 'execution-1',
      sessionId: 'session-fresh',
      executionStatus: 'running',
      dispatchStatus: 'dispatched',
      leaseId: 'reconcile-lease',
    }]);
    rig.runStore.get.mockResolvedValue({
      runId: 'run-fresh',
      sessionId: 'session-fresh',
      status: 'completed',
      requestedAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
    });

    await rig.coordinator.reconcile();

    expect(rig.eventStore.listByRun).not.toHaveBeenCalled();
    expect(rig.store.completeExecution).not.toHaveBeenCalled();
    expect(rig.store.completeExecutionFromReconcile).not.toHaveBeenCalled();
  });

  it('旧活跃执行同时缺少 outbox 与 Runtime Run 时自动阻塞，不再永久卡住', async () => {
    const rig = makeRig();
    vi.mocked(rig.store.claimExecutionReconcileCandidates).mockResolvedValue([{
      runId: 'legacy-run',
      executionId: 'legacy-execution',
      sessionId: 'legacy-session',
      executionStatus: 'queued',
      leaseId: 'reconcile-lease',
    }]);

    await rig.coordinator.reconcile();

    expect(rig.store.completeExecutionFromReconcile).toHaveBeenCalledWith(
      'legacy-run',
      expect.objectContaining({
        status: 'failed',
        error: '执行派发记录缺失，已停止该次 Agent 执行',
      }),
      'reconcile-lease',
    );
  });
});
