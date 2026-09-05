import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';

/**
 * 运行态 watchdog（Web / mobile `useChatAppState` 的共同内核）：防止 done 丢失时 loading 永久锁定。
 *
 * - 首次等待 60s、收到过流事件后每次 45s；到期先查 `/api/sessions/:id/stream-status`，
 *   服务端仍 active 就继续续期，否则交给平台 `onExpired` 收尾；
 * - 过期判定（切走会话 / 流代际变化 / 运行态版本变化）由平台注入 `createStaleGuard`，
 *   缺省视为永不过期。
 */

export interface StreamWatchdogOptions {
  authFetch: (url: string) => Promise<Response>;
  /** 当前是否处于 loading；不在 loading 时不安排、到期也不收尾。 */
  isLoading: () => boolean;
  getSessionId: () => string | null;
  /** 到期时创建的过期判定；每个异步阶段后都会再问一次，返回 true 即放弃本次收尾。 */
  createStaleGuard?: (sessionId: string | null) => () => boolean;
  /** 探活未确认活跃（含无会话、探活失败）后的平台收尾。 */
  onExpired: (sessionId: string | null) => void;
  /** 首次等待（尚未收到任何流事件）。 */
  initialTimeoutMs?: number;
  /** 收到过流事件后的等待。 */
  activeTimeoutMs?: number;
}

export interface StreamWatchdog {
  clearWatchdog: () => void;
  resetWatchdog: () => void;
  /** 记录一次流事件到达并重新计时。 */
  touchWatchdog: () => void;
  lastStreamEventAtRef: MutableRefObject<number>;
}

const neverStale = () => false;

export function useStreamWatchdog(options: StreamWatchdogOptions): StreamWatchdog {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStreamEventAtRef = useRef(0);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    lastStreamEventAtRef.current = 0;
  }, []);

  const resetWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
    const opts = optionsRef.current;
    if (!opts.isLoading()) return;
    const timeout =
      lastStreamEventAtRef.current > 0
        ? (opts.activeTimeoutMs ?? 45_000)
        : (opts.initialTimeoutMs ?? 60_000);
    watchdogTimerRef.current = setTimeout(async () => {
      watchdogTimerRef.current = null;
      const current = optionsRef.current;
      if (!current.isLoading()) return;
      const sid = current.getSessionId();
      const isStale = current.createStaleGuard?.(sid) ?? neverStale;
      if (sid) {
        try {
          const res = await current.authFetch(`/api/sessions/${sid}/stream-status`);
          if (isStale()) return;
          if (res.ok) {
            const { active } = (await res.json()) as { active: boolean };
            if (isStale()) return;
            if (active) {
              resetWatchdog();
              return;
            } // Agent 还活着
          }
        } catch {
          if (isStale()) return;
        }
      }
      if (isStale()) return;
      optionsRef.current.onExpired(sid);
    }, timeout);
  }, []);

  const touchWatchdog = useCallback(() => {
    lastStreamEventAtRef.current = Date.now();
    resetWatchdog();
  }, [resetWatchdog]);

  return { clearWatchdog, resetWatchdog, touchWatchdog, lastStreamEventAtRef };
}
