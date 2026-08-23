import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { invokeTaskboardAction } from '../agent/taskboardToolActions.js';
import type { TaskboardIdentity, TaskboardService } from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user',
};

const board = {
  id: 'board-1',
  name: '迭代任务',
  visibility: 'personal' as const,
  ownerUserId: identity.ownerUserId,
  role: 'owner' as const,
  canManage: true,
  version: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

describe('Agent 创建任务的自动标题', () => {
  it('仅传正文时生成标题，生成失败时保存空标题', async () => {
    const createTask = vi.fn(async (_identity, _boardId, input) => ({
      id: `task-${createTask.mock.calls.length}`,
      boardId: board.id,
      identifier: `TASK-${createTask.mock.calls.length}`,
      title: input.title ?? '',
      description: input.description ?? '',
      status: 'backlog' as const,
      priority: 'none' as const,
      labels: [],
      sortOrder: 1024,
      commentCount: 0,
      version: 1,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    } satisfies TaskBoardTask));
    const service = { getBoard: vi.fn(async () => board), createTask } as unknown as TaskboardService;
    const generateTaskTitle = vi.fn()
      .mockResolvedValueOnce('自动生成标题')
      .mockResolvedValueOnce(null);
    const options = { service: () => service, generateTaskTitle };

    await invokeTaskboardAction(options, identity, {
      action: 'task.create', boardId: board.id, description: '第一条正文',
    });
    await invokeTaskboardAction(options, identity, {
      action: 'task.create', boardId: board.id, description: '第二条正文',
    });

    expect(generateTaskTitle).toHaveBeenNthCalledWith(1, '第一条正文', identity);
    expect(generateTaskTitle).toHaveBeenNthCalledWith(2, '第二条正文', identity);
    expect(createTask.mock.calls.map((call) => call[2].title)).toEqual(['自动生成标题', '']);
  });
});
