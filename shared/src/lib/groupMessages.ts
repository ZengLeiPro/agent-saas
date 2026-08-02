import type { MessageItem, ActivityGroup, RenderItem } from '../types/message';
import { ACTIVITY_TYPES } from '../types/message';
import { projectBusinessStepEvents } from './extractTodos';

/** Check if activity group is active (has streaming/running items) */
function isGroupActive(items: MessageItem[], isLastGroup: boolean, loading: boolean): boolean {
  for (const item of items) {
    if ('streaming' in item && item.streaming) return true;
    if (item.type === 'subagent' && item.status === 'running') return true;
    if (item.type === 'tool_use' && !item.resultReady && isLastGroup && loading) return true;
  }
  return isLastGroup && loading;
}

export interface GroupMessagesOptions {
  /**
   * debug 视图保留 TodoWrite 原始工具块（与业务步骤事件并存，语义=看原始数据）；
   * 非 debug 视图 TodoWrite 从主流隐藏——总览由 TodoPanel 承载、叙事由事件承载。
   */
  debugMode?: boolean;
}

/** Group flat message array into render units (pure function, O(n) single pass) */
export function groupMessages(
  messages: MessageItem[],
  loading: boolean,
  options?: GroupMessagesOptions,
): RenderItem[] {
  const result: RenderItem[] = [];
  let currentGroup: MessageItem[] = [];
  const debugMode = options?.debugMode === true;
  const businessProjection = projectBusinessStepEvents(messages, loading);

  const flushGroup = (isLast: boolean) => {
    if (currentGroup.length === 0) return;
    const items = currentGroup;
    currentGroup = [];
    result.push({
      type: 'activity_group',
      id: `ag-${items[0].id}`,
      items,
      isActive: isGroupActive(items, isLast, loading),
    } satisfies ActivityGroup);
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // 业务步骤事件插在产生它的 TodoWrite 消息位置：终态/开始事件按时间线性出现，
    // 与 thinking / 工具活动 / 正文同向生长（时间叙事，不做原地更新的看板）。
    const anchoredEvents = businessProjection.eventsByAnchor.get(msg.id);
    if (anchoredEvents) {
      flushGroup(false);
      for (const event of anchoredEvents) result.push(event);
    }
    if (!debugMode && businessProjection.hiddenMessageIds.has(msg.id)) {
      continue;
    }

    if (msg.type === 'tool_use' && msg.presentation && msg.defaultExpanded) {
      // 数据源（剧本 / 未来的服务端规则）用 defaultOpen 声明的高价值执行行，
      // 是「AI 在动系统」的可见痕迹，不允许被活动分组吞成「已完成 N 条」。
      // 判据不是「有没有摘要」——真实会话几乎所有工具都有摘要，全拆会刷屏；
      // 而是「数据源是否点名它值得上主流」。真实会话 defaultOpen 恒 false（parse.ts），行为不变。
      flushGroup(false);
      result.push(msg);
    } else if (ACTIVITY_TYPES.has(msg.type)) {
      currentGroup.push(msg);
    } else {
      flushGroup(false);
      result.push(msg);
    }
  }
  flushGroup(true);

  return result;
}
