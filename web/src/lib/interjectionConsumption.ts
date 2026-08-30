import type { ApiSessionDetail } from "@/lib/sessionsApi";
import type { UploadedFile } from "@/components/types";
import { isValidAttachmentId } from "@agent/shared";

export interface InterjectionIdentity {
  clientMsgId?: string;
  sourceRunId?: string;
}

/** 服务端已接收但尚未开始执行的消息；普通 queue 与显式 steer 共用。 */
export interface QueuedInterjection {
  clientMsgId: string;
  /** 服务端 run id（stream_id{queued} ACK 后可用，撤回要用） */
  sourceRunId?: string;
  targetRunId?: string;
  deliveryMode: 'queue' | 'steer';
  queuePosition?: number;
  content: string;
  /** Path-free queue/replay projection; attachmentId is authoritative. */
  attachments?: Array<{
    name: string;
    attachmentId?: string;
    size?: number;
    mimeType?: string;
    isImage?: boolean;
  }>;
  /** 队列项所属的权威会话；异步 ACK/核验不得把它投影到其他会话。 */
  sessionId?: string;
  /** 本机提交时保留完整上传结果，供编辑/重发复用；服务端旧 DTO 仅能恢复 attachments 元数据。 */
  uploadedFiles?: UploadedFile[];
  /** verifying=ACK 超时后正核验服务端；此时禁止无幂等保护的重试。 */
  status: 'sending' | 'verifying' | 'queued' | 'cancelled' | 'failed';
  /** cancelled/failed 的原因说明 */
  reason?: string;
  createdAt: number;
}

/**
 * 记录已进入时间线的插话，拒绝稍晚到达的 queued 广播或旧 detail 快照将其复活。
 * clientMsgId 全局唯一，消费标记跨会话保留（TASK-70）：切会话再切回时，旧 detail
 * 快照即使短暂返回已投影的 pending run，也会被这里拦截，不再复活到队列区。
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
  sessionId?: string,
): QueuedInterjection[] {
  const serverEntries = serverQueued
    .filter((entry) => !consumed.has(entry))
    .map((entry) => {
      const local = entries.find((candidate) => (
        (entry.clientMsgId && candidate.clientMsgId === entry.clientMsgId)
        || (entry.sourceRunId && candidate.sourceRunId === entry.sourceRunId)
      ));
      const restoredFiles = entry.attachments?.flatMap((attachment) => (
        isValidAttachmentId(attachment.attachmentId)
        && typeof attachment.size === 'number'
        && typeof attachment.mimeType === 'string'
          ? [{
            attachmentId: attachment.attachmentId,
            originalName: attachment.name,
            // Local adapters never submit this compatibility placeholder; V1 uses attachmentId only.
            relativePath: '',
            size: attachment.size,
            mimeType: attachment.mimeType,
            isImage: attachment.isImage ?? attachment.mimeType.startsWith('image/'),
          }]
          : []
      ));
      return {
        clientMsgId: entry.clientMsgId ?? entry.sourceRunId,
        sourceRunId: entry.runId ?? entry.sourceRunId,
        ...(entry.targetRunId ? { targetRunId: entry.targetRunId } : {}),
        deliveryMode: entry.deliveryMode === 'steer' ? 'steer' as const : 'queue' as const,
        ...(entry.queuePosition !== undefined ? { queuePosition: entry.queuePosition } : {}),
        content: entry.content,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        ...(local?.uploadedFiles?.length
          ? { uploadedFiles: local.uploadedFiles }
          : restoredFiles?.length
            ? { uploadedFiles: restoredFiles }
            : {}),
        ...(sessionId ? { sessionId } : local?.sessionId ? { sessionId: local.sessionId } : {}),
        status: 'queued' as const,
        createdAt: local?.createdAt ?? (Date.parse(entry.acceptedAt) || Date.now()),
      };
    });
  const serverIds = new Set(serverEntries.map((entry) => entry.clientMsgId));
  const keepLocal = entries.filter((entry) => (
    !serverIds.has(entry.clientMsgId)
    && (entry.status === 'sending' || entry.status === 'verifying' || entry.status === 'cancelled' || entry.status === 'failed')
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
