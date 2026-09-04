import type { ISecureStorage } from '@agent/shared';
import { isTabScopedAuthKey, readTabScopedAuth, removeTabScopedAuth, writeTabScopedAuth } from './tabScopedAuthStorage';

/**
 * Web has no secure storage — localStorage wrapper with async interface.
 * 登录身份相关的键按标签页隔离（见 tabScopedAuthStorage），其余键仍走 localStorage。
 */
export const webSecureStorage: ISecureStorage = {
  async getItem(key: string): Promise<string | null> {
    return isTabScopedAuthKey(key) ? readTabScopedAuth(key) : localStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    if (isTabScopedAuthKey(key)) writeTabScopedAuth(key, value);
    else localStorage.setItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (isTabScopedAuthKey(key)) removeTabScopedAuth(key);
    else localStorage.removeItem(key);
  },
};
