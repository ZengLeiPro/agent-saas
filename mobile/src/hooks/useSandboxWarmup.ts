import { useEffect, useRef } from 'react';
import { warmupSessionSandbox } from '@agent/shared';

/**
 * 首次有效输入触发沙箱预热（对齐 `web/src/components/ChatInput.tsx` 的 `warmupSessionOnce`）。
 *
 * 语义：同一个会话内，输入框从「空」变成「有有效文本」时打一次 warmup；
 * 文本被清空后重新武装，下一次再敲字可以再打一次；切换会话只重新武装，
 * 不把加载出来的既有草稿当成首字（否则重挂载会反复预热）。
 */

export interface WarmupInputState {
  sessionId: string | null;
  hasValidText: boolean;
}

export type WarmupTransition = 'warmup' | 'rearm' | 'none';

export interface WarmupDecision {
  next: WarmupInputState;
  transition: WarmupTransition;
}

/** 纯状态机：给定上一轮状态与本次输入，算出下一轮状态与应触发的动作。 */
export function nextWarmupState(
  previous: WarmupInputState,
  sessionId: string | null,
  value: string,
): WarmupDecision {
  const hasValidText = value.trim().length > 0;
  // 切换会话：只重新武装，不把既有草稿当成首字。
  if (previous.sessionId !== sessionId) {
    return { next: { sessionId, hasValidText: false }, transition: 'rearm' };
  }
  const next: WarmupInputState = { sessionId, hasValidText };
  if (!sessionId) return { next, transition: 'none' };
  if (previous.hasValidText && !hasValidText) return { next, transition: 'rearm' };
  if (!previous.hasValidText && hasValidText) return { next, transition: 'warmup' };
  return { next, transition: 'none' };
}

/** 进程内已预热过的会话；重新武装时移除，重复预热才被抑制。 */
const warmedSessionIds = new Set<string>();

/** 测试与会话回收用：清掉预热记忆。 */
export function resetSandboxWarmupMemory(): void {
  warmedSessionIds.clear();
}

export function useSandboxWarmup(sessionId: string | null | undefined, input: string): void {
  const normalizedSessionId = sessionId ?? null;
  const stateRef = useRef<WarmupInputState>({
    sessionId: normalizedSessionId,
    hasValidText: false,
  });

  useEffect(() => {
    const { next, transition } = nextWarmupState(stateRef.current, normalizedSessionId, input);
    stateRef.current = next;
    if (!normalizedSessionId) return;
    if (transition === 'rearm') {
      warmedSessionIds.delete(normalizedSessionId);
      return;
    }
    if (transition !== 'warmup' || warmedSessionIds.has(normalizedSessionId)) return;
    warmedSessionIds.add(normalizedSessionId);
    // 预热是尽力而为的加速手段，失败不能影响发送，也不提示用户。
    void warmupSessionSandbox(normalizedSessionId).catch(() => undefined);
  }, [normalizedSessionId, input]);
}
