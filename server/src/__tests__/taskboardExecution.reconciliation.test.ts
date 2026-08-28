import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { RunCreateConflictError, type RunRecord } from '../runtime/runStore.js';
import type { PlatformEvent } from '../runtime/types.js';
import { TaskboardValidationError, type TaskboardIdentity } from '../taskboard/types.js';

import { comment, execution, identity, makeRig, task } from './taskboardExecutionTestRig.js';

describe('TaskboardExecutionCoordinator reconciliation', () => {
  it('workflow cancellation 走标准 target/steering/tool/event 原子链后才完成 outbox', async () => {
    const cancel = vi.fn(async () => ({ cancelled: [], targetCancelled: true, eventCreated: true }));
    const rig = makeRig({
      claimWorkflowCancellations: vi.fn(async () => [{ id: 'cancel-1', runId: 'run-cancel', reason: 'superseded' }]),
      finishWorkflowCancellation: vi.fn(async () => undefined),
    }, {
      runStore: {
        get: vi.fn(async (): Promise<RunRecord | null> => ({
          runId: 'run-cancel', sessionId: 'session-cancel', tenantId: 'tenant-1', userId: 'owner-1',
          status: 'running', requestedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', metadata: {},
        })),
        cancelSteeringBeforeDispatchBySessionWithEvent: cancel,
      },
    });

    await rig.coordinator.reconcile();

    expect(cancel).toHaveBeenCalledWith(
      'session-cancel', 'superseded', 'run-cancel',
      expect.objectContaining({ type: 'run_cancel_requested', runId: 'run-cancel', reason: 'superseded' }),
      'tenant-1',
    );
    expect(rig.store.finishWorkflowCancellation).toHaveBeenCalledWith('cancel-1');
  });

  it('workflow cancellation 遇到未创建的 run 时直接收敛，避免永久 poison outbox', async () => {
    const rig = makeRig({
      claimWorkflowCancellations: vi.fn(async () => [{ id: 'cancel-missing', runId: 'run-missing', reason: 'superseded' }]),
      finishWorkflowCancellation: vi.fn(async () => undefined),
    });

    await rig.coordinator.reconcile();

    expect(rig.store.finishWorkflowCancellation).toHaveBeenCalledWith('cancel-missing');
  });

  it('handoff cancellation 收敛后在同一轮继续扫描下一阶段候选', async () => {
    const order: string[] = [];
    const rig = makeRig({
      claimWorkflowCancellations: vi.fn(async () => [{
        id: 'cancel-handoff', runId: 'run-handoff', reason: 'execution_transitioned',
      }]),
      finishWorkflowCancellation: vi.fn(async () => { order.push('handoff-finished'); }),
      claimIntegrationDispatchCandidatesV2: vi.fn(async () => {
        order.push('next-stage-scan');
        return [];
      }),
    });

    await rig.coordinator.reconcile();

    expect(order).toEqual(['handoff-finished', 'next-stage-scan']);
  });

  it('workflow cancellation CAS 输给 completed 终态时按 durable fact 收敛 outbox', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({
        runId: 'run-race', sessionId: 'session-race', tenantId: 'tenant-1', status: 'running',
        requestedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z', metadata: {},
      })
      .mockResolvedValueOnce({
        runId: 'run-race', sessionId: 'session-race', tenantId: 'tenant-1', status: 'completed',
        requestedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:02:00.000Z', metadata: {},
      });
    const reconcileTerminal = vi.fn(async () => undefined);
    const rig = makeRig({
      claimWorkflowCancellations: vi.fn(async () => [{ id: 'cancel-race', runId: 'run-race', reason: 'superseded' }]),
      finishWorkflowCancellation: vi.fn(async () => undefined),
      reconcileWorkflowCancellationTerminal: reconcileTerminal,
    }, {
      runStore: {
        get,
        cancelSteeringBeforeDispatchBySessionWithEvent: vi.fn(async () => ({
          cancelled: [], targetCancelled: false, eventCreated: false,
        })),
      },
    });

    await rig.coordinator.reconcile();

    expect(reconcileTerminal).toHaveBeenCalledWith('cancel-race', {
      runId: 'run-race', status: 'completed',
    });
    expect(rig.store.finishWorkflowCancellation).not.toHaveBeenCalled();
  });

  it('terminal-before-outbox 收敛失败后可重试，重复消费保持幂等委托', async () => {
    const reconcileTerminal = vi.fn()
      .mockRejectedValueOnce(new Error('fault after terminal read'))
      .mockResolvedValue(undefined);
    const finish = vi.fn(async () => undefined);
    const rig = makeRig({
      claimWorkflowCancellations: vi.fn(async () => [{
        id: 'cancel-terminal', runId: 'run-terminal', reason: 'superseded',
      }]),
      finishWorkflowCancellation: finish,
      reconcileWorkflowCancellationTerminal: reconcileTerminal,
    }, {
      runStore: { get: vi.fn(async (): Promise<RunRecord> => ({
        runId: 'run-terminal', sessionId: 'session-terminal', tenantId: 'tenant-1',
        status: 'failed', statusReason: 'runtime failed first',
        requestedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:02:00.000Z', metadata: {},
      })) },
    });

    await rig.coordinator.reconcile();
    await rig.coordinator.reconcile();
    await rig.coordinator.reconcile();

    expect(finish).toHaveBeenCalledWith('cancel-terminal', 'fault after terminal read');
    expect(reconcileTerminal).toHaveBeenCalledTimes(3);
    expect(reconcileTerminal).toHaveBeenLastCalledWith('cancel-terminal', {
      runId: 'run-terminal', status: 'failed', reason: 'runtime failed first',
    });
  });

  it('dispatch gate 拒绝已被 fence 的 claim，绝不创建 Runtime Run', async () => {
    const rig = makeRig({
      runExecutionDispatchGate: vi.fn(async () => false),
    });

    await rig.coordinator.startExecution(identity, task.id, { expectedVersion: task.version, purpose: 'work' });

    expect(rig.store.runExecutionDispatchGate).toHaveBeenCalledTimes(1);
    expect(rig.scheduler.enqueueCreateOnly).not.toHaveBeenCalled();
    expect(rig.store.markExecutionDispatchSucceeded).not.toHaveBeenCalled();
  });
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
