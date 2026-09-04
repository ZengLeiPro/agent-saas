import { beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SESSION_KEY, TOKEN_KEY } from '@agent/shared';
import {
  createTabScopedAuthStorage,
  isTabScopedAuthKey,
  type StorageLike,
} from './tabScopedAuthStorage';

/** 内存版 Storage：一个实例=一个 tab 的 sessionStorage，或整个 profile 的 localStorage。 */
function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

describe('标签页作用域的登录身份', () => {
  let mirror: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    mirror = memoryStorage({
      [TOKEN_KEY]: 'token-admin',
      [AUTH_SESSION_KEY]: '{"authEpoch":1,"generation":1}',
    });
  });

  it('只隔离身份相关的键', () => {
    expect(isTabScopedAuthKey(TOKEN_KEY)).toBe(true);
    expect(isTabScopedAuthKey(AUTH_SESSION_KEY)).toBe(true);
    expect(isTabScopedAuthKey('agentChat.identity.v1')).toBe(true);
    expect(isTabScopedAuthKey('agentChat.sessionId')).toBe(true);
    expect(isTabScopedAuthKey('agentChat.authLifecycle.v1')).toBe(true);
    // 多账号凭据库是跨 tab 共享的保管处，不能按 tab 隔离
    expect(isTabScopedAuthKey('agentChat.savedAccounts.v1')).toBe(false);
    expect(isTabScopedAuthKey('agentChat.inputDraft')).toBe(false);
  });

  it('新 tab 继承上一次使用的账号，保持“新开标签页仍是登录态”', () => {
    const tab = createTabScopedAuthStorage(memoryStorage(), mirror);
    expect(tab.read(TOKEN_KEY)).toBe('token-admin');
  });

  it('两个 tab 各自登录不同账号后互不影响', () => {
    const tabA = createTabScopedAuthStorage(memoryStorage(), mirror);
    const tabB = createTabScopedAuthStorage(memoryStorage(), mirror);
    expect(tabA.read(TOKEN_KEY)).toBe('token-admin');
    expect(tabB.read(TOKEN_KEY)).toBe('token-admin');

    tabB.write(TOKEN_KEY, 'token-zenglei');

    expect(tabB.read(TOKEN_KEY)).toBe('token-zenglei');
    expect(tabA.read(TOKEN_KEY)).toBe('token-admin'); // 改造前这里会变成 token-zenglei
    // 镜像跟随最后一次写入，只决定“再新开一个 tab 用哪个账号”
    expect(createTabScopedAuthStorage(memoryStorage(), mirror).read(TOKEN_KEY)).toBe(
      'token-zenglei',
    );
  });

  it('一个 tab 退出登录不影响另一个 tab，也不清掉别人设的默认账号', () => {
    const tabA = createTabScopedAuthStorage(memoryStorage(), mirror);
    const tabB = createTabScopedAuthStorage(memoryStorage(), mirror);
    tabA.read(TOKEN_KEY);
    tabB.write(TOKEN_KEY, 'token-zenglei');

    tabA.remove(TOKEN_KEY); // A 退出的是 token-admin，镜像此时是 B 写的 token-zenglei

    expect(tabA.read(TOKEN_KEY)).toBeNull();
    expect(tabB.read(TOKEN_KEY)).toBe('token-zenglei');
    expect(mirror.dump()[TOKEN_KEY]).toBe('token-zenglei');
  });

  it('退出后同一 tab 重新加载不会把镜像账号继承回来', () => {
    const tabStorage = memoryStorage();
    createTabScopedAuthStorage(tabStorage, mirror).remove(TOKEN_KEY);
    expect(mirror.dump()[TOKEN_KEY]).toBeUndefined(); // 镜像与本 tab 同值，一并清掉

    mirror.setItem(TOKEN_KEY, 'token-other-tab'); // 另一个 tab 随后成为默认账号
    const afterReload = createTabScopedAuthStorage(tabStorage, mirror); // 同一 tab 刷新：marker 仍在
    expect(afterReload.read(TOKEN_KEY)).toBeNull();
  });

  it('sessionStorage 不可用时退化为镜像读写，仍可登录（失去 tab 隔离）', () => {
    const degraded = createTabScopedAuthStorage(null, mirror);
    expect(degraded.read(TOKEN_KEY)).toBe('token-admin');
    degraded.write(TOKEN_KEY, 'token-zenglei');
    expect(mirror.dump()[TOKEN_KEY]).toBe('token-zenglei');
    degraded.remove(TOKEN_KEY);
    expect(mirror.dump()[TOKEN_KEY]).toBeUndefined();
  });
});
