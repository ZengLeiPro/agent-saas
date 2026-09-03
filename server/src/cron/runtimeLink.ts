import os from 'os';
import { recoverCronClaim, type ClaimedJob, type CronRunLease } from './executionClaim.js';
import { isProcessAlive } from './serviceUtils.js';
import { cronLogger } from '../utils/logger.js';
import { computeJobNextRunAtMs } from './scheduler.js';
import { cloneJob } from './serviceUtils.js';
import type { CronEvent, CronJob, CronRunLogEntry } from './types.js';

export type CronLinkedRuntimeStatus =
  | 'pending' | 'running' | 'waiting_approval' | 'waiting_user' | 'waiting_hand'
  | 'completed' | 'failed' | 'cancelled' | 'orphaned';

export interface CronLinkedRuntimeRun {
  runId: string;
  sessionId: string;
  status: CronLinkedRuntimeStatus;
  statusReason?: string;
}

export interface CronRuntimeLinkDeps {
  inspectRuntimeRun?: (runtimeRunId: string) => Promise<CronLinkedRuntimeRun | null>;
  cancelRuntimeRun?: (input: { runtimeRunId: string; sessionId: string; reason: string; tenantId?: string; userId?: string }) => Promise<CronLinkedRuntimeRun | null>;
  runtimeRunPollMs?: number;
}

export interface CronExecutionResult {
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  output?: string;
  suppressNotification?: boolean;
  sessionId?: string;
  transcriptPath?: string;
  modelRef?: string;
}

type MutationOutcome<T> = { changed: boolean; value: T };
type Mutate = <T>(mutator: (jobs: CronJob[]) => MutationOutcome<T> | Promise<MutationOutcome<T>>) => Promise<MutationOutcome<T>>;

function clearActiveExecution(job: CronJob): void {
  delete job.state.runningAtMs; delete job.state.runningRunId; delete job.state.runningLeaseId;
  delete job.state.runningDeadlineAtMs; delete job.state.runningTimedOutAtMs;
  delete job.state.runningOwnerPid; delete job.state.runningOwnerHostname;
}

export class RuntimeObservationError extends Error {
  constructor(runId: string, cause: unknown) {
    super(`Runtime run observation failed: ${runId}`, { cause });
    this.name = 'RuntimeObservationError';
  }
}

export async function inspectLinkedRuntime(
  inspect: NonNullable<CronRuntimeLinkDeps['inspectRuntimeRun']>,
  runId: string,
): Promise<CronLinkedRuntimeRun | null> {
  try { return await inspect(runId); }
  catch (error) { throw new RuntimeObservationError(runId, error); }
}

export function isRuntimeTerminal(status: CronLinkedRuntimeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned';
}

export function runtimeResult(run: CronLinkedRuntimeRun): CronExecutionResult {
  return run.status === 'completed'
    ? { status: 'ok', sessionId: run.sessionId }
    : { status: 'error', error: run.statusReason ?? `Runtime run ended with status ${run.status}`, sessionId: run.sessionId };
}

export async function waitForRuntimeTerminal(
  run: CronLinkedRuntimeRun,
  inspect: NonNullable<CronRuntimeLinkDeps['inspectRuntimeRun']>,
  pollMs = 1_500,
): Promise<CronExecutionResult> {
  let current = run;
  while (!isRuntimeTerminal(current.status)) {
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, pollMs); timer.unref?.(); });
    const inspected = await inspectLinkedRuntime(inspect, current.runId);
    if (!inspected) throw new RuntimeObservationError(current.runId, new Error('linked Runtime run disappeared'));
    current = inspected;
  }
  return runtimeResult(current);
}

export async function cancelLinkedRuntime(
  claim: ClaimedJob,
  reason: string,
  cancel: CronRuntimeLinkDeps['cancelRuntimeRun'],
): Promise<CronLinkedRuntimeRun | undefined> {
  if (!claim.runtimeRunId || !claim.sessionId) return undefined;
  if (!cancel) throw new Error(`Runtime cancellation adapter is unavailable for ${claim.runtimeRunId}`);
  const run = await cancel({ runtimeRunId: claim.runtimeRunId, sessionId: claim.sessionId, reason, tenantId: claim.runtimeTenantId, userId: claim.job.owner });
  if (!run) throw new Error(`Runtime run cancellation outcome is unknown: ${claim.runtimeRunId}`);
  if (!isRuntimeTerminal(run.status)) {
    throw new Error(`Runtime run did not converge after cancellation: ${run.runId} status=${run.status}`);
  }
  return run;
}

interface SettlementContext {
  nowMs: () => number;
  mutate: Mutate;
  afterJobsChanged: () => void;
  appendRunLog: (entry: CronRunLogEntry) => Promise<void>;
  emit: (event: CronEvent) => void;
}

export async function settleExplicitCancellation(
  context: SettlementContext,
  job: CronJob,
  runId: string,
  runtime: CronLinkedRuntimeRun,
): Promise<{ cancelled: boolean; error?: string }> {
  const execution = job.state.executionLedger!.find((record) => record.runId === runId)!;
  const endedAtMs = context.nowMs();
  const status = runtime.status === 'completed' ? 'ok' as const : 'error' as const;
  const error = runtime.status === 'completed' ? undefined : runtime.statusReason ?? 'Cron run cancelled';
  const outcome = await context.mutate((jobs): MutationOutcome<CronJob | undefined> => {
    const current = jobs.find((candidate) => candidate.id === job.id);
    const record = current?.state.executionLedger?.find((candidate) => candidate.runId === runId);
    if (!current || !record || record.terminalStatus) return { changed: false, value: current && cloneJob(current) };
    record.status = 'terminal'; record.terminalStatus = status; record.endedAtMs = endedAtMs;
    current.state.lastRunAtMs = record.startedAtMs; current.state.lastStatus = status;
    current.state.lastError = error; current.state.lastDurationMs = Math.max(0, endedAtMs - record.startedAtMs);
    clearActiveExecution(current);
    if (current.schedule.kind === 'at' && record.trigger === 'schedule') {
      delete current.state.nextRunAtMs;
      if (status === 'ok') current.enabled = false;
    } else if (current.schedule.kind !== 'at' && current.enabled) {
      current.state.nextRunAtMs = computeJobNextRunAtMs(current, endedAtMs);
    }
    return { changed: true, value: cloneJob(current) };
  });
  if (!outcome.changed) return { cancelled: true };
  context.afterJobsChanged();
  const durationMs = Math.max(0, endedAtMs - execution.startedAtMs);
  await context.appendRunLog({
    runId, startedAtMs: execution.startedAtMs, endedAtMs, trigger: execution.trigger,
    scheduledAtMs: execution.scheduledAtMs, requestId: execution.requestId, attempt: execution.attempt,
    parentRunId: execution.parentRunId, retryOf: execution.retryOf, jobId: job.id, jobName: job.name,
    status, error, sessionId: execution.sessionId, durationMs,
  });
  context.emit({ type: 'finished', jobId: job.id, jobName: job.name, status, error, durationMs,
    sessionId: execution.sessionId, owner: job.owner });
  return { cancelled: true };
}

export async function quarantineLegacyOrphan(context: SettlementContext, claim: ClaimedJob): Promise<boolean> {
  const endedAtMs = context.nowMs();
  const error = 'Legacy orphan cron claim has no Runtime identity; redispatch refused';
  const outcome = await context.mutate((jobs): MutationOutcome<boolean> => {
    const job = jobs.find((candidate) => candidate.id === claim.job.id);
    const execution = job?.state.executionLedger?.find((record) => record.runId === claim.runId);
    if (!job || !execution || execution.terminalStatus || job.state.runningRunId !== claim.runId
      || job.state.runningLeaseId !== claim.leaseId) return { changed: false, value: false };
    execution.status = 'terminal'; execution.terminalStatus = 'error'; execution.endedAtMs = endedAtMs;
    job.enabled = false; job.state.lastRunAtMs = execution.startedAtMs; job.state.lastStatus = 'error';
    job.state.lastError = error; job.state.lastDurationMs = Math.max(0, endedAtMs - execution.startedAtMs);
    delete job.state.nextRunAtMs; clearActiveExecution(job);
    return { changed: true, value: true };
  });
  if (!outcome.changed) return false;
  context.afterJobsChanged();
  await context.appendRunLog({
    runId: claim.runId, startedAtMs: claim.startedAtMs, endedAtMs, trigger: claim.trigger,
    scheduledAtMs: claim.scheduledAtMs, requestId: claim.requestId, attempt: claim.attempt,
    parentRunId: claim.parentRunId, retryOf: claim.retryOf, jobId: claim.job.id, jobName: claim.job.name,
    status: 'error', error, durationMs: Math.max(0, endedAtMs - claim.startedAtMs),
  });
  return true;
}

export interface OrphanClaimCandidate {
  id: string;
  runId: string;
  leaseId: string;
  ownerPid?: number;
  ownerHostname?: string;
}

interface RecoveryContext extends SettlementContext {
  candidates: OrphanClaimCandidate[];
  executionOwnerId: string;
  tryAcquireRunLease?: (jobId: string) => Promise<CronRunLease | null>;
  inspectRuntimeRun?: CronRuntimeLinkDeps['inspectRuntimeRun'];
  getTimeoutSeconds: (job: CronJob) => number;
  watchdogFallbackTimeoutMs: number;
  watchdogOvertimeMs: number;
  executeClaimedJob: (claim: ClaimedJob) => Promise<void>;
}

export async function recoverOrphanCronClaims(context: RecoveryContext): Promise<void> {
  for (const candidate of context.candidates) {
    let lease: CronRunLease | null = null;
    let dispatched = false;
    try {
      const localOwnerDead = candidate.ownerHostname === os.hostname() && !!candidate.ownerPid && !isProcessAlive(candidate.ownerPid);
      if (context.tryAcquireRunLease) lease = await context.tryAcquireRunLease(candidate.id);
      else if (!localOwnerDead) continue;
      if (context.tryAcquireRunLease && !lease) continue;
      const recovered = await recoverCronClaim({
        ...candidate, expectedLeaseId: candidate.leaseId, runLease: lease ?? undefined,
        nowMs: context.nowMs, ownerId: context.executionOwnerId, mutate: context.mutate,
        getTimeoutSeconds: context.getTimeoutSeconds, watchdogFallbackTimeoutMs: context.watchdogFallbackTimeoutMs,
        watchdogOvertimeMs: context.watchdogOvertimeMs,
      });
      if (!recovered.claim) { if (recovered.cleared) context.afterJobsChanged(); continue; }
      context.afterJobsChanged();
      if (recovered.claim.job.payload.kind === 'agentTurn'
        && (!recovered.claim.runtimeRunId || !recovered.claim.sessionId)) {
        if (await quarantineLegacyOrphan(context, recovered.claim))
          cronLogger.error(`Legacy orphan cron claim has no Runtime identity; redispatch refused: ${candidate.id} (${candidate.runId})`);
        continue;
      }
      dispatched = true;
      cronLogger.warn(`Recovering orphan cron claim with stable identity: ${candidate.id} (${candidate.runId})`);
      void context.executeClaimedJob(recovered.claim).catch((error) => cronLogger.error('Recovered cron execution failed:', error));
    } catch (error) {
      cronLogger.error(`Failed to recover orphan cron claim ${candidate.id}:`, error);
    } finally {
      if (!dispatched) await lease?.release().catch(() => {});
    }
  }
}

export async function cancelCronRun(
  context: SettlementContext,
  jobs: CronJob[],
  cancel: CronRuntimeLinkDeps['cancelRuntimeRun'],
  id: string,
  runId: string,
  reason: string,
): Promise<{ cancelled: boolean; error?: string }> {
  const job = jobs.find((candidate) => candidate.id === id);
  if (!job) return { cancelled: false, error: 'Job not found' };
  const execution = job.state.executionLedger?.find((record) => record.runId === runId);
  if (!execution) return { cancelled: false, error: 'Run not found' };
  if (execution.terminalStatus) return { cancelled: true };
  if (job.state.runningRunId !== runId || !execution.runtimeRunId || !execution.sessionId)
    return { cancelled: false, error: 'Run is not cancellable' };
  try {
    if (!cancel) return { cancelled: false, error: 'Runtime cancellation is unavailable' };
    const runtime = await cancel({ runtimeRunId: execution.runtimeRunId, sessionId: execution.sessionId,
      reason: `${reason}:${runId}`, tenantId: execution.runtimeTenantId, userId: job.owner });
    if (!runtime) return { cancelled: false, error: 'Runtime cancellation outcome is unknown' };
    if (!isRuntimeTerminal(runtime.status)) return { cancelled: false, error: `Runtime run did not converge: ${runtime.status}` };
    return settleExplicitCancellation(context, job, runId, runtime);
  } catch (error) {
    return { cancelled: false, error: error instanceof Error ? error.message : String(error) };
  }
}
