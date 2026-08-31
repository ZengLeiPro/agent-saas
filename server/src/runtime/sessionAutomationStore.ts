import { createHash, randomUUID } from 'node:crypto'; // durable idempotency and lifecycle closure identities
import type pg from 'pg';
import type { SessionAutomationSnapshot, SessionAutomationSpec } from '@agent/shared';
import { applySessionAutomationSchema, sessionAutomationTables, type SessionAutomationTables } from './sessionAutomationStoreSchema.js';
import { resolveAutomationBudgetReason } from './sessionAutomationBudgetProgress.js';
import { reduceAutomationInFlight, type AutomationDesiredTerminalStatus, type AutomationInFlightSummary } from './sessionAutomationInFlight.js';

type Pool = pg.Pool; // all mutations remain transaction-scoped
type Client = pg.PoolClient;
export interface SessionAutomationReconciliationEvidence {providerAttemptId:string;receiptKey:string;observedState:'completed'|'not_found'|'still_running'|'ambiguous';receiptAuthority:'provider_adapter'|'operator';receiptPayload:Record<string,unknown>;}
export type SessionAutomationLifecycleObjectType = 'run'|'execution'|'evaluation'|'provider_attempt'|'interaction'|'background_resource'|'budget_reservation'|'outbox';
export interface SessionAutomationLifecycleJob {
  workId:string;tenantId:string;sessionId:string;automationId:string;incarnationId:string;generation:number;
  objectIncarnationId:string;objectGeneration:number;objectType:SessionAutomationLifecycleObjectType;objectId:string;
  action:'cancel'|'complete'|'release'|'reconcile';attemptCount:number;details:Record<string,unknown>;
}
export interface SessionAutomationLifecycleReceipt extends Omit<SessionAutomationLifecycleJob,'attemptCount'|'details'> {
  receiptKey:string;authority:'server_internal'|'runtime'|'provider'|'operator';
  outcome:'completed'|'pending'|'result_unknown';payload:Record<string,unknown>;
}
export function lifecycleRetryDelaySeconds(attemptCount:number):number{return Math.min(300,5*(2**Math.min(Math.max(0,attemptCount-1),6)));}
export function lifecycleWaitsForAuthority(objectType:SessionAutomationLifecycleObjectType):boolean{return ['provider_attempt','interaction','background_resource'].includes(objectType);}

export interface SessionAutomationLifecycleAdapter { execute(job:SessionAutomationLifecycleJob):Promise<SessionAutomationLifecycleReceipt>; }
export type SessionAutomationLifecycleAdapters = Partial<Record<SessionAutomationLifecycleObjectType,SessionAutomationLifecycleAdapter>>;
export function isSessionAutomationLifecycleReceiptForJob(job:SessionAutomationLifecycleJob,receipt:SessionAutomationLifecycleReceipt):boolean{return receipt.workId===job.workId&&receipt.tenantId===job.tenantId&&receipt.sessionId===job.sessionId&&receipt.automationId===job.automationId&&receipt.incarnationId===job.incarnationId&&receipt.generation===job.generation&&receipt.objectIncarnationId===job.objectIncarnationId&&receipt.objectGeneration===job.objectGeneration&&receipt.objectType===job.objectType&&receipt.objectId===job.objectId&&receipt.action===job.action;}

export interface AutomationIdentity { tenantId: string; sessionId: string; ownerUserId: string; sessionMetaCreated?: boolean; }
export interface SessionAutomationCommandReceipt { clientMessageId:string;sessionId:string;commandDigest:string;canonicalRequest:Record<string,unknown>;state:'prepared'|'file_ready'|'committed'|'compensated';automationId?:string;response?:unknown;cursor:string|null;lastError?:string;failureCode?:string;sessionMetaCreated:boolean; }

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
  private receipt(row:Record<string,unknown>):SessionAutomationCommandReceipt{return{clientMessageId:String(row.client_message_id),sessionId:String(row.session_id),commandDigest:String(row.command_digest),canonicalRequest:(row.canonical_request??{}) as Record<string,unknown>,state:row.state as SessionAutomationCommandReceipt['state'],...(row.automation_id?{automationId:String(row.automation_id)}:{}),...(row.response!==null&&row.response!==undefined?{response:row.response}:{}),cursor:row.response_cursor===null||row.response_cursor===undefined?null:String(row.response_cursor),...(row.last_error?{lastError:String(row.last_error)}:{}),...(row.failure_code?{failureCode:String(row.failure_code)}:{}),sessionMetaCreated:row.session_meta_created===true};}
  async findCommand(client:Client,id:AutomationIdentity,clientMessageId:string,digest:string):Promise<SessionAutomationCommandReceipt|undefined>{await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[id.tenantId+':'+id.ownerUserId,clientMessageId]);const r=await client.query(`SELECT * FROM ${this.tables.commands} WHERE tenant_id=$1 AND owner_user_id=$2 AND client_message_id=$3 FOR UPDATE`,[id.tenantId,id.ownerUserId,clientMessageId]);if(!r.rows[0])return undefined;if(r.rows[0].command_digest!==digest)throw new SessionAutomationConflictError('CONFLICT','clientMessageId 已用于不同命令');return this.receipt(r.rows[0]);}
  async getCommandReceipt(tenantId:string,ownerUserId:string,clientMessageId:string):Promise<SessionAutomationCommandReceipt|undefined>{const r=await this.pool.query(`SELECT * FROM ${this.tables.commands} WHERE tenant_id=$1 AND owner_user_id=$2 AND client_message_id=$3`,[tenantId,ownerUserId,clientMessageId]);return r.rows[0]?this.receipt(r.rows[0]):undefined;}
  async recordCommand(client:Client,id:AutomationIdentity,sessionId:string,clientMessageId:string,digest:string,automationId:string|undefined,response:unknown,canonicalRequest:Record<string,unknown>={}):Promise<string|null>{const cursor=automationId?(await client.query(`SELECT MAX(event_sequence)::text cursor FROM ${this.tables.events} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,[id.tenantId,sessionId,automationId])).rows[0]?.cursor??null:null;const r=await client.query(`INSERT INTO ${this.tables.commands}(tenant_id,owner_user_id,client_message_id,session_id,command_digest,canonical_request,automation_id,response,response_cursor,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'committed') ON CONFLICT(tenant_id,owner_user_id,client_message_id) DO UPDATE SET automation_id=EXCLUDED.automation_id,response=EXCLUDED.response,response_cursor=EXCLUDED.response_cursor,state='committed',last_error=NULL,failure_code=NULL,updated_at=now() WHERE ${this.tables.commands}.command_digest=EXCLUDED.command_digest AND ${this.tables.commands}.session_id=EXCLUDED.session_id RETURNING response_cursor::text cursor`,[id.tenantId,id.ownerUserId,clientMessageId,sessionId,digest,JSON.stringify(canonicalRequest),automationId??null,JSON.stringify(response),cursor]);if(!r.rows[0])throw new SessionAutomationConflictError('CONFLICT','command receipt 无法提交');return r.rows[0].cursor??null;}
  async prepareCommandSession(input:{tenantId:string;ownerUserId:string;clientMessageId:string;commandDigest:string;canonicalRequest:Record<string,unknown>;sessionId:string}):Promise<string>{return this.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[input.tenantId+':'+input.ownerUserId,input.clientMessageId]);const existing=await c.query(`SELECT session_id,command_digest,state,failure_code,last_error FROM ${this.tables.commands} WHERE tenant_id=$1 AND owner_user_id=$2 AND client_message_id=$3 FOR UPDATE`,[input.tenantId,input.ownerUserId,input.clientMessageId]);if(existing.rows[0]){if(existing.rows[0].command_digest!==input.commandDigest)throw new SessionAutomationConflictError('CONFLICT','clientMessageId 已用于不同命令');if(existing.rows[0].state==='compensated')throw new SessionAutomationConflictError(String(existing.rows[0].failure_code??'CONFLICT'),String(existing.rows[0].last_error??'creation command failed'));return String(existing.rows[0].session_id);}await c.query(`INSERT INTO ${this.tables.commands}(tenant_id,owner_user_id,client_message_id,session_id,command_digest,canonical_request,state) VALUES($1,$2,$3,$4,$5,$6,'prepared')`,[input.tenantId,input.ownerUserId,input.clientMessageId,input.sessionId,input.commandDigest,JSON.stringify(input.canonicalRequest)]);return input.sessionId;});}
  async markCommandFileReady(input:{tenantId:string;ownerUserId:string;clientMessageId:string;commandDigest:string;sessionId:string;sessionMetaCreated?:boolean}):Promise<void>{const r=await this.pool.query(`UPDATE ${this.tables.commands} SET state=CASE WHEN state='prepared' THEN 'file_ready' ELSE state END,session_meta_created=session_meta_created OR $6,updated_at=now() WHERE tenant_id=$1 AND owner_user_id=$2 AND client_message_id=$3 AND command_digest=$4 AND session_id=$5 AND state<>'compensated' RETURNING state`,[input.tenantId,input.ownerUserId,input.clientMessageId,input.commandDigest,input.sessionId,input.sessionMetaCreated===true]);if(!r.rows[0])throw new SessionAutomationConflictError('CONFLICT','creation receipt 不匹配');}
  async compensateCommand(input:{tenantId:string;ownerUserId:string;clientMessageId:string;commandDigest:string;error:unknown}):Promise<{sessionMetaCreated:boolean}>{const code=input.error instanceof SessionAutomationConflictError?input.error.code:'INTERNAL_ERROR';const r=await this.pool.query(`UPDATE ${this.tables.commands} SET state='compensated',last_error=$5,failure_code=$6,updated_at=now() WHERE tenant_id=$1 AND owner_user_id=$2 AND client_message_id=$3 AND command_digest=$4 AND state IN ('prepared','file_ready') RETURNING session_meta_created`,[input.tenantId,input.ownerUserId,input.clientMessageId,input.commandDigest,input.error instanceof Error?input.error.message:String(input.error),code]);return{sessionMetaCreated:r.rows[0]?.session_meta_created===true};}
  private async assertMutationNotDraining(client:Client,tenantId:string,sessionId:string,automationId?:string):Promise<void>{
    const draining=await client.query(`SELECT a.automation_id FROM ${this.tables.automations} a
      WHERE a.tenant_id=$1 AND a.session_id=$2 AND ($3::uuid IS NULL OR a.automation_id=$3::uuid)
        AND (a.status IN ('completing','cancelling','reconcile_required') OR a.desired_terminal_status IS NOT NULL
          OR EXISTS (SELECT 1 FROM ${this.tables.lifecycleWork} l WHERE l.tenant_id=a.tenant_id AND l.session_id=a.session_id AND l.automation_id=a.automation_id AND l.state<>'completed'))
      LIMIT 1 FOR UPDATE OF a`,[tenantId,sessionId,automationId??null]);
    if(draining.rows[0])throw new SessionAutomationConflictError('AUTOMATION_DRAINING','automation 正在收口，暂不可 edit/replace');
  }
  async create(client:Client,id:AutomationIdentity,spec:SessionAutomationSpec,now:Date):Promise<SessionAutomationSnapshot>{
    await this.assertMutationNotDraining(client,id.tenantId,id.sessionId);
    const automationId=randomUUID(),incarnationId=randomUUID(), digest=specDigest(spec);
    await client.query(`INSERT INTO ${this.tables.automations}(automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'active','waiting')`,[automationId,id.tenantId,id.sessionId,id.ownerUserId,incarnationId,spec.kind,spec.mode]);
    await client.query(`INSERT INTO ${this.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,1,$4,$5)`,[automationId,id.tenantId,id.sessionId,digest,JSON.stringify(spec)]);
    if(spec.kind==='goal')await client.query(`INSERT INTO ${this.tables.completionAllowances}(automation_id,tenant_id,session_id,remaining_attempts,max_output_tokens) VALUES($1,$2,$3,2,500)`,[automationId,id.tenantId,id.sessionId]);
    const due=spec.mode==='fixed'?new Date(now.getTime()+spec.intervalMs!):now; await this.scheduleTx(client,{tenantId:id.tenantId,sessionId:id.sessionId,automationId,incarnationId,generation:1,specVersion:1,continuationEpoch:1,triggerKey:`initial:${automationId}:g1:e1`,dueAt:due,payload:{spec}});
    const created=await this.getLocked(client,id.tenantId,id.sessionId,automationId); if(!created)throw new Error('automation insert lost'); await this.event(client,created,'created',{}); return created;
  }
  async replace(client:Client,current:SessionAutomationSnapshot,spec:SessionAutomationSpec):Promise<SessionAutomationSnapshot>{
    await this.assertMutationNotDraining(client,current.tenantId,current.sessionId,current.automationId);
    const incarnationId=randomUUID(),generation=current.generation+1,specVersion=current.specVersion+1;
    if(current.activeRunId)await this.enqueueCancellationTx(client,current,current.activeRunId,'session_automation_replace');
    await client.query(`UPDATE ${this.tables.wakeups} SET state='superseded' WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,[current.tenantId,current.automationId]);
    await client.query(`UPDATE ${this.tables.automations} SET incarnation_id=$3,kind=$4,mode=$5,status='active',phase=CASE WHEN active_run_id IS NULL THEN 'waiting' ELSE 'running' END,generation=$6,spec_version=$7,control_version=control_version+1,projection_version=projection_version+1,continuation_epoch=1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2`,[current.tenantId,current.automationId,incarnationId,spec.kind,spec.mode,generation,specVersion]);
    await client.query(`INSERT INTO ${this.tables.specs}(automation_id,tenant_id,session_id,spec_version,spec_digest,spec) VALUES($1,$2,$3,$4,$5,$6)`,[current.automationId,current.tenantId,current.sessionId,specVersion,specDigest(spec),JSON.stringify(spec)]);
    if(spec.kind==='goal')await client.query(`INSERT INTO ${this.tables.completionAllowances}(automation_id,tenant_id,session_id,remaining_attempts,max_output_tokens) VALUES($1,$2,$3,2,500) ON CONFLICT(automation_id) DO UPDATE SET remaining_attempts=2,max_output_tokens=500,updated_at=now()`,[current.automationId,current.tenantId,current.sessionId]);
    else await client.query(`DELETE FROM ${this.tables.completionAllowances} WHERE automation_id=$1`,[current.automationId]);
    const due=spec.mode==='fixed'?new Date(Date.now()+spec.intervalMs!):new Date(); await this.scheduleTx(client,{tenantId:current.tenantId,sessionId:current.sessionId,automationId:current.automationId,incarnationId,generation,specVersion,continuationEpoch:1,triggerKey:`initial:${current.automationId}:g${generation}:e1`,dueAt:due,payload:{spec}});
    const replaced=(await this.getLocked(client,current.tenantId,current.sessionId,current.automationId))!;await this.event(client,replaced,'replaced',{previousIncarnationId:current.incarnationId});return replaced;
  }
  private async reconcileProviderEvidence(
    client: Client,
    current: SessionAutomationSnapshot,
    evidence: SessionAutomationReconciliationEvidence,
  ): Promise<'unresolved'|'generic_resolved'|'evaluation_retry'|'evaluation_completed'> {
    const duplicate = await client.query(
      `SELECT provider_attempt_id,observed_state,receipt_authority,(receipt_payload=$3::jsonb) AS same_payload
         FROM ${this.tables.reconciliationReceipts}
        WHERE tenant_id=$1 AND receipt_key=$2 FOR UPDATE`,
      [current.tenantId, evidence.receiptKey, JSON.stringify(evidence.receiptPayload)],
    );
    if (duplicate.rows[0]) {
      const same = duplicate.rows[0].provider_attempt_id === evidence.providerAttemptId
        && duplicate.rows[0].observed_state === evidence.observedState
        && duplicate.rows[0].receipt_authority === evidence.receiptAuthority
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
        (reconciliation_receipt_id,provider_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,receipt_key,observed_state,receipt_authority,receipt_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [randomUUID(), row.provider_attempt_id, row.tenant_id, row.session_id, row.automation_id,
        row.incarnation_id, row.generation, row.execution_id, row.run_id, evidence.receiptKey,
        evidence.observedState, evidence.receiptAuthority, JSON.stringify(evidence.receiptPayload)],
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
        WHERE tenant_id=$1 AND idempotency_key LIKE $2 || ':%' AND state IN ('result_unknown','reconcile','reserved')`,
      [row.tenant_id, row.idempotency_key,
        resolved ? (evidence.observedState === 'completed' ? 'settled' : 'released') : 'result_unknown'],
    );
    if (resolved) {
      await client.query(
        `INSERT INTO ${this.tables.budgetSettlements}
          (settlement_id,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,idempotency_key,amount,outcome,provider_receipt)
         SELECT reservation_id,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,$1 || ':' || budget_kind,amount,$2,$3::jsonb
           FROM ${this.tables.budgetReservations} WHERE tenant_id=$4 AND idempotency_key LIKE $5 || ':%'
         ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
        [`reconcile:${evidence.receiptKey}`,
          evidence.observedState === 'completed' ? 'charged' : 'released',
          JSON.stringify(evidence.receiptPayload), row.tenant_id, row.idempotency_key],
      );
      if (evidence.observedState === 'completed') {
        await client.query(
          `INSERT INTO ${this.tables.usage}
            (usage_id,tenant_id,session_id,automation_id,execution_id,source_key,source_kind,turns,tokens,credits)
           SELECT $1,tenant_id,session_id,automation_id,execution_id,$2,'provider_reconciliation',
                  SUM(CASE WHEN budget_kind='turns' THEN amount ELSE 0 END),
                  SUM(CASE WHEN budget_kind='tokens' THEN amount ELSE 0 END),
                  SUM(CASE WHEN budget_kind='credits' THEN amount ELSE 0 END)
             FROM ${this.tables.budgetReservations} WHERE tenant_id=$3 AND idempotency_key LIKE $4 || ':%'
             GROUP BY tenant_id,session_id,automation_id,execution_id
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
    if(action==='clear')return this.beginTerminalDrainLocked(client,current,'cancelled','session_automation_clear');
    if(action==='reconcile'){
      if(!reconciliation)throw new SessionAutomationConflictError('INVALID_COMMAND','reconcile 需要 provider receipt evidence',current);
      if(status!=='reconcile_required'){
        const duplicate=await client.query(`SELECT provider_attempt_id,observed_state,receipt_authority,(receipt_payload=$3::jsonb) AS same_payload FROM ${this.tables.reconciliationReceipts} WHERE tenant_id=$1 AND receipt_key=$2`,[current.tenantId,reconciliation.receiptKey,JSON.stringify(reconciliation.receiptPayload)]);
        const row=duplicate.rows[0];
        if(row&&row.provider_attempt_id===reconciliation.providerAttemptId&&row.observed_state===reconciliation.observedState&&row.receipt_authority===reconciliation.receiptAuthority&&row.same_payload===true)return current;
        throw new SessionAutomationConflictError('CONFLICT','当前无需 reconcile',current);
      }
      const outcome=await this.reconcileProviderEvidence(client,current,reconciliation);
      const drain=await client.query(`SELECT desired_terminal_status FROM ${this.tables.automations} WHERE tenant_id=$1 AND automation_id=$2`,[current.tenantId,current.automationId]);
      if(drain.rows[0]?.desired_terminal_status){
        if(outcome!=='unresolved'){
          await client.query(`UPDATE ${this.tables.lifecycleWork} SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed','result_unknown') AND ((object_type='provider_attempt' AND object_id=$3) OR (object_type='budget_reservation' AND object_id IN (SELECT r.reservation_id::text FROM ${this.tables.budgetReservations} r JOIN ${this.tables.providerAttempts} p ON p.tenant_id=r.tenant_id AND p.idempotency_key=r.idempotency_key WHERE p.provider_attempt_id=$3)))`,[current.tenantId,current.automationId,reconciliation.providerAttemptId]);
          const next=await this.tryFinalizeLocked(client,current.tenantId,current.sessionId,current.automationId);if(next)await this.event(client,next,'automation_reconciled',{providerAttemptId:reconciliation.providerAttemptId,snapshot:next});return next!;
        }
        return current;
      }
      if(outcome==='generic_resolved'){status='paused';phase=current.activeRunId?'running':'idle';generation++;if(current.activeRunId)await this.enqueueCancellationTx(client,current,current.activeRunId,'session_automation_reconciled_drain');}
      if(outcome==='evaluation_retry'){status='active';phase=current.activeRunId?'running':'waiting';}
      if(outcome==='evaluation_completed'){status='blocked';phase='idle';}
    }
    await client.query(`UPDATE ${this.tables.automations} SET status=$3,phase=$4,generation=$5,control_version=control_version+1,projection_version=projection_version+1,continuation_epoch=continuation_epoch+$6,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2`,[current.tenantId,current.automationId,status,phase,generation,epoch]);
    const next=(await this.getLocked(client,current.tenantId,current.sessionId,current.automationId))!;
    if(action==='resume'||action==='run')await this.scheduleTx(client,{tenantId:next.tenantId,sessionId:next.sessionId,automationId:next.automationId,incarnationId:next.incarnationId,generation:next.generation,specVersion:next.specVersion,continuationEpoch:epoch||Number(Date.now()),triggerKey:action==='run'?`manual:${next.automationId}:g${next.generation}:${randomUUID()}`:`initial:${next.automationId}:g${next.generation}:e${epoch}`,dueAt:new Date(),payload:{spec:next.spec}});
    await this.event(client,next,action,{}); return (await this.getLocked(client,next.tenantId,next.sessionId,next.automationId))!;
  }
  async beginTerminalDrainLocked(client:Client,current:SessionAutomationSnapshot,desired:AutomationDesiredTerminalStatus,reason:string):Promise<SessionAutomationSnapshot>{
    const generation=current.generation+1;
    await client.query(`UPDATE ${this.tables.wakeups} SET state='superseded',lease_token=NULL,lease_expires_at=NULL WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,[current.tenantId,current.automationId]);
    await client.query(`UPDATE ${this.tables.outbox} SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE 'dead' END,lease_token=NULL,lease_expires_at=NULL,last_error=CASE WHEN state='dispatching' THEN 'terminal_drain_dispatch_unknown' ELSE last_error END WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','dispatching')`,[current.tenantId,current.automationId]);
    await client.query(`UPDATE ${this.tables.preparedDispatchAttempts} SET state=CASE WHEN state='prepared' THEN 'cancelled' ELSE 'result_unknown' END,version=version+1,last_error=CASE WHEN state='dispatched' THEN 'terminal_drain_dispatch_unknown' ELSE last_error END,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('prepared','dispatched')`,[current.tenantId,current.automationId]);
    await client.query(`UPDATE ${this.tables.automations}
      SET desired_terminal_status=$3,status=CASE WHEN $3='cancelled' THEN 'cancelling' WHEN $3='blocked' THEN 'completing' ELSE 'completing' END,
          phase='draining',generation=$4,next_wakeup_at=NULL,last_error=COALESCE(last_error,$5),
          control_version=control_version+1,projection_version=projection_version+1,updated_at=now()
      WHERE tenant_id=$1 AND automation_id=$2`,[current.tenantId,current.automationId,desired,generation,reason]);
    const fence=[current.tenantId,current.sessionId,current.automationId,current.incarnationId,generation];
    await client.query(`INSERT INTO ${this.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action,state,last_error) SELECT gen_random_uuid(),$1,$2,$3,$4,$5,o.incarnation_id,o.generation,'outbox',o.outbox_id::text,'reconcile','result_unknown','dispatch_outcome_unknown' FROM ${this.tables.outbox} o WHERE o.tenant_id=$1 AND o.automation_id=$3 AND o.state='dead' AND o.last_error='terminal_drain_dispatch_unknown' ON CONFLICT(tenant_id,automation_id,incarnation_id,generation,object_type,object_id,action) DO NOTHING`,fence);
    const add=async(objectType:string,action:string,table:string,id:string,where:string)=>client.query(
      `INSERT INTO ${this.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action)
       SELECT gen_random_uuid(),$1,$2,$3,$4,$5,x.incarnation_id,x.generation,$6,x.${id}::text,$7 FROM ${table} x
        WHERE x.tenant_id=$1 AND x.automation_id=$3 AND (${where})
       ON CONFLICT(tenant_id,automation_id,incarnation_id,generation,object_type,object_id,action) DO NOTHING`,
      [...fence,objectType,action]);
    await add('execution','complete',this.tables.executions,'execution_id',`x.state<>'terminal'`);
    await add('run','cancel',this.tables.executions,'run_id',`x.state<>'terminal'`);
    await add('evaluation','cancel',this.tables.evaluations,'evaluation_id',`x.state IN ('pending','claimed','blocked')`);
    await add('evaluation','reconcile',this.tables.evaluations,'evaluation_id',`x.state IN ('result_unknown','dead')`);
    await add('provider_attempt','cancel',this.tables.providerAttempts,'provider_attempt_id',`x.state='prepared'`);
    await add('provider_attempt','reconcile',this.tables.providerAttempts,'provider_attempt_id',`x.state IN ('dispatched','result_unknown','reconcile')`);
    await add('interaction','cancel',this.tables.interactions,'interaction_id',`x.state IN ('prepared','active')`);
    await add('interaction','reconcile',this.tables.interactions,'interaction_id',`x.state IN ('result_unknown','reconcile')`);
    await add('background_resource','release',this.tables.backgroundResources,'background_resource_id',`x.state IN ('prepared','active','release_pending')`);
    await add('background_resource','reconcile',this.tables.backgroundResources,'background_resource_id',`x.state IN ('result_unknown','reconcile')`);
    await add('budget_reservation','release',this.tables.budgetReservations,'reservation_id',`x.state='reserved'`);
    await add('budget_reservation','reconcile',this.tables.budgetReservations,'reservation_id',`x.state IN ('result_unknown','reconcile')`);
    const executions=await client.query(`SELECT run_id FROM ${this.tables.executions} WHERE tenant_id=$1 AND automation_id=$2 AND state<>'terminal'`,[current.tenantId,current.automationId]);
    const draining=(await this.getLocked(client,current.tenantId,current.sessionId,current.automationId))!;
    for(const row of executions.rows)await this.enqueueCancellationTx(client,draining,String(row.run_id),reason);
    if(current.activeRunId){await client.query(`INSERT INTO ${this.tables.lifecycleWork}(work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action) VALUES($1,$2,$3,$4,$5,$6,$5,$7,'run',$8,'cancel') ON CONFLICT(tenant_id,automation_id,incarnation_id,generation,object_type,object_id,action) DO NOTHING`,[randomUUID(),current.tenantId,current.sessionId,current.automationId,current.incarnationId,generation,current.generation,current.activeRunId]);await this.enqueueCancellationTx(client,draining,current.activeRunId,reason);}
    await this.tryFinalizeLocked(client,current.tenantId,current.sessionId,current.automationId);
    return (await this.getLocked(client,current.tenantId,current.sessionId,current.automationId))!;
  }

  private async inFlightSummaryLocked(client:Client,tenantId:string,automationId:string):Promise<AutomationInFlightSummary>{
    const r=await client.query(`SELECT
      (SELECT count(*) FROM ${this.runsTable} r JOIN ${this.tables.executions} e ON e.tenant_id=r.tenant_id AND e.session_id=r.session_id AND e.run_id=r.run_id WHERE e.tenant_id=$1 AND e.automation_id=$2 AND r.status IN ('pending','running'))::int active_runs,
      (SELECT count(*) FROM ${this.tables.wakeups} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed'))::int wakeups,
      ((SELECT count(*) FROM ${this.tables.outbox} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','dispatching','dispatched'))+(SELECT count(*) FROM ${this.tables.preparedDispatchAttempts} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('prepared','dispatched')))::int outbox,
      (SELECT count(*) FROM ${this.tables.executions} WHERE tenant_id=$1 AND automation_id=$2 AND state<>'terminal')::int executions,
      (SELECT count(*) FROM ${this.tables.evaluations} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed','blocked','result_unknown','dead'))::int evaluations,
      (SELECT count(*) FROM ${this.tables.providerAttempts} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('prepared','dispatched','result_unknown','reconcile'))::int provider_attempts,
      (SELECT count(*) FROM ${this.tables.interactions} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('prepared','active','result_unknown','reconcile'))::int interactions,
      (SELECT count(*) FROM ${this.tables.backgroundResources} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('prepared','active','release_pending','result_unknown','reconcile'))::int background_resources,
      (SELECT count(*) FROM ${this.tables.budgetReservations} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('reserved','result_unknown','reconcile'))::int budget_reservations,
      (SELECT count(*) FROM ${this.tables.cancellations} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed','dead'))::int cancellations,
      (SELECT count(*) FROM ${this.tables.lifecycleWork} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed','result_unknown','dead'))::int typed_work,
      ((SELECT count(*) FROM ${this.tables.preparedDispatchAttempts} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('result_unknown','reconcile'))+(SELECT count(*) FROM ${this.tables.evaluations} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('result_unknown','dead'))+(SELECT count(*) FROM ${this.tables.providerAttempts} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('result_unknown','reconcile'))+(SELECT count(*) FROM ${this.tables.interactions} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('result_unknown','reconcile'))+(SELECT count(*) FROM ${this.tables.backgroundResources} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('result_unknown','reconcile'))+(SELECT count(*) FROM ${this.tables.budgetReservations} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('result_unknown','reconcile'))+(SELECT count(*) FROM ${this.tables.cancellations} WHERE tenant_id=$1 AND automation_id=$2 AND state='dead')+(SELECT count(*) FROM ${this.tables.lifecycleWork} WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('result_unknown','dead')))::int unknown_or_dead`,[tenantId,automationId]);
    const x=r.rows[0];return{activeRuns:Number(x.active_runs),wakeups:Number(x.wakeups),outbox:Number(x.outbox),executions:Number(x.executions),evaluations:Number(x.evaluations),providerAttempts:Number(x.provider_attempts),interactions:Number(x.interactions),backgroundResources:Number(x.background_resources),budgetReservations:Number(x.budget_reservations),cancellations:Number(x.cancellations),typedWork:Number(x.typed_work),unknownOrDead:Number(x.unknown_or_dead)};
  }

  /** Finalization updates projection_version exactly when the visible projection changes. */
  async tryFinalizeLocked(client:Client,tenantId:string,sessionId:string,automationId:string):Promise<SessionAutomationSnapshot|undefined>{
    const locked=await client.query(`SELECT desired_terminal_status,incarnation_id,generation,status FROM ${this.tables.automations} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 FOR UPDATE`,[tenantId,sessionId,automationId]);
    const row=locked.rows[0];if(!row)return undefined;
    const decision=reduceAutomationInFlight(row.desired_terminal_status,await this.inFlightSummaryLocked(client,tenantId,automationId));
    if(decision.kind==='reconcile_required')await client.query(`UPDATE ${this.tables.automations} SET status='reconcile_required',phase='draining',next_wakeup_at=NULL,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND incarnation_id=$3 AND generation=$4 AND (status,phase) IS DISTINCT FROM ('reconcile_required','draining')`,[tenantId,automationId,row.incarnation_id,row.generation]);
    if(decision.kind==='terminal')await client.query(`UPDATE ${this.tables.automations} SET status=$3,phase=CASE WHEN $3='blocked' THEN 'idle' ELSE 'terminal' END,active_run_id=NULL,next_wakeup_at=NULL,desired_terminal_status=NULL,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND incarnation_id=$4 AND generation=$5 AND desired_terminal_status=$3`,[tenantId,automationId,decision.status,row.incarnation_id,row.generation]);
    return this.getLocked(client,tenantId,sessionId,automationId);
  }

  private mapLifecycleJob(row:Record<string,unknown>):SessionAutomationLifecycleJob{return{workId:String(row.work_id),tenantId:String(row.tenant_id),sessionId:String(row.session_id),automationId:String(row.automation_id),incarnationId:String(row.incarnation_id),generation:Number(row.generation),objectIncarnationId:String(row.object_incarnation_id),objectGeneration:Number(row.object_generation),objectType:row.object_type as SessionAutomationLifecycleObjectType,objectId:String(row.object_id),action:row.action as SessionAutomationLifecycleJob['action'],attemptCount:Number(row.attempt_count),details:(row.details??{}) as Record<string,unknown>};}
  private receiptMatches(job:SessionAutomationLifecycleJob,receipt:SessionAutomationLifecycleReceipt):boolean{return isSessionAutomationLifecycleReceiptForJob(job,receipt);}
  private async lifecycleDetails(client:Client,row:Record<string,unknown>):Promise<Record<string,unknown>>{const lineage=[row.object_id,row.object_incarnation_id,row.object_generation];if(row.object_type==='background_resource')return(await client.query(`SELECT resource_kind,resource_key,provider_resource_id,state,metadata,run_id FROM ${this.tables.backgroundResources} WHERE background_resource_id=$1 AND incarnation_id=$2 AND generation=$3`,lineage)).rows[0]??{};if(row.object_type==='interaction')return(await client.query(`SELECT interaction_key,interaction_kind,state,request_payload,run_id FROM ${this.tables.interactions} WHERE interaction_id=$1 AND incarnation_id=$2 AND generation=$3`,lineage)).rows[0]??{};if(row.object_type==='provider_attempt')return(await client.query(`SELECT provider,provider_request_id,state,operation,run_id FROM ${this.tables.providerAttempts} WHERE provider_attempt_id=$1 AND incarnation_id=$2 AND generation=$3`,lineage)).rows[0]??{};if(row.object_type==='execution')return(await client.query(`SELECT state,run_id FROM ${this.tables.executions} WHERE execution_id=$1 AND incarnation_id=$2 AND generation=$3`,lineage)).rows[0]??{};if(row.object_type==='budget_reservation')return(await client.query(`SELECT r.state,NOT EXISTS(SELECT 1 FROM ${this.tables.providerAttempts} p WHERE p.tenant_id=r.tenant_id AND p.idempotency_key=r.idempotency_key AND p.state IN ('dispatched','completed','result_unknown','reconcile')) AS safe_to_release FROM ${this.tables.budgetReservations} r WHERE r.reservation_id=$1 AND r.incarnation_id=$2 AND r.generation=$3`,lineage)).rows[0]??{};if(row.object_type==='run')return(await client.query(`SELECT status FROM ${this.runsTable} WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3`,[row.tenant_id,row.session_id,row.object_id])).rows[0]??{};return{};}
  private async applyLifecycleReceiptLocked(client:Client,job:SessionAutomationLifecycleJob,receipt:SessionAutomationLifecycleReceipt,leaseToken:string):Promise<boolean>{
    if(!this.receiptMatches(job,receipt))throw new SessionAutomationConflictError('STALE_GENERATION','lifecycle receipt fence mismatch');
    const fence=await client.query(`SELECT incarnation_id,generation FROM ${this.tables.automations} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 FOR UPDATE`,[job.tenantId,job.sessionId,job.automationId]);const current=fence.rows[0];if(!current||current.incarnation_id!==job.incarnationId||Number(current.generation)!==job.generation)return false;
    if(receipt.outcome==='completed'){
      const lineage=[job.objectId,job.objectIncarnationId,job.objectGeneration];
      if(job.objectType==='evaluation')await client.query(`UPDATE ${this.tables.evaluations} SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE evaluation_id=$1 AND incarnation_id=$2 AND generation=$3 AND state IN ('pending','claimed','blocked','result_unknown','dead')`,lineage);
      else if(job.objectType==='provider_attempt'){const providerState=receipt.payload.providerState;if(job.action==='reconcile'&&!['completed','cancelled'].includes(String(providerState)))throw new SessionAutomationConflictError('INVALID_RECEIPT','provider receipt must carry authenticated providerState');await client.query(`UPDATE ${this.tables.providerAttempts} SET state=$4,version=version+1,updated_at=now() WHERE provider_attempt_id=$1 AND incarnation_id=$2 AND generation=$3`,[...lineage,job.action==='reconcile'?providerState:'cancelled']);}
      else if(job.objectType==='interaction')await client.query(`UPDATE ${this.tables.interactions} SET state='cancelled',version=version+1,updated_at=now() WHERE interaction_id=$1 AND incarnation_id=$2 AND generation=$3 AND state IN ('prepared','active','result_unknown','reconcile')`,lineage);
      else if(job.objectType==='background_resource')await client.query(`UPDATE ${this.tables.backgroundResources} SET state='released',version=version+1,updated_at=now() WHERE background_resource_id=$1 AND incarnation_id=$2 AND generation=$3`,lineage);
      else if(job.objectType==='execution')await client.query(`UPDATE ${this.tables.executions} SET state='terminal',terminal_status=COALESCE(terminal_status,'cancelled'),updated_at=now() WHERE execution_id=$1 AND incarnation_id=$2 AND generation=$3`,lineage);
      else if(job.objectType==='outbox'){await client.query(`UPDATE ${this.tables.outbox} SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE outbox_id=$1 AND incarnation_id=$2 AND generation=$3 AND state IN ('pending','dispatching','dispatched','dead')`,lineage);await client.query(`UPDATE ${this.tables.preparedDispatchAttempts} SET state='cancelled',version=version+1,updated_at=now() WHERE outbox_id=$1 AND incarnation_id=$2 AND generation=$3 AND state IN ('prepared','result_unknown','reconcile')`,lineage);}
      else if(job.objectType==='budget_reservation')await client.query(`UPDATE ${this.tables.budgetReservations} SET state='released',version=version+1,updated_at=now() WHERE reservation_id=$1 AND incarnation_id=$2 AND generation=$3 AND state IN ('reserved','result_unknown','reconcile')`,lineage);
    }
    const state=receipt.outcome==='completed'?'completed':receipt.outcome;
    const waitsForAuthority=state==='pending'&&lifecycleWaitsForAuthority(job.objectType);
    const persistedState=waitsForAuthority?'waiting':state;
    const updated=await client.query(`UPDATE ${this.tables.lifecycleWork} SET state=$3,next_attempt_at=CASE WHEN $3='pending' THEN now()+(LEAST(300,5*power(2,LEAST(attempt_count-1,6)))::text||' seconds')::interval ELSE next_attempt_at END,lease_token=NULL,lease_expires_at=NULL,last_error=CASE WHEN $3 IN ('pending','waiting') THEN COALESCE($4,last_error) WHEN $3='result_unknown' THEN COALESCE($4,'authoritative_outcome_unknown') ELSE NULL END,receipt_key=$5,receipt_authority=$6,receipt_payload=$7,updated_at=now() WHERE work_id=$1 AND lease_token=$2 AND state='claimed' RETURNING work_id`,[job.workId,leaseToken,persistedState,typeof receipt.payload.error==='string'?receipt.payload.error:null,receipt.receiptKey,receipt.authority,JSON.stringify(receipt.payload)]);
    if(updated.rowCount)await this.tryFinalizeLocked(client,job.tenantId,job.sessionId,job.automationId);return updated.rowCount===1;
  }
  /** Server-only recovery hook. Callers must authenticate provider/operator evidence before constructing this fully fenced receipt. */
  async applyAuthoritativeLifecycleReceipt(receipt:SessionAutomationLifecycleReceipt):Promise<boolean>{return this.tx(async client=>{const r=await client.query(`SELECT * FROM ${this.tables.lifecycleWork} WHERE work_id=$1 FOR UPDATE`,[receipt.workId]);const row=r.rows[0];if(!row)return false;const job=this.mapLifecycleJob({...row,details:{}});if(!this.receiptMatches(job,receipt))throw new SessionAutomationConflictError('STALE_GENERATION','lifecycle receipt fence mismatch');const token=row.lease_token??randomUUID();if(!row.lease_token)await client.query(`UPDATE ${this.tables.lifecycleWork} SET state='claimed',next_attempt_at=now(),lease_token=$2,lease_expires_at=now()+interval '2 minutes' WHERE work_id=$1 AND state IN ('pending','waiting','result_unknown','dead')`,[receipt.workId,token]);return this.applyLifecycleReceiptLocked(client,job,receipt,String(token));});}
  /** Generic operator retry path for every typed authority; no authority outcome is synthesized. */
  async retryLifecycleWork(tenantId:string,sessionId:string,automationId:string,workId?:string):Promise<number>{const r=await this.pool.query(`UPDATE ${this.tables.lifecycleWork} SET state='pending',next_attempt_at=now(),lease_token=NULL,lease_expires_at=NULL,last_error='manual_retry',updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND state IN ('waiting','result_unknown','dead') AND ($4::uuid IS NULL OR work_id=$4::uuid)`,[tenantId,sessionId,automationId,workId??null]);return r.rowCount??0;}
  async processLifecycleWork(adapters:SessionAutomationLifecycleAdapters={},limit=25,leaseMs=30_000):Promise<number>{
    const claimed=await this.tx(async c=>{const r=await c.query(`SELECT * FROM ${this.tables.lifecycleWork} WHERE state IN ('pending','claimed') AND next_attempt_at<=now() AND (state='pending' OR lease_expires_at<now()) ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1`,[limit]);const jobs:Array<{job:SessionAutomationLifecycleJob;leaseToken:string}>=[];for(const row of r.rows){const leaseToken=randomUUID();const details=await this.lifecycleDetails(c,row);await c.query(`UPDATE ${this.tables.lifecycleWork} SET state='claimed',lease_token=$2,lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1,updated_at=now() WHERE work_id=$1`,[row.work_id,leaseToken,leaseMs]);jobs.push({job:this.mapLifecycleJob({...row,attempt_count:Number(row.attempt_count)+1,details}),leaseToken});}return jobs;});
    for(const {job,leaseToken} of claimed){
      const stale=await this.tx(async c=>{const live=await c.query(`SELECT incarnation_id,generation FROM ${this.tables.automations} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 FOR UPDATE`,[job.tenantId,job.sessionId,job.automationId]);const row=live.rows[0];if(row&&row.incarnation_id===job.incarnationId&&Number(row.generation)===job.generation)return false;await c.query(`UPDATE ${this.tables.lifecycleWork} SET state='completed',last_error='stale_fence',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE work_id=$1 AND lease_token=$2`,[job.workId,leaseToken]);await this.tryFinalizeLocked(c,job.tenantId,job.sessionId,job.automationId);return true;});
      if(stale)continue;
      const adapter=adapters[job.objectType];
      if(!adapter){await this.pool.query(`UPDATE ${this.tables.lifecycleWork} SET state='pending',next_attempt_at=now()+(LEAST(300,5*power(2,LEAST(attempt_count-1,6)))::text||' seconds')::interval,lease_token=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now() WHERE work_id=$1 AND lease_token=$2 AND state='claimed'`,[job.workId,leaseToken,`adapter_unavailable:${job.objectType}:${job.action}`]);continue;}
      let receipt:SessionAutomationLifecycleReceipt;try{receipt=await adapter.execute(job);}catch(error){receipt={...job,receiptKey:`error:${job.workId}:${job.attemptCount}`,authority:'server_internal',outcome:'pending',payload:{error:error instanceof Error?error.message:String(error)}};delete (receipt as Partial<SessionAutomationLifecycleJob>).attemptCount;delete (receipt as Partial<SessionAutomationLifecycleJob>).details;}
      await this.tx(c=>this.applyLifecycleReceiptLocked(c,job,receipt,leaseToken));
    }
    return claimed.length;
  }

  async scheduleTx(client:Client,input:{tenantId:string;sessionId:string;automationId:string;incarnationId:string;generation:number;specVersion:number;continuationEpoch:number;triggerKey:string;dueAt:Date;payload:unknown}):Promise<string>{const id=randomUUID();await client.query(`INSERT INTO ${this.tables.wakeups}(wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,automation_id,trigger_key) DO NOTHING`,[id,input.tenantId,input.sessionId,input.automationId,input.incarnationId,input.generation,input.specVersion,input.continuationEpoch,input.triggerKey,input.dueAt]);await client.query(`UPDATE ${this.tables.automations} SET next_wakeup_at=LEAST(COALESCE(next_wakeup_at,$3),$3),phase=CASE WHEN active_run_id IS NULL THEN 'waiting' ELSE 'running' END,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2`,[input.tenantId,input.automationId,input.dueAt]);return id;}
  private async enqueueCancellationTx(client:Client,current:SessionAutomationSnapshot,runId:string,reason:string):Promise<void>{await client.query(`INSERT INTO ${this.tables.cancellations}(cancellation_id,tenant_id,session_id,automation_id,run_id,requested_generation,reason) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,run_id) DO UPDATE SET state=CASE WHEN ${this.tables.cancellations}.state='completed' THEN 'completed' ELSE 'pending' END,next_attempt_at=now(),updated_at=now()`,[randomUUID(),current.tenantId,current.sessionId,current.automationId,runId,current.generation,reason]);}
  async claimCancellations(limit=10,leaseMs=30_000):Promise<ClaimedCancellation[]>{return this.tx(async c=>{const r=await c.query(`SELECT * FROM ${this.tables.cancellations} WHERE state IN ('pending','claimed') AND next_attempt_at<=now() AND (state='pending' OR lease_expires_at<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1`,[limit]);const items:ClaimedCancellation[]=[];for(const row of r.rows){const leaseToken=randomUUID();await c.query(`UPDATE ${this.tables.cancellations} SET state='claimed',lease_token=$2,lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1,updated_at=now() WHERE cancellation_id=$1`,[row.cancellation_id,leaseToken,leaseMs]);items.push({cancellationId:row.cancellation_id,tenantId:row.tenant_id,sessionId:row.session_id,automationId:row.automation_id,runId:row.run_id,reason:row.reason,leaseToken,requestedGeneration:Number(row.requested_generation)});}return items;});}
  async completeCancellation(item:ClaimedCancellation):Promise<void>{await this.tx(async c=>{
    const completed=await c.query(`UPDATE ${this.tables.cancellations} SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE cancellation_id=$1 AND lease_token=$2 AND state='claimed' RETURNING cancellation_id`,[item.cancellationId,item.leaseToken]);
    if(!completed.rows[0])return;
    const target=await c.query(`SELECT e.execution_id,e.outbox_id,e.incarnation_id,e.generation,o.wakeup_id
      FROM ${this.tables.executions} e
      JOIN ${this.tables.outbox} o ON o.outbox_id=e.outbox_id AND o.tenant_id=e.tenant_id AND o.session_id=e.session_id AND o.automation_id=e.automation_id AND o.incarnation_id=e.incarnation_id AND o.generation=e.generation AND o.target_run_id=e.run_id
      JOIN ${this.tables.wakeups} w ON w.wakeup_id=o.wakeup_id AND w.tenant_id=o.tenant_id AND w.session_id=o.session_id AND w.automation_id=o.automation_id AND w.incarnation_id=o.incarnation_id AND w.generation=o.generation
      WHERE e.tenant_id=$1 AND e.session_id=$2 AND e.automation_id=$3 AND e.run_id=$4
      FOR UPDATE OF e,o,w`,[item.tenantId,item.sessionId,item.automationId,item.runId]);
    for(const row of target.rows){
      const lineage=[row.execution_id,item.tenantId,item.sessionId,item.automationId,row.incarnation_id,row.generation,item.runId,row.outbox_id];
      await c.query(`UPDATE ${this.tables.preparedDispatchAttempts} SET state=CASE WHEN state='completed' THEN state ELSE 'cancelled' END,version=version+1,lease_token=NULL,lease_expires_at=NULL,last_error=CASE WHEN state='completed' THEN last_error ELSE COALESCE(last_error,'run_cancelled') END,updated_at=now() WHERE execution_id=$1 AND tenant_id=$2 AND session_id=$3 AND automation_id=$4 AND incarnation_id=$5 AND generation=$6 AND run_id=$7 AND outbox_id=$8 AND state IN ('prepared','dispatched','result_unknown','reconcile')`,lineage);
      await c.query(`UPDATE ${this.tables.executions} SET state='terminal',terminal_status=COALESCE(terminal_status,'cancelled'),updated_at=now() WHERE execution_id=$1 AND tenant_id=$2 AND session_id=$3 AND automation_id=$4 AND incarnation_id=$5 AND generation=$6 AND run_id=$7 AND outbox_id=$8 AND state<>'terminal'`,lineage);
      await c.query(`UPDATE ${this.tables.outbox} SET state=CASE WHEN state='completed' THEN state ELSE 'cancelled' END,lease_token=NULL,lease_expires_at=NULL,last_error=CASE WHEN state='completed' THEN last_error ELSE COALESCE(last_error,'run_cancelled') END WHERE outbox_id=$1 AND tenant_id=$2 AND session_id=$3 AND automation_id=$4 AND incarnation_id=$5 AND generation=$6 AND target_run_id=$7 AND state IN ('pending','dispatching','dispatched','dead')`,[row.outbox_id,item.tenantId,item.sessionId,item.automationId,row.incarnation_id,row.generation,item.runId]);
      await c.query(`UPDATE ${this.tables.wakeups} SET state='superseded',lease_token=NULL,lease_expires_at=NULL WHERE wakeup_id=$1 AND tenant_id=$2 AND session_id=$3 AND automation_id=$4 AND incarnation_id=$5 AND generation=$6 AND state IN ('pending','claimed')`,[row.wakeup_id,item.tenantId,item.sessionId,item.automationId,row.incarnation_id,row.generation]);
      await c.query(`UPDATE ${this.tables.lifecycleWork} SET state='completed',lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND generation=$4 AND object_incarnation_id=$5 AND object_generation=$6 AND state IN ('pending','claimed','waiting','result_unknown') AND ((object_type='run' AND object_id=$7) OR (object_type='execution' AND object_id=$8::text) OR (object_type='outbox' AND object_id=$9::text))`,[item.tenantId,item.sessionId,item.automationId,item.requestedGeneration,row.incarnation_id,row.generation,item.runId,row.execution_id,row.outbox_id]);
    }
    await c.query(`UPDATE ${this.tables.automations} SET phase=CASE WHEN desired_terminal_status IS NOT NULL THEN 'draining' WHEN status='paused' THEN 'idle' WHEN status='active' AND next_wakeup_at IS NOT NULL THEN 'waiting' ELSE phase END,active_run_id=CASE WHEN active_run_id=$4 THEN NULL ELSE active_run_id END,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND active_run_id=$4`,[item.tenantId,item.sessionId,item.automationId,item.runId]);
    await c.query(`UPDATE ${this.tables.lifecycleWork} SET state='completed',lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND generation=$4 AND object_type='run' AND object_id=$5 AND state IN ('pending','claimed','waiting','result_unknown')`,[item.tenantId,item.sessionId,item.automationId,item.requestedGeneration,item.runId]);
    await this.tryFinalizeLocked(c,item.tenantId,item.sessionId,item.automationId);
    const next=await this.getLocked(c,item.tenantId,item.sessionId,item.automationId);if(next)await this.event(c,next,'automation_state_changed',{reason:item.reason,snapshot:next});
  });}
  async failCancellation(item:ClaimedCancellation,error:unknown):Promise<void>{await this.tx(async c=>{const failed=await c.query(`UPDATE ${this.tables.cancellations} SET state=CASE WHEN attempt_count>=10 THEN 'dead' ELSE 'pending' END,next_attempt_at=now()+LEAST(attempt_count,10)*interval '5 seconds',lease_token=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now() WHERE cancellation_id=$1 AND lease_token=$2 RETURNING state`,[item.cancellationId,item.leaseToken,error instanceof Error?error.message:String(error)]);if(failed.rows[0]?.state==='dead')await this.tryFinalizeLocked(c,item.tenantId,item.sessionId,item.automationId);});}
  async recordUsage(input:{tenantId:string;sessionId:string;automationId:string;executionId?:string;sourceKey:string;sourceKind:string;turns?:number;tokens?:number;credits?:number},client?:Client):Promise<void>{const q=client??this.pool;await q.query(`INSERT INTO ${this.tables.usage}(usage_id,tenant_id,session_id,automation_id,execution_id,source_key,source_kind,turns,tokens,credits) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,automation_id,source_key) DO NOTHING`,[randomUUID(),input.tenantId,input.sessionId,input.automationId,input.executionId??null,input.sourceKey,input.sourceKind,Math.max(0,input.turns??0),Math.max(0,input.tokens??0),Math.max(0,input.credits??0)]);}
  async budgetReasonTx(client:Client,tenantId:string,sessionId:string,automationId:string):Promise<string|undefined>{
    await client.query(`SELECT automation_id FROM ${this.tables.automations} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 FOR UPDATE`,[tenantId,sessionId,automationId]);
    return resolveAutomationBudgetReason({client,tables:this.tables,tablePrefix:this.tablePrefix,runsTable:this.runsTable,tenantId,sessionId,automationId});
  }
  async claimDue(limit=25,leaseMs=30_000):Promise<number>{return this.tx(async c=>{const r=await c.query(`SELECT w.* FROM ${this.tables.wakeups} w JOIN ${this.tables.automations} a USING(automation_id) WHERE w.state='pending' AND w.due_at<=now() AND a.status='active' AND a.active_run_id IS NULL AND a.generation=w.generation AND a.incarnation_id=w.incarnation_id ORDER BY w.due_at FOR UPDATE OF w,a SKIP LOCKED LIMIT $1`,[limit]);let claimed=0;for(const w of r.rows){const reason=await this.budgetReasonTx(c,w.tenant_id,w.session_id,w.automation_id);if(reason){await c.query(`UPDATE ${this.tables.wakeups} SET state='superseded',last_error=$2 WHERE wakeup_id=$1`,[w.wakeup_id,`budget:${reason}`]);await this.expireForBudgetTx(c,w.tenant_id,w.automation_id,reason);continue;}const outboxId=randomUUID(),targetRunId=deterministicRunId(w.tenant_id,w.session_id,w.trigger_key);await c.query(`UPDATE ${this.tables.wakeups} SET state='claimed',lease_token=$2,lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1 WHERE wakeup_id=$1`,[w.wakeup_id,randomUUID(),leaseMs]);await c.query(`INSERT INTO ${this.tables.outbox}(outbox_id,wakeup_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,continuation_epoch,trigger_key,target_run_id,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(tenant_id,wakeup_id) DO NOTHING`,[outboxId,w.wakeup_id,w.tenant_id,w.session_id,w.automation_id,w.incarnation_id,w.generation,w.spec_version,w.continuation_epoch,w.trigger_key,targetRunId,JSON.stringify({automationId:w.automation_id,triggerKey:w.trigger_key})]);claimed++;}return claimed;});}
  async claimDispatch(limit=10,leaseMs=30_000):Promise<ClaimedDispatch[]>{return this.tx(async c=>{const r=await c.query(`SELECT o.* FROM ${this.tables.outbox} o JOIN ${this.tables.automations} a USING(automation_id) WHERE o.state='pending' AND o.next_attempt_at<=now() AND a.status='active' AND a.active_run_id IS NULL AND a.generation=o.generation AND a.incarnation_id=o.incarnation_id ORDER BY o.created_at FOR UPDATE OF o,a SKIP LOCKED LIMIT $1`,[limit]);const result:ClaimedDispatch[]=[];for(const o of r.rows){const reason=await this.budgetReasonTx(c,o.tenant_id,o.session_id,o.automation_id);if(reason){await this.expireForBudgetTx(c,o.tenant_id,o.automation_id,reason);await c.query(`UPDATE ${this.tables.outbox} SET state='dead',last_error=$2,lease_token=NULL,lease_expires_at=NULL WHERE outbox_id=$1`,[o.outbox_id,`budget:${reason}`]);continue;}const token=randomUUID();await c.query(`UPDATE ${this.tables.outbox} SET state='dispatching',lease_token=$2,lease_expires_at=now()+($3::text||' milliseconds')::interval,attempt_count=attempt_count+1 WHERE outbox_id=$1`,[o.outbox_id,token,leaseMs]);result.push({outboxId:o.outbox_id,wakeupId:o.wakeup_id,automationId:o.automation_id,tenantId:o.tenant_id,sessionId:o.session_id,targetRunId:o.target_run_id,triggerKey:o.trigger_key,payload:o.payload,leaseToken:token,generation:Number(o.generation),specVersion:Number(o.spec_version),incarnationId:o.incarnation_id});}return result;});}
  private async expireForBudgetTx(c:Client,tenantId:string,automationId:string,reason:string):Promise<void>{const row=await c.query(`SELECT session_id FROM ${this.tables.automations} WHERE tenant_id=$1 AND automation_id=$2 FOR UPDATE`,[tenantId,automationId]);if(!row.rows[0])return;const current=await this.getLocked(c,tenantId,row.rows[0].session_id,automationId);if(!current)return;await c.query(`UPDATE ${this.tables.automations} SET limit_hit_reason=COALESCE(limit_hit_reason,$3),limit_hit_at=COALESCE(limit_hit_at,now()) WHERE tenant_id=$1 AND automation_id=$2`,[tenantId,automationId,reason]);await this.beginTerminalDrainLocked(c,current,'expired',reason);}
  async prepareDispatch(item:ClaimedDispatch,requestPayload:Record<string,unknown>):Promise<string>{return this.tx(async c=>{await c.query(`INSERT INTO ${this.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared') ON CONFLICT(outbox_id) DO NOTHING`,[item.outboxId,item.tenantId,item.sessionId,item.automationId,item.incarnationId,item.generation,item.specVersion,item.outboxId,item.targetRunId]);const r=await c.query(`INSERT INTO ${this.tables.preparedDispatchAttempts}(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,outbox_id,idempotency_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,idempotency_key) DO UPDATE SET updated_at=now() WHERE ${this.tables.preparedDispatchAttempts}.outbox_id=EXCLUDED.outbox_id RETURNING prepared_dispatch_attempt_id`,[randomUUID(),item.tenantId,item.sessionId,item.automationId,item.incarnationId,item.generation,item.outboxId,item.targetRunId,item.outboxId,`dispatch:${item.outboxId}`,JSON.stringify(requestPayload)]);if(r.rowCount!==1)throw new SessionAutomationConflictError('STALE_GENERATION','prepared dispatch lineage mismatch');return String(r.rows[0].prepared_dispatch_attempt_id);});}
  async transitionPreparedDispatch(outboxId:string,from:'prepared'|'dispatched'|'result_unknown'|'reconcile',to:'dispatched'|'completed'|'result_unknown'|'reconcile',lastError?:string):Promise<boolean>{const r=await this.pool.query(`UPDATE ${this.tables.preparedDispatchAttempts} SET state=$3,version=version+1,last_error=$4,dispatched_at=CASE WHEN $3='dispatched' THEN COALESCE(dispatched_at,now()) ELSE dispatched_at END,completed_at=CASE WHEN $3='completed' THEN now() ELSE completed_at END,updated_at=now() WHERE outbox_id=$1 AND state=$2`,[outboxId,from,to,lastError??null]);return r.rowCount===1;}
  async listRecoverablePreparedDispatches(limit=50):Promise<Array<{outboxId:string;tenantId:string;sessionId:string;runId:string;state:string;requestPayload:Record<string,unknown>}>>{const r=await this.pool.query(`SELECT outbox_id,tenant_id,session_id,run_id,state,request_payload FROM ${this.tables.preparedDispatchAttempts} WHERE state IN ('prepared','result_unknown','reconcile','dispatched') ORDER BY prepared_at LIMIT $1`,[limit]);return r.rows.map(row=>({outboxId:String(row.outbox_id),tenantId:String(row.tenant_id),sessionId:String(row.session_id),runId:String(row.run_id),state:String(row.state),requestPayload:(row.request_payload??{}) as Record<string,unknown>}));}
  async markDispatched(item:ClaimedDispatch):Promise<void>{await this.tx(async c=>{const r=await c.query(`UPDATE ${this.tables.outbox} o SET state='dispatched',lease_expires_at=NULL FROM ${this.tables.automations} a WHERE o.outbox_id=$1 AND o.lease_token=$2 AND o.state='dispatching' AND a.automation_id=o.automation_id AND a.status='active' AND a.active_run_id IS NULL AND a.generation=o.generation AND a.incarnation_id=o.incarnation_id RETURNING o.*`,[item.outboxId,item.leaseToken]);if(!r.rows[0])throw new SessionAutomationConflictError('STALE_GENERATION','dispatch fence lost');await c.query(`INSERT INTO ${this.tables.executions}(execution_id,tenant_id,session_id,automation_id,incarnation_id,generation,spec_version,outbox_id,run_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running') ON CONFLICT(outbox_id) DO UPDATE SET state='running',updated_at=now()`,[item.outboxId,item.tenantId,item.sessionId,item.automationId,item.incarnationId,item.generation,item.specVersion,item.outboxId,item.targetRunId]);const activated=await c.query(`UPDATE ${this.tables.automations} SET phase='running',active_run_id=$3,next_wakeup_at=NULL,run_count=run_count+1,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND status='active' AND active_run_id IS NULL AND generation=$4 AND incarnation_id=$5 RETURNING automation_id`,[item.tenantId,item.automationId,item.targetRunId,item.generation,item.incarnationId]);if(!activated.rows[0])throw new SessionAutomationConflictError('STALE_GENERATION','dispatch active-run fence lost');const next=await this.getLocked(c,item.tenantId,item.sessionId,item.automationId);if(next)await this.event(c,next,'automation_execution_changed',{runId:item.targetRunId,phase:'running',snapshot:next});});}
  async failDispatch(item:ClaimedDispatch,error:unknown):Promise<void>{await this.tx(async c=>{const failed=await c.query(`UPDATE ${this.tables.outbox} SET state=CASE WHEN attempt_count>=5 THEN 'dead' ELSE 'pending' END,next_attempt_at=now()+interval '30 seconds',lease_token=NULL,lease_expires_at=NULL,last_error=$3 WHERE outbox_id=$1 AND lease_token=$2 RETURNING state`,[item.outboxId,item.leaseToken,error instanceof Error?error.message:String(error)]);if(failed.rows[0]?.state==='dead'){const current=await this.getLocked(c,item.tenantId,item.sessionId,item.automationId);if(current&&!['completed','cancelled','failed','expired'].includes(current.status))await this.beginTerminalDrainLocked(c,current,'failed','dispatch_dead');}});}
  async supersedeDispatch(item:ClaimedDispatch,cancelStaged=false):Promise<void>{await this.tx(async c=>{await c.query(`UPDATE ${this.tables.outbox} SET state='dead',lease_token=NULL,lease_expires_at=NULL,last_error='stale_fence' WHERE outbox_id=$1 AND lease_token=$2`,[item.outboxId,item.leaseToken]);if(cancelStaged){const current=await this.getLocked(c,item.tenantId,item.sessionId,item.automationId);if(current)await this.enqueueCancellationTx(c,current,item.targetRunId,'session_automation_stale_dispatch');}});}
  async recoverLeases():Promise<void>{await this.tx(async c=>{await c.query(`UPDATE ${this.tables.wakeups} SET state='pending',lease_token=NULL,lease_expires_at=NULL WHERE state='claimed' AND lease_expires_at<now() AND NOT EXISTS(SELECT 1 FROM ${this.tables.outbox} o WHERE o.wakeup_id=${this.tables.wakeups}.wakeup_id)`);await c.query(`UPDATE ${this.tables.outbox} SET state=CASE WHEN attempt_count>=5 THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,last_error=COALESCE(last_error,'dispatch_lease_expired') WHERE state='dispatching' AND lease_expires_at<now()`);await c.query(`UPDATE ${this.tables.cancellations} SET state=CASE WHEN attempt_count>=10 THEN 'dead' ELSE 'pending' END,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now(),last_error=COALESCE(last_error,'cancel_lease_expired'),updated_at=now() WHERE state='claimed' AND lease_expires_at<now()`);});}
  async getSessionAutomationView(tenantId:string,sessionId:string,ownerUserId:string):Promise<{snapshot:SessionAutomationSnapshot|null;cursor:string|null}>{const r=await this.pool.query(`SELECT a.*,s.spec,(SELECT MAX(e.event_sequence)::text FROM ${this.tables.events} e WHERE e.tenant_id=a.tenant_id AND e.session_id=a.session_id AND e.automation_id=a.automation_id) cursor FROM ${this.tables.automations} a JOIN ${this.tables.specs} s ON s.automation_id=a.automation_id AND s.spec_version=a.spec_version WHERE a.tenant_id=$1 AND a.session_id=$2 AND a.owner_user_id=$3 ORDER BY CASE WHEN a.status IN ('active','paused','blocked','completing','cancelling','reconcile_required') THEN 0 ELSE 1 END,a.updated_at DESC LIMIT 1`,[tenantId,sessionId,ownerUserId]);return r.rows[0]?{snapshot:this.map(r.rows[0]),cursor:r.rows[0].cursor??null}:{snapshot:null,cursor:null};}
  async latestEventCursor(tenantId:string,sessionId:string,automationId:string):Promise<string|null>{const r=await this.pool.query(`SELECT MAX(event_sequence)::text AS cursor FROM ${this.tables.events} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,[tenantId,sessionId,automationId]);return r.rows[0]?.cursor??null;}
  async listEvents(tenantId:string,sessionId:string,automationId:string,cursor?:string,limit=100):Promise<{events:Array<Record<string,unknown>>;nextCursor:string|null}>{const values:unknown[]=[tenantId,sessionId,automationId];let after='';if(cursor&&/^\d+$/.test(cursor)){values.push(cursor);after=` AND event_sequence>$${values.length}`;}values.push(Math.min(Math.max(limit,1),200));const r=await this.pool.query(`SELECT event_sequence,automation_event_id,event_type,event_payload,projection_version,run_id,created_at FROM ${this.tables.events} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3${after} ORDER BY event_sequence LIMIT $${values.length}`,values);return{events:r.rows.map(row=>({eventId:row.automation_event_id,type:row.event_type,...row.event_payload,projectionVersion:Number(row.projection_version),runId:row.run_id??undefined,createdAt:new Date(row.created_at).toISOString()})),nextCursor:r.rows.length?String(r.rows[r.rows.length-1].event_sequence):cursor??null};}
  async event(c:Client,s:SessionAutomationSnapshot,type:string,payload:unknown):Promise<void>{await c.query(`INSERT INTO ${this.tables.events}(automation_event_id,tenant_id,session_id,automation_id,generation,spec_version,control_version,projection_version,event_type,event_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),s.tenantId,s.sessionId,s.automationId,s.generation,s.specVersion,s.controlVersion,s.projectionVersion,type,JSON.stringify(payload)]);}
}
export function specDigest(spec:SessionAutomationSpec):string{return createHash('sha256').update(JSON.stringify(spec)).digest('hex');}
function canonicalize(value:unknown):unknown{if(Array.isArray(value))return value.map(canonicalize);if(value&&typeof value==='object'){return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonicalize(v)]));}return value;}
export function commandDigest(command:string|Record<string,unknown>):string{return createHash('sha256').update(typeof command==='string'?command.trim():JSON.stringify(canonicalize(command))).digest('hex');}
export function deterministicRunId(tenantId:string,sessionId:string,triggerKey:string):string{const hex=createHash('sha256').update(`${tenantId}\0${sessionId}\0${triggerKey}`).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
