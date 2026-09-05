import { useCallback, useRef } from 'react';

/**
 * 会话标题变更（Web / mobile `useSession` 里 `renameSession` / `autoTitleSession` 的共同内核）：
 * 发 PATCH / auto-title 请求，成功后把标题交给平台 `applyTitle` 乐观更新本地列表。
 * 列表结构（Web 扁平数组 / mobile pager）不同，所以只交回字符串，不碰列表。
 */

export interface SessionTitleMutationsOptions {
  authFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** 服务端确认后的本地更新；`title` 为用户输入原文（可能为空串）或自动命名结果。 */
  applyTitle: (sessionId: string, title: string) => void;
}

export interface SessionTitleMutations {
  renameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  autoTitleSession: (sessionId: string) => Promise<boolean>;
}

export function useSessionTitleMutations(
  options: SessionTitleMutationsOptions,
): SessionTitleMutations {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const renameSession = useCallback(
    async (targetId: string, newTitle: string): Promise<boolean> => {
      const opts = optionsRef.current;
      try {
        const response = await opts.authFetch(`/api/sessions/${encodeURIComponent(targetId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
        if (!response.ok) return false;
        // 乐观更新本地列表
        optionsRef.current.applyTitle(targetId, newTitle);
        return true;
      } catch (err) {
        console.error('重命名会话失败:', err);
        return false;
      }
    },
    [],
  );

  const autoTitleSession = useCallback(async (targetId: string): Promise<boolean> => {
    const opts = optionsRef.current;
    try {
      const response = await opts.authFetch(
        `/api/sessions/${encodeURIComponent(targetId)}/auto-title`,
        { method: 'POST' },
      );
      if (!response.ok) return false;
      const data = (await response.json()) as { title?: string };
      if (data.title) {
        optionsRef.current.applyTitle(targetId, data.title);
      }
      return true;
    } catch (err) {
      console.error('自动命名失败:', err);
      return false;
    }
  }, []);

  return { renameSession, autoTitleSession };
}
