import { describe, expect, it } from 'vitest';

import type { TaskboardExecutionContext, TaskboardIdentity } from '../taskboard/types.js';
import { assertTaskboardExecutionScope } from './taskboardExecutionScope.js';

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

describe('taskboard Integration Execution scope', () => {
  it.each([
    'integration.source.inspect',
    'integration.source.log',
    'integration.source.merge',
  ] as const)('hard-rejects workflow v3 action %s', (action) => {
    expect(() => assertTaskboardExecutionScope({ action }, context(3), identity))
      .toThrow('Workflow v3 Integration Agent 禁止调用 legacy integration.source 操作');
  });

  it.each([
    'integration.source.inspect',
    'integration.source.log',
    'integration.source.merge',
  ] as const)('keeps legacy v2 action %s available', (action) => {
    expect(() => assertTaskboardExecutionScope({ action }, context(2), identity)).not.toThrow();
  });
});
