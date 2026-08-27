import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { PgTaskboardStore } from './store.js';
import { assertManualTaskRequeueAllowed, isManualTaskRequeue } from './storeTaskRequeue.js';
import type { TaskboardIdentity } from './types.js';

function task(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
  return {
    id: 'task-1', boardId: 'board-1', identifier: 'TASK-1', kind: 'delivery',
    title: '恢复任务', description: '', status: 'ready_to_merge', priority: 'none', labels: [],
    sortOrder: 1024, commentCount: 0, version: 3,
    createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('manual task requeue', () => {
  it.each(['ready_to_merge', 'done', 'canceled'] as const)(
    'recognizes %s to todo as an explicit manual requeue',
    (status) => {
      expect(isManualTaskRequeue(task({ status }), 'todo')).toBe(true);
    },
  );

  it('does not treat ordinary backlog/todo movement as a workflow requeue', () => {
    expect(isManualTaskRequeue(task({ status: 'backlog' }), 'todo')).toBe(false);
    expect(isManualTaskRequeue(task({ status: 'canceled' }), 'backlog')).toBe(false);
  });

  it.each(['delivery', 'advisory'] as const)('allows unclaimed %s tasks', (kind) => {
    expect(() => assertManualTaskRequeueAllowed(task({ kind, mergeEligibility: 'not_applicable' }))).not.toThrow();
  });

  it.each([
    ['integration task', task({ kind: 'integration' })],
    ['remediation task', task({ kind: 'remediation' })],
    ['claimed delivery', task({ mergeEligibility: 'claimed' })],
    ['merged delivery', task({ mergeEligibility: 'merged', mergedCommitOid: 'abc123' })],
  ])('rejects %s', (_label, current) => {
    try {
      assertManualTaskRequeueAllowed(current);
      throw new Error('expected requeue validation to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'TASKBOARD_PROTECTED_TRANSITION' });
    }
  });

  it('resets workflow intent and stale review evidence without starting an execution', async () => {
    const current = task({ mergeEligibility: 'eligible', reviewedSubjectDigest: 'old-review' });
    const requeued = { ...current, status: 'todo' as const, version: current.version + 1 };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('SELECT t.id, t.sort_order')) return { rows: [] };
      return { rows: [] };
    });
    const client = { query };
    const store = {
      tasksTable: 'tasks', boardsTable: 'boards', executionsTable: 'executions',
      continuationOutboxTable: 'continuations', changesTable: 'changes',
      withTransaction: vi.fn(async (operation: (db: typeof client) => Promise<unknown>) => operation(client)),
      requireTaskWithBoard: vi.fn(async () => ({ task: current, boardRole: 'maintainer', boardArchivedAt: undefined })),
      requireTask: vi.fn(async () => requeued),
    };
    const identity: TaskboardIdentity = { tenantId: 'tenant-1', ownerUserId: 'user-1', username: 'alice' };

    await PgTaskboardStore.prototype.moveTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { status: 'todo', expectedVersion: current.version },
    );

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain("next_action='none'");
    expect(sql).toContain('reviewed_subject_digest=NULL');
    expect(sql).toContain('provider_ci_inspection_id=NULL');
    expect(query.mock.calls.some(([, values]) => Array.isArray(values) && values.includes('task.requeued'))).toBe(true);
  });
});
