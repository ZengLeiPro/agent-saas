import { useSyncExternalStore } from 'react';
import type { SandboxProfile } from '@agent/shared';

/**
 * 新会话草稿的沙箱档位（日常 / 编程）。
 *
 * 与 Web `useSandboxProfile` 同语义，但 Web 把它挂在 `useChatAppState` 里，
 * 移动端的同名 hook 处于行数 ratchet 内不再扩张，因此改成模块级 store：
 *   - 只在「还没有会话」时可写，会话落地后档位由服务端持久化，改档必须开新会话；
 *   - `sendChatViaWs` 建 submission 时读取当前草稿档位塞进 `target.sandboxProfile`
 *     （shared `CanonicalChatTarget` 已有该字段，不自造契约）。
 */

const DEFAULT_PROFILE: SandboxProfile = 'daily';

let draftProfile: SandboxProfile = DEFAULT_PROFILE;
const listeners = new Set<() => void>();

export function getDraftSandboxProfile(): SandboxProfile {
  return draftProfile;
}

export function setDraftSandboxProfile(next: SandboxProfile): void {
  if (draftProfile === next) return;
  draftProfile = next;
  for (const listener of [...listeners]) listener();
}

/** 开新会话时回到默认档位，与 Web `startNewSandboxProfile` 一致。 */
export function resetDraftSandboxProfile(): void {
  setDraftSandboxProfile(DEFAULT_PROFILE);
}

export function subscribeDraftSandboxProfile(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDraftSandboxProfile(): SandboxProfile {
  return useSyncExternalStore(
    subscribeDraftSandboxProfile,
    getDraftSandboxProfile,
    getDraftSandboxProfile,
  );
}
