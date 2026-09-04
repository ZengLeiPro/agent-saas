import {
  AUTH_LIFECYCLE_JOURNAL_KEY,
  AUTH_SESSION_KEY,
  SESSION_STORAGE_KEY,
  TOKEN_KEY,
} from '@agent/shared';

/**
 * 每个浏览器标签页独立的登录身份。
 *
 * 背景：token/binding 原先只写 localStorage，一个浏览器 profile 只有一个全局「当前账号」槽位。
 * 两个 tab 登录不同账号时，后写入的 token 会被两个 tab 同时使用，请求带着别人的身份发出去。
 *
 * 语义：
 * - 权威值放 sessionStorage（天然每 tab 独立）。
 * - localStorage 保留一份镜像，只用于「新开的 tab 继承上一次用过的账号」，
 *   维持既有体验：新开标签页仍然是登录态，不用重新登录。
 * - 新 tab 首次访问时从镜像继承一次（bootstrap，由 marker 保证只发生一次），此后两个 tab 完全独立。
 * - 删镜像时做值比对：只有镜像仍是本 tab 写进去的值才删，避免 A tab 退出登录时
 *   把 B tab 刚设为默认的账号一起清掉。
 *
 * 不在此范围内：多账号凭据库 `agentChat.savedAccounts.v1` 仍留在 localStorage——
 * 它是跨 tab 共享的凭据保管处，不是「当前是谁」。
 */

/** AuthContext 的身份元数据键；与 token 同属「当前是谁」，必须同样按 tab 隔离。 */
export const IDENTITY_META_KEY = 'agentChat.identity.v1';

/** 标记本 tab 已完成一次继承，避免退出登录后下次读取又把镜像账号继承回来。 */
const TAB_SCOPE_MARKER_KEY = 'agentChat.tabScope.v1';

/** 按 tab 隔离的键：全部是「当前是谁 / 当前在哪个会话」这类单 tab 状态。 */
export const TAB_SCOPED_AUTH_KEYS: readonly string[] = Object.freeze([
  TOKEN_KEY,
  AUTH_SESSION_KEY,
  AUTH_LIFECYCLE_JOURNAL_KEY,
  IDENTITY_META_KEY,
  SESSION_STORAGE_KEY,
]);

export function isTabScopedAuthKey(key: string): boolean {
  return TAB_SCOPED_AUTH_KEYS.includes(key);
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TabScopedAuthStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * tab 为空时退化为纯镜像读写（等同改造前行为），保证隐私模式或 sessionStorage
 * 不可用时仍能登录，只是失去 tab 隔离。
 */
export function createTabScopedAuthStorage(
  tab: StorageLike | null,
  mirror: StorageLike | null,
): TabScopedAuthStorage {
  let bootstrapped = false;

  const ensureBootstrapped = (): void => {
    if (bootstrapped) return;
    bootstrapped = true;
    if (!tab || !mirror) return;
    try {
      if (tab.getItem(TAB_SCOPE_MARKER_KEY)) return;
      for (const key of TAB_SCOPED_AUTH_KEYS) {
        const inherited = mirror.getItem(key);
        if (inherited !== null) tab.setItem(key, inherited);
      }
      tab.setItem(TAB_SCOPE_MARKER_KEY, '1');
    } catch {
      // sessionStorage 写失败（配额/隐私模式）：本 tab 退回镜像读写，不阻断登录。
      tab = null;
    }
  };

  return {
    read(key: string): string | null {
      ensureBootstrapped();
      try {
        if (tab) return tab.getItem(key);
      } catch {
        // 读失败时继续回落到镜像
      }
      return mirror?.getItem(key) ?? null;
    },
    write(key: string, value: string): void {
      ensureBootstrapped();
      try {
        tab?.setItem(key, value);
      } catch {
        /* 配额 */
      }
      // 镜像只服务于「下一个新 tab 继承哪个账号」，写失败不影响本 tab。
      try {
        mirror?.setItem(key, value);
      } catch {
        /* 配额 */
      }
    },
    remove(key: string): void {
      ensureBootstrapped();
      const current = (() => {
        try {
          return tab?.getItem(key) ?? null;
        } catch {
          return null;
        }
      })();
      try {
        tab?.removeItem(key);
      } catch {
        /* ignore */
      }
      try {
        // 只有镜像仍是本 tab 的值才清；否则那是别的 tab 设的默认账号。
        if (!tab || mirror?.getItem(key) === current) mirror?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

function browserStorage(get: () => Storage): StorageLike | null {
  try {
    const storage = get();
    const probe = '__agentChat.probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

const instance = createTabScopedAuthStorage(
  browserStorage(() => sessionStorage),
  browserStorage(() => localStorage),
);

export function readTabScopedAuth(key: string): string | null {
  return instance.read(key);
}

export function writeTabScopedAuth(key: string, value: string): void {
  instance.write(key, value);
}

export function removeTabScopedAuth(key: string): void {
  instance.remove(key);
}
