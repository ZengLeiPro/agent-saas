import type { MessageItem, ActivityGroup, RenderItem } from '../types/message';
import { ACTIVITY_TYPES } from '../types/message';

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
    if (ACTIVITY_TYPES.has(msg.type)) {
      currentGroup.push(msg);
    } else {
      flushGroup(false);
      result.push(msg);
    }
  }
  flushGroup(true);

  return result;
}
