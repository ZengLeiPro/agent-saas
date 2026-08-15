import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { recoverRunningToolInvocations } from '../runtime/toolInvocationRecovery.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
if (!testPgUrl) {
  console.warn('[pgRunStoreSteering.pg] SKIPPED: TEST_DATABASE_URL is not configured');
}

describePg('PgRunStore steering PostgreSQL contract', () => {
  const prefix = `steering_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgRunStore;
  let eventStore: PgEventStore;
  let toolInvocationStore: PgToolInvocationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 8 });
    eventStore = new PgEventStore({ connectionString: testPgUrl!, tablePrefix: prefix, poolMax: 4 });
    await eventStore.init();
    store = new PgRunStore({ pool, tablePrefix: prefix });
    await store.init();
    toolInvocationStore = new PgToolInvocationStore({ pool, tablePrefix: prefix });
    await toolInvocationStore.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_tool_invocations`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_inputs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_steering_sessions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_message_submissions`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_runs`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_events`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_event_cursors`);
    } finally {
      await eventStore?.close();
      await pool.end();
    }
  }, 30_000);

  it('同一 clientMessageId 并发提交只创建一个 run', async () => {
    const base = {
      sessionId: 'session-idempotent',
      userId: 'user-1',
      idempotencyKey: 'client-message-1',
      channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: 'session-idempotent', content: '只执行一次' } },
    };
    const [first, second] = await Promise.all([
      store.enqueueUserMessage({ ...base, runId: 'idempotent-run-a' }, 'queue'),
      store.enqueueUserMessage({ ...base, runId: 'idempotent-run-b' }, 'queue'),
    ]);

    expect(first.runId).toBe(second.runId);
    const rows = await pool.query(`SELECT run_id FROM ${prefix}_runs WHERE idempotency_key = $1`, ['client-message-1']);
    expect(rows.rows).toHaveLength(1);
  });

  it('同会话后入队 run 不能越过更早的 pending run', async () => {
    await store.enqueueUserMessage({
      runId: 'fifo-run-a', sessionId: 'session-fifo', userId: 'user-1', idempotencyKey: 'fifo-client-a', channel: 'web',
    }, 'queue');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.enqueueUserMessage({
      runId: 'fifo-run-b', sessionId: 'session-fifo', userId: 'user-1', idempotencyKey: 'fifo-client-b', channel: 'web',
    }, 'queue');

    await expect(store.acquireLease('fifo-run-b', 'worker-b', 60_000, new Date(), 4)).resolves.toBeNull();
    await expect(store.acquireLease('fifo-run-a', 'worker-a', 60_000, new Date(), 4)).resolves.toMatchObject({ runId: 'fifo-run-a' });
  });

  it('跨 worker 同会话同时抢占时只有一个 run 取得 lease', async () => {
    await store.enqueueUserMessage({
      runId: 'serial-run-a', sessionId: 'session-serial', userId: 'user-1', idempotencyKey: 'serial-client-a', channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: 'session-serial', content: 'A' } },
    }, 'queue');
    await store.enqueueUserMessage({
      runId: 'serial-run-b', sessionId: 'session-serial', userId: 'user-1', idempotencyKey: 'serial-client-b', channel: 'web',
      metadata: { wakeMessage: { channel: 'web', chatId: 'session-serial', content: 'B' } },
    }, 'queue');

    const acquired = await Promise.all([
      store.acquireLease('serial-run-a', 'worker-a', 60_000, new Date(), 4),
      store.acquireLease('serial-run-b', 'worker-b', 60_000, new Date(), 4),
    ]);
    expect(acquired.filter(Boolean)).toHaveLength(1);
    const running = await pool.query(`SELECT run_id FROM ${prefix}_runs WHERE session_id = $1 AND status = 'running'`, ['session-serial']);
    expect(running.rows).toHaveLength(1);
  });

  it.each(['waiting_user', 'waiting_approval'] as const)(
    '%s 释放会话后，显式发送回退为独立 run 且可取得 lease',
    async (waitingStatus) => {
      const sessionId = `session-${waitingStatus}`;
      const targetRunId = `target-${waitingStatus}`;
      const sourceRunId = `source-${waitingStatus}`;
      await store.upsertPending({
        runId: targetRunId,
        sessionId,
        userId: 'user-1',
        model: 'gpt-5.5',
        channel: 'web',
      });
      await store.markStatus(targetRunId, waitingStatus);

      const source = await store.enqueueUserMessage({
        runId: sourceRunId,
        sessionId,
        userId: 'user-1',
        idempotencyKey: `client-${waitingStatus}`,
        model: 'gpt-5.5',
        channel: 'web',
      }, 'steer');

      expect(source.metadata?.steeringTargetRunId).toBeUndefined();
      await expect(store.acquireLease(sourceRunId, `worker-${waitingStatus}`, 60_000))
        .resolves.toMatchObject({ runId: sourceRunId, status: 'running' });
      const steeringRows = await pool.query(
        `SELECT source_run_id FROM ${prefix}_steering_inputs WHERE source_run_id = $1`,
        [sourceRunId],
      );
      expect(steeringRows.rows).toHaveLength(0);
    },
  );

  it.each(['waiting_user', 'waiting_approval'] as const)(
    '%s 已释放会话时，普通 queue 不谎报排队并可直接取得 lease',
    async (waitingStatus) => {
      const sessionId = `session-queue-${waitingStatus}`;
      const targetRunId = `target-queue-${waitingStatus}`;
      const sourceRunId = `source-queue-${waitingStatus}`;
      await store.upsertPending({
        runId: targetRunId,
        sessionId,
        userId: 'user-1',
        channel: 'web',
      });
      await store.markStatus(targetRunId, waitingStatus);

      const source = await store.enqueueUserMessage({
        runId: sourceRunId,
        sessionId,
        userId: 'user-1',
        idempotencyKey: `client-queue-${waitingStatus}`,
        channel: 'web',
      }, 'queue');

      expect(source.metadata?.queuedBehindRunId).toBeUndefined();
      await expect(store.acquireLease(sourceRunId, `worker-queue-${waitingStatus}`, 60_000))
        .resolves.toMatchObject({ runId: sourceRunId, status: 'running' });
    },
  );

  it('停止只撤销 steer，普通 queue 保持 pending 并继续串行等待', async () => {
    const sessionId = 'session-stop-semantics';
    await store.upsertPending({
      runId: 'stop-target',
      sessionId,
      userId: 'user-1',
      model: 'gpt-5.5',
      channel: 'web',
    });
    await store.markStatus('stop-target', 'running');
    const queued = await store.enqueueUserMessage({
      runId: 'stop-queue',
      sessionId,
      userId: 'user-1',
      idempotencyKey: 'stop-queue-client',
      model: 'gpt-5.5',
      channel: 'web',
    }, 'queue');
    const steered = await store.enqueueUserMessage({
      runId: 'stop-steer',
      sessionId,
      userId: 'user-1',
      idempotencyKey: 'stop-steer-client',
      model: 'gpt-5.5',
      channel: 'web',
    }, 'steer');

    await store.cancelSteeringBeforeDispatchBySession(sessionId, 'web_abort');

    await expect(store.get(queued.runId)).resolves.toMatchObject({ status: 'pending' });
    await expect(store.get(steered.runId)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('enqueue → reserve → apply 由真实 PostgreSQL 解析并原子结算', async () => {
    await store.upsertPending({
      runId: 'target-run',
      sessionId: 'session-1',
      userId: 'user-1',
      model: 'gpt-5.5',
      channel: 'web',
    });
    await store.markStatus('target-run', 'running');

    const source = await store.enqueueSteeringAware({
      runId: 'source-run',
      sessionId: 'session-1',
      userId: 'user-1',
      model: 'gpt-5.5',
      channel: 'web',
      metadata: {
        clientMsgId: 'client-1',
        wakeMessage: { channel: 'web', chatId: 'session-1', content: '追加要求' },
      },
    });
    expect(source.metadata).toMatchObject({
      steeringTargetRunId: 'target-run',
      steeringState: 'pending',
    });

    await expect(store.reserveSteeringInputs('target-run', ['source-run']))
      .resolves.toEqual(['source-run']);
    const reserved = await store.listPendingSteeringInputs('target-run');
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ sourceRunId: 'source-run', state: 'reserved' });
    expect(reserved[0]?.reservedAt).toBeTruthy();

    await expect(store.markSteeringInputsApplied('target-run', ['source-run']))
      .resolves.toEqual(['source-run']);

    const row = await pool.query<{
      state: string;
      reserved_at: Date | null;
      applied_at: Date | null;
    }>(`SELECT state, reserved_at, applied_at FROM ${prefix}_steering_inputs WHERE source_run_id = $1`, ['source-run']);
    expect(row.rows[0]).toMatchObject({ state: 'applied' });
    expect(row.rows[0]?.reserved_at).toBeInstanceOf(Date);
    expect(row.rows[0]?.applied_at).toBeInstanceOf(Date);
    await expect(store.get('source-run')).resolves.toMatchObject({
      status: 'completed',
      statusReason: 'steered_into_run',
      metadata: { steeringState: 'applied', steeringAppliedToRunId: 'target-run' },
    });
  });

  it('管理员代操作按 authenticated submitter 幂等，run owner 保持会话 owner', async () => {
    const base = {
      sessionId: 'session-admin-submit',
      userId: 'session-owner',
      submitterUserId: 'admin-submitter',
      idempotencyKey: 'admin-client-message',
      channel: 'web',
    };
    const first = await store.enqueueUserMessage({ ...base, runId: 'admin-submit-a' }, 'queue');
    const duplicate = await store.enqueueUserMessage({ ...base, runId: 'admin-submit-b' }, 'queue');

    expect(duplicate.runId).toBe(first.runId);
    await expect(store.findByIdempotencyKey('admin-submitter', base.idempotencyKey))
      .resolves.toMatchObject({ runId: first.runId, userId: 'session-owner' });
    await expect(store.findByIdempotencyKey('session-owner', base.idempotencyKey)).resolves.toBeNull();
  });

  it('不同管理员代同一 owner 使用相同 clientMessageId 时按提交者域分别受理', async () => {
    const base = {
      sessionId: 'session-admin-scopes',
      userId: 'shared-session-owner',
      idempotencyKey: 'shared-client-message',
      channel: 'web',
    };
    const [first, second] = await Promise.all([
      store.enqueueUserMessage({ ...base, runId: 'admin-scope-a', submitterUserId: 'admin-a' }, 'queue'),
      store.enqueueUserMessage({ ...base, runId: 'admin-scope-b', submitterUserId: 'admin-b' }, 'queue'),
    ]);

    expect(first.runId).toBe('admin-scope-a');
    expect(second.runId).toBe('admin-scope-b');
    await expect(store.findByIdempotencyKey('admin-a', base.idempotencyKey))
      .resolves.toMatchObject({ runId: 'admin-scope-a', userId: base.userId, submitterUserId: 'admin-a' });
    await expect(store.findByIdempotencyKey('admin-b', base.idempotencyKey))
      .resolves.toMatchObject({ runId: 'admin-scope-b', userId: base.userId, submitterUserId: 'admin-b' });
  });

  it('只有 message_submissions 已受理记录可短路幂等查询', async () => {
    await store.upsertPending({
      runId: 'preaccepted-failed-run',
      sessionId: 'preaccepted-session',
      userId: 'owner-preaccepted',
      idempotencyKey: 'preaccepted-key',
    });
    await store.markStatus('preaccepted-failed-run', 'failed', 'preflight_failed');

    await expect(store.findByIdempotencyKey('owner-preaccepted', 'preaccepted-key')).resolves.toBeNull();
  });

  it('durable append + apply 重试不会重复事件或 transcript 外部副作用', async () => {
    const sessionId = 'session-atomic-idempotency';
    await store.upsertPending({
      runId: 'target-atomic-idempotency', sessionId, userId: 'user-1', model: 'gpt-5.5', channel: 'web',
    });
    await store.markStatus('target-atomic-idempotency', 'running');
    await store.enqueueUserMessage({
      runId: 'source-atomic-idempotency', sessionId, userId: 'user-1', submitterUserId: 'user-1',
      idempotencyKey: 'client-atomic-idempotency', model: 'gpt-5.5', channel: 'web',
    }, 'steer');
    await store.reserveSteeringInputs('target-atomic-idempotency', ['source-atomic-idempotency']);
    const input = {
      sourceRunId: 'source-atomic-idempotency',
      event: {
        type: 'user_message' as const,
        runId: 'target-atomic-idempotency',
        sessionId,
        content: '只投影一次',
        interjectionSourceRunId: 'source-atomic-idempotency',
      },
    };

    const first = await store.applySteeringInputsAtomically('target-atomic-idempotency', [input]);
    const retry = await store.applySteeringInputsAtomically('target-atomic-idempotency', [input]);
    expect(first.events).toHaveLength(1);
    expect(retry).toEqual({ appliedSourceRunIds: [], events: [] });
    const events = await eventStore.list(sessionId);
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(1);
  });

  it('恢复旧版 append 成功但 apply 未完成的半状态时不重复 durable user_message', async () => {
    const sessionId = 'session-recovered-append';
    const targetRunId = 'target-recovered-append';
    const sourceRunId = 'source-recovered-append';
    await store.upsertPending({
      runId: targetRunId, sessionId, userId: 'user-1', model: 'gpt-5.5', channel: 'web',
    });
    await store.markStatus(targetRunId, 'running');
    await store.enqueueUserMessage({
      runId: sourceRunId, sessionId, userId: 'user-1', submitterUserId: 'user-1',
      idempotencyKey: 'client-recovered-append', model: 'gpt-5.5', channel: 'web',
    }, 'steer');
    await store.reserveSteeringInputs(targetRunId, [sourceRunId]);
    await eventStore.append({
      type: 'user_message', runId: targetRunId, sessionId, content: '旧版已追加内容',
      interjectionSourceRunId: sourceRunId,
    });

    const recovered = await store.applySteeringInputsAtomically(targetRunId, [{
      sourceRunId,
      event: {
        type: 'user_message', runId: targetRunId, sessionId, content: '旧版已追加内容',
        interjectionSourceRunId: sourceRunId,
      },
    }]);

    expect(recovered).toEqual({ appliedSourceRunIds: [sourceRunId], events: [] });
    await expect(store.get(sourceRunId)).resolves.toMatchObject({ status: 'completed' });
    const events = await eventStore.list(sessionId);
    expect(events.filter((event) => (
      event.type === 'user_message' && event.interjectionSourceRunId === sourceRunId
    ))).toHaveLength(1);
  });

  it('apply 与 stop 并发时 cancelled 内容绝不进入 durable transcript，stop 事件与状态同事务', async () => {
    const sessionId = 'session-apply-stop-race';
    const targetRunId = 'target-apply-stop-race';
    const sourceRunId = 'source-apply-stop-race';
    await store.upsertPending({
      runId: targetRunId, sessionId, userId: 'user-1', model: 'gpt-5.5', channel: 'web',
    });
    await store.markStatus(targetRunId, 'running');
    await store.enqueueUserMessage({
      runId: sourceRunId, sessionId, userId: 'user-1', submitterUserId: 'user-1',
      idempotencyKey: 'client-apply-stop-race', model: 'gpt-5.5', channel: 'web',
    }, 'steer');
    await store.reserveSteeringInputs(targetRunId, [sourceRunId]);

    await Promise.all([
      store.applySteeringInputsAtomically(targetRunId, [{
        sourceRunId,
        event: {
          type: 'user_message', runId: targetRunId, sessionId, content: '竞态内容',
          interjectionSourceRunId: sourceRunId,
        },
      }]),
      store.cancelSteeringBeforeDispatchBySessionWithEvent(
        sessionId,
        'web_abort',
        targetRunId,
        { type: 'run_cancel_requested', sessionId, runId: targetRunId, reason: 'web_abort' },
      ),
    ]);

    const source = await store.get(sourceRunId);
    const events = await eventStore.list(sessionId);
    const contentEvents = events.filter((event) => (
      event.type === 'user_message' && event.interjectionSourceRunId === sourceRunId
    ));
    expect(events.some((event) => event.type === 'run_cancel_requested')).toBe(true);
    if (source?.status === 'cancelled') expect(contentEvents).toHaveLength(0);
    else {
      expect(source?.status).toBe('completed');
      expect(contentEvents).toHaveLength(1);
    }
  });

  it.each(['waiting_user', 'waiting_approval'] as const)(
    'stop 对 %s 返回真实 targetCancelled 并持久化 cancelled',
    async (waitingStatus) => {
      const sessionId = `session-stop-${waitingStatus}`;
      const runId = `run-stop-${waitingStatus}`;
      await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
      await store.markStatus(runId, waitingStatus);

      const result = await store.cancelSteeringBeforeDispatchBySessionWithEvent(
        sessionId,
        'web_abort',
        runId,
        { type: 'run_cancel_requested', sessionId, runId, reason: 'web_abort' },
      );

      expect(result.targetCancelled).toBe(true);
      await expect(store.get(runId)).resolves.toMatchObject({ status: 'cancelled', statusReason: 'web_abort' });
    },
  );

  it('stop 事务锁到已 completed target 时不登记取消事件或工具 outbox', async () => {
    const sessionId = 'session-stop-terminal-race';
    const runId = 'run-stop-terminal-race';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'completed');
    await toolInvocationStore.start({
      invocationId: 'invocation-stop-terminal-race',
      runId,
      sessionId,
      toolCallId: 'call-stop-terminal-race',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const result = await store.cancelSteeringBeforeDispatchBySessionWithEvent(
      sessionId,
      'web_abort',
      runId,
      { type: 'run_cancel_requested', sessionId, runId, reason: 'web_abort' },
    );

    expect(result).toMatchObject({ targetCancelled: false, eventCreated: false });
    expect(result.event).toBeUndefined();
    await expect(store.get(runId)).resolves.toMatchObject({ status: 'completed' });
    await expect(toolInvocationStore.get('invocation-stop-terminal-race')).resolves.toMatchObject({
      status: 'running',
      cancelRequestedAt: undefined,
    });
    const events = await eventStore.list(sessionId);
    expect(events.some((event) => event.type === 'run_cancel_requested')).toBe(false);
    expect(events.some((event) => event.type === 'tool_invocation_cancel_requested')).toBe(false);
  });

  it('重复 stop 不重复投递取消事件或工具取消等外部副作用触发源', async () => {
    const sessionId = 'session-stop-idempotency';
    const runId = 'run-stop-idempotency';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    const event = { type: 'run_cancel_requested' as const, sessionId, runId, reason: 'web_abort' };

    const first = await store.cancelSteeringBeforeDispatchBySessionWithEvent(
      sessionId, 'web_abort', runId, event,
    );
    const duplicate = await store.cancelSteeringBeforeDispatchBySessionWithEvent(
      sessionId, 'web_abort', runId, event,
    );

    expect(first.eventCreated).toBe(true);
    expect(duplicate.eventCreated).toBe(false);
    const events = await eventStore.list(sessionId);
    expect(events.filter((item) => item.type === 'run_cancel_requested')).toHaveLength(1);
  });

  it.each(['start-first', 'stop-first'] as const)(
    '%s 顺序下 stop 与 tool invocation 晚插都登记 durable cancel outbox',
    async (order) => {
      const sessionId = `session-stop-late-invocation-${order}`;
      const runId = `run-stop-late-invocation-${order}`;
      const invocationId = `invocation-stop-late-invocation-${order}`;
      await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
      await store.markStatus(runId, 'running');
      const stop = () => store.cancelSteeringBeforeDispatchBySessionWithEvent(
        sessionId,
        'web_abort',
        runId,
        { type: 'run_cancel_requested', sessionId, runId, reason: 'web_abort' },
      );
      const start = () => toolInvocationStore.start({
        invocationId,
        runId,
        sessionId,
        toolCallId: `call-stop-late-invocation-${order}`,
        toolName: 'Shell',
        executionTarget: 'server-remote',
      });

      if (order === 'start-first') {
        await start();
        await stop();
      } else {
        await stop();
        await start();
      }

      await expect(store.get(runId)).resolves.toMatchObject({ status: 'cancelled' });
      await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({
        cancelRequestedAt: expect.any(String),
      });
      await expect(toolInvocationStore.listCancelRequested(sessionId)).resolves.toEqual([
        expect.objectContaining({ invocationId }),
      ]);
    },
  );

  it('stop 与 complete 真并发时 cancel outbox 与数据库线性化时间一致', async () => {
    const sessionId = 'session-stop-complete-race';
    const runId = 'run-stop-complete-race';
    const invocationId = 'invocation-stop-complete-race';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-stop-complete-race',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    await Promise.all([
      store.cancelSteeringBeforeDispatchBySessionWithEvent(
        sessionId,
        'web_abort',
        runId,
        { type: 'run_cancel_requested', sessionId, runId, reason: 'web_abort' },
      ),
      toolInvocationStore.complete(invocationId, 'completed'),
    ]);

    await recoverRunningToolInvocations({ toolInvocationStore, eventStore, runStore: store });
    const [run, invocation] = await Promise.all([store.get(runId), toolInvocationStore.get(invocationId)]);
    expect(run?.status).toBe('cancelled');
    expect(invocation?.status).toBe('completed');
    const completedAfterCancellation = Date.parse(invocation!.completedAt!) >= Date.parse(run!.cancelledAt!);
    expect(Boolean(invocation?.cancelRequestedAt)).toBe(completedAfterCancellation);
  });

  it('取消前已完成 invocation 的幂等 start 不补伪 cancel outbox', async () => {
    const sessionId = 'session-completed-before-cancel';
    const runId = 'run-completed-before-cancel';
    const invocationId = 'invocation-completed-before-cancel';
    const startInput = {
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-completed-before-cancel',
      toolName: 'Shell',
      executionTarget: 'server-remote' as const,
    };
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start(startInput);
    await toolInvocationStore.complete(invocationId, 'completed');
    await store.markStatus(runId, 'cancelled', 'web_abort');

    await toolInvocationStore.start(startInput);

    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({ status: 'completed' });
    expect((await toolInvocationStore.get(invocationId))?.cancelRequestedAt).toBeUndefined();
  });

  it('重复取消已终态 run 不改写首次 cancelledAt', async () => {
    const runId = 'run-cancelled-at-stable';
    await store.upsertPending({
      runId,
      sessionId: 'session-cancelled-at-stable',
      userId: 'user-1',
      channel: 'web',
    });
    await store.markStatus(runId, 'running');
    const first = await store.markStatus(runId, 'cancelled', 'web_abort');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const repeated = await store.markStatus(runId, 'cancelled', 'web_abort');

    expect(first?.cancelledAt).toBeTruthy();
    expect(repeated?.cancelledAt).toBe(first?.cancelledAt);
  });

  it('取消等待 invocation 完成锁时以取得 run 行锁后的时间作为线性化点', async () => {
    const sessionId = 'session-cancel-lock-linearization';
    const runId = 'run-cancel-lock-linearization';
    const invocationId = 'invocation-cancel-lock-linearization';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-cancel-lock-linearization',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const blocker = await pool.connect();
    let cancellation: ReturnType<typeof store.markStatus> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT run_id FROM ${prefix}_runs WHERE run_id = $1 FOR SHARE`, [runId]);
      cancellation = store.markStatus(runId, 'cancelled', 'web_abort');
      let waitingOnRunLock = false;
      for (let attempt = 0; attempt < 100 && !waitingOnRunLock; attempt += 1) {
        const waiting = await pool.query<{ waiting: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE $1
          ) AS waiting
        `, [`%FROM ${prefix}_runs%FOR UPDATE%`]);
        waitingOnRunLock = waiting.rows[0]?.waiting ?? false;
        if (!waitingOnRunLock) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waitingOnRunLock).toBe(true);
      await blocker.query(`
        UPDATE ${prefix}_tool_invocations
        SET status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE invocation_id = $1 AND status = 'running'
      `, [invocationId]);
      await blocker.query('COMMIT');

      const cancelled = await cancellation;
      const invocation = await toolInvocationStore.get(invocationId);
      expect(Date.parse(cancelled!.cancelledAt!)).toBeGreaterThanOrEqual(Date.parse(invocation!.completedAt!));
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await cancellation?.catch(() => undefined);
    }
  });

  it('恢复快照后 invocation 先完成、run 后取消时不误建 cancel outbox', async () => {
    const sessionId = 'session-recovery-snapshot-race';
    const runId = 'run-recovery-snapshot-race';
    const invocationId = 'invocation-recovery-snapshot-race';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-recovery-snapshot-race',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const originalListRunning = toolInvocationStore.listRunning.bind(toolInvocationStore);
    let snapshotRead!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotReadPromise = new Promise<void>((resolve) => { snapshotRead = resolve; });
    const releaseSnapshotPromise = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    toolInvocationStore.listRunning = async (requestedSessionId?: string) => {
      const records = await originalListRunning(requestedSessionId);
      snapshotRead();
      await releaseSnapshotPromise;
      return records;
    };

    const recovery = recoverRunningToolInvocations({ toolInvocationStore, eventStore, runStore: store });
    try {
      await snapshotReadPromise;
      await toolInvocationStore.complete(invocationId, 'completed');
      await store.markStatus(runId, 'cancelled', 'web_abort');
      releaseSnapshot();
      await expect(recovery).resolves.toMatchObject({ scanned: 1, recovered: 0 });
    } finally {
      releaseSnapshot();
      toolInvocationStore.listRunning = originalListRunning;
    }

    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({ status: 'completed' });
    expect((await toolInvocationStore.get(invocationId))?.cancelRequestedAt).toBeUndefined();
  });

  it('恢复器为 cancelled run 下已终态的 invocation 补登记一次 cancel outbox', async () => {
    const sessionId = 'session-terminal-cancel-repair';
    const runId = 'run-terminal-cancel-repair';
    const invocationId = 'invocation-terminal-cancel-repair';
    await store.upsertPending({ runId, sessionId, userId: 'user-1', channel: 'web' });
    await store.markStatus(runId, 'running');
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call-terminal-cancel-repair',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });
    // 使用 PostgreSQL 微秒时间模拟旧版本/崩溃留下的终态半状态；RunStore.get 会把
    // cancelledAt 归一化到毫秒，恢复 CAS 必须直接使用数据库权威时间而非 JS 等值比较。
    await pool.query(`
      UPDATE ${prefix}_runs
      SET status = 'cancelled', status_reason = 'web_abort',
          cancelled_at = TIMESTAMPTZ '2026-08-15 00:00:00.123456+00',
          updated_at = TIMESTAMPTZ '2026-08-15 00:00:00.123456+00'
      WHERE run_id = $1
    `, [runId]);
    await pool.query(`
      UPDATE ${prefix}_tool_invocations
      SET status = 'failed',
          completed_at = TIMESTAMPTZ '2026-08-15 00:00:00.123457+00',
          updated_at = TIMESTAMPTZ '2026-08-15 00:00:00.123457+00',
          error = 'worker crashed'
      WHERE invocation_id = $1
    `, [invocationId]);

    await expect(recoverRunningToolInvocations({
      toolInvocationStore,
      eventStore,
      runStore: store,
    })).resolves.toMatchObject({ recovered: 0 });

    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({
      status: 'failed',
      cancelRequestedAt: expect.any(String),
      cancelReason: 'recovered_after_cancelled_run',
    });
    await expect(toolInvocationStore.requestCancelOnce(invocationId, 'duplicate')).resolves.toMatchObject({ created: false });
  });

  it('PostgreSQL 工具取消只选出一个事件发布者和一个外部投递 claimant', async () => {
    await store.upsertPending({
      runId: 'run-cancel-cas',
      sessionId: 'session-cancel-cas',
      userId: 'user-1',
      channel: 'web',
    });
    await store.markStatus('run-cancel-cas', 'running');
    await toolInvocationStore.start({
      invocationId: 'invocation-cancel-cas',
      runId: 'run-cancel-cas',
      sessionId: 'session-cancel-cas',
      toolCallId: 'call-cancel-cas',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const requests = await Promise.all([
      toolInvocationStore.requestCancelOnce('invocation-cancel-cas', 'web_abort'),
      toolInvocationStore.requestCancelOnce('invocation-cancel-cas', 'web_abort'),
    ]);
    expect(requests.map((item) => item?.created).sort()).toEqual([false, true]);

    const claimNow = new Date('2026-08-15T00:00:00.000Z');
    const claims = await Promise.all([
      toolInvocationStore.claimCancelDelivery('invocation-cancel-cas', 'claim-a', 30_000, claimNow),
      toolInvocationStore.claimCancelDelivery('invocation-cancel-cas', 'claim-b', 30_000, claimNow),
    ]);
    const winner = claims.find((claim) => claim)?.metadata.cancelDeliveryClaimId;
    const loser = winner === 'claim-a' ? 'claim-b' : 'claim-a';
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(winner).toMatch(/^claim-[ab]$/);
    await expect(toolInvocationStore.markCancelDelivered(
      'invocation-cancel-cas', { cancelDelivery: 'stale' }, loser,
    )).resolves.toBeNull();
    await expect(toolInvocationStore.markCancelDelivered(
      'invocation-cancel-cas', { cancelDelivery: 'delivered' }, String(winner),
    )).resolves.toMatchObject({ cancelDeliveredAt: expect.any(String) });
  });

  it('并发 lease renew single-flight 之外仍由 SQL 保证过期时间单调不倒退', async () => {
    const runId = 'lease-monotonic-run';
    const baseNow = new Date('2026-08-15T00:00:00.000Z');
    await store.upsertPending({ runId, sessionId: 'lease-monotonic-session', userId: 'user-1' });
    await store.acquireLease(runId, 'lease-worker', 60_000, baseNow);
    await Promise.all([
      store.renewLease(runId, 'lease-worker', 60_000, new Date(baseNow.getTime() + 120_000)),
      store.renewLease(runId, 'lease-worker', 60_000, new Date(baseNow.getTime() + 30_000)),
    ]);
    const renewed = await store.get(runId);
    expect(Date.parse(renewed!.leaseExpiresAt!)).toBeGreaterThanOrEqual(baseNow.getTime() + 180_000);
  });

});
