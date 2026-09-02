import type { PgPool } from '../runtime/runStoreTypes.js';
import type { BillingService } from '../data/billing/service.js';
import { SessionAutomationTools, SessionAutomationToolProvider } from '../agent/tools/sessionAutomationTools.js';
import { SessionAutomationCommandService } from '../runtime/sessionAutomationCommandService.js';
import {
  RuntimeSchedulerAutomationDispatcher,
  SessionAutomationCoordinator,
} from '../runtime/sessionAutomationCoordinator.js';
import { ModelGoalEvaluator, SessionAutomationEvaluator } from '../runtime/sessionAutomationEvaluator.js';
import { PgSessionAutomationStore, type SessionAutomationLifecycleAdapters, type SessionAutomationLifecycleJob, type SessionAutomationLifecycleReceipt } from '../runtime/sessionAutomationStore.js';
import { PgSessionAutomationAttributionStore } from '../runtime/sessionAutomationAttribution.js';
import { SessionAutomationTerminalProjector } from '../runtime/sessionAutomationTerminalProjector.js';
import { SessionAutomationRuntimeGuard } from '../runtime/sessionAutomationRuntimeGuard.js';
import type { SessionAutomationExecutionFlagSource } from '../runtime/sessionAutomationFlags.js';

export async function createSessionAutomationPersistence(options: {
  pool: PgPool;
  tablePrefix: string;
  runsTable: string;
  /** Shared live config-backed source used by every automation boundary. */
  flagSource: SessionAutomationExecutionFlagSource;
  cancelRun: (runId: string, reason: string) => Promise<void>;
}) {
  const store = new PgSessionAutomationStore(options.pool, options.tablePrefix, options.runsTable);
  await store.init();
  const commandService = new SessionAutomationCommandService(store, options.flagSource);
  return { store, commandService };
}

function lifecycleReceipt(job:SessionAutomationLifecycleJob,outcome:SessionAutomationLifecycleReceipt['outcome'],payload:Record<string,unknown>={}):SessionAutomationLifecycleReceipt { const {attemptCount: _attemptCount,details: _details,...fence}=job; return {...fence,receiptKey:`runtime:${job.workId}:${job.attemptCount}`,authority:'runtime',outcome,payload}; }
export function createLifecycleAdapters(
  cancelRun:(runId:string,reason:string)=>Promise<void>,
  attribution?:PgSessionAutomationAttributionStore,
  billing?:()=>BillingService|undefined,
):SessionAutomationLifecycleAdapters{return{
  run:{execute:async job=>{
    if(job.action==='reconcile'){
      const service=billing?.();if(!service)return lifecycleReceipt(job,'pending',{error:'billing_service_unavailable'});
      await service.store.settleRunDebit(job.tenantId,job.objectId);
      return lifecycleReceipt(job,'completed',{billingClosure:'settled',billingRunId:job.objectId});
    }
    await cancelRun(job.objectId,'session_automation_typed_drain');return lifecycleReceipt(job,'completed',{runId:job.objectId});
  }},
  execution:{execute:async job=>{const runId=String(job.details.run_id??'');if(!runId)return lifecycleReceipt(job,'pending',{error:'execution_run_id_unavailable'});await cancelRun(runId,'session_automation_typed_drain');return lifecycleReceipt(job,'completed',{runId});}},
  evaluation:{execute:async job=>lifecycleReceipt(job,job.action==='cancel'?'completed':'pending',{...(job.action==='reconcile'?{error:'provider_authority_receipt_required'}:{})})},
  provider_attempt:{execute:async job=>{
    const authority=attribution?await attribution.readProviderAuthority({providerAttemptId:job.objectId,tenantId:job.tenantId,sessionId:job.sessionId,automationId:job.automationId,incarnationId:job.objectIncarnationId,generation:job.objectGeneration}):undefined;
    const providerState=authority?.state??String(job.details.state??'');
    if(['completed','cancelled'].includes(providerState))return lifecycleReceipt(job,'completed',{providerState,resultPayload:authority?.resultPayload,sideEffectKnown:true});
    if(job.action==='cancel'&&providerState==='prepared')return lifecycleReceipt(job,'completed',{providerState:'cancelled',sideEffectKnown:false});
    return lifecycleReceipt(job,'pending',{error:'provider_authority_unresolved',providerState,sideEffectKnown:false});
  }},
  interaction:{execute:async job=>lifecycleReceipt(job,job.details.state==='prepared'?'completed':'pending',{error:'active_interaction_adapter_unavailable'})},
  background_resource:{execute:async job=>{
    if(job.details.resource_kind!=='child_run')return lifecycleReceipt(job,'pending',{error:`resource_adapter_unavailable:${String(job.details.resource_kind??'unknown')}`});
    const runId=String(job.details.provider_resource_id??'');
    if(!runId)return lifecycleReceipt(job,'pending',{error:'resource_provider_id_unavailable'});
    const state=String(job.details.state??'');
    const childStatus=typeof job.details.child_run_status==='string'?job.details.child_run_status:undefined;
    const metadata=job.details.metadata as Record<string,unknown>|undefined;
    const invokingRunId=typeof metadata?.invokingRunId==='string'?metadata.invokingRunId:undefined;
    const invokingStatus=typeof job.details.invoking_run_status==='string'?job.details.invoking_run_status:undefined;
    const terminal=(status:string|undefined)=>status!==undefined&&['completed','failed','cancelled','orphaned'].includes(status);
    if(childStatus&&!terminal(childStatus))await cancelRun(runId,'session_automation_background_resource_release');
    if(invokingStatus&&!terminal(invokingStatus)){
      if(!invokingRunId)return lifecycleReceipt(job,'pending',{error:'resource_invoking_run_id_unavailable',childStatus,sideEffectKnown:false});
      await cancelRun(invokingRunId,`session_automation_background_resource_${state}_cancel`);
      return lifecycleReceipt(job,'pending',{error:`${state}_worker_cancellation_pending`,invokingRunId,childStatus:childStatus??null,childMissing:!childStatus,sideEffectKnown:false});
    }
    if(childStatus)return lifecycleReceipt(job,'completed',{runId,childStatus:terminal(childStatus)?childStatus:'cancelled',sideEffectKnown:true});
    if(state==='prepared')return lifecycleReceipt(job,'completed',{runId,invokingRunId,childMissing:true,sideEffectKnown:false});
    return lifecycleReceipt(job,'pending',{error:'worker_stop_receipt_required',invokingRunId,childMissing:true,sideEffectKnown:false});
  }},
  budget_reservation:{execute:async job=>{
    const state=String(job.details.state??'');if(['settled','released'].includes(state))return lifecycleReceipt(job,'completed',{billingClosure:state});
    if(job.details.safe_to_release===true)return lifecycleReceipt(job,'completed',{billingClosure:'released'});
    if(['completed','result_unknown','reconcile'].includes(String(job.details.provider_state??'')))return lifecycleReceipt(job,'completed',{billingClosure:'suspense',costKnown:false,providerState:job.details.provider_state});
    return lifecycleReceipt(job,'pending',{error:'provider_reconciliation_required_before_budget_closure',costKnown:false});
  }},
};}

export function createSessionAutomationWorkers(options: {
  store: PgSessionAutomationStore;
  evaluator: Omit<ConstructorParameters<typeof ModelGoalEvaluator>[0], 'runtimeGuard' | 'executionEnabled'>;
  dispatcher: ConstructorParameters<typeof SessionAutomationCoordinator>[1];
  flagSource: SessionAutomationExecutionFlagSource;
  cancelRun: (runId:string,reason:string)=>Promise<void>;
  onError: (error: unknown) => void;
}) {
  // The evaluator shares the same live execution gate at claim and provider transport boundaries.
  const runtimeGuard = new SessionAutomationRuntimeGuard(
    options.store.pool,
    options.flagSource.executionEnabled,
    options.store.tablePrefix,
    options.store.runsTable,
  );
  const evaluator = new SessionAutomationEvaluator(options.store, new ModelGoalEvaluator({
    ...options.evaluator,
    runtimeGuard,
    executionEnabled: options.flagSource.executionEnabled,
  }), options.flagSource.executionEnabled);
  return {
    evaluator,
    provider: new SessionAutomationToolProvider(
      new SessionAutomationTools(options.store, options.flagSource, evaluator),
      options.flagSource,
    ),
    coordinator: new SessionAutomationCoordinator(options.store, options.dispatcher, {
      executionEnabled: options.flagSource.executionEnabled,
      cancelRun: options.cancelRun,
      lifecycleAdapters: createLifecycleAdapters(options.cancelRun, new PgSessionAutomationAttributionStore(options.store.pool, options.store.tablePrefix), options.evaluator.billing),
      onError: options.onError,
    }),
    terminalProjector: new SessionAutomationTerminalProjector(options.store),
  };
}

export { RuntimeSchedulerAutomationDispatcher };

export { SessionAutomationRuntimeGuard } from '../runtime/sessionAutomationRuntimeGuard.js';
export { createSessionAutomationCancelRun } from '../runtime/sessionAutomationCancellation.js';
