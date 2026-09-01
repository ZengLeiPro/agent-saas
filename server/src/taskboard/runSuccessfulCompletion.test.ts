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
  ] as const)('%s 允许正常成功收尾', async (_name, executionContext) => {
    const store = { getExecutionContextByRunId: vi.fn(async () => executionContext) };
    const check = createTaskboardSuccessfulCompletionCheck(store, 'run-1');

    await expect(check?.()).resolves.toEqual({ action: 'allow' });
    expect(store.getExecutionContextByRunId).toHaveBeenCalledWith('run-1');
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
