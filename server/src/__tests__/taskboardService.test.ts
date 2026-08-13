import { describe, expect, it, vi } from 'vitest';

import { resolveExecutionPurpose } from '../taskboard/executionFields.js';
import { RetryableTaskboardService, type InitializableTaskboardService } from '../taskboard/retryableService.js';
import {
  PgTaskboardStore,
  TASKBOARD_TABLE_PREFIX_MAX_LENGTH,
} from '../taskboard/store.js';
import { rowToTask } from '../taskboard/storeHelpers.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
};

describe('Taskboard task mapping', () => {
  it('exposes creator and completion metadata when present', () => {
    const task = rowToTask({
      id: 'task-1',
      board_id: 'board-1',
      identifier: 'TASK-1',
      title: '卡片信息',
      description: '',
      status: 'done',
      priority: 'none',
      labels: [],
      sort_order: 1024,
      comment_count: 0,
      version: 2,
      creator_user_id: 'user-1',
      creator_name: '爱丽丝 @alice',
      completed_at: new Date('2026-08-13T01:00:00.000Z'),
      created_at: new Date('2026-08-12T01:00:00.000Z'),
      updated_at: new Date('2026-08-13T01:00:00.000Z'),
    });

    expect(task).toMatchObject({
      creatorUserId: 'user-1',
      creatorName: '爱丽丝 @alice',
      completedAt: '2026-08-13T01:00:00.000Z',
    });
  });
});

describe('Taskboard service hardening', () => {
  it('按任务阶段限制实施与独立复核执行', () => {
    expect(resolveExecutionPurpose('todo', undefined)).toBe('work');
    expect(resolveExecutionPurpose('in_review', 'review')).toBe('review');
    expect(() => resolveExecutionPurpose('todo', 'review')).toThrow('Only in-review tasks');
    expect(() => resolveExecutionPurpose('in_review', 'work')).toThrow('Only todo tasks');
  });

  it('rejects prefixes that would make implicit PostgreSQL identifiers exceed 63 bytes', () => {
    expect(() => new PgTaskboardStore({
      pool: {} as never,
      tablePrefix: `t${'a'.repeat(TASKBOARD_TABLE_PREFIX_MAX_LENGTH - 1)}`,
    })).not.toThrow();

    expect(() => new PgTaskboardStore({
      pool: {} as never,
      tablePrefix: `t${'a'.repeat(TASKBOARD_TABLE_PREFIX_MAX_LENGTH)}`,
    })).toThrow(`max ${TASKBOARD_TABLE_PREFIX_MAX_LENGTH} bytes`);
  });

  it('retries a failed initialization and coalesces concurrent recovery requests', async () => {
    const board = {
      id: 'board-1',
      name: '研发事项',
      version: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const init = vi.fn()
      .mockRejectedValueOnce(new Error('database starting'))
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    const listBoards = vi.fn().mockResolvedValue([board]);
    const target = { init, listBoards } as unknown as InitializableTaskboardService;
    const service = new RetryableTaskboardService(target);

    await expect(service.init()).rejects.toThrow('database starting');
    const [first, second] = await Promise.all([
      service.listBoards(identity),
      service.listBoards(identity),
    ]);

    expect(first).toEqual([board]);
    expect(second).toEqual([board]);
    expect(init).toHaveBeenCalledTimes(2);
    expect(listBoards).toHaveBeenCalledTimes(2);
  });
});
