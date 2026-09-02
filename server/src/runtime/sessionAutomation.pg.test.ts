import { randomUUID } from 'node:crypto'; // isolated real-PG fixture identities
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgEventStore } from './pgEventStore.js';
import { PgRunStore } from './runStore.js';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';
import type { AutomationInFlightSummary } from './sessionAutomationInFlight.js';
import { parseWholeNumeric, SessionAutomationRuntimeGuard } from './sessionAutomationRuntimeGuard.js';
import { createLifecycleAdapters } from '../app/sessionAutomationRuntime.js';
import { PgSessionAutomationAttributionStore } from './sessionAutomationAttribution.js';
import { SessionAutomationTerminalProjector } from './sessionAutomationTerminalProjector.js';
import { SessionAutomationToolProvider, SessionAutomationTools } from '../agent/tools/sessionAutomationTools.js';
const {Pool}=pg;
const url=process.env.TEST_DATABASE_URL;
const describePg=url?describe:describe.skip; // Real PostgreSQL is required for concurrency, migration, and crash tests.

describePg('session automation real PostgreSQL integration',()=>{
 const prefix=`automation_${randomUUID().replaceAll('-','').slice(0,12)}`;let pool:InstanceType<typeof Pool>;let events:PgEventStore;let runs:PgRunStore;let store:PgSessionAutomationStore;const tenant='tenant-a',session='session-a',automation=randomUUID(),incarnation=randomUUID();
 beforeAll(async()=>{pool=new Pool({connectionString:url!,max:8});events=new PgEventStore({connectionString:url!,tablePrefix:prefix,poolMax:4});await events.init();runs=new PgRunStore({pool,tablePrefix:prefix,writerCapability:{capability:'tenant-native-v1',allowPrivilegedRoleForTests:true}});await runs.init();store=new PgSessionAutomationStore(pool,prefix,runs.runsTable);await store.init();},30_000);
 beforeEach(async()=>{
  await pool.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '${prefix}_%' LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE',r.tablename); END LOOP; END $$`);
  await runs.init();
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','active',1,1,1,1)`,[automation,tenant,session,incarnation]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'digest',$4)`,[automation,tenant,session,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'continue',budget:{}})]);
 });
 afterAll(async()=>{if(!pool)return;await events.close();await pool.query(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '${prefix}_%' LOOP EXECUTE format('DROP TABLE IF EXISTS %I CASCADE',r.tablename); END LOOP; END $$`).catch(()=>undefined);await pool.end();},30_000);

 async function schedule(automationId:string,sessionId:string,key:string,dueAt:Date,generation:number){const current=await pool.query(`SELECT incarnation_id,continuation_epoch FROM ${store.tables.automations} WHERE automation_id=$1`,[automationId]);await store.tx(c=>store.scheduleTx(c,{tenantId:tenant,sessionId,automationId,incarnationId:String(current.rows[0].incarnation_id),generation,specVersion:1,continuationEpoch:Number(current.rows[0].continuation_epoch),triggerKey:key,dueAt,payload:{}}));}
 async function wake(key:string,generation=1){await schedule(automation,session,key,new Date(0),generation);}
 it('multi-worker claims exactly once and crash lease is recovered',async()=>{await wake('multi');await Promise.all([store.claimDue(10,10),store.claimDue(10,10)]);const [a,b]=await Promise.all([store.claimDispatch(10,10),store.claimDispatch(10,10)]);expect([...a,...b]).toHaveLength(1);await new Promise(r=>setTimeout(r,20));await store.recoverLeases();expect(await store.claimDispatch(10,1000)).toHaveLength(1);});
 it('claimDue coalesces double-due generations and keeps producing around an existing open dispatch',async()=>{
  await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);
  await pool.query(`UPDATE ${store.tables.automations} SET generation=3,status='active',phase='idle',active_run_id=NULL,run_count=0,limit_hit_reason=NULL,limit_hit_at=NULL WHERE automation_id=$1`,[automation]);
  const otherAutomation=randomUUID(),otherIncarnation=randomUUID(),otherSession=`session-${randomUUID()}`;
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','active',1,1,1,1)`,[otherAutomation,tenant,otherSession,otherIncarnation]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'digest',$4)`,[otherAutomation,tenant,otherSession,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'continue',budget:{}})]);
  await schedule(automation,session,'double-due-late',new Date(1),3);
  await schedule(automation,session,'double-due-early',new Date(0),3);
  await schedule(otherAutomation,otherSession,'other-first',new Date(0),1);

  expect(await store.claimDue(10)).toBe(2); // one coalesced winner per automation; the batch does not roll back
  const first=await pool.query(`SELECT trigger_key FROM ${store.tables.outbox} WHERE automation_id=$1 AND generation=3 AND state='pending'`,[automation]);
  expect(first.rows).toEqual([{trigger_key:'double-due-early'}]);
  expect((await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.wakeups} WHERE automation_id=$1 AND generation=3 AND state='pending'`,[automation])).rows[0].count).toBe(1);

  await pool.query(`UPDATE ${store.tables.outbox} SET state='dead' WHERE automation_id=$1`,[otherAutomation]);
  const [firstDispatch]=await store.claimDispatch();
  expect(firstDispatch?.automationId).toBe(automation);
  await runs.createPending({runId:firstDispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});
  await store.markDispatched(firstDispatch!);
  await events.append({type:'run_finished',runId:firstDispatch!.targetRunId,sessionId:session,subtype:'success',numTurns:1},{tenantId:tenant});
  await new SessionAutomationTerminalProjector(store,`claim-due-${randomUUID()}`).recover(events);
  expect((await pool.query(`SELECT state FROM ${store.tables.outbox} WHERE outbox_id=$1`,[firstDispatch!.outboxId])).rows[0]?.state).toBe('completed');

  await schedule(otherAutomation,otherSession,'other-second',new Date(0),1);
  expect(await store.claimDue(10)).toBe(2);
  expect((await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.outbox} WHERE automation_id=$1 AND generation=3 AND state='pending'`,[automation])).rows[0].count).toBe(1);
  expect((await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.outbox} WHERE automation_id=$1 AND state='pending'`,[otherAutomation])).rows[0].count).toBe(1);
  expect(await store.claimDue(10)).toBe(0);
 });
 it('cancel/generation fence prevents stale dispatch',async()=>{await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);await wake('old-generation');await store.claimDue();await pool.query(`UPDATE ${store.tables.automations} SET generation=2,status='cancelled' WHERE automation_id=$1`,[automation]);expect(await store.claimDispatch()).toEqual([]);});
 it('tool visibility requires matching host fence',()=>{const provider=new SessionAutomationToolProvider({} as never,{read:()=>({controlEnabled:true,executionEnabled:true,fixedLoopEnabled:true,adaptiveLoopEnabled:true,goalEnabled:true,evaluatorEnforced:true}),executionEnabled:()=>true});expect(provider.list()).toEqual([]);const base={channelContext:{channel:'web'},workspace:{root:'.',executionTarget:'server-local'},sessionId:session,runId:'run-a'} as any;expect(provider.list(base)).toEqual([]);expect(provider.list({...base,automationFence:{automationId:automation,incarnationId:incarnation,generation:2,specVersion:1,executionId:'e',runId:'run-a'}}).map(t=>t.id)).toEqual(['ScheduleWakeup','UpdateGoal']);});
 it.each(['clear','replace','pause'] as const)('UpdateGoal continue loses safely to a concurrent %s under the automation row lock',async(action)=>{
  const caseSession=`goal-race-${action}-${randomUUID()}`,runId=randomUUID(),executionId=randomUUID(),outboxId=randomUUID();
  const goal=await store.tx(c=>store.create(c,{tenantId:tenant,sessionId:caseSession,ownerUserId:'user-a'},{kind:'goal',mode:'goal',prompt:'finish the goal',budget:{}},new Date()));
  await runs.createPending({runId,sessionId:caseSession,tenantId:tenant,userId:'user-a'});
  const initialWakeup=await pool.query(`SELECT wakeup_id,trigger_key FROM ${store.tables.wakeups} WHERE tenant_id=$1 AND automation_id=$2 AND state='pending'`,[tenant,goal.automationId]);
  await pool.query(`UPDATE ${store.tables.wakeups} SET state='consumed' WHERE wakeup_id=$1`,[initialWakeup.rows[0].wakeup_id]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,'{}'::jsonb,'dispatched')`,[outboxId,initialWakeup.rows[0].wakeup_id,tenant,caseSession,goal.automationId,goal.incarnationId,goal.generation,goal.specVersion,initialWakeup.rows[0].trigger_key,runId]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running')`,[executionId,tenant,caseSession,goal.automationId,goal.incarnationId,goal.generation,goal.specVersion,outboxId,runId]);
  await pool.query(`UPDATE ${store.tables.automations} SET phase='running',active_run_id=$3,next_wakeup_at=NULL WHERE tenant_id=$1 AND automation_id=$2`,[tenant,goal.automationId,runId]);

  let initialRead!:()=>void;
  const readDone=new Promise<void>(resolve=>{initialRead=resolve;});
  const toolStore=Object.create(store) as PgSessionAutomationStore;
  toolStore.get=async(...args:Parameters<PgSessionAutomationStore['get']>)=>{const value=await store.get(...args);initialRead();return value;};
  const flags={read:()=>({controlEnabled:true,executionEnabled:true,fixedLoopEnabled:true,adaptiveLoopEnabled:true,goalEnabled:true,evaluatorEnforced:true}),executionEnabled:()=>true};
  const tools = new SessionAutomationTools(toolStore,flags);
  const locker=await pool.connect();
  try{
   await locker.query('BEGIN');
   const locked=await store.getLocked(locker,tenant,caseSession,goal.automationId);
   const continuing=tools.updateGoal({tenantId:tenant,sessionId:caseSession,automationId:goal.automationId,incarnationId:goal.incarnationId,generation:goal.generation,specVersion:goal.specVersion,executionId,runId,action:'continue',summary:'old run checkpoint'});
   await readDone;
   let waitingOnAutomationLock=false;
   for(let attempt=0;attempt<100&&!waitingOnAutomationLock;attempt++){
    const waiting=await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE $1) AS blocked`,[`%${store.tables.automations}%FOR UPDATE OF a%`]);
    waitingOnAutomationLock=waiting.rows[0]?.blocked===true;
    if(!waitingOnAutomationLock)await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waitingOnAutomationLock).toBe(true);
   if(action==='replace')await store.replace(locker,locked!,{kind:'goal',mode:'goal',prompt:'replacement goal',budget:{}});
   else await store.control(locker,locked!,action);
   await locker.query('COMMIT');
   await expect(continuing).resolves.toEqual({accepted:false,reason:'stale_fence'});
  }finally{
   await locker.query('ROLLBACK').catch(()=>undefined);
   locker.release();
  }
  const stale=await pool.query(`SELECT count(*)::int count FROM ${store.tables.wakeups} WHERE tenant_id=$1 AND automation_id=$2 AND trigger_key LIKE 'goal:%'`,[tenant,goal.automationId]);
  expect(stale.rows[0].count).toBe(0);
  const after=await store.get(tenant,caseSession,goal.automationId);
  expect(after?.generation).toBe(goal.generation+1);
  if(action==='replace'){
   expect(after).toMatchObject({status:'active',phase:'running'});
   const replacement=await pool.query(`SELECT state,generation FROM ${store.tables.wakeups} WHERE tenant_id=$1 AND automation_id=$2 AND state='pending'`,[tenant,goal.automationId]);
   expect(replacement.rows).toEqual([expect.objectContaining({state:'pending',generation:String(goal.generation+1)})]);
  }else if(action==='pause')expect(after).toMatchObject({status:'paused',phase:'running'});
  else expect(after).toMatchObject({status:'cancelling',phase:'draining'});
 });
 it('fixed terminal schedules from the durable wakeup slot and advances the projection',async()=>{
  const dueAt=new Date(Date.now()-1_000);
  await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);
  await pool.query(`UPDATE ${store.tables.wakeups} SET state='superseded' WHERE state IN ('pending','claimed')`);
  await pool.query(`UPDATE ${store.tables.specs} SET spec=$2 WHERE automation_id=$1 AND spec_version=1`,[automation,JSON.stringify({kind:'loop',mode:'fixed',prompt:'continue',intervalMs:60_000,budget:{}})]);
  await pool.query(`UPDATE ${store.tables.automations} SET generation=3,status='active',mode='fixed',phase='idle',active_run_id=NULL,continuation_epoch=7,projection_version=100 WHERE automation_id=$1`,[automation]);
  await store.tx(c=>store.scheduleTx(c,{tenantId:tenant,sessionId:session,automationId:automation,incarnationId:incarnation,generation:3,specVersion:1,continuationEpoch:7,triggerKey:'fixed-source-slot-7',dueAt,payload:{}}));
  expect(await store.claimDue()).toBe(1);
  const [dispatch]=await store.claimDispatch();
  await runs.createPending({runId:dispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});
  await store.markDispatched(dispatch!);
  const before=await store.get(tenant,session,automation);
  await new SessionAutomationTerminalProjector(store,`fixed-terminal-${randomUUID()}`).project({globalSequence:1,tenantId:tenant,sessionId:session,runId:dispatch!.targetRunId,status:'completed'});
  const snapshot=await store.get(tenant,session,automation);
  expect(snapshot).toMatchObject({phase:'waiting',projectionVersion:before!.projectionVersion+1});
  const next=await pool.query(`SELECT continuation_epoch,trigger_key,due_at FROM ${store.tables.wakeups} WHERE automation_id=$1 AND trigger_key=$2`,[automation,`fixed:${automation}:g3:slot8`]);
  expect(next.rows[0]).toMatchObject({continuation_epoch:'8',trigger_key:`fixed:${automation}:g3:slot8`});
  expect(new Date(next.rows[0].due_at).getTime()).toBe(dueAt.getTime()+60_000);
  await pool.query(`UPDATE ${store.tables.wakeups} SET state='superseded' WHERE automation_id=$1 AND state='pending'`,[automation]);
  await pool.query(`UPDATE ${store.tables.specs} SET spec=$2 WHERE automation_id=$1 AND spec_version=1`,[automation,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'continue',budget:{}})]);
 });
 it('fixed terminal skips missed periods, synchronizes its epoch, and is idempotent on repeated projection',async()=>{
  const interval=60_000;
  const dueAt=new Date(Date.now()-(3*interval+30_000));
  await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);
  await pool.query(`UPDATE ${store.tables.wakeups} SET state='superseded' WHERE state IN ('pending','claimed')`);
  await pool.query(`UPDATE ${store.tables.specs} SET spec=$2 WHERE automation_id=$1 AND spec_version=1`,[automation,JSON.stringify({kind:'loop',mode:'fixed',prompt:'continue',intervalMs:interval,budget:{}})]);
  await pool.query(`UPDATE ${store.tables.automations} SET generation=4,status='active',mode='fixed',phase='idle',active_run_id=NULL,continuation_epoch=7,projection_version=200 WHERE automation_id=$1`,[automation]);
  await store.tx(c=>store.scheduleTx(c,{tenantId:tenant,sessionId:session,automationId:automation,incarnationId:incarnation,generation:4,specVersion:1,continuationEpoch:7,triggerKey:'fixed-delayed-source-slot-7',dueAt,payload:{}}));
  expect(await store.claimDue()).toBe(1);
  const [dispatch]=await store.claimDispatch();
  await runs.createPending({runId:dispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});
  await store.markDispatched(dispatch!);
  const projector=new SessionAutomationTerminalProjector(store,`fixed-delayed-${randomUUID()}`);
  const terminal={globalSequence:1,tenantId:tenant,sessionId:session,runId:dispatch!.targetRunId,status:'completed' as const};
  expect(await projector.project(terminal)).toBe(true);
  expect(await projector.project(terminal)).toBe(false);
  const next=await pool.query(`SELECT continuation_epoch,trigger_key,due_at,state FROM ${store.tables.wakeups} WHERE automation_id=$1 AND trigger_key=$2`,[automation,`fixed:${automation}:g4:slot11`]);
  expect(next.rows).toHaveLength(1);
  expect(next.rows[0]).toMatchObject({continuation_epoch:'11',trigger_key:`fixed:${automation}:g4:slot11`,state:'pending'});
  expect(new Date(next.rows[0].due_at).getTime()).toBe(dueAt.getTime()+4*interval);
  expect(new Date(next.rows[0].due_at).getTime()).toBeGreaterThan(Date.now());
  const current=await pool.query(`SELECT continuation_epoch,projection_version FROM ${store.tables.automations} WHERE automation_id=$1`,[automation]);
  // markDispatched and the terminal projector are both externally visible projections.
  expect(current.rows[0]).toMatchObject({continuation_epoch:'11',projection_version:'202'});
  await pool.query(`UPDATE ${store.tables.wakeups} SET state='superseded' WHERE automation_id=$1 AND state='pending'`,[automation]);
  await pool.query(`UPDATE ${store.tables.specs} SET spec=$2 WHERE automation_id=$1 AND spec_version=1`,[automation,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'continue',budget:{}})]);
 });
 it('terminal recovery closes only prepared dispatch authorities on the authoritative run lineage',async()=>{
  await pool.query(`UPDATE ${store.tables.automations} SET generation=3,status='active',mode='adaptive',active_run_id=NULL WHERE automation_id=$1`,[automation]);
  await wake('terminal',3);
  await store.claimDue();
  const [dispatch]=await store.claimDispatch();
  await runs.createPending({runId:dispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});
  await store.markDispatched(dispatch!);
  for(const state of ['prepared','dispatched','result_unknown','reconcile'] as const){
   await pool.query(
    `INSERT INTO ${store.tables.preparedDispatchAttempts}
      (prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,outbox_id,idempotency_key,request_payload,state)
     VALUES($1,$2,$3,$4,$5,3,$6,$7,$6,$8,'{}',$9)`,
    [randomUUID(),tenant,session,automation,incarnation,dispatch!.outboxId,dispatch!.targetRunId,`terminal:${state}:${dispatch!.outboxId}`,state],
   );
  }
  const unrelatedWakeupId=randomUUID(),unrelatedOutboxId=randomUUID(),unrelatedRunId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at,state) VALUES($1,$2,$3,$4,$5,3,1,99,$6,now(),'consumed')`,[unrelatedWakeupId,tenant,session,automation,incarnation,`terminal-unrelated:${unrelatedWakeupId}`]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,3,1,99,$7,$8,'{}','completed')`,[unrelatedOutboxId,unrelatedWakeupId,tenant,session,automation,incarnation,`terminal-unrelated:${unrelatedWakeupId}`,unrelatedRunId]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,3,1,$1,$6,'terminal')`,[unrelatedOutboxId,tenant,session,automation,incarnation,unrelatedRunId]);
  const unrelatedAttemptId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.preparedDispatchAttempts}(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,outbox_id,idempotency_key,request_payload,state) VALUES($1,$2,$3,$4,$5,3,$6,$7,$6,$8,'{}','prepared')`,[unrelatedAttemptId,tenant,session,automation,incarnation,unrelatedOutboxId,unrelatedRunId,`terminal:unrelated:${unrelatedOutboxId}`]);
  await events.append({type:'run_finished',runId:dispatch!.targetRunId,sessionId:session,subtype:'success',numTurns:1},{tenantId:tenant});
  const first=new SessionAutomationTerminalProjector(store);
  expect(await first.recover(events)).toBeGreaterThan(0);
  const cursor=await first.cursor();
  const second=new SessionAutomationTerminalProjector(store);
  expect(await second.recover(events)).toBe(0);
  expect(await second.cursor()).toBe(cursor);
  const execution=await pool.query(`SELECT state,terminal_status FROM ${store.tables.executions} WHERE run_id=$1`,[dispatch!.targetRunId]);
  expect(execution.rows[0]).toMatchObject({state:'terminal',terminal_status:'completed'});
  const prepared=await pool.query(`SELECT state,count(*)::int AS count FROM ${store.tables.preparedDispatchAttempts} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4 AND generation=3 AND execution_id=$5 AND run_id=$6 AND outbox_id=$5 GROUP BY state`,[tenant,session,automation,incarnation,dispatch!.outboxId,dispatch!.targetRunId]);
  expect(prepared.rows).toEqual([{state:'completed',count:4}]);
  expect((await pool.query(`SELECT state FROM ${store.tables.preparedDispatchAttempts} WHERE prepared_dispatch_attempt_id=$1`,[unrelatedAttemptId])).rows[0]?.state).toBe('prepared');
  await pool.query(`DELETE FROM ${store.tables.preparedDispatchAttempts} WHERE prepared_dispatch_attempt_id=$1`,[unrelatedAttemptId]);
 });
 it('pause keeps the active run alive and stale-generation terminal still releases the one-live slot',async()=>{await pool.query(`UPDATE ${store.tables.outbox} SET state='dead'`);await pool.query(`UPDATE ${store.tables.automations} SET generation=10,status='active',mode='adaptive',phase='idle',active_run_id=NULL WHERE automation_id=$1`,[automation]);await wake('pause-running',10);await store.claimDue();const [dispatch]=await store.claimDispatch();await runs.createPending({runId:dispatch!.targetRunId,sessionId:session,tenantId:tenant,userId:'user-a',metadata:{schedulerState:'staged'}});await store.markDispatched(dispatch!);await store.tx(async c=>{const current=await store.getLocked(c,tenant,session,automation);await store.control(c,current!,'pause');});expect((await pool.query(`SELECT count(*)::int AS count FROM ${store.tables.cancellations} WHERE run_id=$1`,[dispatch!.targetRunId])).rows[0].count).toBe(0);await events.append({type:'run_finished',runId:dispatch!.targetRunId,sessionId:session,subtype:'success',numTurns:2},{tenantId:tenant});await new SessionAutomationTerminalProjector(store,'pause-terminal-test').recover(events);const snapshot=await store.get(tenant,session,automation);expect(snapshot).toMatchObject({status:'paused',phase:'idle'});expect(snapshot?.activeRunId).toBeUndefined();});
 it('clear writes a durable cancellation intent and converges after a retry',async()=>{
  await store.tx(async c=>{
   const scope=[tenant,session,automation];
   await c.query(`UPDATE ${store.tables.wakeups} SET state='superseded',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND state IN ('pending','claimed')`,scope);
   await c.query(`UPDATE ${store.tables.outbox} SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND state IN ('pending','dispatching','dispatched')`,scope);
   await c.query(`UPDATE ${store.tables.preparedDispatchAttempts} SET state='completed',lease_token=NULL,lease_expires_at=NULL,completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND state IN ('prepared','dispatched','result_unknown','reconcile')`,scope);
   await c.query(`UPDATE ${store.tables.executions} SET state='terminal',terminal_status=COALESCE(terminal_status,'cancelled'),updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND state<>'terminal'`,scope);
   await c.query(`UPDATE ${runs.runsTable} SET status='cancelled',status_reason='test fixture cleanup',cancelled_at=COALESCE(cancelled_at,now()),updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND status IN ('pending','running') AND run_id IN (SELECT run_id FROM ${store.tables.executions} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3)`,scope);
   await c.query(`UPDATE ${store.tables.lifecycleWork} SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND state IN ('pending','claimed','waiting','result_unknown')`,scope);
   await c.query(`UPDATE ${store.tables.cancellations} SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND state IN ('pending','claimed')`,scope);
  });
  const runId=randomUUID();
  await runs.createPending({runId,sessionId:session,tenantId:tenant,userId:'user-a'});await pool.query(`UPDATE ${store.tables.automations} SET generation=20,status='active',phase='running',active_run_id=$4 WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,[tenant,session,automation,runId]);await store.tx(async c=>{const current=await store.getLocked(c,tenant,session,automation);await store.control(c,current!,'clear');});let [item]=await store.claimCancellations();expect(item?.runId).toBe(runId);await store.failCancellation(item!,new Error('transient'));await pool.query(`UPDATE ${store.tables.cancellations} SET next_attempt_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND run_id=$4`,[tenant,session,automation,runId]);[item]=await store.claimCancellations();await runs.markStatus(runId,'cancelled','authoritative cancel adapter');await store.completeCancellation(item!);
  const summary=await store.tx(c=>(store as unknown as {inFlightSummaryLocked(client:typeof c,tenantId:string,automationId:string):Promise<AutomationInFlightSummary>}).inFlightSummaryLocked(c,tenant,automation));
  expect(summary).toEqual({activeRuns:0,wakeups:0,outbox:0,executions:0,evaluations:0,providerAttempts:0,interactions:0,backgroundResources:0,budgetReservations:0,cancellations:0,typedWork:0,unknownOrDead:0});
  expect(await store.get(tenant,session,automation)).toMatchObject({status:'cancelled',phase:'terminal'});});
 it('the first budget limit closes a quiescent automation directly as terminal without another dispatch',async()=>{
  await pool.query(`UPDATE ${store.tables.specs} SET spec=$2 WHERE automation_id=$1 AND spec_version=1`,[automation,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'continue',budget:{maxRuns:1}})]);
  await pool.query(`UPDATE ${store.tables.automations} SET generation=30,status='active',phase='idle',active_run_id=NULL,run_count=1,limit_hit_reason=NULL,limit_hit_at=NULL WHERE automation_id=$1`,[automation]);
  await wake('budget-stop',30);
  expect(await store.claimDue()).toBe(0);
  const result=await pool.query(`SELECT status,phase,active_run_id,desired_terminal_status,limit_hit_reason,limit_hit_at FROM ${store.tables.automations} WHERE automation_id=$1`,[automation]);
  expect(result.rows[0]).toMatchObject({status:'expired',phase:'terminal',active_run_id:null,desired_terminal_status:null,limit_hit_reason:'max_runs'});
  expect(result.rows[0].limit_hit_at).toBeTruthy();
 });

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
  await runs.markStatus(oldRun,'cancelled','authoritative cancel adapter');
  await store.completeCancellation(cancel!);
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
  await runs.markStatus(dispatch!.targetRunId,'cancelled','authoritative cancel adapter');
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
  await runs.markStatus(runId,'cancelled','authoritative cancel adapter');
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
  expect((await pool.query(`SELECT count(*)::int count FROM ${store.tables.reconciliationReceipts} WHERE provider_attempt_id=$1 AND receipt_authority='provider_adapter'`,[reconcile!.providerAttemptId])).rows[0].count).toBe(1);
  const constraints=await pool.query(`SELECT count(*)::int count FROM pg_constraint WHERE conrelid=$1::regclass AND condeferrable`,[store.tables.providerAttempts]);expect(constraints.rows[0].count).toBeGreaterThanOrEqual(2);
  await expect(pool.query(`INSERT INTO ${store.tables.interactions}(interaction_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,interaction_key,interaction_kind,request_payload) VALUES($1,$2,$3,$4,$5,99,$6,$7,'bad-lineage','tool','{}')`,[randomUUID(),tenant,session,automationId,incarnationId,executionId,runId])).rejects.toMatchObject({code:'23503'});
 });

 it('clear drains evaluator/provider/resource/interaction/reservation authorities before the last-item terminal projection',async()=>{
  const testSession=`${session}-typed-drain-${randomUUID()}`,automationId=randomUUID(),incarnationId=randomUUID(),runId=randomUUID(),wakeupId=randomUUID(),outboxId=randomUUID(),executionId=randomUUID(),preparedId=randomUUID();
  await runs.createPending({runId,sessionId:testSession,tenantId:tenant,userId:'user-a'});await runs.markStatus(runId,'completed','fixture');
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'goal','goal','active',1,1,1,1)`,[automationId,tenant,testSession,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'typed-drain',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'goal',mode:'goal',condition:'done',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at,state) VALUES($1,$2,$3,$4,$5,1,1,0,$6,now(),'consumed')`,[wakeupId,tenant,testSession,automationId,incarnationId,`typed-${automationId}`]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,1,1,0,$7,$8,'{}','completed')`,[outboxId,wakeupId,tenant,testSession,automationId,incarnationId,`typed-${automationId}`,runId]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state,terminal_status) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,'terminal','completed')`,[executionId,tenant,testSession,automationId,incarnationId,outboxId,runId]);
  await pool.query(`INSERT INTO ${store.tables.preparedDispatchAttempts}(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,outbox_id,idempotency_key,request_payload,state) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'{}','completed')`,[preparedId,tenant,testSession,automationId,incarnationId,executionId,runId,outboxId,`dispatch:${outboxId}`]);
  const providerId=randomUUID(),reservationId=randomUUID(),evaluationId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.providerAttempts}(provider_attempt_id,prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,provider,operation,idempotency_key,request_payload,state) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'test','prepared',$9,'{}','prepared')`,[providerId,preparedId,tenant,testSession,automationId,incarnationId,executionId,runId,`attempt:${providerId}`]);
  await pool.query(`INSERT INTO ${store.tables.budgetReservations}(reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,budget_kind,amount,unit,idempotency_key) VALUES($1,$2,$3,$4,$5,1,$6,$7,'turns',1,'turn',$8)`,[reservationId,tenant,testSession,automationId,incarnationId,executionId,runId,`reservation:${reservationId}`]);
  await pool.query(`INSERT INTO ${store.tables.evaluations}(evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence) VALUES($1,$2,$3,$4,$5,$6,1,1,1,'{}')`,[evaluationId,tenant,testSession,automationId,executionId,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.interactions}(interaction_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,interaction_key,interaction_kind,request_payload) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,'tool','{}')`,[randomUUID(),tenant,testSession,automationId,incarnationId,executionId,runId,`interaction:${automationId}`]);
  await pool.query(`INSERT INTO ${store.tables.backgroundResources}(background_resource_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,resource_kind,resource_key) VALUES($1,$2,$3,$4,$5,1,$6,$7,'child_run',$8)`,[randomUUID(),tenant,testSession,automationId,incarnationId,executionId,runId,`resource:${automationId}`]);
  await store.tx(async c=>{const live=await store.getLocked(c,tenant,testSession,automationId);await store.control(c,live!,'clear');});
  expect(await store.get(tenant,testSession,automationId)).toMatchObject({status:'cancelling',phase:'draining'});
  const adapter = { execute: async (job: import('./sessionAutomationStore.js').SessionAutomationLifecycleJob) => {
    // Simulate the authoritative runtime side effect; it intentionally happens outside the store transaction.
    if (job.objectType === 'run') await pool.query(`UPDATE ${runs.runsTable} SET status='cancelled',updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3`, [job.tenantId, job.sessionId, job.objectId]);
    const { attemptCount: _attemptCount, details: _details, ...fence } = job;
    return { ...fence, receiptKey: `test-runtime:${job.workId}`, authority: 'runtime' as const, outcome: 'completed' as const, payload: job.objectType === 'provider_attempt' ? { providerState: 'cancelled' } : {} };
  } };
  await store.processLifecycleWork({ run: adapter, execution: adapter, evaluation: adapter, provider_attempt: adapter, interaction: adapter, background_resource: adapter, budget_reservation: adapter }, 20);
  expect(await store.get(tenant,testSession,automationId)).toMatchObject({status:'cancelled',phase:'terminal'});
  const states=await pool.query(`SELECT (SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1) evaluation,(SELECT state FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$2) provider,(SELECT state FROM ${store.tables.budgetReservations} WHERE reservation_id=$3) reservation`,[evaluationId,providerId,reservationId]);
  expect(states.rows[0]).toMatchObject({evaluation:'cancelled',provider:'cancelled',reservation:'released'});
 });

 it('old-generation lifecycle receipts are fenced and cannot mutate a new generation',async()=>{
  const testSession=`${session}-old-fence-${randomUUID()}`,automationId=randomUUID(),incarnationId=randomUUID(),evaluationId=randomUUID(),executionId=randomUUID(),runId=randomUUID(),wakeupId=randomUUID(),outboxId=randomUUID();
  await runs.createPending({runId,sessionId:testSession,tenantId:tenant,userId:'user-a'});
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'goal','goal','cancelling',2,1,1,1)`,[automationId,tenant,testSession,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'old-fence',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'goal',mode:'goal',condition:'done',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at,state) VALUES($1,$2,$3,$4,$5,1,1,0,$6,now(),'consumed')`,[wakeupId,tenant,testSession,automationId,incarnationId,`old-${automationId}`]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,1,1,0,$7,$8,'{}','completed')`,[outboxId,wakeupId,tenant,testSession,automationId,incarnationId,`old-${automationId}`,runId]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,'terminal')`,[executionId,tenant,testSession,automationId,incarnationId,outboxId,runId]);
  await pool.query(`INSERT INTO ${store.tables.evaluations}(evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence) VALUES($1,$2,$3,$4,$5,$6,1,1,1,'{}')`,[evaluationId,tenant,testSession,automationId,executionId,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action) VALUES($1,$2,$3,$4,$5,1,$5,1,'evaluation',$6,'cancel')`,[randomUUID(),tenant,testSession,automationId,incarnationId,evaluationId]);
  await store.processLifecycleWork();
  expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`,[evaluationId])).rows[0].state).toBe('pending');
 });

 it('dead lifecycle work forces reconcile_required instead of a false terminal state',async()=>{
  const testSession=`${session}-dead-work`,automationId=randomUUID(),incarnationId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version,desired_terminal_status) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','cancelling','draining',1,1,1,1,'cancelled')`,[automationId,tenant,testSession,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'dead-work',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'x',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action,state) VALUES($1,$2,$3,$4,$5,1,$5,1,'provider_attempt',$6,'reconcile','dead')`,[randomUUID(),tenant,testSession,automationId,incarnationId,randomUUID()]);
  await store.tx(c=>store.tryFinalizeLocked(c,tenant,testSession,automationId));
  expect(await store.get(tenant,testSession,automationId)).toMatchObject({status:'reconcile_required',phase:'draining'});
 });

 it('parses scaled PG NUMERIC as strict whole values and upgrades legacy scheduling columns',async()=>{
  const numeric=await pool.query<{amount:string}>(`SELECT 1::numeric(20,6)::text amount`);
  expect(parseWholeNumeric(numeric.rows[0]!.amount)).toBe(1n);
  await pool.query(`ALTER TABLE ${store.tables.outbox} DROP COLUMN updated_at`);
  await pool.query(`DROP INDEX IF EXISTS ${prefix}_automation_lifecycle_due`);
  await pool.query(`ALTER TABLE ${store.tables.lifecycleWork} DROP COLUMN next_attempt_at`);
  await store.init();
  const columns=await pool.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name=$1 AND column_name='updated_at') OR (table_name=$2 AND column_name='next_attempt_at'))`,[store.tables.outbox,store.tables.lifecycleWork]);
  expect(columns.rowCount).toBe(2);
 });

 it('parks external authority work until an authoritative receipt wakes it',async()=>{
  const testSession=`${session}-waiting-work`,automationId=randomUUID(),incarnationId=randomUUID(),workId=randomUUID(),objectId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','reconcile_required','waiting',1,1,1,1)`,[automationId,tenant,testSession,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'waiting-work',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'x',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action) VALUES($1,$2,$3,$4,$5,1,$5,1,'provider_attempt',$6,'reconcile')`,[workId,tenant,testSession,automationId,incarnationId,objectId]);
  await store.processLifecycleWork({provider_attempt:{execute:async job=>{const {attemptCount:_,details:__,...fence}=job;return{...fence,receiptKey:'await-provider',authority:'runtime',outcome:'pending',payload:{}};}}});
  expect((await pool.query(`SELECT state FROM ${store.tables.lifecycleWork} WHERE work_id=$1`,[workId])).rows[0].state).toBe('waiting');
  const receipt={workId,tenantId:tenant,sessionId:testSession,automationId,incarnationId,generation:1,objectIncarnationId:incarnationId,objectGeneration:1,objectType:'provider_attempt' as const,objectId,action:'reconcile' as const,receiptKey:'provider-final',authority:'provider' as const,outcome:'completed' as const,payload:{providerState:'completed'}};
  expect(await store.applyAuthoritativeLifecycleReceipt(receipt)).toBe(true);
  expect((await pool.query(`SELECT state FROM ${store.tables.lifecycleWork} WHERE work_id=$1`,[workId])).rows[0].state).toBe('completed');
 });

 it('rejects a stale authoritative lease before mutating the lifecycle object',async()=>{
  const testSession=`${session}-stale-receipt`,automationId=randomUUID(),incarnationId=randomUUID(),workId=randomUUID(),evaluationId=randomUUID(),executionId=randomUUID(),runId=randomUUID(),wakeupId=randomUUID(),outboxId=randomUUID();
  await runs.createPending({runId,sessionId:testSession,tenantId:tenant,userId:'user-a'});
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'goal','goal','cancelling','draining',1,1,1,1)`,[automationId,tenant,testSession,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'stale-receipt',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'goal',mode:'goal',condition:'done',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at,state) VALUES($1,$2,$3,$4,$5,1,1,0,$6,now(),'consumed')`,[wakeupId,tenant,testSession,automationId,incarnationId,`stale-${workId}`]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,1,1,0,$7,$8,'{}','completed')`,[outboxId,wakeupId,tenant,testSession,automationId,incarnationId,`stale-${workId}`,runId]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,'terminal')`,[executionId,tenant,testSession,automationId,incarnationId,outboxId,runId]);
  await pool.query(`INSERT INTO ${store.tables.evaluations}(evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence) VALUES($1,$2,$3,$4,$5,$6,1,1,1,'{}')`,[evaluationId,tenant,testSession,automationId,executionId,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action,state,lease_token,lease_expires_at) VALUES($1,$2,$3,$4,$5,1,$5,1,'evaluation',$6,'cancel','claimed',$7,now()+interval '2 minutes')`,[workId,tenant,testSession,automationId,incarnationId,evaluationId,randomUUID()]);
  const receipt={workId,tenantId:tenant,sessionId:testSession,automationId,incarnationId,generation:1,objectIncarnationId:incarnationId,objectGeneration:1,objectType:'evaluation' as const,objectId:evaluationId,action:'cancel' as const,receiptKey:'stale-authority',authority:'provider' as const,outcome:'completed' as const,payload:{}};
  expect(await store.applyAuthoritativeLifecycleReceipt(receipt)).toBe(false);
  expect((await pool.query(`SELECT state FROM ${store.tables.evaluations} WHERE evaluation_id=$1`,[evaluationId])).rows[0].state).toBe('pending');
  expect((await pool.query(`SELECT state FROM ${store.tables.lifecycleWork} WHERE work_id=$1`,[workId])).rows[0].state).toBe('claimed');
 });

 it('rejects old-generation reconcile evidence and keeps completed provider state monotonic',async()=>{
  const testSession=`${session}-old-reconcile`,automationId=randomUUID(),oldIncarnation=randomUUID(),currentIncarnation=randomUUID();
  const wakeupId=randomUUID(),outboxId=randomUUID(),executionId=randomUUID(),runId=randomUUID(),preparedId=randomUUID(),attemptId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','reconcile_required','waiting',2,1,1,1)`,[automationId,tenant,testSession,currentIncarnation]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'old-reconcile',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'x',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at,state) VALUES($1,$2,$3,$4,$5,1,1,1,$6,now(),'consumed')`,[wakeupId,tenant,testSession,automationId,oldIncarnation,`old:${wakeupId}`]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,$8,'{}','completed')`,[outboxId,wakeupId,tenant,testSession,automationId,oldIncarnation,`old:${wakeupId}`,runId]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,'terminal')`,[executionId,tenant,testSession,automationId,oldIncarnation,outboxId,runId]);
  await pool.query(`INSERT INTO ${store.tables.preparedDispatchAttempts}(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,outbox_id,idempotency_key,request_payload,state) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'{}','completed')`,[preparedId,tenant,testSession,automationId,oldIncarnation,executionId,runId,outboxId,`old:${attemptId}`]);
  await pool.query(`INSERT INTO ${store.tables.providerAttempts}(provider_attempt_id,prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,provider,operation,idempotency_key,request_payload,state) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'model',$10,$9,'{}','result_unknown')`,[attemptId,preparedId,tenant,testSession,automationId,oldIncarnation,executionId,runId,`old-provider:${attemptId}`,`goal-evaluation:${executionId}`]);
  const current=(await store.get(tenant,testSession,automationId))!;
  await expect(store.tx(c=>store.control(c,current,'reconcile',{providerAttemptId:attemptId,receiptKey:`receipt:${attemptId}`,observedState:'not_found',receiptAuthority:'operator',receiptPayload:{}}))).rejects.toMatchObject({code:'CONFLICT'});
  expect((await pool.query(`SELECT state FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`,[attemptId])).rows[0].state).toBe('result_unknown');
  await pool.query(`UPDATE ${store.tables.automations} SET incarnation_id=$2,generation=1 WHERE automation_id=$1`,[automationId,oldIncarnation]);
  const workId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action,state) VALUES($1,$2,$3,$4,$5,1,$5,1,'provider_attempt',$6,'reconcile','waiting')`,[workId,tenant,testSession,automationId,oldIncarnation,attemptId]);
  const base={workId,tenantId:tenant,sessionId:testSession,automationId,incarnationId:oldIncarnation,generation:1,objectIncarnationId:oldIncarnation,objectGeneration:1,objectType:'provider_attempt' as const,objectId:attemptId,action:'reconcile' as const,authority:'provider' as const,outcome:'completed' as const};
  expect(await store.applyAuthoritativeLifecycleReceipt({...base,receiptKey:'provider-completed',payload:{providerState:'completed'}})).toBe(true);
  await pool.query(`UPDATE ${store.tables.lifecycleWork} SET state='waiting' WHERE work_id=$1`,[workId]);
  expect(await store.applyAuthoritativeLifecycleReceipt({...base,receiptKey:'stale-cancelled',payload:{providerState:'cancelled'}})).toBe(true);
  expect((await pool.query(`SELECT state FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`,[attemptId])).rows[0].state).toBe('completed');
 });

 it('persists billing closure work and a restarted lifecycle worker retries settlement',async()=>{
  const testSession=`${session}-billing-restart`,automationId=randomUUID(),incarnationId=randomUUID(),billingRunId=`utility-automation_evaluator-${randomUUID()}`;
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version) VALUES($1,$2,$3,'user-a',$4,'goal','adaptive','active','waiting',1,1,1,1)`,[automationId,tenant,testSession,incarnationId]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'billing-restart',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'goal',mode:'adaptive',prompt:'x',completionCondition:'done',budget:{}})]);
  const guard=new SessionAutomationRuntimeGuard(pool,()=>true,prefix,runs.runsTable);
  const context={tenantId:tenant,sessionId:testSession,runId:'evaluation-run',model:'model',cwd:'.',channelContext:{channel:'web'},automationFence:{automationId,incarnationId,generation:1,specVersion:1,executionId:randomUUID(),runId:'evaluation-run'}} as never;
  await guard.ensureBillingClosure(context,billingRunId);
  let calls=0;const billing={store:{settleRunDebit:async()=>{calls++;if(calls===1)throw new Error('pg unavailable');}}};
  const adapters=createLifecycleAdapters(async()=>undefined,undefined,()=>billing as never);
  await new PgSessionAutomationStore(pool,prefix,runs.runsTable).processLifecycleWork(adapters,10);
  expect((await pool.query(`SELECT state FROM ${store.tables.lifecycleWork} WHERE object_id=$1`,[billingRunId])).rows[0].state).toBe('pending');
  await pool.query(`UPDATE ${store.tables.lifecycleWork} SET next_attempt_at=now() WHERE object_id=$1`,[billingRunId]);
  await new PgSessionAutomationStore(pool,prefix,runs.runsTable).processLifecycleWork(adapters,10);
  expect(calls).toBe(2);
  expect((await pool.query(`SELECT state,receipt_payload FROM ${store.tables.lifecycleWork} WHERE object_id=$1`,[billingRunId])).rows[0]).toMatchObject({state:'completed',receipt_payload:{billingClosure:'settled',billingRunId}});
 });

 it.each([{desired:'blocked',status:'completing'},{desired:'cancelled',status:'cancelling'}] as const)('rejects replace while $desired drain is still closing lifecycle work',async({desired,status})=>{
  const testSession=`${session}-drain-${desired}`,automationId=randomUUID(),incarnationId=randomUUID(),workId=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version,desired_terminal_status) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive',$5,'draining',7,1,1,1,$6)`,[automationId,tenant,testSession,incarnationId,status,desired]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,'drain-mutation',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'old',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action,state) VALUES($1,$2,$3,$4,$5,7,$5,7,'run',$6,'cancel','pending')`,[workId,tenant,testSession,automationId,incarnationId,randomUUID()]);
  const before=await pool.query(`SELECT incarnation_id,generation,spec_version,(SELECT count(*) FROM ${store.tables.wakeups} w WHERE w.automation_id=a.automation_id)::int wakeups FROM ${store.tables.automations} a WHERE automation_id=$1`,[automationId]);
  const current=await store.get(tenant,testSession,automationId);
  await expect(store.tx(c=>store.replace(c,current!,{kind:'loop',mode:'adaptive',prompt:'new',budget:{}}))).rejects.toMatchObject({code:'AUTOMATION_DRAINING'});
  const after=await pool.query(`SELECT incarnation_id,generation,spec_version,(SELECT count(*) FROM ${store.tables.wakeups} w WHERE w.automation_id=a.automation_id)::int wakeups FROM ${store.tables.automations} a WHERE automation_id=$1`,[automationId]);
  expect(after.rows[0]).toEqual(before.rows[0]);
 });

 it('does not let a late old-run terminal event finalize or clear a newer draining incarnation',async()=>{
  const testSession=`${session}-late-terminal`,automationId=randomUUID(),oldIncarnation=randomUUID(),newIncarnation=randomUUID();
  const wakeupId=randomUUID(),outboxId=randomUUID(),executionId=randomUUID(),oldRun=randomUUID();
  await pool.query(`INSERT INTO ${store.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version,active_run_id,desired_terminal_status) VALUES($1,$2,$3,'user-a',$4,'loop','adaptive','cancelling','draining',2,2,2,2,$5,'cancelled')`,[automationId,tenant,testSession,newIncarnation,oldRun]);
  await pool.query(`INSERT INTO ${store.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,2,'late-terminal',$4)`,[automationId,tenant,testSession,JSON.stringify({kind:'loop',mode:'adaptive',prompt:'new incarnation',budget:{}})]);
  await pool.query(`INSERT INTO ${store.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at,state) VALUES($1,$2,$3,$4,$5,1,1,1,$6,now(),'consumed')`,[wakeupId,tenant,testSession,automationId,oldIncarnation,`late:${wakeupId}`]);
  await pool.query(`INSERT INTO ${store.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload,state) VALUES($1,$2,$3,$4,$5,$6,1,1,1,$7,$8,'{}','dispatched')`,[outboxId,wakeupId,tenant,testSession,automationId,oldIncarnation,`late:${wakeupId}`,oldRun]);
  await pool.query(`INSERT INTO ${store.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,'running')`,[executionId,tenant,testSession,automationId,oldIncarnation,outboxId,oldRun]);
  await new SessionAutomationTerminalProjector(store,`late-old-run-${randomUUID()}`).project({globalSequence:1,tenantId:tenant,sessionId:testSession,runId:oldRun,status:'completed'});
  expect(await store.get(tenant,testSession,automationId)).toMatchObject({incarnationId:newIncarnation,generation:2,status:'cancelling',phase:'draining',activeRunId:oldRun});
  expect((await pool.query(`SELECT state FROM ${store.tables.executions} WHERE execution_id=$1`,[executionId])).rows[0].state).toBe('terminal');
 });

});
