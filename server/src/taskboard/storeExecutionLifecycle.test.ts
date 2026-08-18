import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import type { PgTaskboardStore } from './store.js';
import { claimExecution } from './storeExecutionLifecycle.js';
import type { TaskboardExecutionClaimInput, TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'alice-id',
  username: 'alice',
};

const task: TaskBoardTask = {
  id: 'task-1',
  boardId: 'board-1',
  identifier: 'TASK-1',
  kind: 'delivery',
  title: '创建后直接执行',
  description: '',
  attachments: [],
  status: 'todo',
  priority: 'none',
  labels: [],
  sortOrder: 1024,
  commentCount: 0,
  version: 1,
  createdAt: '2026-08-18T01:00:00.000Z',
  updatedAt: '2026-08-18T01:00:00.000Z',
};

function claimInput(): TaskboardExecutionClaimInput {
  return {
    expectedVersion: task.version,
    executionId: 'execution-1',
    runId: 'run-1',
    sessionId: 'session-1',
    purpose: 'work',
    configuredModelRef: 'group-a/model-work',
    executionOwnerUserId: identity.ownerUserId,
    dispatch: {
      version: 1,
      session: {
        sessionId: 'session-1',
        userId: identity.ownerUserId,
        username: identity.username,
        tenantId: identity.tenantId,
        channel: 'web',
        cwd: '/tmp/taskboard-test',
        transcriptPath: '/tmp/taskboard-test/session-1.jsonl',
        status: 'running',
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      run: {
        runId: 'run-1',
        sessionId: 'session-1',
        userId: identity.ownerUserId,
        tenantId: identity.tenantId,
        channel: 'web',
        idempotencyKey: 'taskboard-execution:execution-1',
        metadata: { taskboardExecution: true, taskboardExecutionId: 'execution-1' },
      },
    },
  };
}

describe('claimExecution model consistency', () => {
  it('accepts the selected work-stage model while holding the board lock', async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [{
          id: 'execution-1',
          task_id: task.id,
          run_id: 'run-1',
          session_id: 'session-1',
          status: 'queued',
          purpose: 'work',
          trigger: 'initial',
          protocol_version: 1,
          requested_by: identity.ownerUserId,
          created_at: task.createdAt,
          updated_at: task.updatedAt,
        }],
      })),
    };
    const store = {
      executionsTable: 'taskboard_executions',
      requireTaskWithBoard: vi.fn(async () => ({
        task,
        boardModel: 'group-a/model-board',
        boardStageModels: { work: 'group-a/model-work' },
        boardOwnerUserId: identity.ownerUserId,
        boardRole: 'owner',
      })),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(claimExecution(store, identity, task.id, claimInput())).resolves.toMatchObject({
      task: { id: task.id },
      execution: { id: 'execution-1', purpose: 'work' },
    });
  });
});
