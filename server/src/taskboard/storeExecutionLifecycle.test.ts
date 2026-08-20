import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import type { PgTaskboardStore } from './store.js';
import {
  claimExecution,
  unresolvedExecutionRecovery,
} from './storeExecutionLifecycle.js';
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
  it('replays the same execution id after the task reaches a terminal state', async () => {
    const terminalTask = { ...task, status: 'done' as const, version: 9 };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM taskboard_executions WHERE id=')) return {
          rows: [{
            id: 'execution-1', task_id: task.id, run_id: 'original-run', session_id: 'session-1',
            status: 'succeeded', purpose: 'work', trigger: 'initial', protocol_version: 2,
            requested_by: identity.ownerUserId, id_match: true, run_match: false,
            created_at: task.createdAt, updated_at: task.updatedAt,
          }],
        };
        return { rows: [] };
      }),
    };
    const store = {
      executionsTable: 'taskboard_executions',
      requireTaskWithBoard: vi.fn(async () => ({
        task: terminalTask, boardOwnerUserId: identity.ownerUserId, boardRole: 'owner',
      })),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(claimExecution(store, identity, task.id, claimInput())).resolves.toMatchObject({
      task: { status: 'done' }, execution: { id: 'execution-1', runId: 'original-run' },
    });
  });

  it('replays an execution matched by run id after the task reaches a terminal state', async () => {
    const terminalTask = { ...task, status: 'done' as const, version: 9 };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM taskboard_executions WHERE id=')) return {
          rows: [{
            id: 'original-execution', task_id: task.id, run_id: 'run-1', session_id: 'session-1',
            status: 'succeeded', purpose: 'work', trigger: 'initial', protocol_version: 2,
            requested_by: identity.ownerUserId, id_match: false, run_match: true,
            created_at: task.createdAt, updated_at: task.updatedAt,
          }],
        };
        return { rows: [] };
      }),
    };
    const store = {
      executionsTable: 'taskboard_executions',
      requireTaskWithBoard: vi.fn(async () => ({
        task: terminalTask, boardOwnerUserId: identity.ownerUserId, boardRole: 'owner',
      })),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(claimExecution(store, identity, task.id, claimInput())).resolves.toMatchObject({
      task: { status: 'done' }, execution: { id: 'original-execution', runId: 'run-1' },
    });
  });

  it('rejects a replay whose execution id and run id belong to different executions', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM taskboard_executions WHERE id=')) return {
          rows: [
            {
              id: 'execution-1', task_id: task.id, run_id: 'other-run', session_id: 'session-1',
              status: 'running', purpose: 'work', trigger: 'initial', protocol_version: 2,
              requested_by: identity.ownerUserId, id_match: true, run_match: false,
              created_at: task.createdAt, updated_at: task.updatedAt,
            },
            {
              id: 'other-execution', task_id: task.id, run_id: 'run-1', session_id: 'session-2',
              status: 'running', purpose: 'work', trigger: 'initial', protocol_version: 2,
              requested_by: identity.ownerUserId, id_match: false, run_match: true,
              created_at: task.createdAt, updated_at: task.updatedAt,
            },
          ],
        };
        return { rows: [] };
      }),
    };
    const store = {
      executionsTable: 'taskboard_executions',
      requireTaskWithBoard: vi.fn(async () => ({
        task, boardOwnerUserId: identity.ownerUserId, boardRole: 'owner',
      })),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(claimExecution(store, identity, task.id, claimInput())).rejects.toMatchObject({
      code: 'TASKBOARD_EXECUTION_IDEMPOTENCY_CONFLICT',
    });
  });

  it('rejects a new claim when a provider receipt is the only merge fact', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM taskboard_executions WHERE id=')) return { rows: [] };
        if (sql.includes('AS merged')) return { rows: [{ merged: true }] };
        return { rows: [] };
      }),
    };
    const store = {
      executionsTable: 'taskboard_executions', integrationSourcesTable: 'taskboard_sources',
      requireTaskWithBoard: vi.fn(async () => ({
        task, boardOwnerUserId: identity.ownerUserId, boardRole: 'owner',
      })),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(claimExecution(store, identity, task.id, claimInput())).rejects.toMatchObject({
      code: 'TASKBOARD_TERMINAL_EXECUTION_FORBIDDEN',
    });
  });

  it('loads and validates the current v3 candidate before admitting a work execution', async () => {
    const integrationTask: TaskBoardTask = {
      ...task,
      kind: 'integration',
      workflowVersion: 3,
      status: 'in_progress',
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM taskboard_executions WHERE id=')) return { rows: [] };
        if (sql.includes('AS merged')) return { rows: [{ merged: false }] };
        if (sql.includes('SELECT c.id,c.state')) return { rows: [{
          id: 'candidate-1', state: 'working', version: 4, current_revision: 2,
          work_round: 1, workflow_epoch: '8', lane_epoch: '3', head_oid: 'head-2',
        }] };
        if (sql.includes('SELECT 1 WHERE EXISTS')) return { rows: [{}] };
        return { rows: [] };
      }),
    };
    const store = {
      executionsTable: 'taskboard_executions',
      continuationOutboxTable: 'taskboard_continuation_outbox',
      integrationSourcesTable: 'taskboard_sources',
      remediationAttemptsTable: 'taskboard_remediation_attempts',
      requireTaskWithBoard: vi.fn(async () => ({
        task: integrationTask, boardOwnerUserId: identity.ownerUserId, boardRole: 'owner',
      })),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(claimExecution(store, identity, task.id, claimInput())).rejects.toMatchObject({
      code: 'TASKBOARD_EXECUTION_ACTIVE',
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE OF c'), [task.id]);
  });

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

describe('unresolvedExecutionRecovery', () => {
  it.each([
    ['work', 'cancelled', 99, 0, 'todo', false],
    ['review', 'cancelled', 99, 0, 'in_review', false],
    ['merge', 'cancelled', 99, 0, 'in_progress', false],
    ['work', 'failed', 1, 3, 'todo', false],
    ['review', 'failed', 3, 3, 'blocked', true],
    ['merge', 'failed', 4, 3, 'blocked', true],
  ] as const)(
    '%s %s recovers to %s without consuming cancellation retry budget',
    (purpose, completionStatus, failedCount, maxRetries, status, exhausted) => {
      expect(unresolvedExecutionRecovery(purpose, completionStatus, failedCount, maxRetries))
        .toEqual({ status, exhausted });
    },
  );
});
