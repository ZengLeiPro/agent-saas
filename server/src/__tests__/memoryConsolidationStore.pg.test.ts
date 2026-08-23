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

  it('运行失败耗尽预算后暂时 blocked，并可在启动恢复', async () => {
    const boundaryAt = now();
    await store!.applyRunFinished({
      ...BASE, runId: 'r2', sessionSequence: 50, at: boundaryAt, globalSequence: 12,
      eligible: true, debounceMinutes: 10,
    });
    const firstClaimAt = new Date(Date.parse(boundaryAt) + 11 * 60_000).toISOString();
    const firstClaim = (await store!.claimDue({
      workerId: 'failure-a', now: firstClaimAt, limit: 10, leaseSeconds: 900,
    })).find((state) => state.sessionId === BASE.sessionId)!;
    const r1 = await store!.markFailed({
      tenantId: BASE.tenantId, sessionId: BASE.sessionId, leaseOwner: firstClaim.leaseOwner!,
      toSequence: firstClaim.targetSessionSequence, boundarySequence: firstClaim.lastBoundaryGlobalSequence,
      now: firstClaimAt, backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: 1,
    });
    expect(r1).toBe('retry_wait');
    const secondClaimAt = new Date(Date.parse(firstClaimAt) + 6 * 60_000).toISOString();
    const secondClaim = (await store!.claimDue({
      workerId: 'failure-b', now: secondClaimAt, limit: 10, leaseSeconds: 900,
    })).find((state) => state.sessionId === BASE.sessionId)!;
    const r2 = await store!.markFailed({
      tenantId: BASE.tenantId, sessionId: BASE.sessionId, leaseOwner: secondClaim.leaseOwner!,
      toSequence: secondClaim.targetSessionSequence, boundarySequence: secondClaim.lastBoundaryGlobalSequence,
      now: secondClaimAt, backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: 1,
    });
    expect(r2).toBe('blocked');
    expect((await store!.getState(BASE.tenantId, BASE.sessionId))?.status).toBe('blocked');
    const nextBoundaryAt = new Date(Date.parse(secondClaimAt) + 60_000).toISOString();
    await store!.applyRunFinished({
      ...BASE, runId: 'r3', sessionSequence: 60, at: nextBoundaryAt, globalSequence: 13,
      eligible: true, debounceMinutes: 10,
    });
    expect((await store!.getState(BASE.tenantId, BASE.sessionId))?.status).toBe('pending');
    const permanentClaimAt = new Date(Date.parse(nextBoundaryAt) + 11 * 60_000).toISOString();
    const permanentClaim = (await store!.claimDue({
      workerId: 'failure-c', now: permanentClaimAt, limit: 10, leaseSeconds: 900,
    })).find((state) => state.sessionId === BASE.sessionId)!;
    await store!.markFailed({
      tenantId: BASE.tenantId, sessionId: BASE.sessionId, leaseOwner: permanentClaim.leaseOwner!,
      toSequence: permanentClaim.targetSessionSequence,
      boundarySequence: permanentClaim.lastBoundaryGlobalSequence,
      now: permanentClaimAt, backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES,
      maxRetries: 0, permanent: true,
    });
    expect(await store!.reviveLegacyBlocked()).toBeGreaterThanOrEqual(1);
    const state = await store!.getState(BASE.tenantId, BASE.sessionId);
    expect(state?.status).toBe('pending');
    expect(state?.processedSessionSequence).toBe(40);
  });

  it('旧 worker 失败转换不能覆盖新 generation 的 run ledger', async () => {
    const base = { ...BASE, sessionId: 's-stale-ledger' };
    const boundaryAt = now();
    await store!.applyRunFinished({
      ...base, runId: 'r-old', sessionSequence: 40, at: boundaryAt, globalSequence: 300,
      eligible: true, debounceMinutes: 0,
    });
    const claimAt = new Date(Date.parse(boundaryAt) + 1_000).toISOString();
    const oldClaim = (await store!.claimDue({
      workerId: 'old-worker', now: claimAt, limit: 10, leaseSeconds: 900,
    })).find((state) => state.sessionId === base.sessionId)!;
    const runInput = {
      idempotencyKey: 'k-stale-ledger', ...base,
      fromSessionSequence: oldClaim.processedSessionSequence,
      toSessionSequence: oldClaim.targetSessionSequence,
      promptVersion: 2,
    };
    await store!.insertOrGetRun(runInput);
    await store!.updateRun({
      idempotencyKey: runInput.idempotencyKey,
      status: 'prepared',
      usageJson: { commitJournal: { version: 1, entries: [] }, commitBoundarySequence: 302 },
    });
    await store!.applyRunStarted({
      ...base, runId: 'r-new-error', at: now(), globalSequence: 301,
    });
    await store!.applyRunFinished({
      ...base, runId: 'r-new-error', sessionSequence: 45, at: now(), globalSequence: 302,
      eligible: false, debounceMinutes: 0,
    });
    expect(await store!.updateRunFenced({
      idempotencyKey: runInput.idempotencyKey,
      tenantId: base.tenantId,
      sessionId: base.sessionId,
      leaseOwner: oldClaim.leaseOwner!,
      fromSequence: oldClaim.processedSessionSequence,
      toSequence: oldClaim.targetSessionSequence,
      boundarySequence: oldClaim.lastBoundaryGlobalSequence,
      status: 'retryable_failed',
      errorCode: 'stale-fenced-update',
    })).toBe(false);
    expect(await store!.failRunAndState({
      idempotencyKey: runInput.idempotencyKey,
      tenantId: base.tenantId,
      sessionId: base.sessionId,
      leaseOwner: oldClaim.leaseOwner!,
      toSequence: oldClaim.targetSessionSequence,
      boundarySequence: oldClaim.lastBoundaryGlobalSequence,
      now: claimAt,
      backoffMinutes: [1],
      maxRetries: 1,
      errorCode: 'stale-worker',
      errorMessage: 'must not overwrite',
    })).toBeNull();
    const { record } = await store!.insertOrGetRun(runInput);
    expect(record.status).toBe('prepared');
    expect(record.usageJson).toEqual(expect.objectContaining({ commitBoundarySequence: 302 }));
  });

  it('commit fence 将文件提交与 run_started 串行，并阻止旧 worker 失败状态覆盖新 boundary', async () => {
    const base = { ...BASE, sessionId: 's-commit-fence' };
    const boundaryAt = now();
    await store!.applyRunFinished({
      ...base, runId: 'r-before-commit', sessionSequence: 40, at: boundaryAt, globalSequence: 200,
      eligible: true, debounceMinutes: 0,
    });
    const claimAt = new Date(Date.parse(boundaryAt) + 1_000).toISOString();
    const claimed = (await store!.claimDue({
      workerId: 'fence-worker', now: claimAt, limit: 10, leaseSeconds: 900,
    })).find((state) => state.sessionId === base.sessionId)!;
    await store!.insertOrGetRun({
      idempotencyKey: 'k-commit-fence', ...base,
      fromSessionSequence: claimed.processedSessionSequence,
      toSessionSequence: claimed.targetSessionSequence,
      promptVersion: 2,
    });
    const commitLock = await store!.acquireCommitLock(base.tenantId, base.userId);
    expect(commitLock).not.toBeNull();
    const fenceResult = await commitLock!.acquireFence({
      tenantId: base.tenantId,
      sessionId: base.sessionId,
      leaseOwner: claimed.leaseOwner!,
      now: claimAt,
      fromSequence: claimed.processedSessionSequence,
      toSequence: claimed.targetSessionSequence,
      boundarySequence: claimed.lastBoundaryGlobalSequence,
    });
    expect(fenceResult.fence).not.toBeNull();
    let runStartedApplied = false;
    const runStarted = store!.applyRunStarted({
      ...base, runId: 'r-new', at: now(), globalSequence: 201,
    }).then(() => { runStartedApplied = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runStartedApplied).toBe(false);
    await fenceResult.fence!.finalizeApplied({
      idempotencyKey: 'k-commit-fence',
      toSequence: claimed.targetSessionSequence,
      debounceMinutes: 0,
      now: claimAt,
      usageJson: { changedFiles: ['MEMORY.md'] },
    });
    await runStarted;
    await commitLock!.release();
    const afterBoundary = await store!.getState(base.tenantId, base.sessionId);
    expect(afterBoundary?.processedSessionSequence).toBe(40);
    expect(afterBoundary?.activeRunIds).toContain('r-new');
    expect(afterBoundary?.leaseOwner).toBeNull();
    await store!.markFailed({
      tenantId: base.tenantId,
      sessionId: base.sessionId,
      leaseOwner: claimed.leaseOwner!,
      toSequence: claimed.targetSessionSequence,
      boundarySequence: claimed.lastBoundaryGlobalSequence,
      now: claimAt,
      backoffMinutes: [1],
      maxRetries: 1,
    });
    const afterStaleFailure = await store!.getState(base.tenantId, base.sessionId);
    expect(afterStaleFailure?.activeRunIds).toContain('r-new');
    expect(afterStaleFailure?.attempts).toBe(0);
  });

  it('旧 boundary prepared journal 可被新 generation 定位并原子退休、重排 state', async () => {
    const base = { ...BASE, sessionId: 's-retire-journal' };
    const firstAt = now();
    await store!.applyRunFinished({
      ...base, runId: 'r-old', sessionSequence: 40, at: firstAt, globalSequence: 400,
      eligible: true, debounceMinutes: 0,
    });
    const oldClaimAt = new Date(Date.parse(firstAt) + 1_000).toISOString();
    const oldClaim = (await store!.claimDue({
      workerId: 'old-journal-worker', now: oldClaimAt, limit: 10, leaseSeconds: 900,
    })).find((state) => state.sessionId === base.sessionId)!;
    await store!.insertOrGetRun({
      idempotencyKey: 'k-old-journal', ...base,
      fromSessionSequence: oldClaim.processedSessionSequence,
      toSessionSequence: oldClaim.targetSessionSequence,
      promptVersion: 2,
    });
    await store!.updateRun({
      idempotencyKey: 'k-old-journal', status: 'prepared',
      usageJson: {
        commitJournal: { version: 1, entries: [] },
        commitBoundarySequence: oldClaim.lastBoundaryGlobalSequence,
      },
    });
    await store!.applyRunStarted({
      ...base, runId: 'r-new', at: now(), globalSequence: 401,
    });
    await store!.applyRunFinished({
      ...base, runId: 'r-new', sessionSequence: 45, at: now(), globalSequence: 402,
      eligible: true, debounceMinutes: 0,
    });
    const newClaimAt = new Date(Date.parse(oldClaimAt) + 2_000).toISOString();
    const newClaim = (await store!.claimDue({
      workerId: 'new-journal-worker', now: newClaimAt, limit: 10, leaseSeconds: 900,
    })).find((state) => state.sessionId === base.sessionId)!;
    const prepared = await store!.findPreparedCommitRun(
      base.tenantId,
      base.sessionId,
      newClaim.processedSessionSequence,
    );
    expect(prepared?.idempotencyKey).toBe('k-old-journal');
    const lock = await store!.acquireCommitLock(base.tenantId, base.userId);
    const fence = await lock!.acquireFence({
      tenantId: base.tenantId, sessionId: base.sessionId,
      leaseOwner: newClaim.leaseOwner!, now: newClaimAt,
      fromSequence: newClaim.processedSessionSequence,
      toSequence: newClaim.targetSessionSequence,
      boundarySequence: newClaim.lastBoundaryGlobalSequence,
    });
    await fence.fence!.retireJournalAndRequeue({
      idempotencyKey: prepared!.idempotencyKey,
      now: newClaimAt,
      usageJson: {},
      errorCode: 'recovery_boundary_superseded',
      errorMessage: 'rolled back',
    });
    await lock!.release();
    const state = await store!.getState(base.tenantId, base.sessionId);
    expect(state).toMatchObject({ status: 'pending', leaseOwner: null, targetSessionSequence: 45 });
    const { record } = await store!.insertOrGetRun({
      idempotencyKey: 'k-old-journal', ...base,
      fromSessionSequence: 0, toSessionSequence: 40, promptVersion: 2,
    });
    expect(record).toMatchObject({ status: 'retryable_failed', usageJson: {} });
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
