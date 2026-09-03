import { describe, expect, it, vi } from 'vitest';

import { TASKBOARD_STAGE_DEFAULT_PROMPTS } from '../../../shared/src/types/taskboard.js';

import { execution, identity, makeRig, task } from './taskboardExecutionTestRig.js';

function runRecord() {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'pending' as const,
    requestedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
  };
}

describe('taskboard execution prompt defaults', () => {
  it('injects the work default when the board has no stored override', async () => {
    const rig = makeRig({
      getExecutionContextByRunId: vi.fn(async () => ({
        identity,
        task,
        comments: [],
        execution: execution({ status: 'queued', purpose: 'work' }),
        boardPrompt: '',
        stagePrompts: {},
      })),
    });

    const prepared = await rig.coordinator.prepareWake(runRecord());

    expect(prepared.metadata.taskboardStagePrompt).toBe(TASKBOARD_STAGE_DEFAULT_PROMPTS.work);
  });

  it('maps the durable Integration work execution to the merge default', async () => {
    const integrationTask = { ...task, kind: 'integration' as const, workflowVersion: 3 as const };
    const rig = makeRig({
      getExecutionContextByRunId: vi.fn(async () => ({
        identity,
        task: integrationTask,
        comments: [],
        execution: execution({ status: 'queued', purpose: 'work' }),
        boardPrompt: '',
        stagePrompts: {},
      })),
    });

    const prepared = await rig.coordinator.prepareWake(runRecord());

    expect(prepared.metadata.taskboardStagePrompt).toBe(TASKBOARD_STAGE_DEFAULT_PROMPTS.merge);
  });
});
