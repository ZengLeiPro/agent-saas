import { useEffect, useRef } from 'react';
import type { ApiSessionListItem } from '../types/session';
import type { BoundaryIdentity } from '../lib/identity';

/**
 * 会话列表缓存的统一写入通道（Web / mobile `useSession` 的共同内核）：
 * 无论来源（API / WS sync），`sessions` / `hasMore` / `identity` 变化后 5s 内无新变化则持久化；
 * 期间再有变化就重新计时，卸载时丢弃未落盘的定时器。
 *
 * `enabled=false` 的那次变化不写也不计时（两端都用它跳过「空列表」）；
 * 存储介质由平台注入 `save`。
 */

export interface SessionListCacheWriterOptions {
  enabled: boolean;
  save: (
    sessions: ApiSessionListItem[],
    hasMore: boolean,
    identity: BoundaryIdentity | null,
  ) => void;
  delayMs?: number;
}

export const SESSION_LIST_CACHE_WRITE_DELAY_MS = 5000;

export function useSessionListCacheWriter(
  sessions: ApiSessionListItem[],
  hasMore: boolean,
  identity: BoundaryIdentity | null,
  options: SessionListCacheWriterOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const debounceSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!optionsRef.current.enabled) return;
    if (debounceSaveRef.current) clearTimeout(debounceSaveRef.current);
    debounceSaveRef.current = setTimeout(() => {
      optionsRef.current.save(sessions, hasMore, identity);
      debounceSaveRef.current = null;
    }, optionsRef.current.delayMs ?? SESSION_LIST_CACHE_WRITE_DELAY_MS);
    return () => {
      if (debounceSaveRef.current) {
        clearTimeout(debounceSaveRef.current);
        debounceSaveRef.current = null;
      }
    };
  }, [sessions, hasMore, identity]);
}
