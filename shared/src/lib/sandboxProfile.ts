import type { SandboxProfile } from '../types/session';

/**
 * 沙箱档位（日常 / 编程）的共享语义。
 *
 * Web 把这套逻辑散在 `web/src/types/sandboxProfile.ts` 与 `ChatInput` 组件里；
 * 移动端要一比一复用同样的标签与锁定规则，因此下沉到 shared 作为纯函数。
 */

export interface SandboxProfileOption {
  value: SandboxProfile;
  label: string;
}

/** 档位选项顺序与 Web ChatInput 弹层一致：日常在前、编程在后。 */
export const SANDBOX_PROFILE_OPTIONS: readonly SandboxProfileOption[] = [
  { value: 'daily', label: '日常' },
  { value: 'coding', label: '编程' },
];

/** 与 Web `profileLabel` 同语义：只有显式 coding 才叫「编程」，其余一律「日常」。 */
export function sandboxProfileLabel(profile: SandboxProfile | null | undefined): string {
  return profile === 'coding' ? '编程' : '日常';
}

/**
 * 会话详情里的档位归一化，与 Web `resolveSessionSandboxProfile` 逐字对齐：
 * 只有显式 'daily' 才是日常，缺省/脏值一律按 coding 兜底（老会话默认编程沙箱）。
 */
export function resolveSessionSandboxProfile(value: unknown): SandboxProfile {
  return value === 'daily' ? 'daily' : 'coding';
}

/**
 * 档位是否锁定。与 Web ChatInput `profileLocked = !!sessionId || isDisabled || loading` 一致：
 * 会话一旦落地，沙箱已按档位创建，改档只能靠开新会话。
 */
export function isSandboxProfileLocked(input: {
  sessionId?: string | null;
  loading?: boolean;
  disabled?: boolean;
}): boolean {
  return Boolean(input.sessionId) || input.loading === true || input.disabled === true;
}
