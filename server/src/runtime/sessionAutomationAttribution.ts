import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { sessionAutomationTables, type SessionAutomationTables } from './sessionAutomationStoreSchema.js';

type Pool = pg.Pool;
type Client = pg.PoolClient;
export type AttributionAttemptState = 'prepared'|'dispatched'|'completed'|'result_unknown'|'reconcile';
export interface AutomationLineage { tenantId:string;sessionId:string;automationId:string;incarnationId:string;generation:number;executionId:string;runId:string; }
export interface ClaimedAttributionAttempt extends AutomationLineage { providerAttemptId:string;preparedDispatchAttemptId:string;provider:string;operation:string;idempotencyKey:string;state:AttributionAttemptState;version:number;leaseToken:string;requestPayload:Record<string,unknown>; }
export interface ClaimedPreparedDispatch extends AutomationLineage { preparedDispatchAttemptId:string;outboxId:string;idempotencyKey:string;state:AttributionAttemptState;version:number;leaseToken:string;requestPayload:Record<string,unknown>; }

const transitions: Readonly<Record<AttributionAttemptState,readonly AttributionAttemptState[]>> = {
  prepared:['dispatched','result_unknown'], dispatched:['completed','result_unknown'], completed:[],
  result_unknown:['reconcile'], reconcile:['completed','result_unknown'],
};
export class SessionAutomationAttributionConflictError extends Error {
  constructor(readonly code:'invalid_transition'|'stale_claim',message:string){super(message);this.name='SessionAutomationAttributionConflictError';}
}
function assertTransition(from:AttributionAttemptState,to:AttributionAttemptState):void {
  if(!transitions[from].includes(to)) throw new SessionAutomationAttributionConflictError('invalid_transition',`非法 attribution 状态迁移: ${from} -> ${to}`);
}
function lineageValues(value:AutomationLineage):unknown[]{return[value.tenantId,value.sessionId,value.automationId,value.incarnationId,value.generation,value.executionId,value.runId];}
function claimed(row:Record<string,unknown>):ClaimedAttributionAttempt{return{providerAttemptId:String(row.provider_attempt_id),preparedDispatchAttemptId:String(row.prepared_dispatch_attempt_id),tenantId:String(row.tenant_id),sessionId:String(row.session_id),automationId:String(row.automation_id),incarnationId:String(row.incarnation_id),generation:Number(row.generation),executionId:String(row.execution_id),runId:String(row.run_id),provider:String(row.provider),operation:String(row.operation),idempotencyKey:String(row.idempotency_key),state:row.state as AttributionAttemptState,version:Number(row.version),leaseToken:String(row.lease_token),requestPayload:(row.request_payload??{}) as Record<string,unknown>};}
function claimedPrepared(row:Record<string,unknown>):ClaimedPreparedDispatch{return{preparedDispatchAttemptId:String(row.prepared_dispatch_attempt_id),outboxId:String(row.outbox_id),tenantId:String(row.tenant_id),sessionId:String(row.session_id),automationId:String(row.automation_id),incarnationId:String(row.incarnation_id),generation:Number(row.generation),executionId:String(row.execution_id),runId:String(row.run_id),idempotencyKey:String(row.idempotency_key),state:row.state as AttributionAttemptState,version:Number(row.version),leaseToken:String(row.lease_token),requestPayload:(row.request_payload??{}) as Record<string,unknown>};}

/** Durable attribution ledger API. Every mutation is lineage-fenced and version/lease CAS guarded. */
export class PgSessionAutomationAttributionStore {
  readonly tables:SessionAutomationTables;
  constructor(readonly pool:Pool,tablePrefix='runtime'){this.tables=sessionAutomationTables(tablePrefix);}
  /** Read only the durable attribution fact; this never guesses provider state. */
  async readProviderAuthority(input:{providerAttemptId:string;tenantId:string;sessionId:string;automationId:string;incarnationId:string;generation:number}):Promise<{state:AttributionAttemptState|'cancelled';resultPayload?:Record<string,unknown>}|undefined>{
    const result=await this.pool.query(
      `SELECT state,result_payload FROM ${this.tables.providerAttempts}
        WHERE provider_attempt_id=$1 AND tenant_id=$2 AND session_id=$3 AND automation_id=$4
          AND incarnation_id=$5 AND generation=$6`,
      [input.providerAttemptId,input.tenantId,input.sessionId,input.automationId,input.incarnationId,input.generation],
    );
    const row=result.rows[0];if(!row)return undefined;
    return {state:row.state,...(row.result_payload?{resultPayload:row.result_payload as Record<string,unknown>}:{})};
  }

  async prepareDispatch(input:AutomationLineage&{preparedDispatchAttemptId?:string;outboxId:string;idempotencyKey:string;requestPayload:Record<string,unknown>}):Promise<string>{
    const id=input.preparedDispatchAttemptId??randomUUID();
    const r=await this.pool.query(`INSERT INTO ${this.tables.preparedDispatchAttempts}(prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,outbox_id,idempotency_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key WHERE ${this.tables.preparedDispatchAttempts}.session_id=EXCLUDED.session_id AND ${this.tables.preparedDispatchAttempts}.automation_id=EXCLUDED.automation_id AND ${this.tables.preparedDispatchAttempts}.incarnation_id=EXCLUDED.incarnation_id AND ${this.tables.preparedDispatchAttempts}.generation=EXCLUDED.generation AND ${this.tables.preparedDispatchAttempts}.execution_id=EXCLUDED.execution_id AND ${this.tables.preparedDispatchAttempts}.run_id=EXCLUDED.run_id AND ${this.tables.preparedDispatchAttempts}.outbox_id=EXCLUDED.outbox_id RETURNING prepared_dispatch_attempt_id`,[id,...lineageValues(input),input.outboxId,input.idempotencyKey,JSON.stringify(input.requestPayload)]);
    if(r.rowCount!==1)throw new SessionAutomationAttributionConflictError('stale_claim','prepared dispatch idempotency key lineage 不匹配');return String(r.rows[0].prepared_dispatch_attempt_id);
  }
  async prepareProviderAttempt(input:AutomationLineage&{providerAttemptId?:string;preparedDispatchAttemptId:string;provider:string;operation:string;idempotencyKey:string;requestPayload:Record<string,unknown>}):Promise<string>{
    const id=input.providerAttemptId??randomUUID();
    const r=await this.pool.query(`INSERT INTO ${this.tables.providerAttempts}(provider_attempt_id,prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,provider,operation,idempotency_key,request_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,provider,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key WHERE ${this.tables.providerAttempts}.prepared_dispatch_attempt_id=EXCLUDED.prepared_dispatch_attempt_id AND ${this.tables.providerAttempts}.session_id=EXCLUDED.session_id AND ${this.tables.providerAttempts}.automation_id=EXCLUDED.automation_id AND ${this.tables.providerAttempts}.incarnation_id=EXCLUDED.incarnation_id AND ${this.tables.providerAttempts}.generation=EXCLUDED.generation AND ${this.tables.providerAttempts}.execution_id=EXCLUDED.execution_id AND ${this.tables.providerAttempts}.run_id=EXCLUDED.run_id AND ${this.tables.providerAttempts}.operation=EXCLUDED.operation RETURNING provider_attempt_id`,[id,input.preparedDispatchAttemptId,...lineageValues(input),input.provider,input.operation,input.idempotencyKey,JSON.stringify(input.requestPayload)]);
    if(r.rowCount!==1)throw new SessionAutomationAttributionConflictError('stale_claim','provider attempt idempotency key lineage 不匹配');return String(r.rows[0].provider_attempt_id);
  }
  async claimPreparedDispatch(limit=20,leaseSeconds=60):Promise<ClaimedPreparedDispatch[]>{
    const token=randomUUID();
    const r=await this.pool.query(`WITH candidates AS (SELECT prepared_dispatch_attempt_id FROM ${this.tables.preparedDispatchAttempts} WHERE state IN ('prepared','result_unknown','reconcile') AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY prepared_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE ${this.tables.preparedDispatchAttempts} a SET lease_token=$2,lease_expires_at=now()+($3*interval '1 second'),updated_at=now() FROM candidates c WHERE a.prepared_dispatch_attempt_id=c.prepared_dispatch_attempt_id RETURNING a.*`,[limit,token,leaseSeconds]);
    return r.rows.map(claimedPrepared);
  }
  async claimProviderAttempts(states:readonly AttributionAttemptState[]=['prepared'],limit=20,leaseSeconds=60):Promise<ClaimedAttributionAttempt[]>{
    if(states.length===0)return[];const token=randomUUID();
    const r=await this.pool.query(`WITH candidates AS (SELECT provider_attempt_id FROM ${this.tables.providerAttempts} WHERE state=ANY($1::text[]) AND state<>'completed' AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY prepared_at FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE ${this.tables.providerAttempts} a SET lease_token=$3,lease_expires_at=now()+($4*interval '1 second'),updated_at=now() FROM candidates c WHERE a.provider_attempt_id=c.provider_attempt_id RETURNING a.*`,[states,limit,token,leaseSeconds]);
    return r.rows.map(claimed);
  }
  async transitionPreparedDispatch(item:ClaimedPreparedDispatch,to:AttributionAttemptState,patch:{resultPayload?:Record<string,unknown>;lastError?:string}={}):Promise<void>{
    assertTransition(item.state,to);
    const r=await this.pool.query(`UPDATE ${this.tables.preparedDispatchAttempts} SET state=$5,version=version+1,lease_token=NULL,lease_expires_at=NULL,last_error=$6,dispatched_at=CASE WHEN $5='dispatched' THEN now() ELSE dispatched_at END,completed_at=CASE WHEN $5='completed' THEN now() ELSE completed_at END,updated_at=now() WHERE prepared_dispatch_attempt_id=$1 AND tenant_id=$2 AND version=$3 AND state=$4 AND lease_token=$7 AND session_id=$8 AND automation_id=$9 AND incarnation_id=$10 AND generation=$11 AND execution_id=$12 AND run_id=$13`,[item.preparedDispatchAttemptId,item.tenantId,item.version,item.state,to,patch.lastError??null,item.leaseToken,item.sessionId,item.automationId,item.incarnationId,item.generation,item.executionId,item.runId]);
    if(r.rowCount!==1)throw new SessionAutomationAttributionConflictError('stale_claim','prepared dispatch CAS fence 不匹配');
  }
  async transitionProviderAttempt(item:ClaimedAttributionAttempt,to:AttributionAttemptState,patch:{providerRequestId?:string;resultPayload?:Record<string,unknown>;lastError?:string}={}):Promise<void>{
    assertTransition(item.state,to);
    const r=await this.pool.query(`UPDATE ${this.tables.providerAttempts} SET state=$5,version=version+1,lease_token=NULL,lease_expires_at=NULL,provider_request_id=COALESCE($6,provider_request_id),result_payload=COALESCE($7::jsonb,result_payload),last_error=$8,dispatched_at=CASE WHEN $5='dispatched' THEN now() ELSE dispatched_at END,completed_at=CASE WHEN $5='completed' THEN now() ELSE completed_at END,updated_at=now() WHERE provider_attempt_id=$1 AND tenant_id=$2 AND version=$3 AND state=$4 AND lease_token=$9 AND session_id=$10 AND automation_id=$11 AND incarnation_id=$12 AND generation=$13 AND execution_id=$14 AND run_id=$15`,[item.providerAttemptId,item.tenantId,item.version,item.state,to,patch.providerRequestId??null,patch.resultPayload?JSON.stringify(patch.resultPayload):null,patch.lastError??null,item.leaseToken,item.sessionId,item.automationId,item.incarnationId,item.generation,item.executionId,item.runId]);
    if(r.rowCount!==1)throw new SessionAutomationAttributionConflictError('stale_claim','provider attempt CAS fence 不匹配');
  }
  async reconcileProviderAttempt(item:ClaimedAttributionAttempt,input:{receiptId?:string;receiptKey:string;observedState:'completed'|'not_found'|'still_running'|'ambiguous';receiptPayload:Record<string,unknown>;nextState:'completed'|'result_unknown'}):Promise<void>{
    if(item.state!=='reconcile')throw new SessionAutomationAttributionConflictError('invalid_transition',`reconcile 要求 reconcile 状态，当前为 ${item.state}`);
    if((input.observedState==='completed'||input.observedState==='not_found')!==(input.nextState==='completed'))throw new SessionAutomationAttributionConflictError('invalid_transition','receipt observed state 与目标状态不一致');
    const client=await this.pool.connect();try{await client.query('BEGIN');await this.insertReceipt(client,item,input);const r=await client.query(`UPDATE ${this.tables.providerAttempts} SET state=$5,version=version+1,lease_token=NULL,lease_expires_at=NULL,result_payload=CASE WHEN $5='completed' THEN $6::jsonb ELSE result_payload END,last_error=CASE WHEN $5='completed' THEN NULL ELSE 'reconciliation_inconclusive' END,completed_at=CASE WHEN $5='completed' THEN now() ELSE completed_at END,updated_at=now() WHERE provider_attempt_id=$1 AND tenant_id=$2 AND version=$3 AND state=$4 AND lease_token=$7 AND session_id=$8 AND automation_id=$9 AND incarnation_id=$10 AND generation=$11 AND execution_id=$12 AND run_id=$13`,[item.providerAttemptId,item.tenantId,item.version,item.state,input.nextState,JSON.stringify(input.receiptPayload),item.leaseToken,item.sessionId,item.automationId,item.incarnationId,item.generation,item.executionId,item.runId]);if(r.rowCount!==1)throw new SessionAutomationAttributionConflictError('stale_claim','reconciliation CAS fence 不匹配');await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  private async insertReceipt(client:Client,item:ClaimedAttributionAttempt,input:{receiptId?:string;receiptKey:string;observedState:string;receiptPayload:Record<string,unknown>}):Promise<void>{
    const inserted=await client.query(`INSERT INTO ${this.tables.reconciliationReceipts}(reconciliation_receipt_id,provider_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,receipt_key,observed_state,receipt_authority,receipt_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'provider_adapter',$12) ON CONFLICT(tenant_id,receipt_key) DO NOTHING`,[input.receiptId??randomUUID(),item.providerAttemptId,...lineageValues(item),input.receiptKey,input.observedState,JSON.stringify(input.receiptPayload)]);
    if(inserted.rowCount===1)return;
    const duplicate=await client.query(`SELECT 1 FROM ${this.tables.reconciliationReceipts} WHERE tenant_id=$1 AND receipt_key=$2 AND session_id=$3 AND automation_id=$4 AND incarnation_id=$5 AND generation=$6 AND provider_attempt_id=$7 AND execution_id=$8 AND run_id=$9 AND observed_state=$10 AND receipt_payload=$11::jsonb`,[item.tenantId,input.receiptKey,item.sessionId,item.automationId,item.incarnationId,item.generation,item.providerAttemptId,item.executionId,item.runId,input.observedState,JSON.stringify(input.receiptPayload)]);
    if(duplicate.rowCount!==1)throw new SessionAutomationAttributionConflictError('stale_claim','receipt key lineage conflict');
  }
}
