import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import type { PgTaskboardStore } from './store.js';
import {
  cancelExecution,
  claimExecution,
  completeExecution,
  shouldPersistIntegrationDurableSession,
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
  it.each([undefined, 'merge'] as const)(
    'rejects a v2 integration purpose=%s before reading or inserting executions',
    async (purpose) => {
      const legacyTask: TaskBoardTask = { ...task, kind: 'integration', workflowVersion: 2 };
      const client = { query: vi.fn() };
      const store = {
        requireTaskWithBoard: vi.fn(async () => ({
          task: legacyTask, boardOwnerUserId: identity.ownerUserId, boardRole: 'owner',
        })),
        withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
      } as unknown as PgTaskboardStore;
      const input = claimInput();
      if (purpose) input.purpose = purpose;
      else delete input.purpose;

      await expect(claimExecution(store, identity, task.id, input)).rejects.toMatchObject({
        code: 'TASKBOARD_INTEGRATION_MIGRATION_REQUIRED',
      });
      expect(client.query).not.toHaveBeenCalled();
    },
  );
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

  it('admits v3 work through the durable Agent rendezvous without a Candidate binding', async () => {
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
        if (sql.includes('FROM taskboard_agents') && sql.includes('SELECT 1')) return { rows: [{}] };
        if (sql.includes('SELECT integration_task_id FROM taskboard_agents')) return { rows: [{}] };
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
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FROM taskboard_agents'), [task.id]);
  });

  it('validates the single v3 work Execution against the Integration merge-model configuration key', async () => {
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
        if (sql.includes('SELECT integration_task_id FROM taskboard_agents')) return { rows: [{}] };
        if (sql.includes('SELECT 1 WHERE EXISTS')) return { rows: [] };
        throw new Error('passed Integration model check');
      }),
    };
    const store = {
      executionsTable: 'taskboard_executions',
      continuationOutboxTable: 'taskboard_continuation_outbox',
      integrationSourcesTable: 'taskboard_sources',
      remediationAttemptsTable: 'taskboard_remediation_attempts',
      requireTaskWithBoard: vi.fn(async () => ({
        task: integrationTask,
        boardModel: 'group-a/model-board',
        boardStageModels: { work: 'group-a/model-work', merge: 'group-a/model-merge' },
        boardOwnerUserId: identity.ownerUserId,
        boardRole: 'owner',
      })),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;
    const input = claimInput();
    input.configuredModelRef = 'group-a/model-merge';

    await expect(claimExecution(store, identity, task.id, input)).rejects.toThrow('passed Integration model check');
    input.configuredModelRef = 'group-a/model-work';
    await expect(claimExecution(store, identity, task.id, input)).rejects.toMatchObject({
      code: 'TASKBOARD_EXECUTION_MODEL_CHANGED',
    });
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

describe('completeExecution', () => {
  it('treats Runtime cancellation after a protocol handoff as successful stage completion', async () => {
    const handedOffTask = { ...task, status: 'in_review' as const, version: 2 };
    const executionRow = {
      id: 'execution-1', task_id: task.id, run_id: 'run-1', session_id: 'session-1',
      status: 'running', purpose: 'work', trigger: 'initial', protocol_version: 2,
      requested_by: identity.ownerUserId, transitioned_at: new Date('2026-08-18T01:05:00.000Z'),
      terminal_reason_code: 'execution_transitioned', fence_epoch: 1,
      created_at: new Date(task.createdAt), updated_at: new Date(task.updatedAt),
      reconcile_lease_valid: true,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('SELECT *') && sql.includes('reconcile_lease_valid')) return { rows: [executionRow] };
        if (sql.includes('AS merged')) return { rows: [{ merged: false }] };
        if (sql.includes('SELECT c.id FROM')) return { rows: [{ id: 'comment-1' }] };
        if (sql.includes('UPDATE taskboard_executions') && sql.includes('SET status=$2')) {
          return { rows: [{ ...executionRow, status: values?.[1], error: values?.[2], terminal_reason_code: null }] };
        }
        return { rows: [] };
      }),
    };
    const store = {
      pool: { query: vi.fn(async () => ({ rows: [{
        task_id: task.id, tenant_id: identity.tenantId, owner_user_id: identity.ownerUserId,
      }] })) },
      tasksTable: 'taskboard_tasks', boardsTable: 'taskboard_boards', executionsTable: 'taskboard_executions',
      commentsTable: 'taskboard_comments', changesTable: 'taskboard_changes',
      executionOutboxTable: 'taskboard_execution_outbox', cancellationOutboxTable: 'taskboard_cancellation_outbox',
      integrationSourcesTable: 'taskboard_sources', remediationAttemptsTable: 'taskboard_remediation_attempts',
      requireTaskWithBoard: vi.fn(async () => ({ task: handedOffTask, boardArchivedAt: undefined })),
      requireTask: vi.fn(async () => handedOffTask),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(completeExecution(store, 'run-1', {
      status: 'cancelled', error: 'execution_transitioned', commentBody: 'handoff already persisted',
    })).resolves.toMatchObject({ execution: { status: 'succeeded' } });

    const completion = client.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE taskboard_executions')
      && String(sql).includes('SET status=$2'));
    expect(completion?.[1]).toEqual(['run-1', 'succeeded', null, 'execution_transitioned']);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE taskboard_cancellation_outbox'),
      ['execution-1', 'execution_transitioned'],
    );
  });
});

describe('cancelExecution', () => {
  it('终止已经交接但仍显示 running 的 Execution，且不回滚任务状态', async () => {
    const transitionedExecution = {
      id: 'execution-stale',
      task_id: task.id,
      run_id: 'run-stale',
      session_id: 'session-stale',
      status: 'running',
      purpose: 'work',
      trigger: 'initial',
      protocol_version: 2,
      requested_by: identity.ownerUserId,
      transitioned_at: new Date('2026-08-18T01:05:00.000Z'),
      fence_epoch: 1,
      created_at: new Date(task.createdAt),
      updated_at: new Date(task.updatedAt),
    };
    const cancelledExecution = {
      ...transitionedExecution,
      status: 'cancelled',
      superseded_at: new Date('2026-08-18T01:06:00.000Z'),
      finished_at: new Date('2026-08-18T01:06:00.000Z'),
      fence_epoch: 2,
    };
    let executionSelects = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT * FROM taskboard_executions WHERE id=$1')) {
          executionSelects += 1;
          return { rows: [executionSelects === 1 ? transitionedExecution : cancelledExecution] };
        }
        if (sql.includes("UPDATE taskboard_executions") && sql.includes("SET status='cancelled'")) {
          return {
            rows: [{ id: transitionedExecution.id, run_id: transitionedExecution.run_id, task_id: task.id, fence_epoch: 2 }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const store = {
      tasksTable: 'taskboard_tasks',
      boardsTable: 'taskboard_boards',
      executionsTable: 'taskboard_executions',
      changesTable: 'taskboard_changes',
      cancellationOutboxTable: 'taskboard_cancellation_outbox',
      requireTaskWithBoard: vi.fn(async () => ({ task, boardRole: 'maintainer' })),
      requireTask: vi.fn(async () => task),
      withTransaction: vi.fn(async (operation: (transaction: typeof client) => Promise<unknown>) => operation(client)),
    } as unknown as PgTaskboardStore;

    await expect(cancelExecution(store, identity, task.id, transitionedExecution.id, {
      expectedVersion: task.version,
      reason: '清理卡死执行',
    })).resolves.toMatchObject({
      task: { id: task.id, status: task.status, version: task.version },
      execution: { id: transitionedExecution.id, status: 'cancelled' },
    });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE taskboard_tasks'), expect.anything());
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO taskboard_cancellation_outbox'),
      expect.arrayContaining([transitionedExecution.id, transitionedExecution.run_id, task.id, 'operator_cancelled']),
    );
  });
});

describe('Integration Agent durable session persistence', () => {
  it('is established by work only and is never overwritten by independent review or merge', () => {
    expect(shouldPersistIntegrationDurableSession(true, 'work')).toBe(true);
    expect(shouldPersistIntegrationDurableSession(true, 'review')).toBe(false);
    expect(shouldPersistIntegrationDurableSession(true, 'merge')).toBe(false);
    expect(shouldPersistIntegrationDurableSession(false, 'work')).toBe(false);
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

  it.each([
    ['work', 'in_progress'],
    ['review', 'in_progress'],
    ['merge', 'in_progress'],
  ] as const)('normalizes historical Agent-first %s runtime failures into the single work stage', (purpose, status) => {
    expect(unresolvedExecutionRecovery(purpose, 'failed', 99, 1, { agentFirstIntegration: true }))
      .toEqual({ status, exhausted: false });
  });
});
