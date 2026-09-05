import type { ChatQueueItem } from './chatQueue';

/**
 * 插话队列条的跨端投影（与 `web/src/components/QueuedMessageBar.tsx` +
 * `web/src/lib/interjectionConsumption.ts` 的可见性/文案口径同源）。
 *
 * 只有「运行中发送、正在等待目标 run 安全边界」的真实插话才进队列条——
 * 判据是服务端给的 `targetRunId`，不是客户端猜的忙闲状态。
 */
export interface QueuedMessageEntry {
  clientMsgId: string;
  /** 撤回走 `cancel_queued`，服务端只认 sourceRunId。 */
  sourceRunId: string;
  content: string;
  attachmentCount: number;
  /** 面向用户的状态文案。 */
  statusLabel: string;
  /** 仍在等待处理（未撤销、未失败）。 */
  pending: boolean;
  /** 已发出撤回请求、等待服务端确认。 */
  cancelling: boolean;
  /** 可以撤回（只有 queued 能撤，cancel_pending 已在路上）。 */
  cancellable: boolean;
  /** 终态（已撤销 / 发送失败）：条目只剩「知道了」价值，可本地移除。 */
  settled: boolean;
}

const VISIBLE_STATUSES = new Set<ChatQueueItem['status']>([
  'queued',
  'cancel_pending',
  'cancelled',
  'failed',
]);

function statusLabelOf(item: ChatQueueItem): string {
  if (item.status === 'cancelled') return item.reason || '已撤销';
  if (item.status === 'failed') return item.reason || '发送失败';
  if (item.deliveryMode === 'steer') return '已发送，将在当前步骤结束后处理';
  return `已排队${item.queuePosition !== undefined ? ` · 第 ${item.queuePosition} 位` : ''}`;
}

export function selectQueuedMessageEntries(
  items: readonly ChatQueueItem[],
  sessionId?: string,
): QueuedMessageEntry[] {
  return items
    .filter(
      (item) =>
        (!sessionId || item.sessionId === sessionId) &&
        Boolean(item.targetRunId) &&
        VISIBLE_STATUSES.has(item.status),
    )
    .map((item) => {
      const settled = item.status === 'cancelled' || item.status === 'failed';
      return {
        clientMsgId: item.clientMsgId,
        sourceRunId: item.sourceRunId,
        content: item.content ?? '',
        attachmentCount: item.attachments?.length ?? 0,
        statusLabel: statusLabelOf(item),
        pending: !settled,
        cancelling: item.status === 'cancel_pending',
        cancellable: item.status === 'queued',
        settled,
      };
    });
}

/** 队列条标题：排队中的条数是用户唯一关心的总量。 */
export function queuedMessageBarTitle(entries: readonly QueuedMessageEntry[]): string {
  return `排队中 · ${entries.filter((entry) => entry.pending).length} 条`;
}
