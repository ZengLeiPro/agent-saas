import type { CronJob } from './types.js';

export class ServiceTimeoutError extends Error {}

export function pTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new ServiceTimeoutError(message)), ms);
    timer.unref?.();
    promise.then(
      value => { clearTimeout(timer); resolvePromise(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}

export function toFiniteInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

export function cloneJob(job: CronJob): CronJob {
  return structuredClone(job);
}

export function updatedAtAfterEdit(job: CronJob, candidateMs: number): number {
  return Math.max(candidateMs, job.updatedAtMs + 1);
}

export function transferCronJobOwner(
  jobs: CronJob[],
  input: { id: string; expectedOwner: string; owner: string; ownerName?: string; nowMs: number },
): { changed: boolean; value: string | undefined } {
  const job = jobs.find(candidate => candidate.id === input.id);
  if (!job) return { changed: false, value: undefined };
  if (job.systemKind) throw new Error('CRON_SYSTEM_JOB_TRANSFER_UNSUPPORTED');
  if (job.owner !== input.expectedOwner) throw new Error('CRON_OWNER_CONFLICT');
  if (job.state.runningRunId) throw new Error('CRON_RUN_ACTIVE_STOP_UNSUPPORTED');
  job.enabled = false;
  job.owner = input.owner;
  job.ownerName = input.ownerName;
  delete job.orgAgentId;
  job.updatedAtMs = updatedAtAfterEdit(job, input.nowMs);
  job.state.nextRunAtMs = undefined;
  return { changed: true, value: job.id };
}
