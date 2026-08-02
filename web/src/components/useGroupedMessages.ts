import { useMemo } from 'react';
import type { MessageItem, RenderItem } from './types';
import { groupMessages } from '@agent/shared';

export { groupMessages };

/** Grouping hook: recompute when messages, loading or debug view changes */
export function useGroupedMessages(messages: MessageItem[], loading: boolean, debugMode = false): RenderItem[] {
  return useMemo(() => groupMessages(messages, loading, { debugMode }), [messages, loading, debugMode]);
}
