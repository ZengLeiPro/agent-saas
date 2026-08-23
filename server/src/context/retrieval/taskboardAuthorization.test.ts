import { describe, expect, it, vi } from 'vitest';

import type { ContextSourceLocator } from './sourceAuthorization.js';
import { TaskboardContextSourceAuthorizer } from './taskboardAuthorization.js';

const subject = { tenantId: 'tenant-a', userId: 'user-a' };
function locator(overrides: Partial<ContextSourceLocator> = {}): ContextSourceLocator {
  return {
    sourceKind: 'taskboard', sourceId: 'source', collectionId: 'collection', recordId: 'record', revision: 1,
    recordType: 'snapshot', resourceType: 'board', boardId: 'board-a', deleted: false, metadata: {}, ...overrides,
  };
}

describe('TaskboardContextSourceAuthorizer', () => {
  it('checks live owner/organization board access without consulting member roles', async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => {
      expect(params.slice(0, 2)).toEqual(['tenant-a', 'user-a']);
      return { rows: [{ idx: 0 }, { idx: 1 }] };
    });
    const authorizer = new TaskboardContextSourceAuthorizer({
      pool: { query } as never, boardsTable: 'boards', tasksTable: 'tasks',
    });
    await expect(authorizer.authorizeBatch(subject, [
      locator(), locator({ recordId: 'org', boardId: 'board-org' }), locator({ recordId: 'other', boardId: 'other' }),
    ])).resolves.toEqual([true, true, false]);
    expect(query.mock.calls[0]![0]).toContain("board.owner_user_id=$2 OR board.visibility='organization'");
    expect(query.mock.calls[0]![0]).not.toContain('members');
  });

  it('routes tasks/events through boards, denies deleted snapshots, and preserves delete-event eligibility', async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => {
      const payload = JSON.parse(String(params[2])) as Array<{ idx: number; recordType: string }>;
      expect(payload).toEqual([
        expect.objectContaining({ idx: 1, recordType: 'event', taskId: 'task-a' }),
        expect.objectContaining({ idx: 2, recordType: 'snapshot', taskId: 'task-a' }),
      ]);
      return { rows: [{ idx: 1 }, { idx: 2 }] };
    });
    const authorizer = new TaskboardContextSourceAuthorizer({
      pool: { query } as never, boardsTable: 'boards', tasksTable: 'tasks',
    });
    await expect(authorizer.authorizeBatch(subject, [
      locator({ resourceType: 'task', taskId: 'task-a', boardId: undefined, deleted: true }),
      locator({ recordType: 'event', resourceType: 'task', taskId: 'task-a', boardId: undefined, deleted: true, eventType: 'task.deleted' }),
      locator({ resourceType: 'task', taskId: 'task-a', boardId: undefined }),
    ])).resolves.toEqual([false, true, true]);
    expect(query.mock.calls[0]![0]).toContain("request.\"recordType\"='event'");
    expect(query.mock.calls[0]![0]).toContain('task.deleted_at IS NULL');
  });

  it('fails cross-tenant/unknown resources closed from the live SQL result', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const authorizer = new TaskboardContextSourceAuthorizer({
      pool: { query } as never, boardsTable: 'boards', tasksTable: 'tasks',
    });
    await expect(authorizer.authorizeBatch(subject, [locator(), locator({ resourceType: 'unknown' })]))
      .resolves.toEqual([false, false]);
    expect((query.mock.calls[0] as unknown as [string])[0]).toContain('board.tenant_id=$1');
  });
});
