import type { ApiSessionDetail, MessageItem } from "@agent/shared";

/**
 * /compact v2 黑箱压缩 —— mobile 侧本地扩展。
 *
 * shared 的 MessageItem 联合类型暂未包含 compaction kind（避免动 shared/），
 * mobile 在消息数组里以结构化对象承载压缩分界线，渲染层用 isCompactionItem
 * 类型守卫识别。summary 字段完整传递（当前 mobile 未消费 user.debugMode，
 * 暂不渲染「查看摘要」入口，字段留作后续接入）。
 */
export interface CompactionMessageItem {
  id: string;
  type: "compaction";
  /** 压缩摘要正文（debugMode 展开查看用，当前 mobile 不渲染入口） */
  summary?: string;
  /** 被摘要替代的历史事件数 */
  coveredEventCount: number;
  timestamp?: number;
}

/** WS 实时事件：压缩开始/完成（服务端黑箱，不再流式下发 thinking/text） */
export interface CompactionStatusEvent {
  type: "compaction_status";
  phase: "started" | "completed";
  compaction?: {
    summary?: string;
    coveredEventCount: number;
    /** 历史太短未压缩 */
    skipped?: boolean;
    /** skipped 时的说明文案 */
    note?: string;
  };
}

export function isCompactionItem(item: unknown): item is CompactionMessageItem {
  return (
    !!item &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === "compaction"
  );
}

export function isCompactionStatusEvent(
  data: unknown,
): data is CompactionStatusEvent {
  return (
    !!data &&
    typeof data === "object" &&
    (data as { type?: unknown }).type === "compaction_status"
  );
}

/**
 * 会话重载：把 transcript blocks 里 kind === 'compaction' 的分界线块
 * 按原始顺序插回 mapSessionDetailToMessages 的产物。
 *
 * shared 的 mapBlock 对未知 kind 返回 null（compaction 块被丢弃），
 * 这里以 block.id 为锚点做第二遍游标扫描：遇到 compaction 块时在当前
 * 游标处插入分界线项；其余块把游标推进到其产出消息（含 `${id}-file-N`
 * / `${id}-artifact` 派生消息）之后，保证插入位置与 transcript 时序一致。
 */
export function injectCompactionMessages(
  blocks: ApiSessionDetail["blocks"],
  msgs: MessageItem[],
): MessageItem[] {
  const hasCompaction = blocks.some(
    (b) => (b.kind as string) === "compaction",
  );
  if (!hasCompaction) return msgs;

  const out: MessageItem[] = [...msgs];
  let cursor = 0;
  for (const block of blocks) {
    if ((block.kind as string) === "compaction") {
      const covered = (block as { coveredEventCount?: number })
        .coveredEventCount;
      const item: CompactionMessageItem = {
        id: block.id,
        type: "compaction",
        ...(block.content ? { summary: block.content } : {}),
        coveredEventCount: typeof covered === "number" ? covered : 0,
        ...(typeof block.tsMs === "number" ? { timestamp: block.tsMs } : {}),
      };
      out.splice(cursor, 0, item as unknown as MessageItem);
      cursor++;
      continue;
    }
    // 推进游标：跳过该块映射出的消息及其派生消息
    let idx = -1;
    for (let i = cursor; i < out.length; i++) {
      if (out[i].id === block.id) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      cursor = idx + 1;
      while (cursor < out.length && out[cursor].id.startsWith(block.id)) {
        cursor++;
      }
    }
  }
  return out;
}
