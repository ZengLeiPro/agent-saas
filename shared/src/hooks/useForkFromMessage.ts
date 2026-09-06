import { useCallback, useRef } from 'react';
import type { MessageItem } from '../types/message';

/**
 * 「从此编辑」：以某条用户消息为分叉点向服务端 fork 出新会话（两端 `useChatAppState` 共同内核）。
 * 成功后由平台 `onForked` 切换到新会话、等详情加载完再把 fork 文案填进输入框并刷新列表。
 */
export interface ForkFromMessageOptions {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  getSourceSessionId: () => string | null;
  onForked: (newSessionId: string, forkMessage: string) => Promise<void>;
}

export function useForkFromMessage(
  options: ForkFromMessageOptions,
): (message: MessageItem) => Promise<string | null> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  return useCallback(async (message: MessageItem): Promise<string | null> => {
    if (message.type !== 'user') return null;
    const opts = optionsRef.current;
    const sourceSessionId = opts.getSourceSessionId();
    if (!sourceSessionId) return null;

    try {
      const res = await opts.authFetch(
        `/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blockId: message.id }),
        },
      );
      if (!res.ok) {
        console.error('Fork failed:', res.status);
        return null;
      }
      const { newSessionId, forkMessage } = (await res.json()) as {
        newSessionId: string;
        forkMessage: string;
      };
      await optionsRef.current.onForked(newSessionId, forkMessage);
      return newSessionId;
    } catch (err) {
      console.error('Fork failed:', err);
      return null;
    }
  }, []);
}
