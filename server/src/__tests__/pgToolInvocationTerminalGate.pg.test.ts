import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
if (!testPgUrl) {
  console.warn('[pgToolInvocationTerminalGate.pg] SKIPPED: TEST_DATABASE_URL is not configured');
}

describePg('PgToolInvocationStore terminal run gate', () => {
  const prefix = `tool_terminal_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let eventStore: PgEventStore;
  let runStore: PgRunStore;
  let toolInvocationStore: PgToolInvocationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    eventStore = new PgEventStore({ connectionString: testPgUrl!, tablePrefix: prefix, poolMax: 4 });
    await eventStore.init();
    runStore = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    await runStore.init();
    toolInvocationStore = new PgToolInvocationStore({ pool, tablePrefix: prefix });
    await toolInvocationStore.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_tool_invocations`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
    await eventStore.close();
    await pool.end();
  }, 30_000);

  it.each(['completed', 'failed', 'orphaned'] as const)(
    'run 已 %s 后的 late start 原子落为 failed 且不创建外部取消 outbox',
    async (terminalStatus) => {
      const sessionId = `session-terminal-late-start-${terminalStatus}`;
      const runId = `run-terminal-late-start-${terminalStatus}`;
      const invocationId = `invocation-terminal-late-start-${terminalStatus}`;
      await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
      await runStore.markStatus(runId, terminalStatus);

      const invocation = await toolInvocationStore.start({
        invocationId,
        runId,
        sessionId,
        toolCallId: `call-terminal-late-start-${terminalStatus}`,
        toolName: 'Shell',
        executionTarget: 'server-remote',
      });

      expect(invocation).toMatchObject({
        status: 'failed',
        error: `run_already_terminal_before_tool_start status=${terminalStatus}`,
        metadata: expect.objectContaining({ terminalRunStatus: terminalStatus }),
      });
      expect(invocation.cancelRequestedAt).toBeUndefined();
      await expect(toolInvocationStore.listRunning(sessionId)).resolves.toHaveLength(0);
      await expect(toolInvocationStore.listCancelRequested(sessionId)).resolves.toHaveLength(0);
    },
  );

  it('真实 PostgreSQL 下同一 invocation 只允许一个 worker 取得执行 claim', async () => {
    const sessionId = 'session-invoke-claim-once';
    const runId = 'run-invoke-claim-once';
    const invocationId = 'invocation-invoke-claim-once';
    await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await runStore.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-invoke-claim-once',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });
    let sideEffects = 0;
    const invoke = async () => {
      sideEffects += 1;
      return 'invoked';
    };

    await expect(toolInvocationStore.invokeWithActiveRunGate(
      runId, invocationId, invoke,
    )).resolves.toMatchObject({ invoked: true, result: 'invoked' });
    await expect(toolInvocationStore.invokeWithActiveRunGate(
      runId, invocationId, invoke,
    )).resolves.toMatchObject({ invoked: false, reason: 'invocation_claimed' });

    expect(sideEffects).toBe(1);
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-invoke-claim-once',
      toolName: 'Shell',
      executionTarget: 'server-remote',
      metadata: { workerId: 'worker-recovery' },
    });
    const claimed = await toolInvocationStore.get(invocationId);
    expect(claimed?.metadata.invokeClaimedAt).toEqual(expect.any(String));
    expect(claimed?.metadata).not.toHaveProperty('workerId');
    expect(claimed?.metadata).not.toHaveProperty('invokeClaimedByWorkerId');
  });

  it('真实 PostgreSQL 下旧 worker 在 lease 转移后不能 claim 或执行，新 owner 可继续 claim', async () => {
    const sessionId = 'session-run-lease-owner-gate';
    const runId = 'run-lease-owner-gate';
    const invocationId = 'invocation-run-lease-owner-gate';
    await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await expect(runStore.acquireLease(runId, 'worker-winner', 60_000)).resolves.toMatchObject({
      status: 'running',
      workerId: 'worker-winner',
    });
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-run-lease-owner-gate',
      toolName: 'Write',
      executionTarget: 'server-remote',
      metadata: { workerId: 'worker-loser' },
    });
    let sideEffects = 0;
    const invoke = async () => {
      sideEffects += 1;
      return 'invoked';
    };

    await expect(toolInvocationStore.invokeWithActiveRunGate(
      runId, invocationId, invoke, undefined, 'worker-loser',
    )).resolves.toMatchObject({
      invoked: false,
      reason: 'run_lease_lost',
      runWorkerId: 'worker-winner',
    });
    expect(sideEffects).toBe(0);
    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({
      metadata: expect.not.objectContaining({ invokeClaimedAt: expect.anything() }),
    });

    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-run-lease-owner-gate',
      toolName: 'Write',
      executionTarget: 'server-remote',
      metadata: { workerId: 'worker-winner' },
    });
    await expect(toolInvocationStore.invokeWithActiveRunGate(
      runId, invocationId, invoke, undefined, 'worker-winner',
    )).resolves.toMatchObject({ invoked: true, result: 'invoked' });
    expect(sideEffects).toBe(1);
    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({
      metadata: expect.objectContaining({ invokeClaimedByWorkerId: 'worker-winner' }),
    });
  });

  it('真实 PostgreSQL 下 worker 匹配但 lease 已过期时不能 claim 或执行', async () => {
    const sessionId = 'session-run-expired-lease-gate';
    const runId = 'run-expired-lease-gate';
    const invocationId = 'invocation-run-expired-lease-gate';
    await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await runStore.acquireLease(runId, 'worker-expired', 60_000);
    await pool.query(`
      UPDATE ${prefix}_runs
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE run_id = $1
    `, [runId]);
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-run-expired-lease-gate',
      toolName: 'Write',
      executionTarget: 'server-remote',
      metadata: { workerId: 'worker-expired' },
    });
    let sideEffects = 0;

    await expect(toolInvocationStore.invokeWithActiveRunGate(
      runId,
      invocationId,
      async () => {
        sideEffects += 1;
        return 'must-not-run';
      },
      undefined,
      'worker-expired',
    )).resolves.toMatchObject({
      invoked: false,
      reason: 'run_lease_lost',
      runStatus: 'running',
      runWorkerId: 'worker-expired',
    });
    expect(sideEffects).toBe(0);
    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({
      metadata: expect.not.objectContaining({ invokeClaimedAt: expect.anything() }),
    });
  });

  it('terminal update 提交与 late start 真并发时，start 等待行锁后 fail closed', async () => {
    const sessionId = 'session-terminal-start-race';
    const runId = 'run-terminal-start-race';
    const invocationId = 'invocation-terminal-start-race';
    await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await runStore.markStatus(runId, 'running');

    const terminalWriter = await pool.connect();
    let lateStart: ReturnType<PgToolInvocationStore['start']> | undefined;
    try {
      await terminalWriter.query('BEGIN');
      await terminalWriter.query(`
        UPDATE ${prefix}_runs
        SET status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE run_id = $1
      `, [runId]);
      lateStart = toolInvocationStore.start({
        invocationId,
        runId,
        sessionId,
        toolCallId: 'call-terminal-start-race',
        toolName: 'Shell',
        executionTarget: 'server-remote',
      });

      let waitingOnRunLock = false;
      for (let attempt = 0; attempt < 100 && !waitingOnRunLock; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE $1
          ) AS waiting
        `, [`%SELECT status FROM ${prefix}_runs%FOR SHARE%`]);
        waitingOnRunLock = waiting.rows[0]?.waiting ?? false;
        if (!waitingOnRunLock) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waitingOnRunLock).toBe(true);
      await terminalWriter.query('COMMIT');

      await expect(lateStart).resolves.toMatchObject({
        status: 'failed',
        error: 'run_already_terminal_before_tool_start status=completed',
      });
      expect((await toolInvocationStore.get(invocationId))?.cancelRequestedAt).toBeUndefined();
      await expect(toolInvocationStore.listCancelRequested(sessionId)).resolves.toHaveLength(0);
    } finally {
      await terminalWriter.query('ROLLBACK').catch(() => undefined);
      terminalWriter.release();
      await lateStart?.catch(() => undefined);
    }
  });

  it('状态预读后 terminal 先提交时，最终 invoke 门禁等待行锁并禁止外部副作用', async () => {
    const sessionId = 'session-terminal-invoke-race';
    const runId = 'run-terminal-invoke-race';
    const invocationId = 'invocation-terminal-invoke-race';
    await runStore.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await runStore.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-terminal-invoke-race',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });
    await expect(runStore.get(runId)).resolves.toMatchObject({ status: 'running' });

    const terminalWriter = await pool.connect();
    let gatedInvoke: ReturnType<PgToolInvocationStore['invokeWithActiveRunGate']> | undefined;
    let sideEffects = 0;
    try {
      await terminalWriter.query('BEGIN');
      await terminalWriter.query(`
        UPDATE ${prefix}_runs
        SET status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE run_id = $1
      `, [runId]);

      gatedInvoke = toolInvocationStore.invokeWithActiveRunGate(
        runId,
        invocationId,
        async () => {
          sideEffects += 1;
          return 'invoked';
        },
      );
      let waitingOnRunLock = false;
      for (let attempt = 0; attempt < 100 && !waitingOnRunLock; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE $1
          ) AS waiting
        `, [`%SELECT status, worker_id, lease_expires_at%FROM ${prefix}_runs%FOR SHARE%`]);
        waitingOnRunLock = waiting.rows[0]?.waiting ?? false;
        if (!waitingOnRunLock) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waitingOnRunLock).toBe(true);
      await terminalWriter.query('COMMIT');

      await expect(gatedInvoke).resolves.toMatchObject({
        invoked: false,
        reason: 'run_terminal',
        runStatus: 'completed',
      });
      expect(sideEffects).toBe(0);
      await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({ status: 'running' });
    } finally {
      await terminalWriter.query('ROLLBACK').catch(() => undefined);
      terminalWriter.release();
      await gatedInvoke?.catch(() => undefined);
    }
  });
  it('重复 stop 不重复投递取消事件或工具取消等外部副作用触发源', async () => {
    const sessionId = 'session-stop-idempotency';
    const runId = 'run-stop-idempotency';
    await runStore.upsertPending({
      runId, sessionId, userId: 'user-1', tenantId: LEGACY_TENANT_ID, channel: 'web',
    });
    await runStore.markStatus(runId, 'running');
    const event = { type: 'run_cancel_requested' as const, sessionId, runId, reason: 'web_abort' };

    const first = await runStore.cancelSteeringBeforeDispatchBySessionWithEvent(
      sessionId, 'web_abort', runId, event, LEGACY_TENANT_ID,
    );
    const firstStopped = await pool.query<{ stopped_at: Date }>(`
      SELECT stopped_at FROM ${prefix}_steering_sessions WHERE session_id = $1
    `, [sessionId]);
    await runStore.upsertPending({
      runId: 'run-stop-idempotency-next', sessionId, userId: 'user-1',
      tenantId: LEGACY_TENANT_ID, channel: 'web',
    });
    await runStore.markStatus('run-stop-idempotency-next', 'running');
    await runStore.enqueueSteeringAware({
      runId: 'source-stop-idempotency-next',
      sessionId,
      userId: 'user-1',
      tenantId: LEGACY_TENANT_ID,
      channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: sessionId, content: 'stop 后新消息' } },
    });
    const duplicate = await runStore.cancelSteeringBeforeDispatchBySessionWithEvent(
      sessionId, 'web_abort', runId, event, LEGACY_TENANT_ID,
    );

    expect(first.eventCreated).toBe(true);
    expect(duplicate.eventCreated).toBe(false);
    await expect(runStore.get('source-stop-idempotency-next')).resolves.toMatchObject({ status: 'pending' });
    const [events, secondStopped, steering] = await Promise.all([
      eventStore.list(LEGACY_TENANT_ID, sessionId),
      pool.query<{ stopped_at: Date }>(`
        SELECT stopped_at FROM ${prefix}_steering_sessions WHERE session_id = $1
      `, [sessionId]),
      pool.query<{ state: string }>(`
        SELECT state FROM ${prefix}_steering_inputs WHERE source_run_id = $1
      `, ['source-stop-idempotency-next']),
    ]);
    expect(events.filter((item) => item.type === 'run_cancel_requested')).toHaveLength(1);
    expect(secondStopped.rows[0]?.stopped_at.toISOString()).toBe(firstStopped.rows[0]?.stopped_at.toISOString());
    expect(steering.rows[0]?.state).toBe('pending');
  });

  it('target 并发终态先提交时 stop 不写 stopped_at 且不撤销后续 steering', async () => {
    const sessionId = 'session-terminal-stop-preserves-queue';
    const runId = 'run-terminal-stop-preserves-queue';
    const sourceRunId = 'source-terminal-stop-preserves-queue';
    await runStore.upsertPending({
      runId, sessionId, userId: 'user-1', tenantId: LEGACY_TENANT_ID, channel: 'web',
    });
    await runStore.markStatus(runId, 'running');
    await runStore.enqueueSteeringAware({
      runId: sourceRunId,
      sessionId,
      userId: 'user-1',
      tenantId: LEGACY_TENANT_ID,
      channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: sessionId, content: '后续任务' } },
    });

    const terminalWriter = await pool.connect();
    let stop: ReturnType<PgRunStore['cancelSteeringBeforeDispatchBySessionWithEvent']> | undefined;
    try {
      await terminalWriter.query('BEGIN');
      await terminalWriter.query(`
        UPDATE ${prefix}_runs
        SET status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE run_id = $1
      `, [runId]);
      stop = runStore.cancelSteeringBeforeDispatchBySessionWithEvent(
        sessionId,
        'web_abort',
        runId,
        { type: 'run_cancel_requested', sessionId, runId, reason: 'web_abort' },
        LEGACY_TENANT_ID,
      );

      let waitingOnTargetLock = false;
      for (let attempt = 0; attempt < 100 && !waitingOnTargetLock; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE $1
          ) AS waiting
        `, [`%FROM ${prefix}_runs%WHERE tenant_id = $1 AND session_id = $2 AND run_id = $3%FOR UPDATE%`]);
        waitingOnTargetLock = waiting.rows[0]?.waiting ?? false;
        if (!waitingOnTargetLock) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waitingOnTargetLock).toBe(true);
      await terminalWriter.query('COMMIT');

      await expect(stop).resolves.toMatchObject({
        cancelled: [],
        targetCancelled: false,
        eventCreated: false,
      });
      await expect(runStore.get(sourceRunId)).resolves.toMatchObject({ status: 'pending' });
      const [input, stopped, events] = await Promise.all([
        pool.query<{ state: string }>(`
          SELECT state FROM ${prefix}_steering_inputs WHERE source_run_id = $1
        `, [sourceRunId]),
        pool.query(`SELECT stopped_at FROM ${prefix}_steering_sessions WHERE session_id = $1`, [sessionId]),
        eventStore.list(LEGACY_TENANT_ID, sessionId),
      ]);
      expect(input.rows[0]?.state).toBe('pending');
      expect(stopped.rows).toHaveLength(0);
      expect(events.some((item) => item.type === 'run_cancel_requested')).toBe(false);
    } finally {
      await terminalWriter.query('ROLLBACK').catch(() => undefined);
      terminalWriter.release();
      await stop?.catch(() => undefined);
    }
  });


});
