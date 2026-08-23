import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { createTaskboardRouter } from '../routes/taskboard.js';
import { PgTaskboardStore } from '../taskboard/store.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

const USER: JwtPayload = {
  sub: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-a',
};

describePg('任务标题生成的并发幂等', () => {
  const prefix = `tb_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  let server: Server;
  let baseUrl = '';
  let boardId = '';
  let titleGenerationCalls = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 2 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
    boardId = (await store.createBoard({
      tenantId: USER.tenantId!, ownerUserId: USER.sub, username: USER.username,
    }, { name: `并发幂等 ${randomUUID()}` })).id;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USER; next(); });
    app.use('/api/taskboard', createTaskboardRouter({
      service: store,
      generateTaskTitle: async () => {
        titleGenerationCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return '并发唯一标题';
      },
    }));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  }, 30_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
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

  it('过期创建 lease 可由同 key 重放接管并完成', async () => {
    const identity = { tenantId: USER.tenantId!, ownerUserId: USER.sub, username: USER.username };
    const input = { description: '进程中断恢复', clientRequestId: 'expired-request' };
    const first = await store.createTaskWithResult(identity, boardId, input);
    expect(first).toMatchObject({ created: true, creationClaimToken: expect.any(String) });
    await pool.query(
      `UPDATE ${store.tasksTable} SET creation_lease_expires_at=now()-interval '1 second' WHERE id=$1`,
      [first.task.id],
    );
    const takeover = await store.createTaskWithResult(identity, boardId, input);
    expect(takeover).toMatchObject({ created: false, creationClaimToken: expect.any(String) });
    expect(takeover.creationClaimToken).not.toBe(first.creationClaimToken);
    await store.completeTaskCreation(identity, takeover.task.id, takeover.creationClaimToken!);
    await expect(store.createTaskWithResult(identity, boardId, input))
      .resolves.toMatchObject({ created: false, task: { id: first.task.id } });
  });

  it('小连接池下并发同一 clientRequestId 不挂死且只生成一次', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(
      `${baseUrl}/api/taskboard/boards/${boardId}/tasks`,
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: '并发创建正文', clientRequestId: 'same-request' }),
      },
    )));

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(201));
    expect((await Promise.all(responses.map((response) => response.json())))
      .every((task) => task.title === '并发唯一标题')).toBe(true);
    expect(titleGenerationCalls).toBe(1);
    const tasks = await store.listTasks({
      tenantId: USER.tenantId!, ownerUserId: USER.sub, username: USER.username,
    }, boardId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('并发唯一标题');
  }, 15_000);
});
