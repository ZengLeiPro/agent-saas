import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronService, type CronServiceDeps } from '../cron/service.js';
import type { CronJob, CronRunLogEntry } from '../cron/types.js';

function harness(timeoutSeconds = 1) {
  let now = 1_000_000;
  const logs: CronRunLogEntry[] = [];
  const cancels: Parameters<NonNullable<CronServiceDeps['cancelRuntimeRun']>>[0][] = [];
  const service = new CronService({
    nowMs: () => now, loadJobs: async () => [], saveJobs: async () => {},
    executeJob: async () => new Promise(() => {}), appendRunLog: async (entry) => { logs.push(entry); },
    cancelRuntimeRun: async (input) => {
      cancels.push(input);
      return { runId: input.runtimeRunId, sessionId: input.sessionId, status: 'cancelled', statusReason: input.reason };
    },
    defaultTimeoutSeconds: timeoutSeconds,
  });
  return { service, logs, cancels, setNow: (value: number) => { now = value; } };
}

async function scheduledClaim(h: ReturnType<typeof harness>, timeoutSeconds = 1) {
  const { service } = h;
  const job = await service.add({ name: 'one-shot', schedule: { kind: 'at', atMs: 1_000_001 },
    payload: { kind: 'agentTurn', message: 'run', timeoutSeconds } });
  h.setNow(1_000_001);
  (service as any).started = true;
  const result = await (service as any).claimJob(job.id, { trigger: 'schedule', scheduledAtMs: job.state.nextRunAtMs });
  (service as any).started = false;
  return { job, claim: result.value } as { job: CronJob; claim: any };
}

afterEach(() => vi.useRealTimers());

describe('scheduled-at terminal settlement', () => {
  it('hard timeout 消费一次性计划后清除过期 nextRunAtMs', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { job, claim } = await scheduledClaim(h);
    const execution = (h.service as any).executeClaimedJob(claim);
    await vi.advanceTimersByTimeAsync(61_000);
    h.setNow(1_061_001);
    await execution;
    expect((await h.service.get(job.id))?.state.nextRunAtMs).toBeUndefined();
    expect(h.cancels).toHaveLength(1);
  });

  it('watchdog 收口一次性计划后清除过期 nextRunAtMs', async () => {
    const h = harness(600);
    const { job, claim } = await scheduledClaim(h, 600);
    void (h.service as any).executeClaimedJob(claim);
    await Promise.resolve();
    h.setNow(1_780_002);
    await (h.service as any).checkStaleJobs();
    expect((await h.service.get(job.id))?.state.nextRunAtMs).toBeUndefined();
    expect(h.cancels).toHaveLength(1);
  });

  it('显式 cancel 清除已消费 at，但手工运行不误吞未来 at', async () => {
    const scheduled = harness();
    const { job, claim } = await scheduledClaim(scheduled);
    await scheduled.service.cancelRun(job.id, claim.runId);
    expect((await scheduled.service.get(job.id))?.state.nextRunAtMs).toBeUndefined();

    const manual = harness();
    const future = await manual.service.add({ name: 'future', schedule: { kind: 'at', atMs: 9_999_999 },
      payload: { kind: 'agentTurn', message: 'run' } });
    const started = await manual.service.runNow(future.id, { requestId: 'manual-1' });
    await manual.service.cancelRun(future.id, started.runId!);
    expect((await manual.service.get(future.id))?.state.nextRunAtMs).toBe(9_999_999);
  });
});
