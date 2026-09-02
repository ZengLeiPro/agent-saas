import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgEventStore } from './pgEventStore.js';
import { PgRunStore } from './runStore.js';
import {
  SessionAutomationCoordinator,
  SessionAutomationProcessCrash,
  type AutomationRunDispatcher,
} from './sessionAutomationCoordinator.js';
import { SessionAutomationEvaluator, type GoalEvaluatorPort } from './sessionAutomationEvaluator.js';
import {
  PgSessionAutomationStore,
  type SessionAutomationLifecycleAdapters,
  type SessionAutomationLifecycleJob,
  type SessionAutomationLifecycleReceipt,
} from './sessionAutomationStore.js';
import { SessionAutomationTerminalProjector } from './sessionAutomationTerminalProjector.js';

const { Pool } = pg;
const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

describePg('session automation staged dispatch crash recovery on PostgreSQL', () => {
  const prefix = `automation_staged_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const tenantId = 'tenant-staged-recovery';
  let pool: InstanceType<typeof Pool>;
  let events: PgEventStore;
  let runs: PgRunStore;
  let store: PgSessionAutomationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 8 });
    events = new PgEventStore({ connectionString: url!, tablePrefix: prefix, poolMax: 3 });
    await events.init();
    runs = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    await runs.init();
    store = new PgSessionAutomationStore(pool, prefix, runs.runsTable);
    await store.init();
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '${prefix}_%'
      LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE',r.tablename); END LOOP;
    END $$`);
    await runs.init();
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

  async function stageThenCrash() {
    const automationId = randomUUID();
    const incarnationId = randomUUID();
    const sessionId = `session-staged-${randomUUID()}`;
    const spec = { kind: 'goal' as const, mode: 'goal' as const, prompt: 'continue', condition: 'done', budget: {} };
    await pool.query(`INSERT INTO ${store.tables.automations}
      (automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version)
      VALUES($1,$2,$3,'user-a',$4,'goal','goal','active','waiting',1,1,1,1)`,
    [automationId,tenantId,sessionId,incarnationId]);
    await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec)
      VALUES($1,$2,$3,1,$4,$5)`,[automationId,tenantId,sessionId,randomUUID(),JSON.stringify(spec)]);
    await pool.query(`INSERT INTO ${store.tables.completionAllowances}(automation_id,tenant_id,session_id,remaining_attempts,max_output_tokens) VALUES($1,$2,$3,2,500)`,[automationId,tenantId,sessionId]);
    await store.tx(client=>store.scheduleTx(client,{tenantId,sessionId,automationId,incarnationId,generation:1,specVersion:1,continuationEpoch:1,triggerKey:`initial:${automationId}`,dueAt:new Date(0),payload:{}}));

    const stage = vi.fn<AutomationRunDispatcher['stage']>(async input => {
      await runs.createPending({
        runId: input.runId, tenantId: input.tenantId, sessionId: input.sessionId, userId: 'user-a',
        idempotencyKey: `session-automation:${input.runId}`,
        metadata: { schedulerState: 'staged', automationFence: input.metadata },
      });
      throw new SessionAutomationProcessCrash('fault injection: crash after durable stage');
    });
    const onError = vi.fn();
    const coordinator = new SessionAutomationCoordinator(store, { stage, activate: vi.fn() }, { executionEnabled: () => true, onError });
    await coordinator.tick();

    const rows = await pool.query(`SELECT
      (SELECT state FROM ${store.tables.preparedDispatchAttempts} WHERE automation_id=$1) attempt,
      (SELECT state FROM ${store.tables.outbox} WHERE automation_id=$1) outbox,
      (SELECT state FROM ${store.tables.executions} WHERE automation_id=$1) execution,
      (SELECT target_run_id FROM ${store.tables.outbox} WHERE automation_id=$1) run_id,
      (SELECT wakeup_id FROM ${store.tables.outbox} WHERE automation_id=$1) wakeup_id,
      (SELECT active_run_id FROM ${store.tables.automations} WHERE automation_id=$1) active_run_id,
      (SELECT metadata->>'schedulerState' FROM ${runs.runsTable} WHERE run_id=(SELECT target_run_id FROM ${store.tables.outbox} WHERE automation_id=$1)) scheduler_state`,[automationId]);
    expect(stage).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(SessionAutomationProcessCrash));
    expect(rows.rows[0]).toMatchObject({attempt:'prepared',outbox:'dispatching',execution:'prepared',active_run_id:null,scheduler_state:'staged'});
    return {automationId,incarnationId,sessionId,spec,runId:String(rows.rows[0].run_id),wakeupId:String(rows.rows[0].wakeup_id),outboxId:(await store.listRecoverablePreparedDispatches()).find(row=>row.automationId===automationId)!.outboxId};
  }

  function completedReceipt(job: SessionAutomationLifecycleJob): SessionAutomationLifecycleReceipt {
    const { attemptCount: _attemptCount, details: _details, ...fence } = job;
    return { ...fence, receiptKey: `test:${job.workId}:${job.attemptCount}`, authority: 'runtime', outcome: 'completed', payload: {} };
  }

  function recoveryAdapters(): { adapters: SessionAutomationLifecycleAdapters; execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn(async (job: SessionAutomationLifecycleJob) => {
      if (job.objectType === 'run') await runs.markStatus(job.objectId, 'cancelled', 'staged crash lifecycle closure');
      return completedReceipt(job);
    });
    return { adapters: { run: { execute }, execution: { execute }, outbox: { execute } }, execute };
  }

  async function converge(setup: Awaited<ReturnType<typeof stageThenCrash>>) {
    const { adapters, execute } = recoveryAdapters();
    const cancelRun = vi.fn()
      .mockRejectedValueOnce(new Error('fault injection: cancellation adapter restart'))
      .mockImplementation(async (runId: string) => { await runs.markStatus(runId, 'cancelled', 'staged crash cancellation closure'); });
    const recovery = new SessionAutomationCoordinator(store, { stage: vi.fn(), activate: vi.fn() }, {
      executionEnabled: () => false, cancelRun, lifecycleAdapters: adapters,
    });
    await recovery.tick();
    expect(execute).toHaveBeenCalled();
    await pool.query(`UPDATE ${store.tables.cancellations} SET next_attempt_at=now() WHERE automation_id=$1 AND state='pending'`,[setup.automationId]);
    await recovery.tick();
    expect(cancelRun).toHaveBeenCalledTimes(2);
  }

  async function assertClosed(setup: Awaited<ReturnType<typeof stageThenCrash>>) {
    const closed=await pool.query(`SELECT
      (SELECT state FROM ${store.tables.outbox} WHERE outbox_id=$1) outbox,
      (SELECT state FROM ${store.tables.preparedDispatchAttempts} WHERE outbox_id=$1) attempt,
      (SELECT state FROM ${store.tables.executions} WHERE execution_id=$1) execution,
      (SELECT state FROM ${store.tables.wakeups} WHERE wakeup_id=$2) wakeup,
      (SELECT metadata->>'schedulerState' FROM ${runs.runsTable} WHERE tenant_id=$3 AND run_id=$4) scheduler_state,
      (SELECT status FROM ${runs.runsTable} WHERE tenant_id=$3 AND run_id=$4) run_status,
      (SELECT count(*)::int FROM ${store.tables.lifecycleWork} WHERE tenant_id=$3 AND automation_id=$5 AND state<>'completed') open_work`,
    [setup.outboxId,setup.wakeupId,tenantId,setup.runId,setup.automationId]);
    expect(closed.rows[0]).toMatchObject({outbox:'cancelled',attempt:'cancelled',execution:'terminal',wakeup:'superseded',scheduler_state:'staged',run_status:'cancelled',open_work:0});
  }

  it('stage success/crash-before-dispatched + replace closes old lineage and releases evaluator/new dispatch fences', async () => {
    const setup=await stageThenCrash();
    const before=await store.get(tenantId,setup.sessionId,setup.automationId);
    const replacement=await store.tx(client=>store.replace(client,before!,{...setup.spec,prompt:'replacement'}));
    expect(replacement).toMatchObject({status:'active',generation:2,activeRunId:undefined});
    expect(await store.claimDue(20)).toBe(0);

    const evaluator=new SessionAutomationEvaluator(store,{evaluate:vi.fn()} as unknown as GoalEvaluatorPort,()=>true);
    const resolve=(evaluator as unknown as {resolveHardGates(client:typeof pool,input:{tenantId:string;sessionId:string;automationId:string;executionId:string;runId:string}):Promise<{noActiveResources:boolean}>}).resolveHardGates.bind(evaluator);
    const gateInput={tenantId,sessionId:setup.sessionId,automationId:setup.automationId,executionId:setup.outboxId,runId:'replacement-evaluator'};
    expect((await resolve(pool,gateInput)).noActiveResources).toBe(false);

    await converge(setup);
    await assertClosed(setup);
    expect((await resolve(pool,gateInput)).noActiveResources).toBe(true);
    expect(await store.get(tenantId,setup.sessionId,setup.automationId)).toMatchObject({status:'active',generation:2,activeRunId:undefined});
    expect(await store.claimDue(20)).toBe(1);

    const projector=new SessionAutomationTerminalProjector(store,`late-old-${randomUUID()}`);
    const late={globalSequence:1,tenantId,sessionId:setup.sessionId,runId:setup.runId,status:'completed' as const,summary:'late old terminal',progressFingerprint:'late-old'};
    await projector.project(late);
    await projector.project(late);
    expect(await store.get(tenantId,setup.sessionId,setup.automationId)).toMatchObject({status:'active',generation:2,activeRunId:undefined});
  });

  it('stage success/crash-before-dispatched + clear reaches complete terminal closure and ignores late terminal replay', async () => {
    const setup=await stageThenCrash();
    const current=await store.get(tenantId,setup.sessionId,setup.automationId);
    const draining=await store.tx(client=>store.control(client,current!,'clear'));
    expect(draining).toMatchObject({status:'cancelling',phase:'draining',activeRunId:undefined});

    await converge(setup);
    await assertClosed(setup);
    expect(await store.get(tenantId,setup.sessionId,setup.automationId)).toMatchObject({status:'cancelled',phase:'terminal',activeRunId:undefined});

    const projector=new SessionAutomationTerminalProjector(store,`late-clear-${randomUUID()}`);
    const late={globalSequence:1,tenantId,sessionId:setup.sessionId,runId:setup.runId,status:'completed' as const,summary:'late clear terminal',progressFingerprint:'late-clear'};
    await projector.project(late);
    await projector.project(late);
    expect(await store.get(tenantId,setup.sessionId,setup.automationId)).toMatchObject({status:'cancelled',phase:'terminal',activeRunId:undefined});
  });
});
