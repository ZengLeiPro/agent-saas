/**
 * 调度计算模块
 */
import { Cron } from "croner";
import type { CronSchedule, CronJob } from "./types.js";
import { cronLogger } from "../utils/logger.js";

/**
 * 计算调度的下次执行时间
 */
export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number
): number | undefined {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs > nowMs ? schedule.atMs : undefined;

    case "every": {
      const everyMs = Math.max(1, Math.floor(schedule.everyMs));
      const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));

      if (nowMs < anchor) return anchor;

      const elapsed = nowMs - anchor;
      const steps = Math.floor(elapsed / everyMs) + 1;
      return anchor + steps * everyMs;
    }

    case "cron": {
      const expr = schedule.expr.trim();
      if (!expr) return undefined;

      try {
        const cron = new Cron(expr, {
          timezone: schedule.tz?.trim() || undefined,
        });
        const next = cron.nextRun(new Date(nowMs));
        return next ? next.getTime() : undefined;
      } catch (err) {
        cronLogger.error("Invalid cron expression:", expr, err);
        return undefined;
      }
    }
  }
}

/**
 * 计算任务的下次执行时间
 */
export function computeJobNextRunAtMs(
  job: CronJob,
  nowMs: number
): number | undefined {
  if (!job.enabled) return undefined;
  return computeNextRunAtMs(job.schedule, nowMs);
}

/**
 * 找出所有到期的任务
 */
export function findDueJobs(jobs: CronJob[], nowMs: number): CronJob[] {
  return jobs.filter((job) => {
    if (!job.enabled) return false;
    if (job.state.runningAtMs) return false;
    const nextRun = job.state.nextRunAtMs;
    return nextRun !== undefined && nextRun <= nowMs;
  });
}

/**
 * 计算下一次唤醒时间（所有任务中最早的）
 */
export function computeNextWakeAtMs(jobs: CronJob[]): number | undefined {
  let earliest: number | undefined;

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (job.state.runningAtMs) continue;
    const nextRun = job.state.nextRunAtMs;
    if (nextRun === undefined) continue;

    if (earliest === undefined || nextRun < earliest) {
      earliest = nextRun;
    }
  }

  return earliest;
}

/**
 * 验证 Cron 表达式是否有效
 */
export function validateCronExpr(
  expr: string,
  tz?: string
): { valid: boolean; error?: string } {
  try {
    const cron = new Cron(expr.trim(), {
      timezone: tz?.trim() || undefined,
    });
    cron.nextRun();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}
