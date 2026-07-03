import type { ModelChatMessage, PlatformEvent, PlatformEventInput } from './types.js';
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

/**
 * /compact 真实现（2026-07-03）：以最后一条 compaction 事件为切分点。
 * 切分点之前的事件被 summary（一条 user message）替代，之后的事件正常重放。
 * 原始事件仍在 EventStore（SessionSearchEvents 可查原文），这里只影响 prompt 投影。
 */
function applyCompaction(events: PlatformEvent[]): {
  effectiveEvents: PlatformEvent[];
  summaryMessages: ModelChatMessage[];
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'compaction') {
      return {
        effectiveEvents: events.slice(i + 1),
        summaryMessages: [{ role: 'user', content: formatCompactionSummary(event.summary) }],
      };
    }
  }
  return { effectiveEvents: events, summaryMessages: [] };
}

function formatCompactionSummary(summary: string): string {
  return [
    '<context-summary>',
    '以下是本会话较早历史的压缩摘要（原始消息已被压缩以节省 context；如需查询原始细节，可用 SessionSearchEvents 工具检索会话事件）：',
    '',
    summary,
    '</context-summary>',
  ].join('\n');
}

/**
 * Convert the durable session log into a prompt-sized context view.
 *
 * The returned messages are derived. The raw PlatformEvents remain the source of truth.
 */
export function buildContextProjection(allEvents: PlatformEvent[], options: ContextProjectionOptions): ContextProjection {
  const policy = options.policy ?? { type: 'full_replay' };
  const truncate = (msgs: ModelChatMessage[]) => truncateOldToolResults(msgs, options.toolResultTruncation);
  const { effectiveEvents: events, summaryMessages } = applyCompaction(allEvents);
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
