import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import { COMMENT_PREVIEW_CHARS } from '../taskboard/commentQuery.js';
import { TaskboardValidationError, type TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

/** 每条正文都超过预览长度，便于验证 digest 投影与字节预算。 */
const longBody = (index: number) => `第${index}条阶段报告：${'详'.repeat(COMMENT_PREVIEW_CHARS)}`;

describePg('taskboard comment locating and context projection', () => {
  const prefix = `tbc_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  const alice: TaskboardIdentity = {
    tenantId: 'tenant-a',
    ownerUserId: 'alice-id',
    username: 'alice',
  };

  async function seedTask(
    name: string,
    count: number,
  ): Promise<{ taskId: string; commentIds: string[] }> {
    const board = await store.createBoard(alice, { name });
    const task = await store.createTask(alice, board.id, { title: `${name} 任务` });
    const commentIds: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const comment = await store.createComment(alice, task.id, { body: longBody(index) });
      commentIds.push(comment.id);
      // created_at 是事务时间；错开写入避免同一微秒导致 (created_at,id) 顺序不确定。
      await delay(2);
    }
    return { taskId: task.id, commentIds };
  }

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      max: 8,
    });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS
        ${store.integrationTriggerOutboxTable}, ${store.blockEpisodesTable}, ${store.cancellationOutboxTable},
        ${store.remediationAttemptsTable}, ${store.mergeOperationsTable},
        ${store.mergeAuthorizationsTable}, ${store.integrationSourcesTable}, ${store.integrationLanesTable},
        ${store.attemptsTable}, ${store.changesTable}, ${store.membersTable}, ${store.continuationOutboxTable},
        ${store.executionOutboxTable}, ${store.executionsTable}, ${store.commentsTable}, ${store.tasksTable},
        ${store.boardsTable} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('supports order, latest, ordinal and commentId locating', async () => {
    const { taskId, commentIds } = await seedTask('评论定位', 5);

    const ascending = await store.searchComments(alice, taskId, { page: 1, pageSize: 10 });
    expect(ascending.items.map((item) => item.id)).toEqual(commentIds);
    expect(ascending.items.map((item) => item.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(ascending.total).toBe(5);

    const descending = await store.searchComments(alice, taskId, {
      page: 1,
      pageSize: 2,
      order: 'desc',
    });
    expect(descending.items.map((item) => item.id)).toEqual([commentIds[4], commentIds[3]]);
    expect(descending.hasMore).toBe(true);

    const latest = await store.searchComments(alice, taskId, { latest: 3 });
    expect(latest.items.map((item) => item.id)).toEqual(commentIds.slice(2));
    expect(latest.total).toBe(5);
    expect(latest.hasMore).toBe(false);

    const second = await store.searchComments(alice, taskId, { ordinal: 2 });
    expect(second.items.map((item) => item.id)).toEqual([commentIds[1]]);

    const last = await store.searchComments(alice, taskId, { ordinal: -1 });
    expect(last.items.map((item) => item.id)).toEqual([commentIds[4]]);
    expect(last.items[0]?.body).toBe(longBody(5));
    expect(last.items[0]?.bodyTruncated).toBeUndefined();

    const byId = await store.searchComments(alice, taskId, { commentId: commentIds[2]! });
    expect(byId.items.map((item) => item.ordinal)).toEqual([3]);

    const missing = await store.searchComments(alice, taskId, { ordinal: 99 });
    expect(missing.items).toEqual([]);
    expect(missing.total).toBe(5);

    await expect(store.searchComments(alice, taskId, { ordinal: 0 })).rejects.toBeInstanceOf(
      TaskboardValidationError,
    );
    await expect(store.searchComments(alice, taskId, { latest: 99 })).rejects.toBeInstanceOf(
      TaskboardValidationError,
    );
  });

  it('projects digest rows and re-numbers ordinals after a delete', async () => {
    const { taskId, commentIds } = await seedTask('评论目录', 4);

    const digest = await store.searchComments(alice, taskId, {
      page: 1,
      pageSize: 10,
      view: 'digest',
    });
    expect(digest.items).toHaveLength(4);
    for (const item of digest.items) {
      expect(item.body).toHaveLength(COMMENT_PREVIEW_CHARS);
      expect(item.bodyTruncated).toBe(true);
      expect(item.bodyChars).toBeGreaterThan(COMMENT_PREVIEW_CHARS);
    }

    const removed = await store.searchComments(alice, taskId, { ordinal: 2 });
    await store.deleteComment(alice, removed.items[0]!.id, {
      expectedVersion: removed.items[0]!.version,
    });

    const afterDelete = await store.searchComments(alice, taskId, { page: 1, pageSize: 10 });
    expect(afterDelete.items.map((item) => item.id)).toEqual([
      commentIds[0],
      commentIds[2],
      commentIds[3],
    ]);
    expect(afterDelete.items.map((item) => item.ordinal)).toEqual([1, 2, 3]);
    const shifted = await store.searchComments(alice, taskId, { ordinal: 2 });
    expect(shifted.items.map((item) => item.id)).toEqual([commentIds[2]]);
    const stillLast = await store.searchComments(alice, taskId, { ordinal: -1 });
    expect(stillLast.items.map((item) => item.id)).toEqual([commentIds[3]]);
  });

  it('returns only the newest comment body in execution context by default', async () => {
    const { taskId, commentIds } = await seedTask('上下文评论', 4);

    const context = await store.getExecutionContextV2!(alice, taskId, { include: ['comments'] });
    expect(context.comments?.map((item) => item.id)).toEqual(commentIds);
    expect(context.comments?.slice(0, 3).every((item) => item.bodyTruncated === true)).toBe(true);
    expect(
      context.comments?.slice(0, 3).every((item) => item.body.length === COMMENT_PREVIEW_CHARS),
    ).toBe(true);
    const newest = context.comments?.[3];
    expect(newest?.body).toBe(longBody(4));
    expect(newest?.bodyTruncated).toBeUndefined();
    expect(context.truncation?.comments).toEqual({ returned: 4, total: 4, digested: 3 });

    const full = await store.getExecutionContextV2!(alice, taskId, {
      include: ['comments'],
      comments: { mode: 'full' },
    });
    expect(full.comments?.map((item) => item.body)).toEqual([1, 2, 3, 4].map(longBody));
    expect(full.truncation?.comments).toBeUndefined();

    const digest = await store.getExecutionContextV2!(alice, taskId, {
      include: ['comments'],
      comments: { mode: 'digest' },
    });
    expect(digest.comments?.every((item) => item.bodyTruncated === true)).toBe(true);

    const window = await store.getExecutionContextV2!(alice, taskId, {
      include: ['comments'],
      comments: { mode: 'recent', limit: 2 },
    });
    expect(window.comments?.filter((item) => !item.bodyTruncated).map((item) => item.id)).toEqual(
      commentIds.slice(2),
    );
  });
});
