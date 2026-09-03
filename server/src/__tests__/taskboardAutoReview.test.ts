import { describe, expect, it, vi } from 'vitest';

import type { PlatformEvent } from '../runtime/types.js';
import type {
  TaskboardExecutionClaimInput,
  TaskboardExecutionCompletionInput,
  TaskboardExecutionDispatch,
} from '../taskboard/types.js';
import { execution, identity, makeRig, task } from './taskboardExecutionTestRig.js';

describe('Taskboard automatic review', () => {
  it('实施成功后创建并立即派发唯一 review Execution', async () => {
    let review: TaskboardExecutionClaimInput | undefined;
    const completeExecution = vi.fn(async (_runId: string, input: TaskboardExecutionCompletionInput) => {
      review = input.reviewExecution;
      return { task: { ...task, status: 'in_review' as const }, execution: execution({ status: input.status }) };
    });
    const claimExecutionDispatch = vi.fn(async (
      runId: string | undefined,
      leaseId: string,
    ): Promise<TaskboardExecutionDispatch | null> => {
      if (!review || runId !== review.runId) return null;
      return {
        runId: review.runId,
        executionId: review.executionId,
        outboxExecutionId: review.executionId,
        taskId: task.id,
        taskKind: task.kind ?? 'delivery',
        purpose: review.purpose ?? 'review',
        sessionId: review.sessionId,
        tenantId: identity.tenantId,
        ownerUserId: identity.ownerUserId,
        payload: review.dispatch,
        attemptCount: 1,
        leaseId,
      };
    });
    const rig = makeRig({ completeExecution, claimExecutionDispatch });
    vi.mocked(rig.eventStore.listByRun!).mockResolvedValue([{
      id: 'event-auto-review',
      timestamp: '2026-08-01T03:00:00.000Z',
      type: 'assistant_message',
      runId: 'run-1',
      sessionId: 'session-1',
      content: '实施交付完成',
    } as PlatformEvent]);

    await rig.coordinator.handleRuntimeEvent({
      id: 'event-auto-review-finished',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: 'run-1',
      sessionId: 'session-1',
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent);

    expect(completeExecution).toHaveBeenCalledWith('run-1', expect.objectContaining({
      reviewExecution: expect.objectContaining({
        purpose: 'review',
        executionId: 'execution-1-review',
        runId: 'taskboard-execution-execution-1-review',
        sessionId: expect.stringMatching(/^taskboard-/),
      }),
    }));
    expect(review?.sessionId).not.toBe('session-1');
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledTimes(1);
    expect(rig.scheduler.enqueueCreateOnly).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'taskboard-execution-execution-1-review',
      sessionId: review?.sessionId,
    }));
  });

  it('每一轮 review 都新建 Session，不复用 work 或历史 review Session', async () => {
    const rig = makeRig({
      listExecutions: vi.fn(async () => [
        execution({ id: 'review-old', purpose: 'review', sessionId: 'review-session-old' }),
        execution({ id: 'work-old', purpose: 'work', sessionId: 'work-session' }),
      ]),
    });

    const first = await rig.coordinator.startExecution(identity, task.id, {
      expectedVersion: task.version,
      purpose: 'review',
    });
    const second = await rig.coordinator.startExecution(identity, task.id, {
      expectedVersion: task.version,
      purpose: 'review',
    });

    expect(first.execution.sessionId).toMatch(/^taskboard-/);
    expect(second.execution.sessionId).toMatch(/^taskboard-/);
    expect(first.execution.sessionId).not.toBe(second.execution.sessionId);
    expect([first.execution.sessionId, second.execution.sessionId]).not.toContain('work-session');
    expect([first.execution.sessionId, second.execution.sessionId]).not.toContain('review-session-old');
    expect(rig.store.listExecutions).toHaveBeenCalledTimes(2);
    expect(rig.store.listExecutions).toHaveBeenNthCalledWith(1, identity, task.id);
    expect(rig.store.listExecutions).toHaveBeenNthCalledWith(2, identity, task.id);
  });

  it('返工 work 复用原 work Session，不误接最新 review Session', async () => {
    const rig = makeRig({
      listExecutions: vi.fn(async () => [
        execution({ id: 'review-latest', purpose: 'review', sessionId: 'review-session-latest' }),
        execution({ id: 'work-old', purpose: 'work', sessionId: 'work-session' }),
      ]),
    });

    const result = await rig.coordinator.startExecution(identity, task.id, {
      expectedVersion: task.version,
      purpose: 'work',
    });

    expect(result.execution.sessionId).toBe('work-session');
  });

  it('复核 Execution 成功时不会递归派发下一轮复核', async () => {
    const completeExecution = vi.fn(async () => ({
      task: { ...task, status: 'in_review' as const },
      execution: execution({ purpose: 'review', status: 'succeeded' }),
    }));
    const rig = makeRig({
      getExecutionContextByRunId: vi.fn(async () => ({
        identity,
        task: { ...task, status: 'in_review' as const },
        boardPrompt: '只做复核。',
        comments: [],
        execution: execution({ purpose: 'review' }),
      })),
      completeExecution,
    });

    await rig.coordinator.handleRuntimeEvent({
      id: 'event-review-finished',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: 'run-1',
      sessionId: 'session-1',
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent);

    expect(completeExecution).toHaveBeenCalledWith('run-1', expect.not.objectContaining({
      reviewExecution: expect.anything(),
    }));
    expect(rig.scheduler.enqueueCreateOnly).not.toHaveBeenCalled();
  });
});
