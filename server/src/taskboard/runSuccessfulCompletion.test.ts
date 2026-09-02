import { describe, expect, it, vi } from 'vitest';

import type { TaskboardExecutionContext } from './types.js';
import {
  createTaskboardSuccessfulCompletionCheck,
  TASKBOARD_UNFINISHED_EXECUTION_PROMPT,
} from './runSuccessfulCompletion.js';
import { execution, identity, task } from '../__tests__/taskboardExecutionTestRig.js';

function context(overrides: Parameters<typeof execution>[0] = {}): TaskboardExecutionContext {
  return {
    identity,
    task,
    boardPrompt: '',
    comments: [],
    execution: execution(overrides),
  };
}

describe('createTaskboardSuccessfulCompletionCheck', () => {
  it.each([
    ['非任务看板 Run', null],
    ['legacy protocol', context({ protocolVersion: 1 })],
    ['已显式交接的 protocol v2', context({
      protocolVersion: 2,
      transitionedAt: '2026-09-01T09:00:00.000Z',
    })],
  ] as const)('%s 保持原有成功收尾', async (_name, executionContext) => {
    const store = { getExecutionContextByRunId: vi.fn(async () => executionContext) };
    const check = createTaskboardSuccessfulCompletionCheck(store, 'run-1');

    await expect(check?.()).resolves.toEqual({ action: 'allow' });
    expect(store.getExecutionContextByRunId).toHaveBeenCalledWith('run-1');
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('%s 且未显式交接时拒绝成功收尾', async (status) => {
    const store = {
      getExecutionContextByRunId: vi.fn(async () => context({ protocolVersion: 2, status })),
    };
    const check = createTaskboardSuccessfulCompletionCheck(store, 'run-1');

    await expect(check?.()).resolves.toEqual({
      action: 'reject',
      error: `taskboard execution reached ${status} before successful completion handoff`,
    });
  });

  it.each(['work', 'review', 'merge'] as const)('%s 未显式交接时要求继续同一 Run', async (purpose) => {
    const store = {
      getExecutionContextByRunId: vi.fn(async () => context({ protocolVersion: 2, purpose })),
    };
    const check = createTaskboardSuccessfulCompletionCheck(store, 'run-1');

    await expect(check?.()).resolves.toEqual({
      action: 'continue',
      prompt: TASKBOARD_UNFINISHED_EXECUTION_PROMPT,
    });
  });
});
