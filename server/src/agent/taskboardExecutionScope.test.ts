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
      status: workflowVersion === 3 ? 'in_progress' : 'ready_to_merge',
    },
    execution: {
      id: 'execution-1', runId: 'run-1',
      purpose: workflowVersion === 3 ? 'work' : 'merge', status: 'running',
    },
  } as TaskboardExecutionContext;
}

const removedActions = [
  'integration.source.inspect',
  'integration.source.log',
  'integration.source.merge',
  'integration.agent.merge',
  'integration.agent.cleanup',
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

  it.each([
    'execution.pull_request.set',
    'execution.pull_request.inspect',
    'execution.pull_request.log',
    'execution.review_subject.record',
  ] as const)('keeps Integration out of the Delivery receipt protocol: %s', (action) => {
    expect(() => assertTaskboardExecutionScope({ action }, context(3), identity))
      .toThrow('Integration Agent 直接使用标准 Git/GitHub');
  });

  it('preserves Delivery pull request inspection', () => {
    const delivery = {
      ...context(3),
      task: { id: 'delivery-1', boardId: 'board-1', kind: 'delivery', status: 'in_progress' },
    } as TaskboardExecutionContext;
    expect(() => assertTaskboardExecutionScope({ action: 'execution.pull_request.inspect' }, delivery, identity))
      .not.toThrow();
  });
});
