import { useMemo } from 'react';
import type { MessageItem, RenderItem } from './types';
import { groupMessages } from '@agent/shared';
import type { GroupMessagesOptions } from '@agent/shared';

export { groupMessages };

/** Grouping hook: recompute when messages, loading or view options change */
export function useGroupedMessages(
  messages: MessageItem[],
  loading: boolean,
  options?: GroupMessagesOptions,
): RenderItem[] {
  const debugMode = options?.debugMode === true;
  const sectioning = options?.sectioning === true;
  return useMemo(
    () => groupMessages(messages, loading, { debugMode, sectioning }),
    [messages, loading, debugMode, sectioning],
  );
}
