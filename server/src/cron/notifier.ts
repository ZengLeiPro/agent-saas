/**
 * Cron Notification Handler
 *
 * 组装通知消息并分发到注入的 NotifyChannel 实例。
 * 具体通道实现（DingTalk、Web 等）由 runtime.ts 在装配时通过 NotifyChannelResolver 注入。
 */

import type { CronJob, CronRunLogEntry } from './types.js';
import type { NotifyChannelResolver } from './notifyChannel.js';
import { cronLogger } from '../utils/logger.js';

// ============================================
// Types
// ============================================

export interface CronNotifierDeps {
  resolveChannels: NotifyChannelResolver;
}

// ============================================
// Message Formatting
// ============================================

function buildNotificationMessage(
  job: CronJob,
  run: CronRunLogEntry,
  output?: string,
  error?: string,
): string {
  const statusText = run.status === 'ok' ? '完成' : run.status === 'error' ? '失败' : '跳过';
  const timeText = new Date(run.startedAtMs).toLocaleString('zh-CN');
  const meta = `时间：${timeText}\n耗时：${(run.durationMs / 1000).toFixed(1)}s\nrunId：${run.runId}`;
  const body = run.status === 'error' ? (error || run.error || output || '') : (output || '');
  const excerpt = (body || '').trim() ? (body || '').trim().slice(0, 2000) : '(no output)';
  const followup = `\n\n追问：在本会话回复\n追问 ${run.runId} <你的问题>`;
  return `[定时任务${statusText}] ${job.name}\n\n${meta}\n\n${excerpt}${followup}`;
}

// ============================================
// Notifier Factory
// ============================================

/**
 * 创建 Cron 通知回调函数
 *
 * 由 runtime.ts 调用，注入 resolveChannels 后返回可直接传给 CronService 的 notify 函数。
 */
export function createCronNotifier(deps: CronNotifierDeps) {
  const { resolveChannels } = deps;

  return async ({ job, run, output, error }: {
    job: CronJob;
    run: CronRunLogEntry;
    output?: string;
    error?: string;
  }) => {
    const notify = job.notify;
    if (!notify?.enabled) return;
    if (run.status === 'ok' && notify.onSuccess === false) return;
    if (run.status === 'error' && notify.onError === false) return;

    const message = buildNotificationMessage(job, run, output, error);
    const channels = resolveChannels(notify);

    for (const channel of channels) {
      try {
        const result = await channel.send(message, {
          msgType: 'markdown',
          jobId: job.id,
          jobName: job.name,
          jobOwner: job.owner,
          runId: run.runId,
          runStatus: run.status,
          durationMs: run.durationMs,
        });
        if (!result.ok) {
          cronLogger.error(`Notify channel ${channel.name} failed: ${result.error}`);
        }
      } catch (e) {
        cronLogger.error(`Failed to send notification via ${channel.name}:`, e);
      }
    }
  };
}
