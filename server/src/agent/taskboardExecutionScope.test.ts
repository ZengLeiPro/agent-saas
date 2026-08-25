import { describe, expect, it } from 'vitest';

import type { TaskboardExecutionContext, TaskboardIdentity } from '../taskboard/types.js';
import { cronManageToolDescriptor } from './cronToolProvider.js';
import { assertTaskboardExecutionScope } from './taskboardExecutionScope.js';
import { TASKBOARD_MANAGE_ACTIONS, TASKBOARD_RESOURCE_ACTIONS } from './taskboardToolActions.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a', ownerUserId: 'user-1', username: 'alice', userRole: 'user',
};

function context(workflowVersion: 2 | 3): TaskboardExecutionContext {
  return {
    identity,
    task: {
      id: 'integration-1', boardId: 'board-1', kind: 'integration', workflowVersion,
      status: 'ready_to_merge',
    },
    execution: { id: 'execution-1', runId: 'run-1', purpose: 'merge', status: 'running' },
  } as TaskboardExecutionContext;
}

const removedActions = [
  'integration.source.inspect',
  'integration.source.log',
  'integration.source.merge',
] as const;

describe('taskboard Integration Execution scope', () => {
  it.each(removedActions)('removes legacy action %s from action lists and CronManage schema', (action) => {
    expect(TASKBOARD_RESOURCE_ACTIONS).not.toContain(action);
    expect(TASKBOARD_MANAGE_ACTIONS).not.toContain(action);
    expect(() => cronManageToolDescriptor.schema.parse({ target: 'taskboard', action })).toThrow();
  });

  it.each([2, 3] as const)('does not let workflow v%s invoke removed source actions', (workflowVersion) => {
    for (const action of removedActions) {
      expect(() => assertTaskboardExecutionScope({ action }, context(workflowVersion), identity))
        .toThrow('看板 Agent Execution 只能使用当前任务协议 action');
    }
  });

  it('only exposes Agent-first integration merge actions in execution scope', () => {
    expect(() => assertTaskboardExecutionScope({ action: 'integration.agent.merge' }, context(3), identity)).not.toThrow();
    expect(() => assertTaskboardExecutionScope({ action: 'integration.agent.cleanup' }, context(3), identity)).not.toThrow();
  });
});
