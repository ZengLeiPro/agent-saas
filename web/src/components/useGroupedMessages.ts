import { useMemo } from 'react';
import type { MessageItem, RenderItem } from './types';
import { groupMessages } from '@agent/shared';

export { groupMessages };

/** Grouping hook: recompute when messages or loading changes */
export function useGroupedMessages(messages: MessageItem[], loading: boolean): RenderItem[] {
  return useMemo(() => groupMessages(messages, loading), [messages, loading]);
}
