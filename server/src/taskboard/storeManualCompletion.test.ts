import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardMemberRole, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { PgTaskboardStore } from './store.js';
import type { TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-1',
  ownerUserId: 'user-1',
  username: 'alice',
};

function task(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
  return {
    id: 'task-1',
    boardId: 'board-1',
    identifier: 'TASK-1',
    kind: 'advisory',
    title: '答复事项',
    description: '',
    status: 'todo',
    priority: 'none',
    labels: [],
    sortOrder: 1024,
    commentCount: 0,
    version: 3,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

function host(current: TaskBoardTask, options: {
  active?: boolean;
  boardRole?: TaskBoardMemberRole;
  boardArchivedAt?: string;
} = {}) {
  const completed = {
    ...current,
    status: 'done' as const,
    version: current.version + 1,
    completedAt: '2026-08-26T01:00:00.000Z',
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT 1 WHERE EXISTS')) return { rows: options.active ? [{ '?column?': 1 }] : [] };
    if (sql.includes('SELECT t.sort_order')) return { rows: [] };
    return { rows: [] };
  });
  type TestClient = { query: typeof query };
  const client: TestClient = { query };
  const store = {
    tasksTable: 'tasks',
    boardsTable: 'boards',
    executionsTable: 'executions',
    continuationOutboxTable: 'continuations',
    executionOutboxTable: 'execution_outbox',
    changesTable: 'changes',
    withTransaction: vi.fn(async (operation: (transactionClient: TestClient) => Promise<unknown>) => operation(client)),
    requireTaskWithBoard: vi.fn(async () => ({
      task: current,
      boardRole: options.boardRole ?? 'owner',
      boardArchivedAt: options.boardArchivedAt,
    })),
    requireTask: vi.fn(async () => completed),
  };
  return { store, client, query, completed };
}

describe('PgTaskboardStore.completeTask', () => {
  it('atomically marks an ordinary task done and records the transition', async () => {
    const current = task();
    const { store, query, completed } = host(current, { boardRole: 'maintainer' });

    await expect(PgTaskboardStore.prototype.completeTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { expectedVersion: current.version },
    )).resolves.toEqual(completed);

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain("SET status='done'");
    expect(sql).toContain('completed_at=COALESCE(completed_at,now())');
    expect(sql).toContain('workflow_epoch=workflow_epoch+1');
    expect(sql).toContain('next_action_revision=next_action_revision+1');
    expect(sql).toContain('version=version+1');
    expect(sql).toContain('INSERT INTO changes');
  });

  it('requires a maintainer role', async () => {
    const current = task();
    const { store } = host(current, { boardRole: 'editor' });
    await expect(PgTaskboardStore.prototype.completeTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { expectedVersion: current.version },
    )).rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
  });

  it('enforces expectedVersion before updating the task', async () => {
    const current = task();
    const { store, query } = host(current);
    await expect(PgTaskboardStore.prototype.completeTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { expectedVersion: current.version - 1 },
    )).rejects.toMatchObject({ code: 'TASKBOARD_VERSION_CONFLICT', current });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['integration task', task({ kind: 'integration' })],
    ['remediation task', task({ kind: 'remediation' })],
    ['completed task', task({ status: 'done' })],
    ['canceled task', task({ status: 'canceled' })],
    ['claimed task', task({ mergeEligibility: 'claimed' })],
  ])('keeps %s under workflow control', async (_label, current) => {
    const { store } = host(current);
    await expect(PgTaskboardStore.prototype.completeTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { expectedVersion: current.version },
    )).rejects.toMatchObject({ code: 'TASKBOARD_PROTECTED_TRANSITION' });
  });

  it.each([
    ['archived task', task({ archivedAt: '2026-08-26T00:30:00.000Z' }), undefined, 'TASKBOARD_TASK_ARCHIVED'],
    ['archived board', task(), '2026-08-26T00:30:00.000Z', 'TASKBOARD_BOARD_ARCHIVED'],
  ])('rejects an %s', async (_label, current, boardArchivedAt, code) => {
    const { store } = host(current, { boardArchivedAt });
    await expect(PgTaskboardStore.prototype.completeTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { expectedVersion: current.version },
    )).rejects.toMatchObject({ code });
  });

  it('rejects manual completion while an Agent execution is active', async () => {
    const current = task({ status: 'in_progress' });
    const { store, query } = host(current, { active: true });

    await expect(PgTaskboardStore.prototype.completeTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { expectedVersion: current.version },
    )).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('continuations');
    expect(sql).not.toContain("SET status='done'");
  });
});
