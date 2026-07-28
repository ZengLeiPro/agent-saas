import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgSkillMaterializationStore } from '../workspace/materialization/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('技能物化 PostgreSQL 队列', () => {
  const prefix = `smq_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const batchesTable = `${prefix}_skill_materialization_batches`;
  const tasksTable = `${prefix}_skill_materialization_tasks`;
  let pool: InstanceType<typeof Pool>;
  let store: PgSkillMaterializationStore;
  let peer: PgSkillMaterializationStore;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: testPgUrl!,
      connectionTimeoutMillis: 5_000,
      max: 8,
    });
    store = new PgSkillMaterializationStore({ pool, tablePrefix: prefix });
    peer = new PgSkillMaterializationStore({ pool, tablePrefix: prefix });
    await Promise.all([store.init(), peer.init()]);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${tasksTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${batchesTable}`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('空批次直接成功，普通批次持久化租户范围和进度', async () => {
    const empty = await store.enqueueBatch({ requests: [] });
    expect(empty).toMatchObject({
      status: 'succeeded',
      total: 0,
      tenantIds: [],
    });

    const batch = await store.enqueueBatch({
      requests: [{
        user: {
          id: 'user-a',
          username: 'alice',
          role: 'user',
          tenantId: 'tenant-a',
        },
        userCwd: '/workspace/tenant-a/user-a',
        reason: 'admin',
        priority: 50,
        requiredSkillIds: ['beta', 'alpha'],
        force: true,
        requestKey: 'alice:1:alpha,beta',
        sourceRevision: 'release-a',
      }],
    });
    expect(batch).toMatchObject({
      status: 'queued',
      total: 1,
      queued: 1,
      tenantIds: ['tenant-a'],
    });

    const task = await store.claimNext('worker-a', 60, 'release-a');
    expect(task).toMatchObject({
      batchId: batch.id,
      status: 'running',
      attempts: 1,
      force: true,
      requiredSkillIds: ['alpha', 'beta'],
    });
    await store.markSucceeded(task!.id, 'worker-a', {
      changedSkills: 2,
      skippedSkills: 1,
      removedSkills: 1,
      desiredHash: 'digest',
    });
    await expect(store.getBatch(batch.id)).resolves.toMatchObject({
      status: 'succeeded',
      total: 1,
      succeeded: 1,
      changedSkills: 2,
      skippedSkills: 1,
      removedSkills: 1,
    });
  });

  it('优先领取高优先级任务，并可重新领取过期租约', async () => {
    const low = await store.enqueueBatch({
      requests: [{
        user: { id: 'low', username: 'low', role: 'user', tenantId: 'tenant-a' },
        userCwd: '/workspace/tenant-a/low',
        reason: 'startup',
        priority: 10,
        requestKey: 'low:1:',
        sourceRevision: 'release-b',
      }],
    });
    const high = await store.enqueueBatch({
      requests: [{
        user: { id: 'high', username: 'high', role: 'user', tenantId: 'tenant-a' },
        userCwd: '/workspace/tenant-a/high',
        reason: 'dispatch',
        priority: 100,
        requestKey: 'high:1:',
        sourceRevision: 'release-b',
      }],
    });

    const first = await store.claimNext('worker-a', -1, 'release-b');
    expect(first?.batchId).toBe(high.id);
    expect(await store.releaseExpiredLeases()).toBe(1);
    const retried = await store.claimNext('worker-b', 60, 'release-b');
    expect(retried).toMatchObject({
      id: first!.id,
      batchId: high.id,
      attempts: 2,
    });
    await store.markFailed(retried!.id, 'worker-b', 'expected failure');

    const second = await store.claimNext('worker-b', 60, 'release-b');
    expect(second?.batchId).toBe(low.id);
    await store.markSucceeded(second!.id, 'worker-b', {
      changedSkills: 0,
      skippedSkills: 1,
      removedSkills: 0,
      desiredHash: 'ready',
    });
  });

  it('两个消费者通过 SKIP LOCKED 并发领取不同任务', async () => {
    const requests = ['one', 'two'].map((username) => ({
      user: { id: username, username, role: 'user' as const, tenantId: 'tenant-a' },
      userCwd: `/workspace/tenant-a/${username}`,
      reason: 'dispatch' as const,
      priority: 100,
      requestKey: `${username}:1:`,
      sourceRevision: 'release-concurrent',
    }));
    await store.enqueueBatch({ requests });

    const [first, second] = await Promise.all([
      store.claimNext('worker-one', 60, 'release-concurrent'),
      peer.claimNext('worker-two', 60, 'release-concurrent'),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
  });

  it('两个 store 实例对同一 workspace 使用 advisory lock 串行执行', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.runExclusive('/workspace/tenant-a/shared', async () => {
      order.push('first-enter');
      firstEntered();
      await releaseFirstPromise;
      order.push('first-exit');
    });
    await firstEnteredPromise;
    const second = peer.runExclusive('/workspace/tenant-a/shared', async () => {
      order.push('second-enter');
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first-enter']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });
});
