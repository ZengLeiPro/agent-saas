import type { UserStore } from '../../data/users/store.js';
import type { WebPushService } from '../../webPush/service.js';
import type { NotifyChannel, NotifyChannelSendOptions, NotifySendResult } from '../notifyChannel.js';

export function createWebPushNotifyChannel(deps: {
  service: WebPushService;
  userStore?: UserStore;
}): NotifyChannel {
  return {
    name: 'web-push',
    async send(_message: string, options: NotifyChannelSendOptions = {}): Promise<NotifySendResult> {
      const ownerId = options.jobOwner;
      const jobId = options.jobId;
      const runId = options.runId;
      const runStatus = options.runStatus;
      if (!ownerId || !jobId || !runId || !runStatus) {
        return { ok: false, error: 'Web Push 缺少任务归属或运行元数据' };
      }
      const owner = deps.userStore?.findById(ownerId);
      if (!owner?.tenantId) return { ok: false, error: 'Web Push 找不到任务归属用户' };

      const status = runStatus === 'ok' ? '执行成功' : runStatus === 'error' ? '执行失败' : '已跳过';
      const url = options.sessionId
        ? `/chat/${encodeURIComponent(options.sessionId)}`
        : `/cron?jobId=${encodeURIComponent(jobId)}&runId=${encodeURIComponent(runId)}`;
      await deps.service.send({
        tenantId: owner.tenantId,
        userId: owner.id,
        eventKey: `cron:${jobId}:${runId}:${runStatus}`,
        taskName: options.jobName || '定时任务',
        status,
        url,
      });
      return { ok: true };
    },
  };
}
