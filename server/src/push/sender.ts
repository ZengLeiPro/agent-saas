/**
 * 推送投递面：浏览器 Web Push 与 iOS APNs 共用同一条消息契约与计数器语义。
 * 触发点（运行期事件 / Cron / Taskboard）只依赖 PushSender，不关心具体通道。
 */

export interface PushOwner {
  tenantId: string;
  userId: string;
}

export interface PushMessage extends PushOwner {
  /** 同一事件在每台设备只投递一次的幂等键。 */
  eventKey: string;
  /** 锁屏可见文案只允许任务名和状态，不含会话正文。 */
  taskName: string;
  status: string;
  /** 站内相对路径（`/chat/<id>`、`/cron?jobId=…`），各端自行映射为深链。 */
  url: string;
}

export interface PushSendCounters {
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
}

export interface PushSender {
  send(message: PushMessage): Promise<PushSendCounters>;
}

export function emptyPushCounters(): PushSendCounters {
  return { sent: 0, failed: 0, skipped: 0, deferred: 0 };
}

/**
 * 把一条消息扇出到所有已配置通道并汇总计数。单个通道抛错不阻断其它通道；
 * 全部完成后再把错误抛回，让调用方保留重试语义（各通道自有幂等 claim，重试不会重复投递）。
 */
export function createPushFanout(transports: readonly PushSender[]): PushSender | undefined {
  if (transports.length === 0) return undefined;
  if (transports.length === 1) return transports[0];
  return {
    async send(message) {
      const results = await Promise.allSettled(
        transports.map((transport) => transport.send(message)),
      );
      const counters = emptyPushCounters();
      const errors: unknown[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          counters.sent += result.value.sent;
          counters.failed += result.value.failed;
          counters.skipped += result.value.skipped;
          counters.deferred += result.value.deferred;
        } else {
          errors.push(result.reason);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} 条推送通道投递失败`);
      }
      return counters;
    },
  };
}

export function normalizePushTargetUrl(rawUrl: string): string {
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('\\')) return '/';
  return rawUrl;
}
