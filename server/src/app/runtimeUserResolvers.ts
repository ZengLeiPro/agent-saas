import type { UserInfo } from '../data/users/types.js';

interface RuntimeUserLookup {
  findById(id: string): UserInfo | undefined;
  findByUsername(username: string): UserInfo | undefined;
}

export function createRuntimeUserResolvers(store?: RuntimeUserLookup) {
  // scheduler wake 不经过 Web channel，需要从账户资料恢复系统提示语使用的角色与全名。
  const find = ({ userId, username }: { userId?: string; username?: string }) =>
    userId ? store?.findById(userId) : username ? store?.findByUsername(username) : undefined;
  return {
    resolveUserRole: (identity: { userId?: string; username?: string }) =>
      find(identity)?.role as 'admin' | 'user' | undefined,
    resolveUserRealName: (identity: { userId?: string; username?: string }) =>
      find(identity)?.realName,
  };
}
