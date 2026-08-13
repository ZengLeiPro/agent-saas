import { randomUUID } from "crypto";
import os from "os";
import type { CronExecutionRecord, CronJob, CronRunTrigger } from "./types.js";
import { cloneJob } from "./serviceUtils.js";

export interface CronRunLease {
  release(): Promise<void>;
}

export interface CronRunRequest {
  requestId?: string;
  retryOf?: string;
  parentRunId?: string;
  attempt?: number;
}

export interface ExecutionInvocation extends CronRunRequest {
  trigger: CronRunTrigger;
  scheduledAtMs?: number;
}

export interface ClaimedJob {
  job: CronJob;
  runId: string;
  leaseId: string;
  ownerId: string;
  startedAtMs: number;
  claimedUpdatedAtMs: number;
  forced: boolean;
  runLease?: CronRunLease;
  releaseLeaseAfterSettlement?: boolean;
  trigger: CronRunTrigger;
  scheduledAtMs?: number;
  requestId?: string;
  attempt: number;
  parentRunId?: string;
  retryOf?: string;
  idempotencyKey: string;
}

interface MutationOutcome<T> { changed: boolean; value: T }
interface ClaimValue {
  claim?: ClaimedJob;
  error?: string;
  duplicate?: CronExecutionRecord;
}

interface ClaimMutationOptions {
  nowMs: () => number;
  ownerId: string;
  mutate: <T>(mutator: (jobs: CronJob[]) => MutationOutcome<T>) => Promise<MutationOutcome<T>>;
  getTimeoutSeconds: (job: CronJob) => number;
  watchdogFallbackTimeoutMs: number;
  watchdogOvertimeMs: number;
}

export interface ClaimCronJobOptions extends ClaimMutationOptions {
  id: string;
  invocation: ExecutionInvocation;
  schedulerActive: () => boolean;
  tryAcquireRunLease?: (jobId: string) => Promise<CronRunLease | null>;
}

function clearActiveExecution(job: CronJob): void {
  delete job.state.runningAtMs;
  delete job.state.runningRunId;
  delete job.state.runningLeaseId;
  delete job.state.runningDeadlineAtMs;
  delete job.state.runningTimedOutAtMs;
  delete job.state.runningOwnerPid;
  delete job.state.runningOwnerHostname;
}

function claimSnapshot(
  job: CronJob,
  execution: CronExecutionRecord,
  claimedUpdatedAtMs: number,
  runLease?: CronRunLease,
): ClaimedJob {
  return {
    job: cloneJob(job),
    runId: execution.runId,
    leaseId: execution.leaseId,
    ownerId: execution.ownerId,
    startedAtMs: execution.startedAtMs,
    claimedUpdatedAtMs,
    forced: execution.trigger !== "schedule",
    runLease,
    trigger: execution.trigger,
    scheduledAtMs: execution.scheduledAtMs,
    requestId: execution.requestId,
    attempt: execution.attempt,
    parentRunId: execution.parentRunId,
    retryOf: execution.retryOf,
    idempotencyKey: execution.idempotencyKey,
  };
}

function assignLease(
  job: CronJob,
  execution: CronExecutionRecord,
  options: ClaimMutationOptions,
  claimedAtMs: number,
): void {
  const leaseId = randomUUID();
  execution.status = "claimed";
  execution.ownerId = options.ownerId;
  execution.leaseId = leaseId;
  execution.claimedAtMs = claimedAtMs;
  execution.leaseVersion = Math.max(0, execution.leaseVersion ?? 0) + 1;
  delete execution.runningAtMs;
  delete execution.terminalStatus;
  delete execution.endedAtMs;
  job.state.runningAtMs = claimedAtMs;
  job.state.runningRunId = execution.runId;
  job.state.runningLeaseId = leaseId;
  job.state.runningOwnerPid = process.pid;
  job.state.runningOwnerHostname = os.hostname();
  delete job.state.runningTimedOutAtMs;
  const timeoutMs = options.getTimeoutSeconds(job) * 1000 || options.watchdogFallbackTimeoutMs;
  job.state.runningDeadlineAtMs = claimedAtMs + timeoutMs + options.watchdogOvertimeMs;
}

export async function claimCronJob(options: ClaimCronJobOptions): Promise<{
  value?: ClaimedJob;
  error?: string;
  duplicate?: CronExecutionRecord;
}> {
  const { id, invocation } = options;
  const claimedAtMs = options.nowMs();
  const forced = invocation.trigger !== "schedule";
  const requestId = invocation.requestId?.trim();
  if (forced && !requestId) return { error: "Manual execution request id is required" };
  if (invocation.trigger === "retry" && !invocation.retryOf) return { error: "Retry source run is required" };
  const idempotencyKey = invocation.trigger === "schedule"
    ? `cron:${id}:schedule:${invocation.scheduledAtMs}`
    : `cron:${id}:request:${requestId}`;
  const runLease = options.tryAcquireRunLease
    ? await options.tryAcquireRunLease(id)
    : undefined;
  if (options.tryAcquireRunLease && !runLease) {
    const duplicate = await options.mutate((jobs) => {
      const job = jobs.find((candidate) => candidate.id === id);
      const record = job?.state.executionLedger?.find((item) => item.idempotencyKey === idempotencyKey);
      return { changed: false, value: record ? { ...record } : undefined };
    });
    return duplicate.value ? { duplicate: duplicate.value } : { error: "Job is already running" };
  }

  let claimed = false;
  try {
    const outcome = await options.mutate<ClaimValue>((jobs) => {
      if (!forced && !options.schedulerActive()) return { changed: false, value: {} };
      const job = jobs.find((candidate) => candidate.id === id);
      if (!job) return { changed: false, value: { error: "Job not found" } };
      const ledger = job.state.executionLedger ?? (job.state.executionLedger = []);
      const duplicate = ledger.find((record) => record.idempotencyKey === idempotencyKey);
      if (duplicate) return { changed: false, value: { duplicate: { ...duplicate } } };

      if (job.state.runningAtMs != null || job.state.runningRunId != null) {
        return { changed: false, value: { error: "Job is already running" } };
      }
      if (!forced) {
        const nextRunAtMs = job.state.nextRunAtMs;
        if (!job.enabled || nextRunAtMs === undefined || nextRunAtMs > claimedAtMs
          || nextRunAtMs !== invocation.scheduledAtMs) {
          return { changed: false, value: {} };
        }
      }

      let attempt = Math.max(1, Math.floor(invocation.attempt ?? 1));
      const parentRunId = invocation.trigger === "retry"
        ? (invocation.parentRunId || invocation.retryOf)
        : undefined;
      if (parentRunId) {
        const maxLineageAttempt = ledger.reduce((max, record) => {
          const sameLineage = record.runId === parentRunId || record.parentRunId === parentRunId;
          return sameLineage ? Math.max(max, record.attempt || 1) : max;
        }, 0);
        attempt = Math.max(attempt, maxLineageAttempt + 1);
      }

      const execution: CronExecutionRecord = {
        idempotencyKey,
        runId: `${claimedAtMs}-${randomUUID()}`,
        startedAtMs: claimedAtMs,
        claimedAtMs,
        status: "claimed",
        ownerId: options.ownerId,
        leaseId: "",
        leaseVersion: 0,
        trigger: invocation.trigger,
        scheduledAtMs: invocation.scheduledAtMs,
        requestId,
        attempt,
        parentRunId,
        retryOf: invocation.retryOf,
      };
      ledger.push(execution);
      const claimedUpdatedAtMs = job.updatedAtMs;
      assignLease(job, execution, options, claimedAtMs);
      return {
        changed: true,
        value: { claim: claimSnapshot(job, execution, claimedUpdatedAtMs, runLease ?? undefined) },
      };
    });
    claimed = !!outcome.value.claim;
    return { value: outcome.value.claim, error: outcome.value.error, duplicate: outcome.value.duplicate };
  } finally {
    if (!claimed) await runLease?.release().catch(() => {});
  }
}

export async function markCronClaimRunning(
  options: Pick<ClaimMutationOptions, "mutate" | "nowMs"> & { claim: ClaimedJob },
): Promise<boolean> {
  const outcome = await options.mutate((jobs): MutationOutcome<boolean> => {
    const job = jobs.find((candidate) => candidate.id === options.claim.job.id);
    const execution = job?.state.executionLedger?.find((record) => record.runId === options.claim.runId);
    if (!job || !execution
      || job.state.runningRunId !== options.claim.runId
      || job.state.runningLeaseId !== options.claim.leaseId
      || execution.leaseId !== options.claim.leaseId
      || execution.status !== "claimed") {
      return { changed: false, value: false };
    }
    execution.status = "running";
    execution.runningAtMs = options.nowMs();
    return { changed: true, value: true };
  });
  return outcome.value;
}

export interface RecoverCronClaimOptions extends ClaimMutationOptions {
  id: string;
  runId: string;
  expectedLeaseId?: string;
  runLease?: CronRunLease;
}

export async function recoverCronClaim(options: RecoverCronClaimOptions): Promise<{
  claim?: ClaimedJob;
  cleared: boolean;
}> {
  const recoveredAtMs = options.nowMs();
  const outcome = await options.mutate((jobs): MutationOutcome<{ claim?: ClaimedJob; cleared: boolean }> => {
    const job = jobs.find((candidate) => candidate.id === options.id);
    if (!job || job.state.runningRunId !== options.runId
      || job.state.runningLeaseId !== options.expectedLeaseId) {
      return { changed: false, value: { cleared: false } };
    }
    const execution = job.state.executionLedger?.find((record) => record.runId === options.runId);
    if (!execution || execution.terminalStatus || execution.status === "terminal") {
      clearActiveExecution(job);
      return { changed: true, value: { cleared: true } };
    }
    const claimedUpdatedAtMs = job.updatedAtMs;
    assignLease(job, execution, options, recoveredAtMs);
    return {
      changed: true,
      value: {
        claim: claimSnapshot(job, execution, claimedUpdatedAtMs, options.runLease),
        cleared: false,
      },
    };
  });
  return outcome.value;
}
