/**
 * 同一组织的调试模式设置与成员开关共享串行锁。
 *
 * 关闭上级开关需要先持久化组织状态再清理成员；成员开启则必须在同一锁内
 * 完成上级校验与用户写入，避免“校验通过后被关闭、随后又写回 true”。
 */
const lockTails = new Map<string, Promise<void>>();

export async function withTenantDebugModeLock<T>(
  tenantId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = lockTails.get(tenantId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  lockTails.set(tenantId, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lockTails.get(tenantId) === current) lockTails.delete(tenantId);
  }
}
