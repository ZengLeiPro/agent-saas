import type { PgPool } from '../runtime/runStoreTypes.js';
import { SessionAutomationTools, SessionAutomationToolProvider } from '../agent/tools/sessionAutomationTools.js';
import { SessionAutomationCommandService } from '../runtime/sessionAutomationCommandService.js';
import {
  RuntimeSchedulerAutomationDispatcher,
  SessionAutomationCoordinator,
} from '../runtime/sessionAutomationCoordinator.js';
import { ModelGoalEvaluator, SessionAutomationEvaluator } from '../runtime/sessionAutomationEvaluator.js';
import { PgSessionAutomationStore, type SessionAutomationLifecycleAdapters, type SessionAutomationLifecycleJob, type SessionAutomationLifecycleReceipt } from '../runtime/sessionAutomationStore.js';
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
export function createLifecycleAdapters(cancelRun:(runId:string,reason:string)=>Promise<void>):SessionAutomationLifecycleAdapters{return{
  run:{execute:async job=>{await cancelRun(job.objectId,'session_automation_typed_drain');return lifecycleReceipt(job,'completed',{runId:job.objectId});}},
  execution:{execute:async job=>{const runId=String(job.details.run_id??'');if(!runId)return lifecycleReceipt(job,'pending',{error:'execution_run_id_unavailable'});await cancelRun(runId,'session_automation_typed_drain');return lifecycleReceipt(job,'completed',{runId});}},
  evaluation:{execute:async job=>lifecycleReceipt(job,job.action==='cancel'?'completed':'pending',{...(job.action==='reconcile'?{error:'provider_authority_receipt_required'}:{})})},
  provider_attempt:{execute:async job=>lifecycleReceipt(job,job.action==='cancel'&&job.details.state==='prepared'?'completed':'pending',{error:'provider_reconciliation_adapter_unavailable'})},
  interaction:{execute:async job=>lifecycleReceipt(job,job.details.state==='prepared'?'completed':'pending',{error:'active_interaction_adapter_unavailable'})},
  background_resource:{execute:async job=>{if(job.details.resource_kind!=='child_run')return lifecycleReceipt(job,'pending',{error:`resource_adapter_unavailable:${String(job.details.resource_kind??'unknown')}`});const runId=String(job.details.provider_resource_id??'');if(!runId)return lifecycleReceipt(job,'pending',{error:'resource_provider_id_unavailable'});await cancelRun(runId,'session_automation_background_resource_release');return lifecycleReceipt(job,'completed',{runId});}},
  budget_reservation:{execute:async job=>lifecycleReceipt(job,job.details.safe_to_release===true?'completed':'pending',{error:'provider_reconciliation_required_before_budget_release'})},
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
      lifecycleAdapters: createLifecycleAdapters(options.cancelRun),
      onError: options.onError,
    }),
    terminalProjector: new SessionAutomationTerminalProjector(options.store),
  };
}

export { RuntimeSchedulerAutomationDispatcher };

export { SessionAutomationRuntimeGuard } from '../runtime/sessionAutomationRuntimeGuard.js';
export { createSessionAutomationCancelRun } from '../runtime/sessionAutomationCancellation.js';
