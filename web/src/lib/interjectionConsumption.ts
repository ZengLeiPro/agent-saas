import type { ApiSessionDetail } from "@/lib/sessionsApi";

export interface InterjectionIdentity {
  clientMsgId?: string;
  sourceRunId?: string;
}

/** 插话队列区条目（2026-08-04 终态设计）：排队中的消息不进时间线。 */
export interface QueuedInterjection {
  clientMsgId: string;
  /** 服务端 steering source run id（stream_id{queued} ACK 后可用，撤回要用） */
  sourceRunId?: string;
  targetRunId?: string;
  content: string;
  attachments?: Array<{ name: string; isImage?: boolean; relativePath?: string }>;
  /** sending=已发出等 ACK；queued=服务端已受理排队；cancelled=已撤销（可重发）；failed=发送失败（可重发） */
  status: 'sending' | 'queued' | 'cancelled' | 'failed';
  /** cancelled/failed 的原因说明 */
  reason?: string;
  createdAt: number;
}

/**
 * 记录当前会话内已进入时间线的插话，拒绝稍晚到达的 queued 广播或旧 detail 快照将其复活。
 */
export class InterjectionConsumptionRegistry {
  private readonly clientMsgIds = new Set<string>();
  private readonly sourceRunIds = new Set<string>();

  mark(identity: InterjectionIdentity): void {
    if (identity.clientMsgId) this.clientMsgIds.add(identity.clientMsgId);
    if (identity.sourceRunId) this.sourceRunIds.add(identity.sourceRunId);
  }

  markMany(clientMsgIds: readonly string[], sourceRunIds: readonly string[]): void {
    for (const clientMsgId of clientMsgIds) this.clientMsgIds.add(clientMsgId);
    for (const sourceRunId of sourceRunIds) this.sourceRunIds.add(sourceRunId);
  }

  has(identity: InterjectionIdentity): boolean {
    return Boolean(
      (identity.clientMsgId && this.clientMsgIds.has(identity.clientMsgId))
      || (identity.sourceRunId && this.sourceRunIds.has(identity.sourceRunId)),
    );
  }

  clear(): void {
    this.clientMsgIds.clear();
    this.sourceRunIds.clear();
  }
}

export function reconcileQueuedInterjections(
  entries: QueuedInterjection[],
  serverQueued: NonNullable<ApiSessionDetail["queuedMessages"]>,
  consumed: InterjectionConsumptionRegistry,
): QueuedInterjection[] {
  const serverEntries = serverQueued
    .filter((entry) => !consumed.has(entry))
    .map((entry) => {
      const local = entries.find((candidate) => (
        (entry.clientMsgId && candidate.clientMsgId === entry.clientMsgId)
        || candidate.sourceRunId === entry.sourceRunId
      ));
      return {
        clientMsgId: entry.clientMsgId ?? entry.sourceRunId,
        sourceRunId: entry.sourceRunId,
        content: entry.content,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        status: 'queued' as const,
        createdAt: local?.createdAt ?? (Date.parse(entry.acceptedAt) || Date.now()),
      };
    });
  const serverIds = new Set(serverEntries.map((entry) => entry.clientMsgId));
  const keepLocal = entries.filter((entry) => (
    !serverIds.has(entry.clientMsgId)
    && (entry.status === 'sending' || entry.status === 'cancelled' || entry.status === 'failed')
  ));
  return [...serverEntries, ...keepLocal].sort((a, b) => a.createdAt - b.createdAt);
}

/** 无命中时保留原数组引用，避免重复投影触发队列栏和消息区无意义重渲染。 */
export function removeConsumedInterjections<T extends InterjectionIdentity>(
  entries: T[],
  clientMsgIds: ReadonlySet<string>,
  sourceRunIds: ReadonlySet<string>,
): T[] {
  const next = entries.filter((entry) => (
    !(entry.clientMsgId && clientMsgIds.has(entry.clientMsgId))
    && !(entry.sourceRunId && sourceRunIds.has(entry.sourceRunId))
  ));
  return next.length === entries.length ? entries : next;
}
