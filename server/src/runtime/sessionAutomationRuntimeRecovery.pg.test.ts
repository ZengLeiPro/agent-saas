import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgEventStore } from './pgEventStore.js';
import { PgRunStore } from './runStore.js';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';
import {
  AutomationBudgetExceededError,
  AutomationFenceRejectedError,
  SessionAutomationRuntimeGuard,
} from './sessionAutomationRuntimeGuard.js';
import { SessionAutomationEvaluator, type GoalEvaluatorPort } from './sessionAutomationEvaluator.js';
import { deriveChildAutomationFence } from './subagent/subagentRunner.js';
import { SessionAutomationTerminalProjector } from './sessionAutomationTerminalProjector.js';
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
    runs = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    await runs.init();
    store = new PgSessionAutomationStore(pool, prefix, runs.runsTable);
    await store.init();
    guard = new SessionAutomationRuntimeGuard(pool, () => true, prefix, runs.runsTable);
  }, 30_000);

  afterEach(async () => {
    if (!pool) return;
    // Queue scanners are table-wide. Retire only this suite's retryable test jobs between cases.
    const sessionPattern = `${sessionId}-%`;
    await pool.query(`UPDATE ${store.tables.evaluations}
      SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE tenant_id=$1 AND session_id LIKE $2 AND state IN ('pending','claimed')`,
    [tenantId, sessionPattern]);
    await pool.query(`UPDATE ${store.tables.wakeups}
      SET state='superseded',lease_token=NULL,lease_expires_at=NULL
      WHERE tenant_id=$1 AND session_id LIKE $2 AND state IN ('pending','claimed')`,
    [tenantId, sessionPattern]);
  });

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
       VALUES($1,$2,$3,'user-a',$4,'goal','goal','active','idle',1,1,1,1)`,
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
    // Goal completion is a separately budgeted evaluator call and starts with two crash-safe attempts.
    await pool.query(
      `INSERT INTO ${store.tables.completionAllowances}
        (automation_id,tenant_id,session_id,remaining_attempts,max_output_tokens)
       VALUES($1,$2,$3,2,500)`,
      [automationId, tenantId, executionSessionId],
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

  async function appendSuccessfulShellEvidence(
    setup: Awaited<ReturnType<typeof activeExecution>>,
    command = 'pnpm test',
  ) {
    const toolCallId = randomUUID();
    await events.append({
      type: 'assistant_tool_calls',
      runId: setup.dispatch.targetRunId,
      sessionId: setup.sessionId,
      content: '',
      toolCalls: [{ id: toolCallId, name: 'Shell', arguments: JSON.stringify({ command }) }],
    }, { tenantId });
    const event = await events.append({
      type: 'tool_result',
      runId: setup.dispatch.targetRunId,
      sessionId: setup.sessionId,
      toolCallId,
      toolName: 'Shell',
      content: 'command completed successfully',
      metadata: { exitCode: 0 },
    }, { tenantId });
    const sequence = await pool.query(
      `SELECT global_sequence FROM ${prefix}_events WHERE tenant_id=$1 AND event_id=$2`,
      [tenantId, event.id],
    );
    expect(sequence.rows).toHaveLength(1);
    return { event, globalSequence: Number(sequence.rows[0].global_sequence) };
  }

  async function closeExecutionAsProjected(setup: Awaited<ReturnType<typeof activeExecution>>) {
    // Evaluator recovery cases seed a post-terminal boundary directly. Mirror the dispatch-artifact
    // closure performed by SessionAutomationTerminalProjector without exercising projector policy.
    await store.tx(async client => {
      await client.query(
        `UPDATE ${store.tables.executions}
            SET state='terminal',terminal_status='completed',updated_at=now()
          WHERE execution_id=$1`,
        [setup.dispatch.outboxId],
      );
      await client.query(
        `UPDATE ${store.tables.outbox}
            SET state='completed',lease_token=NULL,lease_expires_at=NULL
          WHERE outbox_id=$1`,
        [setup.dispatch.outboxId],
      );
      await client.query(
        `UPDATE ${store.tables.preparedDispatchAttempts}
            SET state='completed',version=version+1,lease_token=NULL,lease_expires_at=NULL,
                completed_at=COALESCE(completed_at,now()),updated_at=now()
          WHERE outbox_id=$1 AND state IN ('prepared','dispatched','result_unknown','reconcile')`,
        [setup.dispatch.outboxId],
      );
      await client.query(
        `UPDATE ${store.tables.wakeups} SET state='consumed' WHERE wakeup_id=$1`,
        [setup.dispatch.wakeupId],
      );
    });
  }

  it('clear ACK supersedes its wakeup before model admission and stale generation starts no provider attempt', async () => {
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
    const admission = guard.beforeModel(setup.context, 'turn:1', {model: setup.context.model, inputTokens: 10, maxOutputTokens: 20});
    unlock();
    await clear;
    await expect(admission).rejects.toBeInstanceOf(AutomationFenceRejectedError);
    const attempts = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tables.providerAttempts}
        WHERE automation_id=$1`,
      [setup.automationId],
    );
    expect(attempts.rows[0].count).toBe(0);
    const cancellation = (await store.claimCancellations(20)).find(item => item.automationId === setup.automationId);
    expect(cancellation).toBeDefined();
    await runs.markStatus(setup.dispatch.targetRunId, 'cancelled', 'authoritative cancel adapter');
    await store.completeCancellation(cancellation!);
    const closure = await pool.query(
      `SELECT
        (SELECT state FROM ${store.tables.executions} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND run_id=$4) AS execution,
        (SELECT state FROM ${store.tables.outbox} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND target_run_id=$4) AS outbox,
        (SELECT state FROM ${store.tables.preparedDispatchAttempts} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND run_id=$4) AS prepared,
        (SELECT state FROM ${store.tables.wakeups} WHERE wakeup_id=$5) AS wakeup`,
      [tenantId, setup.sessionId, setup.automationId, setup.dispatch.targetRunId, setup.dispatch.wakeupId],
    );
    expect(closure.rows[0]).toMatchObject({ execution: 'terminal', outbox: 'cancelled', prepared: 'cancelled', wakeup: 'superseded' });
    const lifecycle = await pool.query(
      `SELECT object_type,state FROM ${store.tables.lifecycleWork}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
          AND ((object_type='run' AND object_id=$4) OR object_id=$5::text)`,
      [tenantId, setup.sessionId, setup.automationId, setup.dispatch.targetRunId, setup.dispatch.outboxId],
    );
    expect(lifecycle.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ object_type: 'run', state: 'completed' }),
      expect.objectContaining({ object_type: 'execution', state: 'completed' }),
    ]));
    const adapter = { execute: async (job: import('./sessionAutomationStore.js').SessionAutomationLifecycleJob) => {
      const { attemptCount: _attemptCount, details: _details, ...fence } = job;
      return { ...fence, receiptKey: `clear-test:${job.workId}`, authority: 'runtime' as const, outcome: 'completed' as const, payload: {} };
    } };
    await store.processLifecycleWork({ run: adapter, execution: adapter, evaluation: adapter, provider_attempt: adapter, interaction: adapter, background_resource: adapter, budget_reservation: adapter }, 50);
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'cancelled', phase: 'terminal' });
  });

  it('admits a child session against its root automation while preserving the invoking child lineage', async () => {
    const setup = await activeExecution();
    const childSessionId = `${setup.sessionId}-child`;
    const childRunId = `child-${randomUUID()}`;
    await runs.createPending({
      runId: childRunId, tenantId, sessionId: childSessionId, userId: 'user-a',
      metadata: { subagent: true, parentRunId: setup.dispatch.targetRunId, parentSessionId: setup.sessionId },
    });
    const childContext = {
      ...setup.context,
      sessionId: childSessionId,
      runId: childRunId,
      automationFence: deriveChildAutomationFence(
        setup.context.automationFence,
        childRunId,
        { sessionId: setup.sessionId, runId: setup.dispatch.targetRunId },
      ),
    } as RunContext;

    const attempt = await guard.beforeModel(childContext, 'turn:child', {
      model: childContext.model, inputTokens: 10, maxOutputTokens: 20,
    });
    expect(attempt).toBeDefined();
    const audit = await pool.query(
      `SELECT tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,
              invoking_session_id,invoking_run_id,idempotency_key,request_payload
         FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`,
      [attempt!.providerAttemptId],
    );
    expect(audit.rows[0]).toMatchObject({
      tenant_id: tenantId,
      session_id: setup.sessionId,
      automation_id: setup.automationId,
      incarnation_id: setup.incarnationId,
      generation: '1',
      execution_id: setup.dispatch.outboxId,
      run_id: setup.dispatch.targetRunId,
      invoking_session_id: childSessionId,
      invoking_run_id: childRunId,
      idempotency_key: `model:${setup.dispatch.outboxId}:${childSessionId.length}:${childSessionId}:${childRunId}:turn:child`,
      request_payload: expect.objectContaining({
        rootSessionId: setup.sessionId,
        rootRunId: setup.dispatch.targetRunId,
        invokingSessionId: childSessionId,
        invokingRunId: childRunId,
      }),
    });
    await guard.finishModel(childContext, attempt, { inputTokens: 10, outputTokens: 5 });

    await expect(guard.beforeModel({
      ...childContext,
      automationFence: { ...childContext.automationFence!, rootSessionId: `${setup.sessionId}-spoofed` },
    }, 'turn:spoof-root', { model: childContext.model, inputTokens: 10, maxOutputTokens: 20 }))
      .rejects.toMatchObject({ reason: 'automation_not_found' });
    await expect(guard.beforeModel({ ...childContext, tenantId: `${tenantId}-other` }, 'turn:cross-tenant', {
      model: childContext.model, inputTokens: 10, maxOutputTokens: 20,
    })).rejects.toMatchObject({ reason: 'automation_not_found' });
    await expect(guard.beforeModel({
      ...childContext,
      automationFence: { ...childContext.automationFence!, executionId: randomUUID() },
    }, 'turn:wrong-execution', { model: childContext.model, inputTokens: 10, maxOutputTokens: 20 }))
      .rejects.toMatchObject({ reason: 'execution_mismatch' });
  });

  it('the first settled reservation consumes the final turn atomically and budget expiry drains before terminal projection', async () => {
    const setup = await activeExecution({ maxTurns: 1 });
    const first = await guard.beforeModel(setup.context, 'turn:first', {model: setup.context.model, inputTokens: 10, maxOutputTokens: 20});
    expect(first).toBeDefined();
    await guard.finishModel(setup.context, first, { inputTokens: 10, outputTokens: 5 });
    expect((await pool.query(`SELECT state FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`, [first!.providerAttemptId])).rows[0].state).toBe('completed');
    await expect(guard.beforeModel(setup.context, 'turn:second', {model: setup.context.model, inputTokens: 10, maxOutputTokens: 20})).rejects.toBeInstanceOf(AutomationBudgetExceededError);
    const draining = await pool.query(
      `SELECT status,phase,desired_terminal_status,limit_hit_reason FROM ${store.tables.automations} WHERE tenant_id=$1 AND automation_id=$2`,
      [tenantId, setup.automationId],
    );
    expect(draining.rows[0]).toMatchObject({ status: 'completing', phase: 'draining', desired_terminal_status: 'expired', limit_hit_reason: 'max_turns' });
    const adapter = { execute: async (job: import('./sessionAutomationStore.js').SessionAutomationLifecycleJob) => {
      if (job.objectType === 'run') await runs.markStatus(job.objectId, 'cancelled', 'authoritative cancel adapter');
      const { attemptCount: _attemptCount, details: _details, ...fence } = job;
      return { ...fence, receiptKey: `max-turns:${job.workId}`, authority: 'runtime' as const, outcome: 'completed' as const,
        payload: job.objectType === 'provider_attempt' && job.action === 'reconcile' ? { providerState: 'cancelled' } : {} };
    } };
    await store.processLifecycleWork({ run: adapter, execution: adapter, evaluation: adapter, provider_attempt: adapter, interaction: adapter, background_resource: adapter, budget_reservation: adapter }, 50);
    const cancellation = (await store.claimCancellations(50)).find(item => item.automationId === setup.automationId);
    expect(cancellation).toBeDefined();
    await store.completeCancellation(cancellation!);
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'expired', phase: 'terminal' });
    const rows = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tables.budgetReservations} WHERE automation_id=$1`,
      [setup.automationId],
    );
    expect(rows.rows[0].count).toBe(4);
  });

  it('does not create a goal evaluation when a normal run ends without a durable completion nomination', async () => {
    const setup = await activeExecution();
    const projector = new SessionAutomationTerminalProjector(store, `goal-no-candidate-${randomUUID()}`);

    await projector.project({
      globalSequence: 1,
      tenantId,
      sessionId: setup.sessionId,
      runId: setup.dispatch.targetRunId,
      status: 'completed',
      summary: 'ordinary run finished',
      evidenceRefs: ['event:ordinary'],
      progressFingerprint: 'ordinary-run',
    });

    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tables.evaluations} WHERE execution_id=$1`,
      [setup.dispatch.outboxId],
    )).rows[0].count).toBe(0);
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ phase: 'waiting' });
    const continuation = await pool.query(
      `SELECT trigger_key FROM ${store.tables.wakeups} WHERE automation_id=$1 AND state='pending'`,
      [setup.automationId],
    );
    expect(continuation.rows).toHaveLength(1);
    expect(continuation.rows[0].trigger_key).toContain('no_checkpoint');
  });

  it('atomically supersedes continuation when the execution nominates a candidate', async () => {
    const setup=await activeExecution();
    await store.tx(client=>store.scheduleTx(client,{tenantId,sessionId:setup.sessionId,automationId:setup.automationId,
      incarnationId:setup.incarnationId,generation:1,specVersion:1,continuationEpoch:9,
      triggerKey:`goal:${setup.automationId}:g1:e9:from:${setup.dispatch.targetRunId}`,dueAt:new Date(),payload:{}}));
    const evidence=await appendSuccessfulShellEvidence(setup);
    const evaluator=new SessionAutomationEvaluator(store,{evaluate:vi.fn()} as unknown as GoalEvaluatorPort,()=>true);
    const nomination={tenantId,sessionId:setup.sessionId,automationId:setup.automationId,executionId:setup.dispatch.outboxId,runId:setup.dispatch.targetRunId,
      incarnationId:setup.incarnationId,generation:1,specVersion:1,summary:'done',evidenceRefs:[`event:${evidence.event.id}`]};
    await expect(Promise.all([evaluator.nominate(nomination),evaluator.nominate(nomination)])).resolves.toEqual([{queued:true},{queued:true}]);
    const active=await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.wakeups} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
      AND incarnation_id=$4 AND generation=1 AND spec_version=1 AND state IN ('pending','claimed')`,[tenantId,setup.sessionId,setup.automationId,setup.incarnationId]);
    expect(active.rows[0].count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.goalCompletionCandidates} WHERE execution_id=$1`,[setup.dispatch.outboxId])).rows[0].count).toBe(1);
  });

  it('creates a goal evaluation only after the current execution durably nominates frozen evidence', async () => {
    const setup = await activeExecution();
    const evaluate = vi.fn(async () => ({ decision: 'met' as const, reason: 'verified', confidence: 0.99 }));
    const evaluator = new SessionAutomationEvaluator(store, { evaluate } as unknown as GoalEvaluatorPort, () => true);
    const evidence = await appendSuccessfulShellEvidence(setup);
    await expect(evaluator.nominate({
      tenantId,
      sessionId: setup.sessionId,
      automationId: setup.automationId,
      executionId: setup.dispatch.outboxId,
      runId: setup.dispatch.targetRunId,
      incarnationId: setup.incarnationId,
      generation: 1,
      specVersion: 1,
      summary: 'candidate complete',
      evidenceRefs: [`event:${evidence.event.id}`],
    })).resolves.toEqual({ queued: true });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tables.evaluations} WHERE execution_id=$1`,
      [setup.dispatch.outboxId],
    )).rows[0].count).toBe(0);

    const projector = new SessionAutomationTerminalProjector(store, `goal-candidate-${randomUUID()}`);
    await projector.project({
      globalSequence: evidence.globalSequence + 1,
      tenantId,
      sessionId: setup.sessionId,
      runId: setup.dispatch.targetRunId,
      status: 'completed',
      summary: 'terminal summary must not replace nominated evidence',
      evidenceRefs: ['event:terminal'],
      progressFingerprint: 'candidate-run',
    });

    const projected = await pool.query(
      `SELECT evidence FROM ${store.tables.evaluations} WHERE execution_id=$1`,
      [setup.dispatch.outboxId],
    );
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0].evidence).toMatchObject({
      summary: 'candidate complete',
      evidenceManifest: { entries: [{ ref: `event:${evidence.event.id}`, kind: 'test', content: { toolName: 'Shell', resultExcerpt: 'command completed successfully', command: 'pnpm test', exitCode: 0 } }] },
      hardGates: { runTerminal: true },
    });
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ phase: 'evaluating' });
    expect(await evaluator.evaluatePending()).toBe(1);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ evidenceManifest: expect.objectContaining({ canonicalHash: expect.any(String) }) }),
    }));
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'completing', phase: 'draining' });
  });

  it('blocks completion when user input arrives after evidence freeze but before terminal projection', async () => {const setup=await activeExecution();const evidence=await appendSuccessfulShellEvidence(setup);const evaluate=vi.fn(async()=>({decision:'met' as const,reason:'done',confidence:0.99}));const evaluator=new SessionAutomationEvaluator(store,{evaluate} as unknown as GoalEvaluatorPort,()=>true);await expect(evaluator.nominate({tenantId,sessionId:setup.sessionId,automationId:setup.automationId,executionId:setup.dispatch.outboxId,runId:setup.dispatch.targetRunId,incarnationId:setup.incarnationId,generation:1,specVersion:1,summary:'done',evidenceRefs:[`event:${evidence.event.id}`]})).resolves.toEqual({queued:true});const userInput=await events.append({type:'user_message',runId:setup.dispatch.targetRunId,sessionId:setup.sessionId,content:'requirements changed'},{tenantId});const sequence=await pool.query(`SELECT global_sequence FROM ${prefix}_events WHERE tenant_id=$1 AND event_id=$2`,[tenantId,userInput.id]);const projector=new SessionAutomationTerminalProjector(store,`goal-user-input-${randomUUID()}`);await projector.project({globalSequence:Number(sequence.rows[0].global_sequence)+1,tenantId,sessionId:setup.sessionId,runId:setup.dispatch.targetRunId,status:'completed'});await expect(evaluator.evaluatePending()).resolves.toBe(1);expect(evaluate).not.toHaveBeenCalled();expect((await pool.query(`SELECT state,decision FROM ${store.tables.evaluations} WHERE execution_id=$1`,[setup.dispatch.outboxId])).rows[0]).toMatchObject({state:'blocked',decision:expect.objectContaining({reason:'hard_gate'})});});
  it('rejects fake and cross-session evidence refs before candidate persistence', async () => {
    const setup = await activeExecution();
    const other = await activeExecution();
    const cross = await events.append({ type: 'assistant_message', runId: other.dispatch.targetRunId,
      sessionId: other.sessionId, content: 'other session evidence' }, { tenantId });
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: vi.fn() } as unknown as GoalEvaluatorPort, () => true);
    const base = { tenantId, sessionId: setup.sessionId, automationId: setup.automationId,
      executionId: setup.dispatch.outboxId, runId: setup.dispatch.targetRunId, incarnationId: setup.incarnationId,
      generation: 1, specVersion: 1, summary: 'done' };
    await expect(evaluator.nominate({ ...base, evidenceRefs: ['fake'] })).resolves.toEqual({ queued: false, reason: 'evidence_ref_invalid_format' });
    await expect(evaluator.nominate({ ...base, evidenceRefs: [`event:${cross.id}`] })).resolves.toEqual({ queued: false, reason: 'evidence_ref_not_found' });
    expect((await pool.query(`SELECT count(*)::int n FROM ${store.tables.goalCompletionCandidates} WHERE execution_id=$1`, [setup.dispatch.outboxId])).rows[0].n).toBe(0);
  });

  it('rejects stale test evidence after a later host-recorded source edit', async () => {
    const setup = await activeExecution();
    const toolCallId = randomUUID();
    await events.append({ type: 'assistant_tool_calls', runId: setup.dispatch.targetRunId, sessionId: setup.sessionId,
      content: '', toolCalls: [{ id: toolCallId, name: 'Shell', arguments: JSON.stringify({ command: 'pnpm test' }) }] }, { tenantId });
    const testResult = await events.append({ type: 'tool_result', runId: setup.dispatch.targetRunId,
      sessionId: setup.sessionId, toolCallId, toolName: 'Shell', content: 'tests passed', metadata: { exitCode: 0 } }, { tenantId });
    const editCallId = randomUUID();
    await events.append({ type: 'assistant_tool_calls', runId: setup.dispatch.targetRunId, sessionId: setup.sessionId,
      content: '', toolCalls: [{ id: editCallId, name: 'Edit', arguments: '{}' }] }, { tenantId });
    await events.append({ type: 'tool_result', runId: setup.dispatch.targetRunId, sessionId: setup.sessionId,
      toolCallId: editCallId, toolName: 'Edit', content: 'edited' }, { tenantId });
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: vi.fn() } as unknown as GoalEvaluatorPort, () => true);
    await expect(evaluator.nominate({ tenantId, sessionId: setup.sessionId, automationId: setup.automationId,
      executionId: setup.dispatch.outboxId, runId: setup.dispatch.targetRunId, incarnationId: setup.incarnationId,
      generation: 1, specVersion: 1, summary: 'done', evidenceRefs: [`event:${testResult.id}`] }))
      .resolves.toEqual({ queued: false, reason: 'evidence_ref_stale' });
  });

  it('rejects direct database mutation of frozen candidate evidence', async () => {
    const setup = await activeExecution();
    const evidence = await appendSuccessfulShellEvidence(setup, 'pnpm build');
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: vi.fn() } as unknown as GoalEvaluatorPort, () => true);
    await expect(evaluator.nominate({ tenantId, sessionId: setup.sessionId, automationId: setup.automationId,
      executionId: setup.dispatch.outboxId, runId: setup.dispatch.targetRunId, incarnationId: setup.incarnationId,
      generation: 1, specVersion: 1, summary: 'done', evidenceRefs: [`event:${evidence.event.id}`] }))
      .resolves.toEqual({ queued: true });
    expect((await pool.query(`SELECT count(*)::int n FROM ${store.tables.goalCompletionCandidates}
      WHERE execution_id=$1`, [setup.dispatch.outboxId])).rows[0].n).toBe(1);
    await expect(pool.query(`UPDATE ${store.tables.goalCompletionCandidates}
      SET evidence_manifest=jsonb_set(evidence_manifest,'{entries,0,source,eventId}','\"tampered\"'::jsonb),
          evidence_manifest_hash='attacker-recomputed-hash'
      WHERE execution_id=$1`, [setup.dispatch.outboxId])).rejects.toThrow('immutable goal candidate evidence');
    const frozen = await pool.query(`SELECT evidence_manifest,evidence_manifest_hash
      FROM ${store.tables.goalCompletionCandidates} WHERE execution_id=$1`, [setup.dispatch.outboxId]);
    expect(frozen.rows[0].evidence_manifest.entries[0].source.eventId).toBe(evidence.event.id);
    expect(frozen.rows[0].evidence_manifest_hash).toBe(frozen.rows[0].evidence_manifest.canonicalHash);
  });

  it('a lease-expired evaluator admitted with the execution correlation key before a crash is frozen for explicit reconciliation', async () => {
    const setup = await activeExecution();
    const evaluationId = randomUUID();
    await closeExecutionAsProjected(setup);
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,lease_token,lease_expires_at)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'claimed',$8,now()-interval '1 second')`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'done', evidenceRefs: ['event:1'], hardGates: {} }), randomUUID()],
    );
    // Production terminal projection clears the active slot before evaluator admission.
    await pool.query(
      `UPDATE ${store.tables.automations} SET active_run_id=NULL,phase='evaluating'
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [tenantId, setup.sessionId, setup.automationId],
    );
    const attempt = await guard.beforeModel(setup.context, `goal-evaluation:${setup.dispatch.outboxId}`, {model: setup.context.model, inputTokens: 10, maxOutputTokens: 500, purpose: 'goal_evaluation'});
    const evaluate = vi.fn();
    const evaluator = new SessionAutomationEvaluator(store, { evaluate } as unknown as GoalEvaluatorPort, () => true);
    expect(await evaluator.reconcileUnknown()).toBe(1);
    expect((await pool.query(`SELECT state,provider_attempt_id FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0]).toMatchObject({
      state: 'result_unknown', provider_attempt_id: attempt!.providerAttemptId,
    });
    expect((await pool.query(`SELECT state FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`, [attempt!.providerAttemptId])).rows[0].state).toBe('result_unknown');
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'reconcile_required' });
    expect(await evaluator.evaluatePending()).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('finishModel crash recovery replays a persisted verdict without calling provider', async () => {
    const setup = await activeExecution();
    await closeExecutionAsProjected(setup);
    const evaluationId = randomUUID();
    const leaseToken = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,lease_token,lease_expires_at)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'claimed',$8,now()+interval '2 minutes')`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'done', evidenceRefs: ['event:completed-crash'], hardGates: {} }), leaseToken],
    );
    await pool.query(
      `UPDATE ${store.tables.automations} SET active_run_id=NULL,phase='evaluating'
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [tenantId, setup.sessionId, setup.automationId],
    );
    const attempt = await guard.beforeModel(setup.context, `goal-evaluation:${setup.dispatch.outboxId}`, {
      model: setup.context.model, inputTokens: 10, maxOutputTokens: 500, purpose: 'goal_evaluation',
    });
    await pool.query(
      `UPDATE ${store.tables.evaluations} SET provider_attempt_id=$2 WHERE evaluation_id=$1 AND lease_token=$3`,
      [evaluationId, attempt!.providerAttemptId, leaseToken],
    );
    // Crash point: finishModel committed provider completion and its parsed verdict, but evaluator CAS did not run.
    await guard.finishModel(setup.context, attempt, { inputTokens: 10, outputTokens: 5 }, undefined, {
      evaluation: { decision: 'continue', reason: 'more work remains', confidence: 0.95 },
    });
    await pool.query(
      `UPDATE ${store.tables.evaluations} SET lease_expires_at=now()-interval '1 second' WHERE evaluation_id=$1`,
      [evaluationId],
    );

    const provider = vi.fn();
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: provider } as unknown as GoalEvaluatorPort, () => true);
    expect(await evaluator.evaluatePending()).toBe(0);
    expect(provider).not.toHaveBeenCalled();
    expect((await pool.query(
      `SELECT state,decision FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId],
    )).rows[0]).toMatchObject({
      state: 'continue',
      decision: { decision: 'continue', reason: 'more work remains', confidence: 0.95 },
    });
    expect((await pool.query(
      `SELECT count(*)::int n FROM ${store.tables.providerAttempts} WHERE automation_id=$1`, [setup.automationId],
    )).rows[0].n).toBe(1);
    const successor=await pool.query(`SELECT continuation_epoch,trigger_key FROM ${store.tables.wakeups}
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4
        AND generation=1 AND spec_version=1 AND state IN ('pending','claimed')`,
    [tenantId,setup.sessionId,setup.automationId,setup.incarnationId]);
    expect(successor.rows).toHaveLength(1);
    expect(successor.rows[0].continuation_epoch).toBe('1');
    expect(successor.rows[0].trigger_key).toContain(`:evaluation:${evaluationId}`);
    expect(await evaluator.evaluatePending()).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.wakeups}
      WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,
    [tenantId,setup.automationId])).rows[0].count).toBe(1);
  });

  it('completed evaluator attempt without a durable verdict becomes explicitly unverifiable without replay', async () => {
    const setup = await activeExecution();
    await closeExecutionAsProjected(setup);
    const evaluationId = randomUUID();
    const leaseToken = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state,lease_token,lease_expires_at)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'claimed',$8,now()-interval '1 second')`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'done', evidenceRefs: ['event:missing-result'], hardGates: {} }), leaseToken],
    );
    await pool.query(
      `UPDATE ${store.tables.automations} SET active_run_id=NULL,phase='evaluating'
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [tenantId, setup.sessionId, setup.automationId],
    );
    const attempt = await guard.beforeModel(setup.context, `goal-evaluation:${setup.dispatch.outboxId}`, {
      model: setup.context.model, inputTokens: 10, maxOutputTokens: 500, purpose: 'goal_evaluation',
    });
    await pool.query(
      `UPDATE ${store.tables.evaluations} SET provider_attempt_id=$2 WHERE evaluation_id=$1`,
      [evaluationId, attempt!.providerAttemptId],
    );
    await guard.finishModel(setup.context, attempt, { inputTokens: 10, outputTokens: 5 });

    const provider = vi.fn();
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: provider } as unknown as GoalEvaluatorPort, () => true);
    expect(await evaluator.evaluatePending()).toBe(0);
    expect(provider).not.toHaveBeenCalled();
    expect((await pool.query(
      `SELECT state,decision FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId],
    )).rows[0]).toMatchObject({
      state: 'unverifiable',
      decision: { decision: 'unverifiable', reason: 'completed_attempt_result_unavailable', confidence: 0 },
    });
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({
      status: 'reconcile_required', lastError: 'completed_attempt_result_unavailable',
    });
  });

  it('claimed lease expiry is retryable but result_unknown never blind-replays', async () => {
    const setup = await activeExecution();
    await closeExecutionAsProjected(setup);
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
    const evaluator = new SessionAutomationEvaluator(store, { evaluate: vi.fn() } as unknown as GoalEvaluatorPort, () => true);
    expect(await evaluator.reconcileUnknown()).toBe(1);
    const states = await pool.query(
      `SELECT evaluation_id,state FROM ${store.tables.evaluations} WHERE evaluation_id=ANY($1::uuid[])`,
      [[claimedId, unknownId]],
    );
    expect(Object.fromEntries(states.rows.map(row => [row.evaluation_id, row.state]))).toEqual({
      [claimedId]: 'pending',
      [unknownId]: 'result_unknown',
    });
    await pool.query(
      `UPDATE ${store.tables.evaluations} SET state='unverifiable' WHERE evaluation_id=$1`,
      [claimedId],
    );
  });

  it('send failure after terminal projection remains receipt-reconcilable after active_run_id is cleared', async () => {
    const setup = await activeExecution();
    const evaluationId = randomUUID();
    await closeExecutionAsProjected(setup);
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'claimed')`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'unknown', evidenceRefs: ['event:1'], hardGates: {} })],
    );
    await pool.query(
      `UPDATE ${store.tables.automations} SET active_run_id=NULL,phase='evaluating'
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [tenantId, setup.sessionId, setup.automationId],
    );
    const attempt = await guard.beforeModel(setup.context, 'goal-evaluation:receipt-test', {model: setup.context.model, inputTokens: 10, maxOutputTokens: 500, purpose: 'goal_evaluation'});
    expect(attempt).toBeDefined();
    await pool.query(
      `UPDATE ${store.tables.evaluations} SET state='result_unknown',provider_attempt_id=$2 WHERE evaluation_id=$1`,
      [evaluationId, attempt!.providerAttemptId],
    );
    await guard.finishModel(setup.context, attempt, undefined, new Error('response lost'));
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({
      status: 'reconcile_required', activeRunId: undefined,
    });

    for (const observedState of ['still_running', 'ambiguous'] as const) {
      const current = await store.get(tenantId, setup.sessionId, setup.automationId);
      await store.tx(client => store.control(client, current!, 'reconcile', {
        providerAttemptId: attempt!.providerAttemptId,
        receiptKey: `receipt-${observedState}`,
        receiptAuthority: 'provider_adapter',
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
      receiptAuthority: 'operator' as const,
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
    const completedEvaluationId = randomUUID();
    await closeExecutionAsProjected(completedSetup);
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,state)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,'claimed')`,
      [completedEvaluationId, tenantId, completedSetup.sessionId, completedSetup.automationId, completedSetup.dispatch.outboxId,
        completedSetup.incarnationId, JSON.stringify({ summary: 'unknown', evidenceRefs: ['event:2'], hardGates: {} })],
    );
    await pool.query(
      `UPDATE ${store.tables.automations} SET active_run_id=NULL,phase='evaluating'
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [tenantId, completedSetup.sessionId, completedSetup.automationId],
    );
    const completedAttempt = await guard.beforeModel(completedSetup.context, 'goal-evaluation:completed-receipt', {model: completedSetup.context.model, inputTokens: 10, maxOutputTokens: 500, purpose: 'goal_evaluation'});
    expect(completedAttempt).toBeDefined();
    await pool.query(
      `UPDATE ${store.tables.evaluations} SET state='result_unknown',provider_attempt_id=$2 WHERE evaluation_id=$1`,
      [completedEvaluationId, completedAttempt!.providerAttemptId],
    );
    await guard.finishModel(completedSetup.context, completedAttempt, undefined, new Error('response lost'));
    expect(await store.get(tenantId, completedSetup.sessionId, completedSetup.automationId)).toMatchObject({
      status: 'reconcile_required', activeRunId: undefined,
    });
    const completedCurrent = await store.get(tenantId, completedSetup.sessionId, completedSetup.automationId);
    await store.tx(client => store.control(client, completedCurrent!, 'reconcile', {
      providerAttemptId: completedAttempt!.providerAttemptId,
      receiptKey: 'receipt-completed',
      receiptAuthority: 'provider_adapter',
      observedState: 'completed',
      receiptPayload: { rawResult: '{"decision":"met"}' },
    }));
    expect(await store.get(tenantId, completedSetup.sessionId, completedSetup.automationId)).toMatchObject({ status: 'blocked' });
    expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [completedEvaluationId])).rows[0].state).toBe('unverifiable');
  });

  it('blocked hard gate check-in resumes only after the durable resource is released', async () => {
    const setup = await activeExecution();
    const evidence = await appendSuccessfulShellEvidence(setup);
    const evaluate = vi.fn(async () => ({ decision: 'unverifiable' as const, reason: 'test', confidence: 1 }));
    const evaluator = new SessionAutomationEvaluator(store, { evaluate } as GoalEvaluatorPort, () => true);
    await expect(evaluator.nominate({
      tenantId, sessionId: setup.sessionId, automationId: setup.automationId,
      executionId: setup.dispatch.outboxId, runId: setup.dispatch.targetRunId,
      incarnationId: setup.incarnationId, generation: 1, specVersion: 1,
      summary: 'done', evidenceRefs: [`event:${evidence.event.id}`],
    })).resolves.toEqual({ queued: true });
    const projector = new SessionAutomationTerminalProjector(store, `blocked-hard-gate-${randomUUID()}`);
    await projector.project({
      globalSequence: evidence.globalSequence + 1,
      tenantId,
      sessionId: setup.sessionId,
      runId: setup.dispatch.targetRunId,
      status: 'completed',
      summary: 'done',
      progressFingerprint: 'blocked-hard-gate',
    });
    const projected = await pool.query(
      `SELECT evaluation_id,state FROM ${store.tables.evaluations} WHERE execution_id=$1`,
      [setup.dispatch.outboxId],
    );
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0].state).toBe('pending');
    const evaluationId = projected.rows[0].evaluation_id;
    const resourceId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.backgroundResources}
        (background_resource_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,resource_kind,resource_key,state)
       VALUES($1,$2,$3,$4,$5,1,$6,$7,'child_run',$8,'active')`,
      [resourceId, tenantId, setup.sessionId, setup.automationId, setup.incarnationId,
        setup.dispatch.outboxId, setup.dispatch.targetRunId, `child:${resourceId}`],
    );
    expect(await evaluator.evaluatePending()).toBe(1);
    expect(evaluate).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0].state).toBe('blocked');
    await pool.query(
      `UPDATE ${store.tables.backgroundResources} SET state='released' WHERE background_resource_id=$1`,
      [resourceId],
    );
    expect(await evaluator.evaluatePending()).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0].state).toBe('unverifiable');
    expect(await store.get(tenantId, setup.sessionId, setup.automationId)).toMatchObject({ status: 'blocked', phase: 'idle' });
  });
  it('does not claim or call the provider for a stale evaluator fence', async () => {
    const setup = await activeExecution();
    await closeExecutionAsProjected(setup);
    const evaluationId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence)
       VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7)`,
      [evaluationId, tenantId, setup.sessionId, setup.automationId, setup.dispatch.outboxId, setup.incarnationId,
        JSON.stringify({ summary: 'done', evidenceRefs: ['event:stale'], hardGates: {} })],
    );
    await pool.query(`UPDATE ${store.tables.automations} SET generation=2 WHERE tenant_id=$1 AND automation_id=$2`, [tenantId, setup.automationId]);
    const evaluate = vi.fn(async () => ({ decision: 'met' as const, reason: 'must-not-run', confidence: 1 }));
    const evaluator = new SessionAutomationEvaluator(store, { evaluate } as GoalEvaluatorPort, () => true);
    expect(await evaluator.evaluatePending()).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
    expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`, [evaluationId])).rows[0].state).toBe('pending');
    expect((await pool.query(`SELECT count(*)::int n FROM ${store.tables.providerAttempts} WHERE automation_id=$1`, [setup.automationId])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM ${store.tables.budgetReservations} WHERE automation_id=$1`, [setup.automationId])).rows[0].n).toBe(0);
  });

});
