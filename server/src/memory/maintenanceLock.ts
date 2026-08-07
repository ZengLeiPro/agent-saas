/**
 * 用户级记忆维护锁（2026-07-14 记忆轮询批次）
 *
 * L2 会话整合与 L3 每日记忆轮询都可能写同一用户的 memory 文件。本集合只做
 * 同进程 fast-path，避免明知冲突仍启动模型；跨进程正确性由共用的 PG commit
 * advisory lock 保证。
 *
 * 语义是 try-lock：拿不到就跳过本次维护（下一轮再来），绝不排队阻塞。
 */

const activeUsers = new Set<string>();

function key(tenantId: string | undefined, userId: string): string {
  return `${tenantId ?? '__none'}:${userId}`;
}

export function tryAcquireMemoryMaintenance(tenantId: string | undefined, userId: string): boolean {
  const k = key(tenantId, userId);
  if (activeUsers.has(k)) return false;
  activeUsers.add(k);
  return true;
}

export function releaseMemoryMaintenance(tenantId: string | undefined, userId: string): void {
  activeUsers.delete(key(tenantId, userId));
}

/** 测试用：重置全部锁状态。 */
export function resetMemoryMaintenanceLocks(): void {
  activeUsers.clear();
}
