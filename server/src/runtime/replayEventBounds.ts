import type { PlatformEvent } from './types.js';

/**
 * Durable EventStore 始终保留工具原文；模型可见投影在工具结果首次入模时使用固定上限。
 * 同一 toolCallId 的投影只由其自身内容决定，后续追加事件不得改变既有前缀。
 */
export const MODEL_TOOL_RESULT_MAX_CHARS = 16_000;
export const LEGACY_MODEL_TOOL_RESULT_MAX_CHARS = 4_000;
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

export function projectToolResultContentForModel(content: string, toolCallId: string): string {
  return truncateReplayToolResultContent(content, MODEL_TOOL_RESULT_MAX_CHARS, toolCallId);
}

export function projectLegacyToolResultContentForModel(content: string, toolCallId: string): string {
  return truncateReplayToolResultContent(content, LEGACY_MODEL_TOOL_RESULT_MAX_CHARS, toolCallId);
}

/** File backend 的语义对齐；生产 PG backend 会在 SQL 边界完成同一固定投影。 */
export function boundReplayToolResultEvents(events: PlatformEvent[]): PlatformEvent[] {
  const bounded = new Map<number, PlatformEvent>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type !== 'tool_result') continue;
    const content = event.modelContent
      ?? projectLegacyToolResultContentForModel(event.content, event.toolCallId);
    if (event.modelContent === undefined && content === event.content) continue;
    const { modelContent: _modelContent, ...rest } = event;
    bounded.set(index, { ...rest, content });
  }
  if (bounded.size === 0) return events;
  return events.map((event, index) => bounded.get(index) ?? event);
}
