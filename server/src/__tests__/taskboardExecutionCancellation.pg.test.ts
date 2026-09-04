import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { BillingService } from '../data/billing/service.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { PgRunStore } from '../runtime/runStore.js';
import { coordinateRunFinishedEvent } from '../runtime/runTerminalCoordinator.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('Taskboard execution cancellation PostgreSQL races', () => {
  const prefix = `tb_cancel_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const identity: TaskboardIdentity = {
    tenantId: 'tenant-cancel', ownerUserId: 'owner-cancel', username: 'owner',
  };
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  let runStore: PgRunStore;
  let eventStore: PgEventStore;
  let toolInvocationStore: PgToolInvocationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 8 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    runStore = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    eventStore = new PgEventStore({ connectionString: connectionString!, tablePrefix: prefix, poolMax: 4 });
    toolInvocationStore = new PgToolInvocationStore({ pool, tablePrefix: prefix });
    await eventStore.init();
    await Promise.all([store.init(), runStore.init()]);
    await toolInvocationStore.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await eventStore.close();
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`,
      [`${prefix}%`],
    );
    for (const { tablename } of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
    }
    await pool.end();
  }, 30_000);

  it('holds the execution fence behind durable run creation and rejects pending-cancellation claims', async () => {
    const suffix = randomUUID();
    const board = await store.createBoard(identity, {
      name: `取消门禁-${suffix}`,
      repository: {
        provider: 'github', repositoryId: 'github:test/taskboard-cancel', owner: 'test',
        name: 'taskboard-cancel', baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const task = await store.createTask(identity, board.id, { title: '取消与派发竞态', status: 'todo' });
    const executionId = `execution-${suffix}`;
    const runId = `run-${suffix}`;
    const sessionId = `session-${suffix}`;
    await store.claimExecution(identity, task.id, {
      expectedVersion: task.version,
      executionId,
      runId,
      sessionId,
      executionOwnerUserId: identity.ownerUserId,
      protocolVersion: 1,
      dispatch: {
        version: 1,
        session: {
          sessionId, userId: identity.ownerUserId, username: identity.username,
          tenantId: identity.tenantId, channel: 'web', cwd: '/tmp/taskboard-cancel-test',
          transcriptPath: `/tmp/taskboard-cancel-test/${sessionId}.jsonl`, status: 'running',
          createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
        },
        run: {
          runId, sessionId, userId: identity.ownerUserId, tenantId: identity.tenantId,
          channel: 'web', idempotencyKey: `taskboard-execution:${executionId}`,
          metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
        },
      },
    });
    await expect(store.claimExecutionDispatch(runId, 'lease-gate')).resolves.toMatchObject({ runId });

    let releaseGate!: () => void;
    const holdGate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let gateEntered = false;
    const gated = store.runExecutionDispatchGate(runId, 'lease-gate', async () => {
      gateEntered = true;
      await holdGate;
      await runStore.createPending({
        runId, sessionId, tenantId: identity.tenantId,
        metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
      });
    });
    await expect.poll(() => gateEntered).toBe(true);
    let fenceFinished = false;
    const fence = pool.query(
      `UPDATE ${store.executionsTable} SET status='cancelled',finished_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('queued','running','waiting_user','waiting_approval')`,
      [executionId],
    ).then(() => { fenceFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fenceFinished).toBe(false);
    releaseGate();
    await expect(gated).resolves.toBe(true);
    await fence;
    await expect(runStore.get(runId)).resolves.toMatchObject({ runId });

    await pool.query(`UPDATE ${store.executionsTable} SET status='queued',finished_at=NULL WHERE id=$1`, [executionId]);
    const pendingCancellationId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.cancellationOutboxTable}(id,execution_id,run_id,task_id,reason,fence_epoch)
       VALUES($1,$2,$3,$4,'superseded',1)`,
      [pendingCancellationId, executionId, runId, task.id],
    );
    await pool.query(
      `UPDATE ${store.executionOutboxTable}
       SET status='pending',lease_id=NULL,lease_expires_at=NULL,next_attempt_at=now() WHERE run_id=$1`,
      [runId],
    );
    await expect(store.claimExecutionDispatch(runId, 'lease-after-cancel')).resolves.toBeNull();
    const [pendingCancellation] = await store.claimWorkflowCancellations(1);
    expect(pendingCancellation).toMatchObject({ id: pendingCancellationId, runId });
    await store.finishWorkflowCancellation(pendingCancellationId);
  });

  it('terminal-before-outbox 以 Runtime completed fact 纠正 Execution 并幂等关闭两个 outbox', async () => {
    const suffix = randomUUID();
    const board = await store.createBoard(identity, {
      name: `终态优先-${suffix}`,
      repository: {
        provider: 'github', repositoryId: `github:test/taskboard-terminal-${suffix}`, owner: 'test',
        name: 'taskboard-terminal', baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const task = await store.createTask(identity, board.id, { title: '终态先于取消消费', status: 'todo' });
    const executionId = `execution-${suffix}`;
    const runId = `run-${suffix}`;
    const sessionId = `session-${suffix}`;
    await store.claimExecution(identity, task.id, {
      expectedVersion: task.version, executionId, runId, sessionId,
      executionOwnerUserId: identity.ownerUserId, protocolVersion: 1,
      dispatch: {
        version: 1,
        session: {
          sessionId, userId: identity.ownerUserId, username: identity.username,
          tenantId: identity.tenantId, channel: 'web', cwd: '/tmp/taskboard-terminal-test',
          transcriptPath: `/tmp/taskboard-terminal-test/${sessionId}.jsonl`, status: 'running',
          createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
        },
        run: {
          runId, sessionId, userId: identity.ownerUserId, tenantId: identity.tenantId,
          channel: 'web', idempotencyKey: `taskboard-execution:${executionId}`,
          metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
        },
      },
    });
    await runStore.createPending({
      runId, sessionId, tenantId: identity.tenantId,
      metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
    });
    await runStore.markStatus(runId, 'running');
    const invocationId = `invocation-${suffix}`;
    await toolInvocationStore.start({
      invocationId, runId, sessionId, tenantId: identity.tenantId,
      toolCallId: `call-${suffix}`, toolName: 'Shell', executionTarget: 'server-remote',
    });
    await toolInvocationStore.complete(invocationId, 'completed');
    await coordinateRunFinishedEvent({
      runStore,
      eventStore,
      event: { type: 'run_finished', runId, sessionId, subtype: 'success', numTurns: 1 },
      ctx: { tenantId: identity.tenantId },
    });

    const durableEvents = await eventStore.list(identity.tenantId, sessionId);
    expect(durableEvents.filter((event) => event.type === 'run_state_changed')).toEqual([
      expect.objectContaining({
        type: 'run_state_changed', runId, status: 'completed', previousStatus: 'running',
      }),
    ]);
    const completedRun = await runStore.get(runId);
    expect(completedRun).toMatchObject({ status: 'completed' });
    const completedTool = await toolInvocationStore.get(invocationId);
    expect(completedTool).toMatchObject({ status: 'completed' });
    expect(completedTool?.cancelRequestedAt).toBeUndefined();
    expect(completedTool?.cancelReason).toBeUndefined();

    const persisted = await pool.query<{
      global_sequence: string;
      event_id: string;
      event_type: string;
      tenant_id: string;
      timestamp: Date;
      event_json: Record<string, unknown>;
    }>(`
      SELECT global_sequence,event_id,event_type,tenant_id,timestamp,event_json
      FROM ${prefix}_events
      WHERE session_id=$1 AND event_type='run_state_changed'
      ORDER BY global_sequence
    `, [sessionId]);
    let projectionSequence = 0;
    const settleRunDebit = vi.fn(async () => null);
    const billingStore = {
      getProjectionState: vi.fn(async () => projectionSequence),
      listUnprojectedRuntimeEvents: vi.fn(async () => persisted.rows
        .filter((row) => Number(row.global_sequence) > projectionSequence)
        .map((row) => ({
          globalSequence: Number(row.global_sequence), eventId: row.event_id,
          eventType: row.event_type, tenantId: row.tenant_id,
          timestamp: new Date(row.timestamp).toISOString(), eventJson: row.event_json,
        }))),
      settleRunDebit,
      setProjectionState: vi.fn(async (_key: string, sequence: number) => { projectionSequence = sequence; }),
    } as unknown as PgBillingStore;
    const billingService = new BillingService({ store: billingStore });
    await billingService.projectRuntimeEvents();
    expect(settleRunDebit).toHaveBeenCalledTimes(1);
    expect(settleRunDebit).toHaveBeenCalledWith(identity.tenantId, runId);

    const cancellationId = randomUUID();
    await pool.query(
      `UPDATE ${store.executionsTable}
          SET status='cancelled',superseded_at=now(),terminal_reason_code='superseded',error='superseded'
        WHERE id=$1`,
      [executionId],
    );
    await pool.query(
      `INSERT INTO ${store.cancellationOutboxTable}(id,execution_id,run_id,task_id,reason,fence_epoch)
       VALUES($1,$2,$3,$4,'superseded',1)`,
      [cancellationId, executionId, runId, task.id],
    );
    const [claimed] = await store.claimWorkflowCancellations(1);
    expect(claimed).toMatchObject({ id: cancellationId, runId });

    const fact = { runId, status: 'completed' as const, reason: completedRun?.statusReason };
    await store.reconcileWorkflowCancellationTerminal(cancellationId, fact);
    await store.reconcileWorkflowCancellationTerminal(cancellationId, fact);
    await billingService.projectRuntimeEvents();

    const eventsAfterReplay = await eventStore.list(identity.tenantId, sessionId);
    expect(eventsAfterReplay.filter((event) => event.type === 'run_state_changed')).toHaveLength(1);
    expect(settleRunDebit).toHaveBeenCalledTimes(1);
    await expect(runStore.get(runId)).resolves.toMatchObject({ status: 'completed' });
    const completedToolAfter = await toolInvocationStore.get(invocationId);
    expect(completedToolAfter).toMatchObject({ status: 'completed' });
    expect(completedToolAfter?.cancelRequestedAt).toBeUndefined();
    expect(completedToolAfter?.cancelReason).toBeUndefined();

    const result = await pool.query(
      `SELECT e.status,e.error,e.superseded_at,o.status AS cancellation_status,d.status AS dispatch_status,
              (SELECT count(*)::int FROM ${store.changesTable}
                WHERE task_id=e.task_id AND change_type='execution.terminal_reconciled'
                  AND actor_id=$2) AS correction_count
         FROM ${store.executionsTable} e
         JOIN ${store.cancellationOutboxTable} o ON o.execution_id=e.id
         JOIN ${store.executionOutboxTable} d ON d.run_id=e.run_id
        WHERE e.id=$1`,
      [executionId, cancellationId],
    );
    expect(result.rows[0]).toMatchObject({
      status: 'succeeded', error: null, superseded_at: null,
      cancellation_status: 'completed', dispatch_status: 'dispatched', correction_count: 1,
    });
  });
});
