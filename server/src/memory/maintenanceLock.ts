/**
 * 用户级记忆维护锁（2026-07-14 记忆轮询批次）
 *
 * 每日记忆轮询（cron executor）与会后记忆维护（memoryHook）都会写同一用户的
 * memory 文件。两者并发时 Edit 的 read-modify-write 存在竞态——用 in-process
 * 互斥集合让同一用户同时只有一个维护性 run 在跑（跨进程场景由部署形态保证：
 * cron 只在 processRole=all 进程执行，会后 hook 也在同一进程）。
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
