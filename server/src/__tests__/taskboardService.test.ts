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
      resume_context: {
        decision: '依赖已解除，按新接口继续实施', purpose: 'work', sourceIds: [],
        requestedAt: '2026-08-12T08:00:00.000Z', requestedBy: 'user-1',
        consumedAt: '2026-08-12T08:05:00.000Z', consumedExecutionId: 'execution-1',
      },
      created_at: new Date('2026-08-12T01:00:00.000Z'),
      updated_at: new Date('2026-08-13T01:00:00.000Z'),
    });

    expect(task).toMatchObject({
      creatorUserId: 'user-1',
      creatorName: '爱丽丝 @alice',
      completedAt: '2026-08-13T01:00:00.000Z',
      resumeContext: {
        decision: '依赖已解除，按新接口继续实施', purpose: 'work',
        consumedExecutionId: 'execution-1',
      },
    });
  });
});

describe('Taskboard service hardening', () => {
  it('按任务阶段限制实施与独立复核执行', () => {
    expect(resolveExecutionPurpose('todo', undefined)).toBe('work');
    expect(resolveExecutionPurpose('in_review', 'review')).toBe('review');
    expect(() => resolveExecutionPurpose('todo', 'review')).toThrow('Only in-review tasks');
    expect(() => resolveExecutionPurpose('in_review', 'work')).toThrow('Only todo or blocked tasks');
  });

  it('允许人工重跑阻塞的交付任务，但仍拒绝 review 与 integration 的非法组合', () => {
    expect(resolveExecutionPurpose('blocked', 'work', 'delivery')).toBe('work');
    expect(resolveExecutionPurpose('blocked', 'work', 'remediation')).toBe('work');
    expect(resolveExecutionPurpose('blocked', 'merge', 'integration')).toBe('merge');
    expect(() => resolveExecutionPurpose('blocked', 'review', 'delivery')).toThrow('Only in-review tasks');
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

  it('通过可重试包装层暴露显式恢复能力', async () => {
    const resumed = { id: 'task-1', status: 'todo', version: 3 };
    const resumeBlockedTask = vi.fn().mockResolvedValue(resumed);
    const target = {
      init: vi.fn().mockResolvedValue(undefined),
      resumeBlockedTask,
    } as unknown as InitializableTaskboardService;
    const service = new RetryableTaskboardService(target);
    const input = { expectedVersion: 2, decision: '依赖已解除，继续实施' };

    await expect(service.resumeBlockedTask(identity, 'task-1', input)).resolves.toBe(resumed);
    expect(resumeBlockedTask).toHaveBeenCalledWith(identity, 'task-1', input);
  });
});
