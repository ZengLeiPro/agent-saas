export interface InterjectionIdentity {
  clientMsgId?: string;
  sourceRunId?: string;
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
