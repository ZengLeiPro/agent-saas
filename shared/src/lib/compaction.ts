/**
 * 上下文压缩（/compact v2 黑箱化）的跨端超集实现。
 *
 * 服务端契约（两端同源）：
 * - WS 实时：`{ type: 'compaction_status', phase: 'started' | 'completed', compaction? }`
 *   （server/src/channels/web/channel.ts 的 compaction_start / compaction_end case）
 * - 会话重载：transcript blocks 新增 kind='compaction'
 *   （server/src/data/transcripts/parse.ts，content=摘要正文、coveredEventCount=被压缩条数）
 *
 * 收编背景（strangler 首例）：web `web/src/lib/compaction.ts` 与 mobile
 * `mobile/src/lib/compaction.ts` 近乎同构但 API 名不同——web 以
 * `asCompactionItem` + `status: running|done` 承载「压缩中状态条 → 分界线」，
 * mobile 以 `isCompactionItem` + `injectCompactionMessages` 承载「重载时插回分界线」。
 * 本文件同时导出两套 API，`status` 收为可选字段以兼容 mobile 既有产物；
 * mobile 的 lib/compaction.ts 已改为纯 re-export，web 待后续替换。
 *
 * shared 的 MessageItem 联合类型不收编 compaction kind（渲染/状态机侧统一用
 * asCompactionItem / isCompactionItem 识别），进出消息数组时用 as-cast 桥接，
 * 避免对联合类型做收窄产生 never 交叉陷阱。
 */
import type { ApiSessionDetail, ApiTranscriptBlock } from '../types/session';
import type { MessageItem, MessageItemInput } from '../types/message';

/** compaction_status completed 携带的压缩结果 */
export interface CompactionOutcome {
  /** 压缩摘要正文（黑箱压缩对外唯一的数据出口） */
  summary?: string;
  /** 被摘要替代的历史事件数 */
  coveredEventCount?: number;
  /** true = 历史太短未压缩，note 为给用户的说明文案 */
  skipped?: boolean;
  note?: string;
}

/** WS 实时事件：压缩开始 / 完成 */
export interface CompactionStatusEvent {
  type: 'compaction_status';
  phase: 'started' | 'completed';
  compaction?: CompactionOutcome;
}

/**
 * 消息流里的压缩单元：
 * - status='running'：消息流中的「正在压缩上下文…」状态条
 * - status='done' / 缺省：分界线；非 debug 只画线，debugMode 显示压缩条数并可展开摘要
 */
export interface CompactionMessageItem {
  id: string;
  type: 'compaction';
  /** mobile 会话重载路径历史上不写该字段，故为可选；缺省按 done 处理 */
  status?: 'running' | 'done';
  /** 压缩摘要正文，仅 debugMode 展开可见 */
  summary?: string;
  /** 被摘要替代的历史事件数 */
  coveredEventCount?: number;
  timestamp?: number;
}

/**
 * 识别 compaction item（web 口径）。返回转换结果而非 type guard：
 * compaction 不在 shared MessageItem 联合里，type guard 收窄会产生 never 交叉类型陷阱。
 */
export function asCompactionItem(m: unknown): CompactionMessageItem | null {
  if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'compaction') {
    return m as CompactionMessageItem;
  }
  return null;
}

/** 识别 compaction item（mobile 口径的 type guard，语义与 asCompactionItem 等价） */
export function isCompactionItem(item: unknown): item is CompactionMessageItem {
  return asCompactionItem(item) !== null;
}

/** 识别 WS compaction_status 事件 */
export function isCompactionStatusEvent(data: unknown): data is CompactionStatusEvent {
  return (
    !!data && typeof data === 'object' && (data as { type?: unknown }).type === 'compaction_status'
  );
}

function compactionDoneFields(outcome?: CompactionOutcome): Omit<CompactionMessageItem, 'id'> {
  return {
    type: 'compaction',
    status: 'done',
    ...(outcome?.summary !== undefined ? { summary: outcome.summary } : {}),
    ...(typeof outcome?.coveredEventCount === 'number'
      ? { coveredEventCount: outcome.coveredEventCount }
      : {}),
    timestamp: Date.now(),
  };
}

/** 压缩进行中状态条（compaction_status phase=started） */
export function createCompactionRunningItem(): MessageItemInput {
  const item: Omit<CompactionMessageItem, 'id'> = {
    type: 'compaction',
    status: 'running',
    timestamp: Date.now(),
  };
  return item as unknown as MessageItemInput;
}

/** 压缩完成分界线（compaction_status phase=completed，非 skipped） */
export function createCompactionDoneItem(outcome?: CompactionOutcome): MessageItemInput {
  return compactionDoneFields(outcome) as unknown as MessageItemInput;
}

/** 就地把 running 状态条落定为 done 分界线（保留原 id，避免 React key 抖动） */
export function compactionDoneReplacement(id: string, outcome?: CompactionOutcome): MessageItem {
  return { id, ...compactionDoneFields(outcome) } as unknown as MessageItem;
}

/** transcript kind='compaction' block → 分界线消息（会话重载路径） */
export function compactionItemFromBlock(block: ApiTranscriptBlock): MessageItem {
  const covered = (block as { coveredEventCount?: unknown }).coveredEventCount;
  const item: CompactionMessageItem = {
    id: block.id,
    type: 'compaction',
    status: 'done',
    ...(block.content ? { summary: block.content } : {}),
    ...(typeof covered === 'number' ? { coveredEventCount: covered } : {}),
    ...(block.tsMs ? { timestamp: block.tsMs } : {}),
  };
  return item as unknown as MessageItem;
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
  blocks: ApiSessionDetail['blocks'],
  msgs: MessageItem[],
): MessageItem[] {
  const hasCompaction = blocks.some((b) => (b.kind as string) === 'compaction');
  if (!hasCompaction) return msgs;

  const out: MessageItem[] = [...msgs];
  let cursor = 0;
  for (const block of blocks) {
    if ((block.kind as string) === 'compaction') {
      out.splice(cursor, 0, compactionItemFromBlock(block));
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
