import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask, TaskBoardTaskPatchInput } from '../../../shared/src/types/taskboard.js';
import { PgTaskboardStore } from './store.js';
import { describeTaskUpdate, resolveTaskKindMutation } from './storeTaskPromotion.js';
import type { TaskboardIdentity } from './types.js';

function task(kind: TaskBoardTask['kind'], status: TaskBoardTask['status'] = 'done'): TaskBoardTask {
  return {
    id: 'task-1', boardId: 'board-1', identifier: 'TASK-1', kind,
    title: '先分析后实施', description: '', status, priority: 'none', labels: [],
    sortOrder: 1024, commentCount: 0, version: 3,
    createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

describe('task kind promotion', () => {
  it('allows only advisory to delivery and requires maintainer', () => {
    expect(resolveTaskKindMutation(task('advisory'), 'delivery')).toEqual({
      promoting: true,
      requiredRole: 'maintainer',
    });
    expect(resolveTaskKindMutation(task('advisory'), undefined)).toEqual({
      promoting: false,
      requiredRole: 'editor',
    });
    expect(() => resolveTaskKindMutation(task('delivery'), 'delivery'))
      .toThrow('Only advisory tasks can be promoted to delivery');
  });

  it('describes promotion as a dedicated audited transition', () => {
    const input: TaskBoardTaskPatchInput = { kind: 'delivery', expectedVersion: 3 };
    expect(describeTaskUpdate(task('advisory', 'blocked'), input)).toEqual({
      type: 'task.promoted',
      payload: {
        fields: ['kind'],
        fromKind: 'advisory',
        toKind: 'delivery',
        previousStatus: 'blocked',
        status: 'todo',
      },
    });
  });

  it('clears automatic next action when promoting, so implementation still requires a manual start', async () => {
    const current = task('advisory', 'todo');
    const promoted = { ...current, kind: 'delivery' as const, version: current.version + 1 };
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    const client = { query };
    const store = {
      tasksTable: 'tasks', boardsTable: 'boards', executionsTable: 'executions',
      continuationOutboxTable: 'continuations', changesTable: 'changes',
      withTransaction: vi.fn(async (operation: (db: typeof client) => Promise<unknown>) => operation(client)),
      requireTaskWithBoard: vi.fn(async () => ({ task: current, boardRole: 'maintainer', boardArchivedAt: undefined })),
      requireTask: vi.fn(async () => promoted),
    };
    const identity: TaskboardIdentity = { tenantId: 'tenant-1', ownerUserId: 'user-1', username: 'alice' };

    await PgTaskboardStore.prototype.updateTask.call(
      store as unknown as PgTaskboardStore,
      identity,
      current.id,
      { kind: 'delivery', expectedVersion: current.version },
    );

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain("status='todo'");
    expect(sql).toContain("next_action='none'");
    expect(sql).toContain('workflow_epoch=workflow_epoch+1');
    expect(sql).toContain('next_action_revision=next_action_revision+1');
  });
});
