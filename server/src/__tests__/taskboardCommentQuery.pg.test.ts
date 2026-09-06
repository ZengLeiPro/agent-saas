import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import { COMMENT_PREVIEW_CHARS } from '../taskboard/commentQuery.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from '../taskboard/types.js';

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
  const bob: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'bob-id', username: 'bob' };

  /**
   * 直接写库并显式指定 created_at：`createComment` 用的是事务时间戳，连续写入可能落在
   * 同一微秒，(created_at,id) 的 tie-break 会退化成 uuid 比较，让 ordinal 断言 flaky。
   */
  async function seedTask(
    name: string,
    count: number,
    body: (index: number) => string = longBody,
    visibility: 'personal' | 'organization' = 'personal',
  ): Promise<{ taskId: string; commentIds: string[] }> {
    const board = await store.createBoard(alice, { name, visibility });
    const task = await store.createTask(alice, board.id, { title: `${name} 任务` });
    const commentIds: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const id = `cmt-${randomUUID()}`;
      commentIds.push(id);
      await pool.query(
        `INSERT INTO ${store.commentsTable}
           (id, task_id, body, author_type, author_id, author_name, version, created_at, updated_at)
         VALUES ($1,$2,$3,'user',$4,$5,1,$6::timestamptz,$6::timestamptz)`,
        [id, task.id, body(index), alice.ownerUserId, alice.username,
          new Date(Date.UTC(2026, 8, 6, 0, 0, index)).toISOString()],
      );
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
    // 定位模式的 hasMore 表示「任务里还有未返回的评论」，避免模型据此误判已读完。
    expect(latest.hasMore).toBe(true);

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
    await expect(store.searchComments(alice, taskId, { ordinal: 2.5 })).rejects.toBeInstanceOf(
      TaskboardValidationError,
    );
    await expect(store.searchComments(alice, taskId, { latest: 99 })).rejects.toBeInstanceOf(
      TaskboardValidationError,
    );
  });

  it('定位参数忽略 order/page，分页越界仍报告真实 total', async () => {
    const { taskId, commentIds } = await seedTask('评论窗口', 5);

    const latestDesc = await store.searchComments(alice, taskId, { latest: 2, order: 'desc', page: 3 });
    expect(latestDesc.items.map((item) => item.id)).toEqual(commentIds.slice(3));
    expect(latestDesc.hasMore).toBe(true);

    const located = await store.searchComments(alice, taskId, { ordinal: -1, order: 'desc' });
    expect(located.items.map((item) => item.id)).toEqual([commentIds[4]]);
    expect(located.hasMore).toBe(true);

    await expect(store.searchComments(alice, taskId, { latest: 5 }))
      .resolves.toMatchObject({ hasMore: false });

    const beyond = await store.searchComments(alice, taskId, { page: 999, pageSize: 10 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(5);
    expect(beyond.hasMore).toBe(false);
  });

  it('按 code point 截断，emoji 正文仍会标记 bodyTruncated', async () => {
    const { taskId } = await seedTask('emoji 评论', 1, () => '🚀'.repeat(300));

    const digest = await store.searchComments(alice, taskId, { view: 'digest' });
    const item = digest.items[0]!;
    expect([...item.body]).toHaveLength(COMMENT_PREVIEW_CHARS);
    expect(item.bodyTruncated).toBe(true);
    expect(item.bodyChars).toBe(300);
    // 切片必须落在 code point 边界上，不能留下孤立代理。
    expect(item.body.endsWith('🚀')).toBe(true);

    const full = await store.searchComments(alice, taskId, { ordinal: 1 });
    expect(full.items[0]?.bodyTruncated).toBeUndefined();
    expect(full.items[0]?.bodyChars).toBe(300);
  });

  it('评论上百条时仍保留最新一条全文，并报告真实总数', async () => {
    const { taskId, commentIds } = await seedTask('长任务评论', 150);

    const context = await store.getExecutionContextV2!(alice, taskId, { include: ['comments'] });
    const newest = context.comments![context.comments!.length - 1]!;
    expect(newest.id).toBe(commentIds[149]);
    expect(newest.body).toBe(longBody(150));
    expect(newest.bodyTruncated).toBeUndefined();
    expect(context.truncation?.comments?.total).toBe(150);
    expect(context.comments!.length).toBeLessThan(150);
    expect(JSON.stringify(context.comments).length).toBeLessThan(150 * 1_000);
  });

  it('拒绝其他成员读取私有看板的评论', async () => {
    const { taskId } = await seedTask('私有评论', 2);
    await expect(store.searchComments(bob, taskId, { latest: 1 }))
      .rejects.toBeInstanceOf(TaskboardNotFoundError);

    const { taskId: sharedTaskId } = await seedTask('组织评论', 2, longBody, 'organization');
    await expect(store.searchComments(bob, sharedTaskId, { latest: 1 }))
      .resolves.toMatchObject({ total: 2 });
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
