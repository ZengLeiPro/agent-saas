/**
 * PgMemoryConsolidationStore 持久层合同（2026-07-29 记忆写入职责剥离批次）。
 * 需要真实 PG：设置 MEMORY_CONSOLIDATION_TEST_PG_URL 启用，否则整体 skip
 * （与 agentRuntimeProfileStore.pg.test.ts 同模式）。
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import { CONSOLIDATION_RETRY_BACKOFF_MINUTES } from '../memory/consolidation/types.js';

const connectionString = process.env.MEMORY_CONSOLIDATION_TEST_PG_URL;
const describePg = connectionString ? describe : describe.skip;
const prefix = `mc_test_${randomUUID().replaceAll('-', '_').slice(0, 12)}`;
const store = connectionString
  ? new PgMemoryConsolidationStore({ connectionString, tablePrefix: prefix })
  : null;
const verificationPool = connectionString ? new Pool({ connectionString, max: 1 }) : null;

const BASE = { tenantId: 't1', userId: 'u1', workspaceId: 'w1', sessionId: 's1' };
const now = (): string => new Date().toISOString();

describePg('PgMemoryConsolidationStore contract', () => {
  beforeAll(async () => {
    await store!.init();
    await store!.init(); // 幂等 init（advisory lock 串行化）
  });

  afterAll(async () => {
    await store?.close();
    await verificationPool?.end();
  });

  it('consumer cursor 单调推进，不倒退', async () => {
    expect(await store!.getConsumerCursor('c1')).toBe(0);
    await store!.advanceConsumerCursor('c1', 100);
    await store!.advanceConsumerCursor('c1', 50); // 倒退被 GREATEST 拒绝
    expect(await store!.getConsumerCursor('c1')).toBe(100);
  });

  it('poison event 隔离台账按 consumer + global sequence 幂等', async () => {
    const input = {
      consumerName: 'c1',
      globalSequence: 101,
      tenantId: 't1',
      sessionId: 'missing-session',
      eventType: 'run_started',
      eventTimestamp: '2026-07-01T00:00:00.000Z',
      reason: 'projection_missing_after_grace',
    };
    await store!.quarantineEnvelopeAndAdvanceCursor(input);
    await store!.quarantineEnvelopeAndAdvanceCursor(input);

    const result = await verificationPool!.query<{
      consumer_name: string;
      global_sequence: string;
      reason: string;
      first_seen_at: Date;
      skipped_at: Date;
    }>(
      `SELECT consumer_name, global_sequence, reason, first_seen_at, skipped_at
       FROM ${prefix}_memory_consolidation_skips
       WHERE consumer_name = $1 AND global_sequence = $2`,
      [input.consumerName, input.globalSequence],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({
      consumer_name: 'c1',
      global_sequence: '101',
      reason: 'projection_missing_after_grace',
    });
    expect(result.rows[0]!.skipped_at.getTime()).toBeGreaterThanOrEqual(result.rows[0]!.first_seen_at.getTime());
    expect(await store!.getConsumerCursor('c1')).toBe(101);
  });

  it('run_started 清 due 并登记 active；eligible run_finished 提 target 并设 due', async () => {
    await store!.applyRunStarted({ ...BASE, runId: 'r1', at: now(), globalSequence: 10 });
    let state = await store!.getState(BASE.tenantId, BASE.sessionId);
    expect(state?.activeRunIds).toContain('r1');
    expect(state?.dueAt).toBeNull();

    await store!.applyRunFinished({
      ...BASE, runId: 'r1', sessionSequence: 40, at: now(), globalSequence: 11,
      eligible: true, debounceMinutes: 10,
    });
    state = await store!.getState(BASE.tenantId, BASE.sessionId);
    expect(state?.activeRunIds).toEqual([]);
    expect(state?.targetSessionSequence).toBe(40);
    expect(state?.status).toBe('pending');
    expect(state?.dueAt).toBeTruthy();
  });

  it('boundary global sequence fencing：迟到的旧 started/finished 不能覆盖新状态', async () => {
    const fenced = { ...BASE, sessionId: 's-fenced' };
    await store!.applyRunFinished({
      ...fenced, runId: 'r-old', sessionSequence: 60, at: now(), globalSequence: 200,
      eligible: true, debounceMinutes: 10,
    });
    await store!.applyRunStarted({ ...fenced, runId: 'r-old', at: now(), globalSequence: 199 });
    let state = await store!.getState(fenced.tenantId, fenced.sessionId);
    expect(state?.activeRunIds).toEqual([]);
    expect(state?.targetSessionSequence).toBe(60);

    await store!.applyRunStarted({ ...fenced, runId: 'r-new', at: now(), globalSequence: 201 });
    await store!.applyRunFinished({
      ...fenced, runId: 'r-old', sessionSequence: 60, at: now(), globalSequence: 200,
      eligible: true, debounceMinutes: 10,
    });
    state = await store!.getState(fenced.tenantId, fenced.sessionId);
    expect(state?.activeRunIds).toEqual(['r-new']);
    expect(state?.dueAt).toBeNull();

    const ineligible = { ...BASE, sessionId: 's-fenced-ineligible' };
    await store!.applyRunFinished({
      ...ineligible, runId: 'r-error', sessionSequence: 1, at: now(), globalSequence: 300,
      eligible: false, debounceMinutes: 10,
    });
    await store!.applyRunStarted({ ...ineligible, runId: 'r-error', at: now(), globalSequence: 299 });
    state = await store!.getState(ineligible.tenantId, ineligible.sessionId);
    expect(state?.activeRunIds).toEqual([]);
  });

  it('active run 存在时 claimDue 不取该会话；到期 + 无 active 才 claim', async () => {
    // 尚未到期（due=now+10m）→ claim 不到
    let claimed = await store!.claimDue({ workerId: 'w-a', now: now(), limit: 10, leaseSeconds: 900 });
    expect(claimed.find((s) => s.sessionId === BASE.sessionId)).toBeUndefined();

    // 到期（用未来时间模拟）→ claim 到并进入 running
    const future = new Date(Date.now() + 11 * 60_000).toISOString();
    claimed = await store!.claimDue({ workerId: 'w-a', now: future, limit: 10, leaseSeconds: 900 });
    const mine = claimed.find((s) => s.sessionId === BASE.sessionId);
    expect(mine?.status).toBe('running');

    // lease 未过期时第二个 worker claim 不到
    const again = await store!.claimDue({ workerId: 'w-b', now: future, limit: 10, leaseSeconds: 900 });
    expect(again.find((s) => s.sessionId === BASE.sessionId)).toBeUndefined();

    // worker 崩溃后 running lease 到期，其他 worker 可回收，不能永久卡死。
    const afterLease = new Date(Date.parse(future) + 901_000).toISOString();
    const reclaimed = await store!.claimDue({ workerId: 'w-c', now: afterLease, limit: 10, leaseSeconds: 900 });
    expect(reclaimed.find((s) => s.sessionId === BASE.sessionId)?.status).toBe('running');
  });

  it('error run 不吞掉此前已 pending 的 backlog，只重新开始 debounce', async () => {
    const base = { ...BASE, sessionId: 's-error-after-pending' };
    await store!.applyRunFinished({
      ...base, runId: 'r-success', sessionSequence: 40, at: now(), globalSequence: 100,
      eligible: true, debounceMinutes: 10,
    });
    await store!.applyRunStarted({ ...base, runId: 'r-error', at: now(), globalSequence: 101 });
    await store!.applyRunFinished({
      ...base, runId: 'r-error', sessionSequence: 45, at: now(), globalSequence: 102,
      eligible: false, debounceMinutes: 10,
    });
    const state = await store!.getState(base.tenantId, base.sessionId);
    expect(state?.targetSessionSequence).toBe(40);
    expect(state?.activeRunIds).toEqual([]);
    expect(state?.status).toBe('pending');
    expect(state?.dueAt).toBeTruthy();
  });

  it('idempotency key 唯一：同范围第二次 insertOrGetRun 返回已有记录', async () => {
    const input = {
      idempotencyKey: 'k-1', ...BASE,
      fromSessionSequence: 0, toSessionSequence: 40, promptVersion: 1,
    };
    const first = await store!.insertOrGetRun(input);
    expect(first.created).toBe(true);
    const second = await store!.insertOrGetRun(input);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  });

  it('markApplied 推进 processed；target 无超前时回 idle', async () => {
    await store!.markApplied({ tenantId: BASE.tenantId, sessionId: BASE.sessionId, toSequence: 40, debounceMinutes: 10, now: now() });
    const state = await store!.getState(BASE.tenantId, BASE.sessionId);
    expect(state?.processedSessionSequence).toBe(40);
    expect(state?.status).toBe('idle');
    expect(state?.leaseOwner).toBeNull();
  });

  it('markFailed 走退避；超过 maxRetries 转 blocked', async () => {
    await store!.applyRunFinished({
      ...BASE, runId: 'r2', sessionSequence: 50, at: now(), globalSequence: 12,
      eligible: true, debounceMinutes: 10,
    });
    const r1 = await store!.markFailed({
      tenantId: BASE.tenantId, sessionId: BASE.sessionId, now: now(),
      backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: 1,
    });
    expect(r1).toBe('retry_wait');
    const r2 = await store!.markFailed({
      tenantId: BASE.tenantId, sessionId: BASE.sessionId, now: now(),
      backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: 1,
    });
    expect(r2).toBe('blocked');
    const state = await store!.getState(BASE.tenantId, BASE.sessionId);
    expect(state?.status).toBe('blocked');
    // blocked 后 processed 不动
    expect(state?.processedSessionSequence).toBe(40);
  });

  it('tombstone：insert/list/revoke 生命周期', async () => {
    const tomb = await store!.insertTombstone({
      tenantId: 't1', userId: 'u1', workspaceId: 'w1',
      normalizedFingerprint: 'abcdef123', subjectText: '测试主题',
      scope: 'item', source: 'explicit_user_forget',
    });
    let active = await store!.listActiveTombstones('t1', 'u1');
    expect(active.some((t) => t.id === tomb.id)).toBe(true);
    expect(await store!.revokeTombstone(tomb.id, 't1', 'u1')).toBe(true);
    active = await store!.listActiveTombstones('t1', 'u1');
    expect(active.some((t) => t.id === tomb.id)).toBe(false);
    // 二次 revoke 幂等 false
    expect(await store!.revokeTombstone(tomb.id, 't1', 'u1')).toBe(false);
  });

  it('per-user commit lock 互斥', async () => {
    const lock1 = await store!.acquireCommitLock('t1', 'u1');
    expect(lock1).not.toBeNull();
    const lock2 = await store!.acquireCommitLock('t1', 'u1', 500);
    expect(lock2).toBeNull();
    await lock1!.release();
    const lock3 = await store!.acquireCommitLock('t1', 'u1', 2_000);
    expect(lock3).not.toBeNull();
    await lock3!.release();
  });
});
