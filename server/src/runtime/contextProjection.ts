import {
  isInternalModelDiagnosticEvent,
  type ModelChatMessage,
  type PlatformEvent,
  type PlatformEventInput,
} from './types.js';
import {
  buildChatMessagesFromEvents,
  truncateOldToolResults,
  type ToolResultTruncationOptions,
} from './legacyTranscriptProjection.js';

export type ContextReconstructionPolicy =
  | { type: 'full_replay' }
  | { type: 'recent_window'; recentEvents?: number }
  | { type: 'retrieval_augmented'; query: string; recentEvents?: number; maxMatches?: number }
  | { type: 'manual_slice'; start?: number; end?: number };

export interface ContextProjectionOptions {
  sessionId: string;
  runId: string;
  policy?: ContextReconstructionPolicy;
  /**
   * 跨 run 历史回放时对较旧 tool_result 做截断（O2）。
   * 默认开启；传 `{ enabled: false }` 显式禁用（如需要严格 full-replay 调试）。
   */
  toolResultTruncation?: ToolResultTruncationOptions;
}

export interface ContextProjection {
  messages: ModelChatMessage[];
  policy: ContextReconstructionPolicy['type'];
  selectedEvents: PlatformEvent[];
  summaryEvent?: PlatformEventInput;
}

const DEFAULT_RECENT_EVENTS = 80;
const DEFAULT_MAX_MATCHES = 20;

/** 用户消息轨迹：单条上限（头 + 尾，超出中间省略） */
const TRAIL_ITEM_MAX_CHARS = 500;
const TRAIL_ITEM_HEAD_CHARS = 400;
const TRAIL_ITEM_TAIL_CHARS = 100;
/** 用户消息轨迹：总预算。超限降级为「首条 + 最近若干条」 */
const TRAIL_TOTAL_MAX_CHARS = 8000;

/** 平台系统命令替身（如 /compact 的 modelContent）前缀，抽取用户消息轨迹时剔除 */
const SYSTEM_COMMAND_MODEL_CONTENT_PREFIX = '[系统命令]';

/**
 * /compact 投影（2026-07-03 v2）：以最后一条 compaction 事件定位压缩。
 * - 压缩段（cutoffEventId 之前；v1 存量事件无 cutoff 则为 compaction 自身之前）
 *   被替代为一条 user message：<context-summary>（LLM 摘要）+ <user-message-trail>
 *   （从压缩段原始事件中抽取的用户消息原文，非 LLM 转述，投影时重建、天然幂等）
 *   + 历史可检索提醒。
 * - 保留段（cutoff 之后）正常重放，但剔除 compaction 所属 run 自身的事件
 *   （/compact 命令替身等，避免模型看到未回应的压缩指令）。
 * 原始事件仍在 EventStore（SessionSearchEvents 可查原文），这里只影响 prompt 投影。
 */
function applyCompaction(events: PlatformEvent[]): {
  effectiveEvents: PlatformEvent[];
  summaryMessages: ModelChatMessage[];
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'compaction') continue;

    let cutIdx = i;
    if (event.cutoffEventId) {
      const idx = events.findIndex((e) => e.id === event.cutoffEventId);
      if (idx >= 0 && idx <= i) cutIdx = idx;
    }
    const compressed = events.slice(0, cutIdx);
    // 保留段：cutoff 之后的全部事件，剔除本 compaction run 自身（含 compaction 事件本身）
    const retained = events.slice(cutIdx).filter(
      (e) => !('runId' in e) || e.runId !== event.runId,
    );
    return {
      effectiveEvents: retained,
      summaryMessages: [{
        role: 'user',
        content: formatCompactionContext(event.summary, extractUserMessageTrail(compressed)),
      }],
    };
  }
  return { effectiveEvents: events, summaryMessages: [] };
}

interface TrailItem {
  timestamp: string;
  content: string;
}

/**
 * 从压缩段原始事件中抽取用户消息轨迹（纯代码抽取，不经 LLM）。
 * 剔除系统命令替身（/compact 等）；多次压缩时压缩段包含更早的全部历史，
 * 轨迹每次从 EventStore 事实重建，不会出现「摘要套娃」。
 */
export function extractUserMessageTrail(compressed: PlatformEvent[]): TrailItem[] {
  const items: TrailItem[] = [];
  for (const event of compressed) {
    if (event.type !== 'user_message') continue;
    if (event.modelContent?.startsWith(SYSTEM_COMMAND_MODEL_CONTENT_PREFIX)) continue;
    const content = event.content.trim();
    if (!content) continue;
    items.push({ timestamp: event.timestamp, content });
  }
  return items;
}

/** 单条截断：保头 + 保尾，中间标注省略字数（用户消息常见「铺垫在前、真问题在最后」） */
function truncateTrailItem(content: string): string {
  if (content.length <= TRAIL_ITEM_MAX_CHARS) return content;
  const head = content.slice(0, TRAIL_ITEM_HEAD_CHARS);
  const tail = content.slice(-TRAIL_ITEM_TAIL_CHARS);
  return `${head}\n……[中间已省略 ${content.length - TRAIL_ITEM_HEAD_CHARS - TRAIL_ITEM_TAIL_CHARS} 字]……\n${tail}`;
}

function formatTrailTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 渲染 <user-message-trail> 块。总预算超限时降级为「首条 + 最近若干条」，
 * 被省略的条目显式标注数量（不静默截断）。
 */
export function renderUserMessageTrail(items: TrailItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((item, i) => {
    const ts = formatTrailTimestamp(item.timestamp);
    return `${i + 1}. ${ts ? `[${ts}] ` : ''}${truncateTrailItem(item.content)}`;
  });

  let selected: string[];
  const total = lines.reduce((sum, l) => sum + l.length, 0);
  if (total <= TRAIL_TOTAL_MAX_CHARS) {
    selected = lines;
  } else {
    // 降级：保首条，再从最新往回加，直到预算耗尽；中间标注省略条数
    const first = lines[0]!;
    let budget = TRAIL_TOTAL_MAX_CHARS - first.length;
    const recent: string[] = [];
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i]!;
      if (line.length > budget) break;
      recent.unshift(line);
      budget -= line.length;
    }
    const omitted = lines.length - 1 - recent.length;
    selected = omitted > 0
      ? [first, `……（中间省略 ${omitted} 条用户消息，可用 SessionSearchEvents 检索原文）……`, ...recent]
      : [first, ...recent];
  }

  return [
    '<user-message-trail>',
    '以下为被压缩历史中用户消息的原文摘录（按时间顺序、逐字抽取而非转述；超长条目已截断）：',
    ...selected,
    '</user-message-trail>',
  ].join('\n');
}

/**
 * 压缩上下文块：摘要 + 用户消息轨迹 + 历史可检索提醒，拼为一条 user message。
 * 必须以 <context-summary> 开头——agentPlanDefense.isPlatformContextBlock 按此
 * 前缀豁免时间戳/中文 leading 防御。
 */
function formatCompactionContext(summary: string, trail: TrailItem[]): string {
  const parts = [
    '<context-summary>',
    '以下是本会话较早历史的压缩摘要（原始消息已被压缩以节省 context）：',
    '',
    summary,
    '</context-summary>',
  ];
  const trailBlock = renderUserMessageTrail(trail);
  if (trailBlock) {
    parts.push('', trailBlock);
  }
  parts.push(
    '',
    '提示：本会话完整历史（含每次工具调用的原始输入输出）仍完整保留。仅当以上摘要与消息摘录不足时再检索：SessionSearchEvents 按关键词搜索历史事件；SessionGetToolTrace 按 toolCallId 获取某次工具调用的完整记录。',
  );
  return parts.join('\n');
}

/**
 * Convert the durable session log into a prompt-sized context view.
 *
 * The returned messages are derived. The raw PlatformEvents remain the source of truth.
 */
export function buildContextProjection(allEvents: PlatformEvent[], options: ContextProjectionOptions): ContextProjection {
  const policy = options.policy ?? { type: 'full_replay' };
  const truncate = (msgs: ModelChatMessage[]) => truncateOldToolResults(msgs, options.toolResultTruncation);
  const contextEvents = allEvents.filter((event) => !isInternalModelDiagnosticEvent(event));
  const { effectiveEvents: events, summaryMessages } = applyCompaction(contextEvents);
  switch (policy.type) {
    case 'full_replay':
      return {
        messages: [...summaryMessages, ...truncate(buildChatMessagesFromEvents(events))],
        policy: policy.type,
        selectedEvents: events,
      };
    case 'recent_window': {
      const selectedEvents = lastN(events, policy.recentEvents ?? DEFAULT_RECENT_EVENTS);
      return {
        messages: [...summaryMessages, ...truncate(buildChatMessagesFromEvents(selectedEvents))],
        policy: policy.type,
        selectedEvents,
      };
    }
    case 'manual_slice': {
      const start = clampIndex(policy.start ?? 0, events.length);
      const end = clampIndex(policy.end ?? events.length, events.length);
      const selectedEvents = events.slice(Math.min(start, end), Math.max(start, end));
      return {
        messages: [...summaryMessages, ...truncate(buildChatMessagesFromEvents(selectedEvents))],
        policy: policy.type,
        selectedEvents,
      };
    }
    case 'retrieval_augmented': {
      const matches = searchEvents(events, policy.query, policy.maxMatches ?? DEFAULT_MAX_MATCHES);
      const recent = lastN(events, policy.recentEvents ?? DEFAULT_RECENT_EVENTS);
      const selectedEvents = uniqueEvents([...matches, ...recent]);
      const retrievalMessage = matches.length > 0
        ? [{ role: 'user' as const, content: formatRetrievalMessage(policy.query, matches) }]
        : [];
      return {
        messages: [...summaryMessages, ...retrievalMessage, ...truncate(buildChatMessagesFromEvents(selectedEvents))],
        policy: policy.type,
        selectedEvents,
      };
    }
  }
}

function formatRetrievalMessage(query: string, matches: PlatformEvent[]): string {
  return [
    '<session-retrieval-results>',
    `Query: ${query}`,
    ...matches.map((event) => `- ${event.timestamp} ${event.type} ${'runId' in event ? event.runId : ''} ${truncateForSummary(JSON.stringify(event), 300)}`),
    '</session-retrieval-results>',
  ].join('\n');
}

function searchEvents(events: PlatformEvent[], query: string, maxMatches: number): PlatformEvent[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return events.filter((event) => JSON.stringify(event).toLowerCase().includes(needle)).slice(0, maxMatches);
}

function uniqueEvents(events: PlatformEvent[]): PlatformEvent[] {
  const seen = new Set<string>();
  const unique: PlatformEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  unique.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return unique;
}

function lastN<T>(items: T[], count: number): T[] {
  return items.slice(Math.max(0, items.length - Math.max(0, count)));
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.floor(value)));
}

function truncateForSummary(value: string, max = 500): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
