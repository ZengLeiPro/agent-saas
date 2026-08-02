import type { MessageItem, ActivityGroup, RenderItem } from '../types/message';
import { ACTIVITY_TYPES } from '../types/message';
import { projectBusinessTodoGroups } from './extractTodos';

/** Check if activity group is active (has streaming/running items) */
function isGroupActive(items: MessageItem[], isLastGroup: boolean, loading: boolean): boolean {
  for (const item of items) {
    if ('streaming' in item && item.streaming) return true;
    if (item.type === 'subagent' && item.status === 'running') return true;
    if (item.type === 'tool_use' && !item.resultReady && isLastGroup && loading) return true;
  }
  return isLastGroup && loading;
}

/** Group flat message array into render units (pure function, O(n) single pass) */
export function groupMessages(messages: MessageItem[], loading: boolean): RenderItem[] {
  const result: RenderItem[] = [];
  let currentGroup: MessageItem[] = [];
  const businessProjection = projectBusinessTodoGroups(messages, loading);
  const businessGroupByAnchor = new Map(
    businessProjection.groups.map((group) => [group.anchorMessageId, group]),
  );

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
    const businessGroup = businessGroupByAnchor.get(msg.id);
    if (businessGroup) {
      flushGroup(false);
      result.push(businessGroup);
    }
    if (businessProjection.hiddenSourceMessageIds.has(msg.id)) {
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
