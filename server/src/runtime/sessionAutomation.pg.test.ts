import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { PgEventStore } from './pgEventStore.js';
import { PgRunStore } from './runStore.js';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';
import { PgSessionAutomationAttributionStore } from './sessionAutomationAttribution.js';
import { SessionAutomationTerminalProjector } from './sessionAutomationTerminalProjector.js';
import { SessionAutomationToolProvider } from '../agent/tools/sessionAutomationTools.js';
const {Pool}=pg;
const url=process.env.TEST_DATABASE_URL;
const describePg=url?describe:describe.skip; // Real PostgreSQL backs concurrency, migration, and crash tests.

describePg('session automation real PostgreSQL integration',()=>{
 const prefix=`automation_${randomUUID().replaceAll('-','').slice(0,12)}`;let pool:InstanceType<typeof Pool>;let events:PgEventStore;let runs:PgRunStore;let store:PgSessionAutomationStore;const tenant='tenant-a',session='session-a',automation=randomUUID(),incarnation=randomUUID();
 beforeAll(async()=>{pool=new Pool({connectionString:url!,max:8});events=new PgEventStore({connectionString:url!,tablePrefix:prefix,poolMax:4});await events.init();runs=new PgRunStore({pool,tablePrefix:prefix});await runs.init();store=new PgSessionAutomationStore(pool,prefix,runs.runsTable);await store.init();await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','active',1,1,1,1)`,[automation,tenant,session,incarnation]);await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'digest',$4)`,[automation,tenant,session,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'continue',budget:{}})]);},30_000);
 afterAll(async()=>{if(!pool)return;await events.close();await pool.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '${prefix}_%' LOOP EXECUTE format('DROP TABLE IF EXISTS %I CASCADE',r.tablename); END LOOP; END $$`).catch(()=>undefined);await pool.end();},30_000);
 async function wake(key:string,generation=1){const current=await pool.query(`SELECT continuation_epoch FROM ${store.tables.automations} WHERE automation_id=$1`,[automation]);await store.tx(c=>store.scheduleTx(c,{tenantId:tenant,sessionId:session,automationId:automation,incarnationId:incarnation,generation,specVersion:1,continuationEpoch:Number(current.rows[0].continuation_epoch),triggerKey:key,dueAt:new Date(0),payload:{}}));}
 it('multi-worker claims exactly once and crash lease is recovered',async()=>{await wake('multi');await Promise.all([store.claimDue(10,10),store.claimDue(10,10)]);const [a,b]=await Promise.all([store.claimDispatch(10,10),store.claimDispatch(10,10)]);expect([...a,...b]).toHaveLength(1);await new Promise(r=>setTimeout(r,20));await store.recoverLeases();expect(await store.claimDispatch(10,1000)).toHaveLength(1);});
 it('cancel/generation fence prevents stale dispatch',async()=>{await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);await wake('old-generation');await store.claimDue();await pool.query(`UPDATE ${store.tables.automations} SET generation=2,status='cancelled' WHERE automation_id=$1`,[automation]);expect(await store.claimDispatch()).toEqual([]);});
 it('tool visibility requires matching host fence',()=>{const provider=new SessionAutomationToolProvider({} as never);expect(provider.list()).toEqual([]);const base={channelContext:{channel:'web'},workspace:{root:'.',executionTarget:'server-local'},sessionId:session,runId:'run-a'} as any;expect(provider.list(base)).toEqual([]);expect(provider.list({...base,automationFence:{automationId:automation,incarnationId:incarnation,generation:2,specVersion:1,executionId:'e',runId:'run-a'}}).map(t=>t.id)).toEqual(['ScheduleWakeup','UpdateGoal']);});
 it('terminal recovery scan advances durable cursor and survives restart',async()=>{await pool.query(`UPDATE ${store.tables.automations} SET generation=3,status='active',mode='adaptive',active_run_id=NULL WHERE automation_id=$1`,[automation]);await wake('terminal',3);await store.claimDue();const [dispatch]=await store.claimDispatch();await runs.createPending({runId:dispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});await store.markDispatched(dispatch!);await events.append({type:'run_finished',runId:dispatch!.targetRunId,sessionId:session,subtype:'success',numTurns:1},{tenantId:tenant});const first=new SessionAutomationTerminalProjector(store);expect(await first.recover(events)).toBeGreaterThan(0);const cursor=await first.cursor();const second=new SessionAutomationTerminalProjector(store);expect(await second.recover(events)).toBe(0);expect(await second.cursor()).toBe(cursor);const execution=await pool.query(`SELECT state,terminal_status FROM ${store.tables.executions} WHERE run_id=$1`,[dispatch!.targetRunId]);expect(execution.rows[0]).toMatchObject({state:'terminal',terminal_status:'completed'});});
 it('pause keeps the active run alive and stale-generation terminal still releases the one-live slot',async()=>{await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);await pool.query(`UPDATE ${store.tables.automations} SET generation=10,status='active',mode='adaptive',phase='idle',active_run_id=NULL WHERE automation_id=$1`,[automation]);await wake('pause-running',10);await store.claimDue();const [dispatch]=await store.claimDispatch();await runs.createPending({runId:dispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});await store.markDispatched(dispatch!);await store.tx(async c=>{const current=await store.getLocked(c,tenant,session,automation);await store.control(c,current!,'pause');});expect((await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.cancellations} WHERE run_id=$1`,[dispatch!.targetRunId])).rows[0].count).toBe(0);await events.append({type:'run_finished',runId:dispatch!.targetRunId,sessionId:session,subtype:'success',numTurns:2},{tenantId:tenant});await new SessionAutomationTerminalProjector(store,'pause-terminal-test').recover(events);const snapshot=await store.get(tenant,session,automation);expect(snapshot).toMatchObject({status:'paused',phase:'idle'});expect(snapshot?.activeRunId).toBeUndefined();});
 it('clear writes a durable cancellation intent and converges after a retry',async()=>{const runId=randomUUID();await runs.createPending({runId,sessionId:session,tenantId:tenant,userId:'user-a'});await pool.query(`UPDATE ${store.tables.automations} SET generation=20,status='active',phase='running',active_run_id=$2 WHERE automation_id=$1`,[automation,runId]);await store.tx(async c=>{const current=await store.getLocked(c,tenant,session,automation);await store.control(c,current!,'clear');});let [item]=await store.claimCancellations();expect(item?.runId).toBe(runId);await store.failCancellation(item!,new Error('transient'));await pool.query(`UPDATE ${store.tables.cancellations} SET next_attempt_at=now() WHERE run_id=$1`,[runId]);[item]=await store.claimCancellations();await store.completeCancellation(item!);await runs.markStatus(runId,'cancelled','test cleanup');expect(await store.get(tenant,session,automation)).toMatchObject({status:'cancelled',phase:'terminal'});});
 it('the first budget limit wins and prevents another dispatch',async()=>{await pool.query(`UPDATE ${store.tables.specs} SET spec=$2 WHERE automation_id=$1 AND spec_version=1`,[automation,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'continue',budget:{maxRuns:1}})]);await pool.query(`UPDATE ${store.tables.automations} SET generation=30,status='active',phase='idle',active_run_id=NULL,run_count=1,limit_hit_reason=NULL,limit_hit_at=NULL WHERE automation_id=$1`,[automation]);await wake('budget-stop',30);expect(await store.claimDue()).toBe(0);const result=await pool.query(`SELECT status,limit_hit_reason,limit_hit_at FROM ${store.tables.automations} WHERE automation_id=$1`,[automation]);expect(result.rows[0]).toMatchObject({status:'expired',limit_hit_reason:'max_runs'});expect(result.rows[0].limit_hit_at).toBeTruthy();});

 it('replace drains the active run before the new generation can claim',async()=>{
  const oldRun=randomUUID();
  await runs.createPending({runId:oldRun,sessionId:session,tenantId:tenant,userId:'user-a'});
  await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);
  await pool.query(`UPDATE ${store.tables.automations} SET generation=40,spec_version=1,status='active',phase='running',active_run_id=$2,run_count=0,limit_hit_reason=NULL,limit_hit_at=NULL,next_wakeup_at=NULL WHERE automation_id=$1`,[automation,oldRun]);
  const current=await store.get(tenant,session,automation);
  const replaced=await store.tx(c=>store.replace(c,current!,{kind:'loop',mode:'adaptive',prompt:'replacement',budget:{}}));
  expect(replaced).toMatchObject({status:'active',phase:'running',generation:41,activeRunId:oldRun});
  expect(await store.claimDue()).toBe(0);
  const [cancel]=await store.claimCancellations();
  expect(cancel?.runId).toBe(oldRun);
  await store.completeCancellation(cancel!);
  await runs.markStatus(oldRun,'cancelled','test cleanup');
  expect(await store.get(tenant,session,automation)).toMatchObject({status:'active',phase:'waiting',generation:41});
  expect(await store.claimDue()).toBe(1);
 });

 it('markDispatched atomically loses when another active run occupies the slot',async()=>{
  const [dispatch]=await store.claimDispatch();
  expect(dispatch).toBeTruthy();
  const blocker=randomUUID();
  await runs.createPending({runId:blocker,sessionId:session,tenantId:tenant,userId:'user-a'});
  await pool.query(`UPDATE ${store.tables.automations} SET active_run_id=$2,phase='running' WHERE automation_id=$1`,[automation,blocker]);
  await expect(store.markDispatched(dispatch!)).rejects.toThrow('dispatch fence lost');
  const outbox=await pool.query(`SELECT state FROM ${store.tables.outbox} WHERE outbox_id=$1`,[dispatch!.outboxId]);
  expect(outbox.rows[0]?.state).toBe('dispatching');
  await pool.query(`UPDATE ${store.tables.outbox} SET state='dead' WHERE outbox_id=$1`,[dispatch!.outboxId]);
  await runs.markStatus(blocker,'failed','test cleanup');
  await pool.query(`UPDATE ${store.tables.automations} SET active_run_id=NULL,phase='idle' WHERE automation_id=$1`,[automation]);
 });

 it('resume fences its queued generation until durable cancellation completes',async()=>{
  await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);
  await pool.query(`UPDATE ${store.tables.automations} SET generation=50,status='active',phase='idle',active_run_id=NULL,next_wakeup_at=NULL WHERE automation_id=$1`,[automation]);
  await wake('resume-drain-old',50);
  expect(await store.claimDue()).toBe(1);
  const [dispatch]=await store.claimDispatch();
  expect(dispatch).toBeTruthy();
  await runs.createPending({runId:dispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});
  await store.markDispatched(dispatch!);
  await store.tx(async c=>{const live=await store.getLocked(c,tenant,session,automation);await store.control(c,live!,'pause');});
  const paused=await store.get(tenant,session,automation);
  await store.tx(c=>store.control(c,paused!,'resume'));
  expect(await store.claimDue()).toBe(0);
  await events.append({type:'run_finished',runId:dispatch!.targetRunId,sessionId:session,subtype:'success',numTurns:1},{tenantId:tenant});
  await runs.markStatus(dispatch!.targetRunId,'completed','test terminal event');
  await new SessionAutomationTerminalProjector(store,`resume-drain-${randomUUID()}`).recover(events);
  expect(await store.claimDue()).toBe(0);
  const [cancel]=await store.claimCancellations();
  expect(cancel?.runId).toBe(dispatch!.targetRunId);
  await store.completeCancellation(cancel!);
  expect(await store.get(tenant,session,automation)).toMatchObject({status:'active',phase:'waiting',generation:52});
  expect((await store.get(tenant,session,automation))?.activeRunId).toBeUndefined();
  expect(await store.claimDue()).toBe(1);
 });

 it('a stale cancellation lease cannot clear the active run after a crash/reclaim',async()=>{
  const runId=randomUUID();
  await runs.createPending({runId,sessionId:session,tenantId:tenant,userId:'user-a'});
  await pool.query(`UPDATE ${store.tables.automations} SET generation=60,status='active',phase='running',active_run_id=$2 WHERE automation_id=$1`,[automation,runId]);
  await store.tx(async c=>{const live=await store.getLocked(c,tenant,session,automation);await store.control(c,live!,'clear');});
  const [first]=await store.claimCancellations(1,1);
  await pool.query(`UPDATE ${store.tables.cancellations} SET lease_expires_at=now()-interval '1 second',next_attempt_at=now() WHERE cancellation_id=$1`,[first!.cancellationId]);
  const [second]=await store.claimCancellations();
  await store.completeCancellation(first!);
  expect((await store.get(tenant,session,automation))?.activeRunId).toBe(runId);
  await store.completeCancellation(second!);
  expect(await store.get(tenant,session,automation)).toMatchObject({status:'cancelled',phase:'terminal'});
 });
 it('durable attribution constraints and crash transitions fail closed',async()=>{
  const automationId=randomUUID(),incarnationId=randomUUID(),runId=randomUUID(),wakeupId=randomUUID(),outboxId=randomUUID(),executionId=randomUUID();
  await runs.createPending({runId,sessionId:session,tenantId:tenant,userId:'user-a'});
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','completed',1,1,1,1)`,[automationId,tenant,session,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at,state) VALUES($1,$2,$3,$4,$5,1,1,0,'ledger',now(),'consumed')`,[wakeupId,tenant,session,automationId,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,1,1,0,'ledger',$7,'{}','completed')`,[outboxId,wakeupId,tenant,session,automationId,incarnationId,runId]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,'terminal')`,[executionId,tenant,session,automationId,incarnationId,outboxId,runId]);
  const ledger=new PgSessionAutomationAttributionStore(pool,prefix);const lineage={tenantId:tenant,sessionId:session,automationId,incarnationId,generation:1,executionId,runId};
  const preparedDispatchAttemptId=await ledger.prepareDispatch({...lineage,outboxId,idempotencyKey:'dispatch-key',requestPayload:{prompt:'x'}});
  await ledger.prepareProviderAttempt({...lineage,preparedDispatchAttemptId,provider:'test',operation:'run',idempotencyKey:'provider-key',requestPayload:{prompt:'x'}});
  const [crashed]=await ledger.claimProviderAttempts(['prepared'],1,0.01);expect(crashed).toBeTruthy();await new Promise(resolve=>setTimeout(resolve,20));
  const [recovered]=await ledger.claimProviderAttempts(['prepared'],1,30);expect(recovered?.providerAttemptId).toBe(crashed?.providerAttemptId);
  await expect(ledger.transitionProviderAttempt(crashed!,'dispatched')).rejects.toMatchObject({code:'stale_claim'});
  await ledger.transitionProviderAttempt(recovered!,'dispatched',{providerRequestId:'provider-request'});
  const [dispatched]=await ledger.claimProviderAttempts(['dispatched']);await ledger.transitionProviderAttempt(dispatched!,'result_unknown',{lastError:'worker_crash_after_send'});
  const [unknown]=await ledger.claimProviderAttempts(['result_unknown']);await ledger.transitionProviderAttempt(unknown!,'reconcile');
  const [reconcile]=await ledger.claimProviderAttempts(['reconcile']);await ledger.reconcileProviderAttempt(reconcile!,{receiptKey:'receipt-key',observedState:'completed',receiptPayload:{providerRequestId:'provider-request'},nextState:'completed'});
  const row=await pool.query(`SELECT state,version,lease_token FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`,[reconcile!.providerAttemptId]);expect(row.rows[0]).toMatchObject({state:'completed',version:'5',lease_token:null});
  expect((await pool.query(`SELECT count(*)::int count FROM ${store.tables.reconciliationReceipts} WHERE provider_attempt_id=$1`,[reconcile!.providerAttemptId])).rows[0].count).toBe(1);
  const constraints=await pool.query(`SELECT count(*)::int count FROM pg_constraint WHERE conrelid=$1::regclass AND condeferrable`,[store.tables.providerAttempts]);expect(constraints.rows[0].count).toBeGreaterThanOrEqual(2);
  await expect(pool.query(`INSERT INTO ${store.tables.interactions}(interaction_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,interaction_key,interaction_kind,request_payload) VALUES($1,$2,$3,$4,$5,99,$6,$7,'bad-lineage','tool','{}')`,[randomUUID(),tenant,session,automationId,incarnationId,executionId,runId])).rejects.toMatchObject({code:'23503'});
 });

});
