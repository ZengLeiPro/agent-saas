/**
 * 上下文压缩黑箱化（2026-07）—— web 端本地模型与辅助函数。
 *
 * 服务端契约：
 * - WS 实时：`{ type: 'compaction_status', phase: 'started' | 'completed', compaction? }`
 *   （server/src/channels/web/channel.ts 的 compaction_start / compaction_end case）
 * - 会话重载：transcript blocks 新增 kind='compaction'
 *   （server/src/data/transcripts/parse.ts，content=摘要正文、coveredEventCount=被压缩条数）
 *
 * shared 的 MessageItem 联合类型暂未收编 compaction item（本次改动仅允许动 web/src），
 * 因此这里定义 web 本地的 CompactionMessageItem，进出消息数组时用 as-cast 桥接；
 * 渲染/状态机侧统一用 asCompactionItem() 识别，避免对 shared 联合类型做收窄。
 */
import type { ApiTranscriptBlock, MessageItem, MessageItemInput } from '@agent/shared';

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
 * web 本地消息 item：
 * - status='running'：消息流中的「正在压缩上下文…」状态条
 * - status='done'：「已压缩 N 条历史消息」分界线（debugMode 可展开摘要）
 */
export interface CompactionMessageItem {
  id: string;
  type: 'compaction';
  status: 'running' | 'done';
  /** 压缩摘要正文，仅 debugMode 展开可见 */
  summary?: string;
  /** 被摘要替代的历史事件数 */
  coveredEventCount?: number;
  timestamp?: number;
}

/**
 * 识别 compaction item。返回转换结果而非 type guard：
 * compaction 不在 shared MessageItem 联合里，type guard 收窄会产生 never 交叉类型陷阱。
 */
export function asCompactionItem(m: unknown): CompactionMessageItem | null {
  if (m && typeof m === 'object' && (m as { type?: unknown }).type === 'compaction') {
    return m as CompactionMessageItem;
  }
  return null;
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
