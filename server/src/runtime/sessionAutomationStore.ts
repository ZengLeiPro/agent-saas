import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SessionAutomationSnapshot, SessionAutomationSpec } from '@agent/shared/types/sessionAutomation.js';
import { applySessionAutomationSchema, sessionAutomationTables, type SessionAutomationTables } from './sessionAutomationStoreSchema.js';
import { resolveAutomationBudgetReason } from './sessionAutomationBudgetProgress.js';

type Pool = pg.Pool;
type Client = pg.PoolClient;
export interface SessionAutomationReconciliationEvidence {providerAttemptId:string;receiptKey:string;observedState:'completed'|'not_found'|'still_running'|'ambiguous';receiptPayload:Record<string,unknown>;}
export interface AutomationIdentity { tenantId: string; sessionId: string; ownerUserId: string; }

export interface ClaimedDispatch { outboxId: string; wakeupId: string; automationId: string; tenantId: string; sessionId: string; targetRunId: string; triggerKey: string; payload: Record<string, unknown>; leaseToken: string; generation: number; specVersion: number; incarnationId: string; }
export interface RecoverablePreparedDispatch extends ClaimedDispatch { requestPayload: Record<string, unknown>; }
export interface ClaimedCancellation { cancellationId:string;tenantId:string;sessionId:string;automationId:string;runId:string;reason:string;leaseToken:string;requestedGeneration:number; }
export class SessionAutomationConflictError extends Error { constructor(readonly code: string, message: string, readonly current?: SessionAutomationSnapshot) { super(message); } }

export class PgSessionAutomationStore {
  readonly tables: SessionAutomationTables;
  private notifier?: (ownerUserId:string,payload:Record<string,unknown>)=>void;
  constructor(readonly pool: Pool, readonly tablePrefix = 'runtime', readonly runsTable = `${tablePrefix}_runs`) { this.tables = sessionAutomationTables(tablePrefix); }
  setNotifier(notifier:(ownerUserId:string,payload:Record<string,unknown>)=>void):void{this.notifier=notifier;}
  publish(snapshot:SessionAutomationSnapshot,type='automation_state_changed',message?:string):void{this.notifier?.(snapshot.ownerUserId,{type,eventId:randomUUID(),sessionId:snapshot.sessionId,automationId:snapshot.automationId,projectionVersion:snapshot.projectionVersion,snapshot,...(message?{message}:{})});}
  async init(): Promise<void> {
    const client = await this.pool.connect(); const key = `${this.tables.automations}:init`;
    try { await client.query('SELECT pg_advisory_lock(hashtext($1))',[key]); await client.query('BEGIN'); await applySessionAutomationSchema(client,this.tablePrefix,this.runsTable); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK').catch(()=>undefined); throw e; }
    finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]).catch(()=>undefined); client.release(); }
  }
  async tx<T>(fn:(client:Client)=>Promise<T>):Promise<T>{ const c=await this.pool.connect(); try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();} }
  private map(row: Record<string,unknown>): SessionAutomationSnapshot {
    const spec = row.spec as SessionAutomationSpec;
    return { automationId:String(row.automation_id),incarnationId:String(row.incarnation_id),tenantId:String(row.tenant_id),sessionId:String(row.session_id),ownerUserId:String(row.owner_user_id),status:row.status as SessionAutomationSnapshot['status'],phase:row.phase as SessionAutomationSnapshot['phase'],generation:Number(row.generation),specVersion:Number(row.spec_version),controlVersion:Number(row.control_version),projectionVersion:Number(row.projection_version),spec,nextWakeupAt:row.next_wakeup_at ? new Date(String(row.next_wakeup_at)).toISOString():undefined,activeRunId:row.active_run_id ? String(row.active_run_id):undefined,runCount:Number(row.run_count),noProgressCount:Number(row.no_progress_count),lastError:row.last_error ? String(row.last_error):undefined,createdAt:new Date(String(row.created_at)).toISOString(),updatedAt:new Date(String(row.updated_at)).toISOString() };
  }
  private selectSql():string { const t=this.tables; return `SELECT a.*,s.spec FROM ${t.automations} a JOIN ${t.specs} s ON s.automation_id=a.automation_id AND s.spec_version=a.spec_version WHERE a.tenant_id=$1 AND a.session_id=$2`; }
  async list(tenantId:string,sessionId:string):Promise<SessionAutomationSnapshot[]>{const r=await this.pool.query(this.selectSql(),[tenantId,sessionId]);return r.rows.map((x)=>this.map(x));}
  async get(tenantId:string,sessionId:string,automationId:string):Promise<SessionAutomationSnapshot|undefined>{const r=await this.pool.query(`${this.selectSql()} AND a.automation_id=$3`,[tenantId,sessionId,automationId]);return r.rows[0]?this.map(r.rows[0]):undefined;}
  async getLive(client:Client,tenantId:string,sessionId:string):Promise<SessionAutomationSnapshot|undefined>{const r=await client.query(`${this.selectSql()} AND a.status IN ('active','paused','blocked','completing','cancelling','reconcile_required') FOR UPDATE OF a`,[tenantId,sessionId]);return r.rows[0]?this.map(r.rows[0]):undefined;}
  async getLiveForOwner(client:Client,id:AutomationIdentity):Promise<SessionAutomationSnapshot|undefined>{const r=await client.query(`${this.selectSql()} AND a.owner_user_id=$3 AND a.status IN ('active','paused','blocked','completing','cancelling','reconcile_required') FOR UPDATE OF a`,[id.tenantId,id.sessionId,id.ownerUserId]);return r.rows[0]?this.map(r.rows[0]):undefined;}
  async getLocked(client:Client,tenantId:string,sessionId:string,automationId:string):Promise<SessionAutomationSnapshot|undefined>{const r=await client.query(`${this.selectSql()} AND a.automation_id=$3 FOR UPDATE OF a`,[tenantId,sessionId,automationId]);return r.rows[0]?this.map(r.rows[0]):undefined;}
  async getLockedForOwner(client:Client,id:AutomationIdentity,automationId:string):Promise<SessionAutomationSnapshot|undefined>{const r=await client.query(`${this.selectSql()} AND a.automation_id=$3 AND a.owner_user_id=$4 FOR UPDATE OF a`,[id.tenantId,id.sessionId,automationId,id.ownerUserId]);return r.rows[0]?this.map(r.rows[0]):undefined;}
  async getByAutomationId(tenantId:string,automationId:string):Promise<SessionAutomationSnapshot|undefined>{const t=this.tables;const r=await this.pool.query(`SELECT a.*,s.spec FROM ${t.automations} a JOIN ${t.specs} s ON s.automation_id=a.automation_id AND s.spec_version=a.spec_version WHERE a.tenant_id=$1 AND a.automation_id=$2`,[tenantId,automationId]);return r.rows[0]?this.map(r.rows[0]):undefined;}
  async findCommand(client:Client,id:AutomationIdentity,clientMessageId:string,commandDigest:string):Promise<unknown|undefined>{await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[id.tenantId+':'+id.ownerUserId,clientMessageId]);const r=await client.query(`SELECT command_digest,response FROM ${this.tables.commands} WHERE tenant_id=$1 AND owner_user_id=$2 AND client_message_id=$3 FOR UPDATE`,[id.tenantId,id.ownerUserId,clientMessageId]);if(!r.rows[0])return undefined;if(r.rows[0].command_digest!==commandDigest)throw new SessionAutomationConflictError('CONFLICT','clientMessageId 已用于不同命令');return r.rows[0].response??undefined;}
  async recordCommand(client:Client,id:AutomationIdentity,sessionId:string,clientMessageId:string,digest:string,automationId:string|undefined,response:unknown):Promise<void>{await client.query(`INSERT INTO ${this.tables.commands}(tenant_id,owner_user_id,client_message_id,session_id,command_digest,automation_id,response,state) VALUES($1,$2,$3,$4,$5,$6,$7,'committed') ON CONFLICT(tenant_id,owner_user_id,client_message_id) DO UPDATE SET automation_id=EXCLUDED.automation_id,response=EXCLUDED.response,state='committed' WHERE ${this.tables.commands}.command_digest=EXCLUDED.command_digest AND ${this.tables.commands}.session_id=EXCLUDED.session_id`,[id.tenantId,id.ownerUserId,clientMessageId,sessionId,digest,automationId??null,JSON.stringify(response)]);}
  async prepareCommandSession(input:{tenantId:string;ownerUserId:string;clientMessageId:string;commandDigest:string;sessionId:string}):Promise<string>{return this.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[input.tenantId+':'+input.ownerUserId,input.clientMessageId]);const existing=await c.query(`SELECT session_id,command_digest FROM ${this.tables.commands} WHERE tenant_id=$1 AND owner_user_id=$2 AND client_message_id=$3 FOR UPDATE`,[input.tenantId,input.ownerUserId,input.clientMessageId]);if(existing.rows[0]){if(existing.rows[0].command_digest!==input.commandDigest)throw new SessionAutomationConflictError('CONFLICT','clientMessageId 已用于不同命令');return String(existing.rows[0].session_id);}await c.query(`INSERT INTO ${this.tables.commands}(tenant_id,owner_user_id,client_message_id,session_id,command_digest,state) VALUES($1,$2,$3,$4,$5,'prepared')`,[input.tenantId,input.ownerUserId,input.clientMessageId,input.sessionId,input.commandDigest]);return input.sessionId;});}
  async create(client:Client,id:AutomationIdentity,spec:SessionAutomationSpec,now:Date):Promise<SessionAutomationSnapshot>{
    const automationId=randomUUID(),incarnationId=randomUUID(), digest=specDigest(spec);
    await client.query(`INSERT INTO ${this.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'active','waiting')`,[automationId,id.tenantId,id.sessionId,id.ownerUserId,incarnationId,spec.kind,spec.mode]);
    await client.query(`INSERT INTO ${this.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,$4,$5)`,[automationId,id.tenantId,id.sessionId,digest,JSON.stringify(spec)]);
    const due=spec.mode==='fixed'?new Date(now.getTime()+spec.intervalMs!):now; await this.scheduleTx(client,{tenantId:id.tenantId,sessionId:id.sessionId,automationId,incarnationId,generation:1,specVersion:1,continuationEpoch:1,triggerKey:`initial:${automationId}:g1:e1`,dueAt:due,payload:{spec}});
    const created=await this.getLocked(client,id.tenantId,id.sessionId,automationId); if(!created)throw new Error('automation insert lost'); await this.event(client,created,'created',{}); return created;
  }
  async replace(client:Client,current:SessionAutomationSnapshot,spec:SessionAutomationSpec):Promise<SessionAutomationSnapshot>{
    const incarnationId=randomUUID(),generation=current.generation+1,specVersion=current.specVersion+1;
    if(current.activeRunId)await this.enqueueCancellationTx(client,current,current.activeRunId,'session_automation_replace');
    await client.query(`UPDATE ${this.tables.wakeups} SET state='superseded' WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,[current.tenantId,current.automationId]);
    await client.query(`UPDATE ${this.tables.automations} SET incarnation_id=$3,kind=$4,mode=$5,status='active',phase=CASE WHEN active_run_id IS NULL THEN 'waiting' ELSE 'running' END,generation=$6,spec_version=$7,control_version=control_version+1,projection_version=projection_version+1,continuation_epoch=1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2`,[current.tenantId,current.automationId,incarnationId,spec.kind,spec.mode,generation,specVersion]);
    await client.query(`INSERT INTO ${this.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,$4,$5,$6)`,[current.automationId,current.tenantId,current.sessionId,specVersion,specDigest(spec),JSON.stringify(spec)]);
    const due=spec.mode==='fixed'?new Date(Date.now()+spec.intervalMs!):new Date(); await this.scheduleTx(client,{tenantId:current.tenantId,sessionId:current.sessionId,automationId:current.automationId,incarnationId,generation,specVersion,continuationEpoch:1,triggerKey:`initial:${current.automationId}:g${generation}:e1`,dueAt:due,payload:{spec}});
    return (await this.getLocked(client,current.tenantId,current.sessionId,current.automationId))!;
  }
  private async reconcileProviderEvidence(
    client: Client,
    current: SessionAutomationSnapshot,
    evidence: SessionAutomationReconciliationEvidence,
  ): Promise<'unresolved'|'generic_resolved'|'evaluation_retry'|'evaluation_completed'> {
    const duplicate = await client.query(
      `SELECT provider_attempt_id,observed_state,(receipt_payload=$3::jsonb) AS same_payload
         FROM ${this.tables.reconciliationReceipts}
        WHERE tenant_id=$1 AND receipt_key=$2 FOR UPDATE`,
      [current.tenantId, evidence.receiptKey, JSON.stringify(evidence.receiptPayload)],
    );
    if (duplicate.rows[0]) {
      const same = duplicate.rows[0].provider_attempt_id === evidence.providerAttemptId
        && duplicate.rows[0].observed_state === evidence.observedState
        && duplicate.rows[0].same_payload === true;
      if (!same) throw new SessionAutomationConflictError('CONFLICT', 'receiptKey 已用于不同对账证据', current);
      const evaluation = await client.query(
        `SELECT state FROM ${this.tables.evaluations} WHERE provider_attempt_id=$1`,
        [evidence.providerAttemptId],
      );
      if (!['completed', 'not_found'].includes(evidence.observedState)) return 'unresolved';
      if (!evaluation.rows[0]) return 'generic_resolved';
      return evidence.observedState === 'not_found' ? 'evaluation_retry' : 'evaluation_completed';
    }

    const attempt = await client.query(
      `SELECT * FROM ${this.tables.providerAttempts}
        WHERE provider_attempt_id=$1 AND tenant_id=$2 AND session_id=$3 AND automation_id=$4
          AND state IN ('result_unknown','reconcile') FOR UPDATE`,
      [evidence.providerAttemptId, current.tenantId, current.sessionId, current.automationId],
    );
    const row = attempt.rows[0];
    if (!row) throw new SessionAutomationConflictError('CONFLICT', 'provider attempt 不存在或无需 reconcile', current);
    await client.query(
      `INSERT INTO ${this.tables.reconciliationReceipts}
        (reconciliation_receipt_id,provider_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,receipt_key,observed_state,receipt_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), row.provider_attempt_id, row.tenant_id, row.session_id, row.automation_id,
        row.incarnation_id, row.generation, row.execution_id, row.run_id, evidence.receiptKey,
        evidence.observedState, JSON.stringify(evidence.receiptPayload)],
    );
    const resolved = evidence.observedState === 'completed' || evidence.observedState === 'not_found';
    await client.query(
      `UPDATE ${this.tables.providerAttempts}
          SET state=$2,result_payload=CASE WHEN $2='completed' THEN $3::jsonb ELSE result_payload END,
              last_error=CASE WHEN $2='completed' THEN NULL ELSE 'reconciliation_inconclusive' END,
              completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,
              version=version+1,updated_at=now()
        WHERE provider_attempt_id=$1`,
      [row.provider_attempt_id, resolved ? 'completed' : 'result_unknown',
        JSON.stringify({ observedState: evidence.observedState, ...evidence.receiptPayload })],
    );
    await client.query(
      `UPDATE ${this.tables.budgetReservations}
          SET state=$3,version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND idempotency_key=$2 AND state IN ('result_unknown','reconcile','reserved')`,
      [row.tenant_id, row.idempotency_key,
        resolved ? (evidence.observedState === 'completed' ? 'settled' : 'released') : 'result_unknown'],
    );
    if (resolved) {
      await client.query(
        `INSERT INTO ${this.tables.budgetSettlements}
          (settlement_id,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,idempotency_key,amount,outcome,provider_receipt)
         SELECT $1,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,$2,amount,$3,$4::jsonb
           FROM ${this.tables.budgetReservations} WHERE tenant_id=$5 AND idempotency_key=$6
         ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
        [randomUUID(), `reconcile:${evidence.receiptKey}`,
          evidence.observedState === 'completed' ? 'charged' : 'released',
          JSON.stringify(evidence.receiptPayload), row.tenant_id, row.idempotency_key],
      );
      if (evidence.observedState === 'completed') {
        await client.query(
          `INSERT INTO ${this.tables.usage}
            (usage_id,tenant_id,session_id,automation_id,execution_id,source_key,source_kind,turns,tokens,credits)
           SELECT $1,tenant_id,session_id,automation_id,execution_id,$2,'provider_reconciliation',
                  CASE WHEN budget_kind='turns' THEN amount ELSE 0 END,
                  CASE WHEN budget_kind='tokens' THEN amount ELSE 0 END,
                  CASE WHEN budget_kind='credits' THEN amount ELSE 0 END
             FROM ${this.tables.budgetReservations} WHERE tenant_id=$3 AND idempotency_key=$4
           ON CONFLICT(tenant_id,automation_id,source_key) DO NOTHING`,
          [randomUUID(), `reconcile:${evidence.receiptKey}`, row.tenant_id, row.idempotency_key],
        );
      }
    }
    const evaluation = await client.query(
      `SELECT evaluation_id FROM ${this.tables.evaluations} WHERE provider_attempt_id=$1 FOR UPDATE`,
      [row.provider_attempt_id],
    );
    if (!evaluation.rows[0]) return resolved ? 'generic_resolved' : 'unresolved';
    if (evidence.observedState === 'not_found') {
      await client.query(
        `UPDATE ${this.tables.evaluations}
            SET state='pending',decision=$2,provider_attempt_id=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE evaluation_id=$1`,
        [evaluation.rows[0].evaluation_id, JSON.stringify({ reason: 'provider_receipt_not_found', receiptKey: evidence.receiptKey })],
      );
      return 'evaluation_retry';
    }
    if (evidence.observedState === 'completed') {
      await client.query(
        `UPDATE ${this.tables.evaluations}
            SET state='unverifiable',decision=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE evaluation_id=$1`,
        [evaluation.rows[0].evaluation_id, JSON.stringify({
          decision: 'unverifiable', reason: 'provider_receipt_completed_without_trusted_decision',
          confidence: 0, receiptKey: evidence.receiptKey,
        })],
      );
      return 'evaluation_completed';
    }
    return 'unresolved';
  }
  async control(client:Client,current:SessionAutomationSnapshot,action:'pause'|'resume'|'run'|'clear'|'reconcile',reconciliation?:SessionAutomationReconciliationEvidence):Promise<SessionAutomationSnapshot>{
    let status=current.status, phase=current.phase, generation=current.generation, epoch=0;
    if(action==='pause'){status='paused';phase=current.activeRunId?'running':'idle';generation++;await client.query(`UPDATE ${this.tables.wakeups} SET state='superseded' WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,[current.tenantId,current.automationId]);}
    if(action==='resume'){if(!['paused','blocked'].includes(status))throw new SessionAutomationConflictError('CONFLICT','仅 paused/blocked 可 resume',current);status='active';phase=current.activeRunId?'running':'waiting';generation++;epoch=1;if(current.activeRunId)await this.enqueueCancellationTx(client,current,current.activeRunId,'session_automation_resume_drain');}
    if(action==='clear'){status=current.activeRunId?'cancelling':'cancelled';phase=current.activeRunId?'running':'terminal';generation++;await client.query(`UPDATE ${this.tables.wakeups} SET state='superseded' WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,[current.tenantId,current.automationId]);if(current.activeRunId)await this.enqueueCancellationTx(client,current,current.activeRunId,'session_automation_clear');}
    if(action==='reconcile'){
      if(!reconciliation)throw new SessionAutomationConflictError('INVALID_COMMAND','reconcile 需要 provider receipt evidence',current);
      if(status!=='reconcile_required'){
        const duplicate=await client.query(`SELECT provider_attempt_id,observed_state,(receipt_payload=$3::jsonb) AS same_payload FROM ${this.tables.reconciliationReceipts} WHERE tenant_id=$1 AND receipt_key=$2`,[current.tenantId,reconciliation.receiptKey,JSON.stringify(reconciliation.receiptPayload)]);
        const row=duplicate.rows[0];
        if(row&&row.provider_attempt_id===reconciliation.providerAttemptId&&row.observed_state===reconciliation.observedState&&row.same_payload===true)return current;
        throw new SessionAutomationConflictError('CONFLICT','当前无需 reconcile',current);
      }
      const outcome=await this.reconcileProviderEvidence(client,current,reconciliation);
      if(outcome==='generic_resolved'){status='paused';phase=current.activeRunId?'running':'idle';generation++;if(current.activeRunId)await this.enqueueCancellationTx(client,current,current.activeRunId,'session_automation_reconciled_drain');}
      if(outcome==='evaluation_retry'){status='active';phase=current.activeRunId?'running':'waiting';}
      if(outcome==='evaluation_completed'){status='blocked';phase='idle';}
    }
    await client.query(`UPDATE ${this.tables.automations} SET status=$3,phase=$4,generation=$5,control_version=control_version+1,projection_version=projection_version+1,continuation_epoch=continuation_epoch+$6,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2`,[current.tenantId,current.automationId,status,phase,generation,epoch]);
    const next=(await this.getLocked(client,current.tenantId,current.sessionId,current.automationId))!;
    if(action==='resume'||action==='run')await this.scheduleTx(client,{tenantId:next.tenantId,sessionId:next.sessionId,automationId:next.automationId,incarnationId:next.incarnationId,generation:next.generation,specVersion:next.specVersion,continuationEpoch:epoch||Number(Date.now()),triggerKey:action==='run'?`manual:${next.automationId}:g${next.generation}:${randomUUID()}`:`initial:${next.automationId}:g${next.generation}:e${epoch}`,dueAt:new Date(),payload:{spec:next.spec}});
    await this.event(client,next,action,{}); return (await this.getLocked(client,next.tenantId,next.sessionId,next.automationId))!;
  }
  async scheduleTx(client:Client,input:{tenantId:string;sessionId:string;automationId:string;incarnationId:string;generation:number;specVersion:number;continuationEpoch:number;triggerKey:string;dueAt:Date;payload:unknown}):Promise<string>{const id=randomUUID();await client.query(`INSERT INTO ${this.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,automation_id,trigger_key) DO NOTHING`,[id,input.tenantId,input.sessionId,input.automationId,input.incarnationId,input.generation,input.specVersion,input.continuationEpoch,input.triggerKey,input.dueAt]);await client.query(`UPDATE ${this.tables.automations} SET next_wakeup_at=LEAST(COALESCE(next_wakeup_at,$3),$3),phase=CASE WHEN active_run_id IS NULL THEN 'waiting' ELSE 'running' END,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2`,[input.tenantId,input.automationId,input.dueAt]);return id;}
  private async enqueueCancellationTx(client:Client,current:SessionAutomationSnapshot,runId:string,reason:string):Promise<void>{await client.query(`INSERT INTO ${this.tables.cancellations}(cancellation_id,tenant_id,session_id,automation_id,run_id,requested_generation,reason) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,run_id) DO UPDATE SET state=CASE WHEN ${this.tables.cancellations}.state='completed' THEN 'completed' ELSE 'pending' END,next_attempt_at=now(),updated_at=now()`,[randomUUID(),current.tenantId,current.sessionId,current.automationId,runId,current.generation,reason]);}
  async claimCancellations(limit=10,leaseMs=30_000):Promise<ClaimedCancellation[]>{return this.tx(async c=>{const r=await c.query(`SELECT * FROM ${this.tables.cancellations} WHERE state IN ('pending','claimed') AND next_attempt_at<=now() AND (state='pending' OR lease_expires_at<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`,[limit]);const items:ClaimedCancellation[]=[];for(const row of r.rows){const leaseToken=randomUUID();await c.query(`UPDATE ${this.tables.cancellations} SET state='claimed',lease_token=$2,lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1,updated_at=now() WHERE cancellation_id=$1`,[row.cancellation_id,leaseToken,leaseMs]);items.push({cancellationId:row.cancellation_id,tenantId:row.tenant_id,sessionId:row.session_id,automationId:row.automation_id,runId:row.run_id,reason:row.reason,leaseToken,requestedGeneration:Number(row.requested_generation)});}return items;});}
  async completeCancellation(item:ClaimedCancellation):Promise<void>{await this.tx(async c=>{const completed=await c.query(`UPDATE ${this.tables.cancellations} SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE cancellation_id=$1 AND lease_token=$2 AND state='claimed' RETURNING cancellation_id`,[item.cancellationId,item.leaseToken]);if(!completed.rows[0])return;await c.query(`UPDATE ${this.tables.automations} SET status=CASE WHEN status='cancelling' THEN 'cancelled' ELSE status END,phase=CASE WHEN status='cancelling' THEN 'terminal' WHEN status='paused' THEN 'idle' WHEN status='active' AND next_wakeup_at IS NOT NULL THEN 'waiting' ELSE phase END,active_run_id=CASE WHEN active_run_id=$3 THEN NULL ELSE active_run_id END,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$3`,[item.tenantId,item.automationId,item.runId]);const next=await this.getLocked(c,item.tenantId,item.sessionId,item.automationId);if(next)await this.event(c,next,'automation_state_changed',{reason:item.reason,snapshot:next});});}
  async failCancellation(item:ClaimedCancellation,error:unknown):Promise<void>{await this.pool.query(`UPDATE ${this.tables.cancellations} SET state=CASE WHEN attempt_count>=10 THEN 'dead' ELSE 'pending' END,next_attempt_at=now()+LEAST(attempt_count,10)*interval '5 seconds',lease_token=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now() WHERE cancellation_id=$1 AND lease_token=$2`,[item.cancellationId,item.leaseToken,error instanceof Error?error.message:String(error)]);}
  async recordUsage(input:{tenantId:string;sessionId:string;automationId:string;executionId?:string;sourceKey:string;sourceKind:string;turns?:number;tokens?:number;credits?:number},client?:Client):Promise<void>{const q=client??this.pool;await q.query(`INSERT INTO ${this.tables.usage}(usage_id,tenant_id,session_id,automation_id,execution_id,source_key,source_kind,turns,tokens,credits) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,automation_id,source_key) DO NOTHING`,[randomUUID(),input.tenantId,input.sessionId,input.automationId,input.executionId??null,input.sourceKey,input.sourceKind,Math.max(0,input.turns??0),Math.max(0,input.tokens??0),Math.max(0,input.credits??0)]);}
  async budgetReasonTx(client:Client,tenantId:string,sessionId:string,automationId:string):Promise<string|undefined>{
    await client.query(`SELECT automation_id FROM ${this.tables.automations} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 FOR UPDATE`,[tenantId,sessionId,automationId]);
    return resolveAutomationBudgetReason({client,tables:this.tables,tablePrefix:this.tablePrefix,runsTable:this.runsTable,tenantId,sessionId,automationId});
  }
  async claimDue(limit=25,leaseMs=30_000):Promise<number>{return this.tx(async c=>{const r=await c.query(`SELECT w.* FROM ${this.tables.wakeups} w JOIN ${this.tables.automations} a USING(automation_id) WHERE w.state='pending' AND w.due_at<=now() AND a.status='active' AND a.active_run_id IS NULL AND a.generation=w.generation AND a.incarnation_id=w.incarnation_id ORDER BY w.due_at FOR UPDATE OF w,a SKIP LOCKED LIMIT $1`,[limit]);let claimed=0;for(const w of r.rows){const reason=await this.budgetReasonTx(c,w.tenant_id,w.session_id,w.automation_id);if(reason){await c.query(`UPDATE ${this.tables.wakeups} SET state='superseded',last_error=$2 WHERE wakeup_id=$1`,[w.wakeup_id,`budget:${reason}`]);await this.expireForBudgetTx(c,w.tenant_id,w.automation_id,reason);continue;}const outboxId=randomUUID(),targetRunId=deterministicRunId(w.tenant_id,w.session_id,w.trigger_key);await c.query(`UPDATE ${this.tables.wakeups} SET state='claimed',lease_token=$2,lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1 WHERE wakeup_id=$1`,[w.wakeup_id,randomUUID(),leaseMs]);await c.query(`INSERT INTO ${this.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(tenant_id,wakeup_id) DO NOTHING`,[outboxId,w.wakeup_id,w.tenant_id,w.session_id,w.automation_id,w.incarnation_id,w.generation,w.spec_version,w.continuation_epoch,w.trigger_key,targetRunId,JSON.stringify({automationId:w.automation_id,triggerKey:w.trigger_key})]);claimed++;}return claimed;});}
  async claimDispatch(limit=10,leaseMs=30_000):Promise<ClaimedDispatch[]>{return this.tx(async c=>{const r=await c.query(`SELECT o.* FROM ${this.tables.outbox} o JOIN ${this.tables.automations} a USING(automation_id) WHERE o.state='pending' AND o.next_attempt_at<=now() AND a.status='active' AND a.active_run_id IS NULL AND a.generation=o.generation AND a.incarnation_id=o.incarnation_id ORDER BY o.created_at FOR UPDATE OF o,a SKIP LOCKED LIMIT $1`,[limit]);const result:ClaimedDispatch[]=[];for(const o of r.rows){const reason=await this.budgetReasonTx(c,o.tenant_id,o.session_id,o.automation_id);if(reason){await this.expireForBudgetTx(c,o.tenant_id,o.automation_id,reason);await c.query(`UPDATE ${this.tables.outbox} SET state='dead',last_error=$2,lease_token=NULL,lease_expires_at=NULL WHERE outbox_id=$1`,[o.outbox_id,`budget:${reason}`]);continue;}const token=randomUUID();await c.query(`UPDATE ${this.tables.outbox} SET state='dispatching',lease_token=$2,lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1 WHERE outbox_id=$1`,[o.outbox_id,token,leaseMs]);result.push({outboxId:o.outbox_id,wakeupId:o.wakeup_id,automationId:o.automation_id,tenantId:o.tenant_id,sessionId:o.session_id,targetRunId:o.target_run_id,triggerKey:o.trigger_key,payload:o.payload,leaseToken:token,generation:Number(o.generation),specVersion:Number(o.spec_version),incarnationId:o.incarnation_id});}return result;});}
  private async expireForBudgetTx(c:Client,tenantId:string,automationId:string,reason:string):Promise<void>{await c.query(`UPDATE ${this.tables.automations} SET status='expired',phase='terminal',limit_hit_reason=COALESCE(limit_hit_reason,$3),limit_hit_at=COALESCE(limit_hit_at,now()),next_wakeup_at=NULL,control_version=control_version+1,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2`,[tenantId,automationId,reason]);}
  async prepareDispatch(item:ClaimedDispatch,requestPayload:Record<string,unknown>):Promise<string>{return this.tx(async c=>{await c.query(`INSERT INTO ${this.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared') ON CONFLICT(outbox_id) DO NOTHING`,[item.outboxId,item.tenantId,item.sessionId,item.automationId,item.incarnationId,item.generation,item.specVersion,item.outboxId,item.targetRunId]);const r=await c.query(`INSERT INTO ${this.tables.preparedDispatchAttempts}(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,outbox_id,idempotency_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,idempotency_key) DO UPDATE SET updated_at=now() WHERE ${this.tables.preparedDispatchAttempts}.outbox_id=EXCLUDED.outbox_id RETURNING prepared_dispatch_attempt_id`,[randomUUID(),item.tenantId,item.sessionId,item.automationId,item.incarnationId,item.generation,item.outboxId,item.targetRunId,item.outboxId,`dispatch:${item.outboxId}`,JSON.stringify(requestPayload)]);if(r.rowCount!==1)throw new SessionAutomationConflictError('STALE_GENERATION','prepared dispatch lineage mismatch');return String(r.rows[0].prepared_dispatch_attempt_id);});}
  async transitionPreparedDispatch(outboxId:string,from:'prepared'|'dispatched'|'result_unknown'|'reconcile',to:'dispatched'|'completed'|'result_unknown'|'reconcile',lastError?:string):Promise<boolean>{const r=await this.pool.query(`UPDATE ${this.tables.preparedDispatchAttempts} SET state=$3,version=version+1,last_error=$4,dispatched_at=CASE WHEN $3='dispatched' THEN COALESCE(dispatched_at,now()) ELSE dispatched_at END,completed_at=CASE WHEN $3='completed' THEN now() ELSE completed_at END,updated_at=now() WHERE outbox_id=$1 AND state=$2`,[outboxId,from,to,lastError??null]);return r.rowCount===1;}
  async listRecoverablePreparedDispatches(limit=50):Promise<Array<{outboxId:string;runId:string;state:string;requestPayload:Record<string,unknown>}>>{const r=await this.pool.query(`SELECT outbox_id,run_id,state,request_payload FROM ${this.tables.preparedDispatchAttempts} WHERE state IN ('prepared','result_unknown','reconcile') ORDER BY prepared_at LIMIT $1`,[limit]);return r.rows.map(row=>({outboxId:String(row.outbox_id),runId:String(row.run_id),state:String(row.state),requestPayload:(row.request_payload??{}) as Record<string,unknown>}));}
  async markDispatched(item:ClaimedDispatch):Promise<void>{await this.tx(async c=>{const r=await c.query(`UPDATE ${this.tables.outbox} o SET state='dispatched',lease_expires_at=NULL FROM ${this.tables.automations} a WHERE o.outbox_id=$1 AND o.lease_token=$2 AND o.state='dispatching' AND a.automation_id=o.automation_id AND a.status='active' AND a.active_run_id IS NULL AND a.generation=o.generation AND a.incarnation_id=o.incarnation_id RETURNING o.*`,[item.outboxId,item.leaseToken]);if(!r.rows[0])throw new SessionAutomationConflictError('STALE_GENERATION','dispatch fence lost');await c.query(`INSERT INTO ${this.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running') ON CONFLICT(outbox_id) DO UPDATE SET state='running',updated_at=now()`,[item.outboxId,item.tenantId,item.sessionId,item.automationId,item.incarnationId,item.generation,item.specVersion,item.outboxId,item.targetRunId]);const activated=await c.query(`UPDATE ${this.tables.automations} SET phase='running',active_run_id=$3,next_wakeup_at=NULL,run_count=run_count+1,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND status='active' AND active_run_id IS NULL AND generation=$4 AND incarnation_id=$5 RETURNING automation_id`,[item.tenantId,item.automationId,item.targetRunId,item.generation,item.incarnationId]);if(!activated.rows[0])throw new SessionAutomationConflictError('STALE_GENERATION','dispatch active-run fence lost');const next=await this.getLocked(c,item.tenantId,item.sessionId,item.automationId);if(next)await this.event(c,next,'automation_execution_changed',{runId:item.targetRunId,phase:'running',snapshot:next});});}
  async failDispatch(item:ClaimedDispatch,error:unknown):Promise<void>{await this.pool.query(`UPDATE ${this.tables.outbox} SET state=CASE WHEN attempt_count>=5 THEN 'dead' ELSE 'pending' END,next_attempt_at=now()+interval '30 seconds',lease_token=NULL,lease_expires_at=NULL,last_error=$3 WHERE outbox_id=$1 AND lease_token=$2`,[item.outboxId,item.leaseToken,error instanceof Error?error.message:String(error)]);}
  async supersedeDispatch(item:ClaimedDispatch,cancelStaged=false):Promise<void>{await this.tx(async c=>{await c.query(`UPDATE ${this.tables.outbox} SET state='dead',lease_token=NULL,lease_expires_at=NULL,last_error='stale_fence' WHERE outbox_id=$1 AND lease_token=$2`,[item.outboxId,item.leaseToken]);if(cancelStaged){const current=await this.getLocked(c,item.tenantId,item.sessionId,item.automationId);if(current)await this.enqueueCancellationTx(c,current,item.targetRunId,'session_automation_stale_dispatch');}});}
  async recoverLeases():Promise<void>{await this.tx(async c=>{await c.query(`UPDATE ${this.tables.wakeups} SET state='pending',lease_token=NULL,lease_expires_at=NULL WHERE state='claimed' AND lease_expires_at<now() AND NOT EXISTS(SELECT 1 FROM ${this.tables.outbox} o WHERE o.wakeup_id=${this.tables.wakeups}.wakeup_id)`);await c.query(`UPDATE ${this.tables.outbox} SET state=CASE WHEN attempt_count>=5 THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,last_error=COALESCE(last_error,'dispatch_lease_expired') WHERE state='dispatching' AND lease_expires_at<now()`);await c.query(`UPDATE ${this.tables.cancellations} SET state=CASE WHEN attempt_count>=10 THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now(),last_error=COALESCE(last_error,'cancel_lease_expired'),updated_at=now() WHERE state='claimed' AND lease_expires_at<now()`);});}
  async latestEventCursor(tenantId:string,sessionId:string,automationId:string):Promise<string|null>{const r=await this.pool.query(`SELECT MAX(event_sequence)::text AS cursor FROM ${this.tables.events} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,[tenantId,sessionId,automationId]);return r.rows[0]?.cursor??null;}
  async listEvents(tenantId:string,sessionId:string,automationId:string,cursor?:string,limit=100):Promise<{events:Array<Record<string,unknown>>;nextCursor:string|null}>{const values:unknown[]=[tenantId,sessionId,automationId];let after='';if(cursor&&/^\d+$/.test(cursor)){values.push(cursor);after=` AND event_sequence>$${values.length}`;}values.push(Math.min(Math.max(limit,1),200));const r=await this.pool.query(`SELECT event_sequence,automation_event_id,event_type,event_payload,projection_version,run_id,created_at FROM ${this.tables.events} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3${after} ORDER BY event_sequence LIMIT $${values.length}`,values);return{events:r.rows.map(row=>({eventId:row.automation_event_id,type:row.event_type,...row.event_payload,projectionVersion:Number(row.projection_version),runId:row.run_id??undefined,createdAt:new Date(row.created_at).toISOString()})),nextCursor:r.rows.length?String(r.rows[r.rows.length-1].event_sequence):cursor??null};}
  async event(c:Client,s:SessionAutomationSnapshot,type:string,payload:unknown):Promise<void>{await c.query(`INSERT INTO ${this.tables.events}(automation_event_id,tenant_id,session_id,automation_id,generation,spec_version,control_version,projection_version,event_type,event_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),s.tenantId,s.sessionId,s.automationId,s.generation,s.specVersion,s.controlVersion,s.projectionVersion,type,JSON.stringify(payload)]);}
}
export function specDigest(spec:SessionAutomationSpec):string{return createHash('sha256').update(JSON.stringify(spec)).digest('hex');}
export function commandDigest(command:string):string{return createHash('sha256').update(command.trim()).digest('hex');}
export function deterministicRunId(tenantId:string,sessionId:string,triggerKey:string):string{const hex=createHash('sha256').update(`${tenantId}\0${sessionId}\0${triggerKey}`).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
