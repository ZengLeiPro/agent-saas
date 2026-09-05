import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ContextUsageData, TokenUsage } from '../types/session';

/**
 * 会话用量统计（Web / mobile `useSession` 里 `fetchTokenUsage` 的共同内核）：
 * 拉 `/api/sessions/:id/stats`，把 `tokenUsage`（附 `totalCostUsd`）与 `contextUsage` 落到状态。
 *
 * `createGuard` 是平台注入的存活判定（mobile 同时绑定 identity generation 与当前会话，
 * 避免慢响应覆盖新会话头部）；缺省始终存活。
 */

export interface SessionUsageStatsOptions {
  authFetch: (url: string) => Promise<Response>;
  /** 当前会话 id；`refreshTokenUsage` 只在有会话时拉取。 */
  sessionId: string | null;
  createGuard?: (sessionId: string) => () => boolean;
}

export interface SessionUsageStats {
  tokenUsage: TokenUsage | null;
  setTokenUsage: Dispatch<SetStateAction<TokenUsage | null>>;
  contextUsage: ContextUsageData | null;
  setContextUsage: Dispatch<SetStateAction<ContextUsageData | null>>;
  fetchTokenUsage: (sessionId: string) => Promise<void>;
  refreshTokenUsage: () => Promise<void>;
}

const alwaysAlive = () => true;

export function useSessionUsageStats(options: SessionUsageStatsOptions): SessionUsageStats {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageData | null>(null);

  const fetchTokenUsage = useCallback(async (id: string) => {
    const opts = optionsRef.current;
    const isAlive = opts.createGuard?.(id) ?? alwaysAlive;
    try {
      const response = await opts.authFetch(`/api/sessions/${encodeURIComponent(id)}/stats`);
      if (response.ok && isAlive()) {
        const data = (await response.json()) as {
          tokenUsage?: TokenUsage;
          contextUsage?: ContextUsageData;
          totalCostUsd?: number | null;
        };
        if (!isAlive()) return;
        const usage = data.tokenUsage
          ? { ...data.tokenUsage, totalCostUsd: data.totalCostUsd ?? null }
          : null;
        setTokenUsage(usage);
        setContextUsage(data.contextUsage ?? null);
      }
    } catch {
      // silent fail
    }
  }, []);

  const { sessionId } = options;
  const refreshTokenUsage = useCallback(async () => {
    if (sessionId) void fetchTokenUsage(sessionId);
  }, [fetchTokenUsage, sessionId]);

  return {
    tokenUsage,
    setTokenUsage,
    contextUsage,
    setContextUsage,
    fetchTokenUsage,
    refreshTokenUsage,
  };
}
