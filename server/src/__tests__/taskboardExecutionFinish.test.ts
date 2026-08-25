import { describe, expect, it, vi } from 'vitest';

import type { PlatformEvent } from '../runtime/types.js';
import type { TaskboardExecutionContext } from '../taskboard/types.js';

import { comment, execution, identity, makeRig, task } from './taskboardExecutionTestRig.js';

describe('TaskboardExecutionCoordinator finish protocol', () => {
  it('V2 Run 未 finish 时结束当前 Run 并自动续跑同一阶段', async () => {
    const currentExecution = execution({ protocolVersion: 2, status: 'running' });
    const completeExecution = vi.fn(async () => ({
      task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
      execution: execution({ protocolVersion: 2, status: 'succeeded' }),
    }));
    const rig = makeRig({
      completeExecution,
      listExecutions: vi.fn(async () => [currentExecution]),
      getExecutionContextByRunId: vi.fn(async (): Promise<TaskboardExecutionContext> => ({
        identity,
        task: { ...task, status: 'in_progress' },
        boardPrompt: '完成当前职责。',
        comments: [comment],
        execution: currentExecution,
      })),
    });

    await rig.coordinator.handleRuntimeEvent({
      id: 'event-resume',
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: currentExecution.runId,
      sessionId: currentExecution.sessionId,
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent);

    expect(completeExecution).toHaveBeenCalledWith(currentExecution.runId, expect.objectContaining({
      status: 'succeeded',
      resumeExecution: expect.objectContaining({
        purpose: 'work',
        trigger: 'resume',
        sessionId: currentExecution.sessionId,
      }),
    }));
    expect(rig.store.claimExecution).not.toHaveBeenCalled();
  });

  it('finish 与 run_finished 并发时按事务结果补派 review', async () => {
    const currentExecution = execution({ protocolVersion: 2, status: 'running' });
    const completeExecution = vi.fn(async () => ({
      task: { ...task, status: 'in_review' as const, version: task.version + 1 },
      execution: execution({ protocolVersion: 2, status: 'succeeded', transitionedAt: '2026-08-01T03:00:00Z' }),
    }));
    const rig = makeRig({
      completeExecution,
      getExecutionContextByRunId: vi.fn(async (): Promise<TaskboardExecutionContext> => ({
        identity, task: { ...task, status: 'in_progress' }, boardPrompt: '完成当前职责。',
        comments: [comment], execution: currentExecution,
      })),
    });

    await rig.coordinator.handleRuntimeEvent({
      id: 'event-race', timestamp: '2026-08-01T03:01:00.000Z', type: 'run_finished',
      runId: currentExecution.runId, sessionId: currentExecution.sessionId,
      subtype: 'success', numTurns: 2,
    } as PlatformEvent);

    expect(rig.store.claimExecution).toHaveBeenCalledWith(identity, task.id,
      expect.objectContaining({ purpose: 'review' }));
  });

  it.each(['review', 'merge'] as const)('%s Run 未 finish 时复用原 Session', async (purpose) => {
    const currentExecution = execution({ protocolVersion: 2, status: 'running', purpose });
    const completeExecution = vi.fn(async () => ({
      task: { ...task, status: 'in_progress' as const },
      execution: execution({ protocolVersion: 2, status: 'succeeded', purpose }),
    }));
    const rig = makeRig({
      completeExecution,
      getExecutionContextByRunId: vi.fn(async (): Promise<TaskboardExecutionContext> => ({
        identity,
        task: { ...task, status: 'in_progress' },
        boardPrompt: '完成当前职责。',
        comments: [comment],
        execution: currentExecution,
      })),
    });

    await rig.coordinator.handleRuntimeEvent({
      id: `event-${purpose}`,
      timestamp: '2026-08-01T03:01:00.000Z',
      type: 'run_finished',
      runId: currentExecution.runId,
      sessionId: currentExecution.sessionId,
      subtype: 'success',
      numTurns: 2,
    } as PlatformEvent);

    expect(completeExecution).toHaveBeenCalledWith(currentExecution.runId, expect.objectContaining({
      resumeExecution: expect.objectContaining({ purpose, sessionId: currentExecution.sessionId }),
    }));
  });
});
