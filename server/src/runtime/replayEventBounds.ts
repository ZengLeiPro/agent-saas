import type { PlatformEvent } from './types.js';

/**
 * Durable EventStore 始终保留工具原文；这些边界只约束模型/恢复回放进入 Node 的派生视图。
 * 与 legacyTranscriptProjection 的模型消息预算保持一致，避免 PG 先载入大字段后才截断。
 */
export const REPLAY_TOOL_RESULT_MAX_CHARS = 4_000;
export const REPLAY_TOOL_RESULT_KEEP_RECENT = 8;
export const REPLAY_RECENT_TOOL_RESULT_MAX_CHARS = 16_000;
export const REPLAY_TOOL_RESULT_MARKER_PREFIX = '\n\n...[tool_result 已截断；完整原文请用 SessionContext(action="trace") toolCallId=';
export const REPLAY_TOOL_RESULT_MARKER_SUFFIX = ' 查询]';

export function replayToolResultMarker(toolCallId: string): string {
  return `${REPLAY_TOOL_RESULT_MARKER_PREFIX}${toolCallId}${REPLAY_TOOL_RESULT_MARKER_SUFFIX}`;
}

export function truncateReplayToolResultContent(
  content: string,
  maxChars: number,
  toolCallId: string,
): string {
  if (content.length <= maxChars) return content;
  if (maxChars <= 0) return '';
  const marker = replayToolResultMarker(toolCallId);
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  return `${content.slice(0, maxChars - marker.length)}${marker}`;
}

/** File backend 的语义对齐；生产 PG backend 会在 SQL 边界完成同一截断。 */
export function boundReplayToolResultEvents(events: PlatformEvent[]): PlatformEvent[] {
  let toolResultRank = 0;
  const bounded = new Map<number, PlatformEvent>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'tool_result') continue;
    toolResultRank += 1;
    const limit = toolResultRank <= REPLAY_TOOL_RESULT_KEEP_RECENT
      ? REPLAY_RECENT_TOOL_RESULT_MAX_CHARS
      : REPLAY_TOOL_RESULT_MAX_CHARS;
    const content = truncateReplayToolResultContent(event.content, limit, event.toolCallId);
    if (content !== event.content) bounded.set(index, { ...event, content });
  }
  if (bounded.size === 0) return events;
  return events.map((event, index) => bounded.get(index) ?? event);
}
