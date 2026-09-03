import {
  MODEL_TOOL_RESULT_MAX_CHARS,
  projectToolResultContentForModel,
} from './replayEventBounds.js';
import type { PlatformEvent } from './types.js';

/**
 * SessionContext(action=events|search) 把原始事件数组整体 JSON.stringify 回给模型。
 * 事件里的 tool_result.content 是工具原文（生产上出现过单条 4,873,793 字符），
 * 一页 200 条就放大成 21,524,494 字符的 tool_result——检索出口自己变成了最大的
 * 超大结果生产者，并再次落进事件日志与 transcript。
 *
 * 这里对返回数组复用模型侧同一投影，原文始终留在 durable EventStore，不做任何删改。
 * action="trace" 不走这里（它就是全量读取出口，自带行/字符预算）。
 *
 * 只压内容、不丢事件：EventListPage.nextCursor 由 EventStore 按整页最后一条生成，
 * 在这一层丢事件会让游标跳过未读事件，翻页出现静默空洞。
 */
export const SESSION_EVENT_LIST_MAX_TOTAL_CHARS = 200_000;
/** 总预算触顶后逐条继续压缩时的下限，保证仍能看出事件形状。 */
export const SESSION_EVENT_MIN_CONTENT_CHARS = 500;

type ToolResultEvent = Extract<PlatformEvent, { type: 'tool_result' }>;

function asOversizedToolResult(event: PlatformEvent, quota: number): ToolResultEvent | undefined {
  if (event.type !== 'tool_result') return undefined;
  return typeof event.content === 'string' && event.content.length > quota ? event : undefined;
}

function clampContent(content: string, quota: number, toolCallId: string): string {
  if (content.length <= quota) return content;
  const head = content.slice(0, Math.max(1, Math.floor(quota / 2)));
  const tail = content.slice(-Math.max(1, quota - head.length));
  return (
    `${head}\n[tool_result 已截断：共 ${content.length} 字符；读取全文：` +
    `SessionContext(action="trace", toolCallId=${JSON.stringify(toolCallId)})]\n${tail}`
  );
}

/** 逐条投影到模型侧上限，再按总预算等额收窄，事件条数与顺序始终不变。 */
export function boundSessionEventList(events: readonly PlatformEvent[]): PlatformEvent[] {
  const projected = events.map((event) => {
    const oversized = asOversizedToolResult(event, MODEL_TOOL_RESULT_MAX_CHARS);
    if (!oversized) return event;
    return {
      ...oversized,
      content: projectToolResultContentForModel(oversized.content, oversized.toolCallId),
    };
  });
  const total = projected.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
  if (total <= SESSION_EVENT_LIST_MAX_TOTAL_CHARS || projected.length === 0) return projected;

  const quota = Math.max(
    SESSION_EVENT_MIN_CONTENT_CHARS,
    Math.floor(SESSION_EVENT_LIST_MAX_TOTAL_CHARS / projected.length),
  );
  return projected.map((event) => {
    const oversized = asOversizedToolResult(event, quota);
    if (!oversized) return event;
    return { ...oversized, content: clampContent(oversized.content, quota, oversized.toolCallId) };
  });
}
