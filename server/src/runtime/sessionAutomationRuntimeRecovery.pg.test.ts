import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgEventStore } from './pgEventStore.js';
import { PgRunStore } from './runStore.js';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';
import {
  AutomationBudgetExceededError,
  AutomationFenceRejectedError,
  SessionAutomationRuntimeGuard,
} from './sessionAutomationRuntimeGuard.js';
import { SessionAutomationEvaluator, type GoalEvaluatorPort } from './sessionAutomationEvaluator.js';
import type { RunContext } from './types.js';

const { Pool } = pg;
const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

describePg('session automation runtime fence and evaluator recovery on PostgreSQL', () => {
  const prefix = `automation_recovery_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let pool: InstanceType<typeof Pool>;
  let events: PgEventStore;
  let runs: PgRunStore;
  let store: PgSessionAutomationStore;
  let guard: SessionAutomationRuntimeGuard;
  const tenantId = 'tenant-runtime-recovery';
  const sessionId = 'session-runtime-recovery';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 8 });
    events = new PgEventStore({ connectionString: url!, tablePrefix: prefix, poolMax: 4 });
    await events.init();
    runs = new PgRunStore({ pool, tablePrefix: prefix });
    await runs.init();
    store = new PgSessionAutomationStore(pool, prefix, runs.runsTable);
    await store.init();
    guard = new SessionAutomationRuntimeGuard(pool, prefix, runs.runsTable);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await events.close();
    await pool.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '${prefix}_%'
      LOOP EXECUTE format('DROP TABLE IF EXISTS %I CASCADE',r.tablename); END LOOP;
    END $$`).catch(() => undefined);
    await pool.end();
  }, 30_000);

  async function activeExecution(budget: Record<string, unknown> = {}) {
    const automationId = randomUUID();
    const incarnationId = randomUUID();
    const executionSessionId = `${sessionId}-${randomUUID()}`;
    await pool.query(
      `INSERT INTO ${store.tables.automations}
        (automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version)
       VALUES($1,$2,$3,'user-a',$4,'goal','adaptive','active','idle',1,1,1,1)`,
      [automationId, tenantId, executionSessionId, incarnationId],
    );
    await pool.query(
      `INSERT INTO ${store.tables.specs}
        (automation_id,tenant_id,session_id,spec_version,spec_digest,spec)
       VALUES($1,$2,$3,1,$4,$5)`,
      [automationId, tenantId, executionSessionId, randomUUID(), JSON.stringify({
        kind: 'goal', mode: 'adaptive', prompt: 'continue', condition: 'done', budget,
      })],
    );
    await store.tx(client => store.scheduleTx(client, {
      tenantId, sessionId: executionSessionId, automationId, incarnationId, generation: 1, specVersion: 1,
      continuationEpoch: 1, triggerKey: `initial:${automationId}`, dueAt: new Date(0), payload: {},
    }));
    await store.claimDue();
    const dispatches = await store.claimDispatch(20);
    const dispatch = dispatches.find(item => item.automationId === automationId)!;
    await store.prepareDispatch(dispatch, { prompt: 'continue' });
    await runs.createPending({
      runId: dispatch.targetRunId, tenantId, sessionId: executionSessionId, userId: 'user-a', metadata: { schedulerState: 'staged' },
    });
    await store.markDispatched(dispatch);
    const context = {
      runId: dispatch.targetRunId,
      sessionId: executionSessionId,
      tenantId,
      model: 'test-model',
      automationFence: {
        automationId,
        incarnationId,
        generation: 1,
        specVersion: 1,
        executionId: dispatch.outboxId,
        runId: dispatch.targetRunId,
      },
    } as RunContext;
    return { automationId, incarnationId, sessionId: executionSessionId, dispatch, context };
  }

  it('clear ACK wins the row lock before model admission and stale generation starts no provider attempt', async () => {
    const setup = await activeExecution();
    let unlock!: () => void;
    let locked!: () => void;
    const lockedPromise = new Promise<void>(resolve => { locked = resolve; });
    const unlockPromise = new Promise<void>(resolve => { unlock = resolve; });
    const clear = store.tx(async client => {
      const current = await store.getLocked(client, tenantId, setup.sessionId, setup.automationId);
      locked();
      await unlockPromise;
      await store.control(client, current!, 'clear');
    });
    await lockedPromise;
    const admission = guard.beforeModel(setup.context, 'turn:1');
    unlock();
    await clear;
    await expect(admission).rejects.toBeInstanceOf(AutomationFenceRejectedError);
    const attempts = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tables.providerAttempts}
        WHERE automation_id=$1`,
      [setup.automationId],
    );
    expect(attempts.rows[0].count).toBe(0);
  });

  it('the first reservation consumes the final turn atomically and a concurrent admission fails closed', async () => {
    const setup = await activeExecution({ maxTurns: 1 });
    const first = await guard.beforeModel(setup.context, 'turn:first');
    expect(first).toBeDefined();
    await expect(guard.beforeModel(setup.context, 'turn:second')).rejects.toBeInstanceOf(AutomationBudgetExceededError);
    const automation = await pool.query(
      `SELECT status,limit_hit_reason FROM ${store.tables.automations} WHERE tenant_id=$1 AND automation_id=$2`,
      [tenantId, setup.automationId],
    );
    expect(automation.rows[0]).toMatchObject({ status: 'expired', limit_hit_reason: 'max_turns' });
    const rows = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tables.budgetReservations} WHERE automation_id=$1`,
      [setup.automationId],
    );
    expect(rows.rows[0].count).toBe(1);
  });

  it('a lease-expired evaluator admitted before a crash is frozen for explicit reconciliation', async () => {
    const setup = await activeExecution();
    const evaluationId = randomUUID();
    await pool.query(`UPDATE ${store.tables.executions} SET state='terminal' WHERE execution_id=$1`, [setup.dispatch.outboxId]);
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,lease_token,lease_expires_at)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'claimed',$8,now()-interval '1 second')`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'done', evidenceRefs: ['event:1'], hardGates: {} }), randomUUID()],
    );
    const attempt = await guard.beforeModel(setup.context, `goal-evaluation:${evaluationId}`);
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: vi.fn() } as unknown as GoalEvaluatorPort);
    expect(await evaluator.reconcileUnknown()).toBe(1);
    expect((await pool.query(`SELECT state,provider_attempt_id FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0]).toMatchObject({
      state: 'result_unknown', provider_attempt_id: attempt!.providerAttemptId,
    });
    expect((await pool.query(`SELECT state FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`, [attempt!.providerAttemptId])).rows[0].state).toBe('result_unknown');
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'reconcile_required' });
  });

  it('claimed lease expiry is retryable but result_unknown never blind-replays', async () => {
    const setup = await activeExecution();
    await pool.query(`UPDATE ${store.tables.executions} SET state='terminal' WHERE execution_id=$1`, [setup.dispatch.outboxId]);
    const claimedId = randomUUID();
    const unknownId = randomUUID();
    for (const [evaluationId, state] of [[claimedId, 'claimed'], [unknownId, 'result_unknown']] as const) {
      await pool.query(
        `INSERT INTO ${store.tables.evaluations}
          (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,lease_token,lease_expires_at)
         VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$10,now()-interval '1 second')`,
        [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId,
          setup.incarnationId, state === 'claimed' ? 10 : 11,
          JSON.stringify({ summary: 'done', evidenceRefs: ['event:1'], hardGates: {} }), state, randomUUID()],
      );
    }
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: vi.fn() } as unknown as GoalEvaluatorPort);
    expect(await evaluator.reconcileUnknown()).toBe(1);
    const states = await pool.query(
      `SELECT evaluation_id,state FROM ${store.tables.evaluations} WHERE evaluation_id=ANY($1::uuid[])`,
      [[claimedId, unknownId]],
    );
    expect(Object.fromEntries(states.rows.map(row => [row.evaluation_id, row.state]))).toEqual({
      [claimedId]: 'pending',
      [unknownId]: 'result_unknown',
    });
  });

  it('explicit evaluator receipts are idempotent and only completed/not_found resolve result_unknown', async () => {
    const setup = await activeExecution();
    const attempt = await guard.beforeModel(setup.context, 'goal-evaluation:receipt-test');
    expect(attempt).toBeDefined();
    const evaluationId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,provider_attempt_id)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'result_unknown',$8)`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'unknown', evidenceRefs: ['event:1'], hardGates: {} }), attempt!.providerAttemptId],
    );
    await guard.finishModel(setup.context, attempt, undefined, new Error('response lost'));

    for (const observedState of ['still_running', 'ambiguous'] as const) {
      const current = await store.get(tenantId, setup.sessionId, setup.automationId);
      await store.tx(client => store.control(client, current!, 'reconcile', {
        providerAttemptId: attempt!.providerAttemptId,
        receiptKey: `receipt-${observedState}`,
        observedState,
        receiptPayload: { providerRequestId: 'provider-1' },
      }));
      expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'reconcile_required' });
      expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0].state).toBe('result_unknown');
    }
    const current = await store.get(tenantId, setup.sessionId, setup.automationId);
    const notFound = {
      providerAttemptId: attempt!.providerAttemptId,
      receiptKey: 'receipt-not-found',
      observedState: 'not_found' as const,
      receiptPayload: { providerRequestId: 'provider-1' },
    };
    await store.tx(client => store.control(client, current!, 'reconcile', notFound));
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'active' });
    expect((await pool.query(`SELECT state,provider_attempt_id FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0]).toMatchObject({ state: 'pending', provider_attempt_id: null });
    const active = await store.get(tenantId, setup.sessionId, setup.automationId);
    await expect(store.tx(client => store.control(client, active!, 'reconcile', notFound))).resolves.toMatchObject({ status: 'active' });
    await expect(store.tx(client => store.control(client, active!, 'reconcile', {
      ...notFound,
      receiptPayload: { providerRequestId: 'different' },
    }))).rejects.toMatchObject({ code: 'CONFLICT' });

    const completedSetup = await activeExecution();
    const completedAttempt = await guard.beforeModel(completedSetup.context, 'goal-evaluation:completed-receipt');
    const completedEvaluationId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,provider_attempt_id)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'result_unknown',$8)`,
      [completedEvaluationId, tenantId, completedSetup.sessionId, completedSetup.automationId, completedSetup.dispatch.outboxId,
        completedSetup.incarnationId, JSON.stringify({ summary: 'unknown', evidenceRefs: ['event:2'], hardGates: {} }),
        completedAttempt!.providerAttemptId],
    );
    await guard.finishModel(completedSetup.context, completedAttempt, undefined, new Error('response lost'));
    const completedCurrent = await store.get(tenantId, completedSetup.sessionId, completedSetup.automationId);
    await store.tx(client => store.control(client, completedCurrent!, 'reconcile', {
      providerAttemptId: completedAttempt!.providerAttemptId,
      receiptKey: 'receipt-completed',
      observedState: 'completed',
      receiptPayload: { rawResult: '{"decision":"met"}' },
    }));
    expect(await store.get(tenantId, completedSetup.sessionId, completedSetup.automationId)).toMatchObject({ status: 'blocked' });
    expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [completedEvaluationId])).rows[0].state).toBe('unverifiable');
  });

  it('blocked hard gate check-in resumes only after the durable resource is released', async () => {
    const setup = await activeExecution();
    await pool.query(`UPDATE ${store.tables.executions} SET state='terminal' WHERE execution_id=$1`, [setup.dispatch.outboxId]);
    const evaluationId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,decision)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'blocked',$8)`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'done', evidenceRefs: ['event:1'], hardGates: {} }),
        JSON.stringify({ decision: 'blocked', reason: 'hard_gate', confidence: 1 })],
    );
    const resourceId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.backgroundResources}
        (background_resource_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,resource_kind,resource_key,state)
       VALUES($1,$2,$3,$4,$5,1,$6,$7,'child_run',$8,'active')`,
      [resourceId, tenantId, setup.sessionId, setup.automationId, setup.incarnationId,
        setup.dispatch.outboxId, setup.dispatch.targetRunId, `child:${resourceId}`],
    );
    const evaluate = vi.fn(async () => ({ decision: 'unverifiable' as const, reason: 'test', confidence: 1 }));
    const evaluator = new SessionAutomationEvaluator(store, { evaluate } as GoalEvaluatorPort);
    await evaluator.evaluatePending();
    expect(evaluate).not.toHaveBeenCalled();
    await pool.query(`UPDATE ${store.tables.backgroundResources} SET state='released' WHERE background_resource_id=$1`, [resourceId]);
    await evaluator.evaluatePending();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0].state).toBe('unverifiable');
  });
});
