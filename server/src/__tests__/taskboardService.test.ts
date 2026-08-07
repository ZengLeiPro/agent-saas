import { describe, expect, it, vi } from 'vitest';

import { RetryableTaskboardService, type InitializableTaskboardService } from '../taskboard/retryableService.js';
import {
  PgTaskboardStore,
  TASKBOARD_TABLE_PREFIX_MAX_LENGTH,
} from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
};

describe('Taskboard service hardening', () => {
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
