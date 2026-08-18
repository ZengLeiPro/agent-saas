import { describe, expect, it } from 'vitest';

import type { TaskBoardTask, TaskBoardTaskPatchInput } from '../../../shared/src/types/taskboard.js';
import { describeTaskUpdate, resolveTaskKindMutation } from './storeTaskPromotion.js';

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
});
