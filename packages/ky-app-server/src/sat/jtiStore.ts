/**
 * §3.1-6 `jti` 单次消费存储。只有 `act=agent` / `act=platform` 需要，`user` 多次使用。
 *
 * 消费必须是**跨进程原子**的：PG 唯一约束或 Redis `SET NX`。本包提供内存实现（单进程，
 * 测试与单实例开发用）与 PG 实现（生产用，见 `pgJtiStore.ts`）。
 */
export interface JtiStore {
  /**
   * 占用一个 `jti`。首次占用返回 `true`，重复返回 `false`（调用方回 401 `token_replayed`）。
   * `expiresAt` = SAT `exp` + 容忍，到期后可被清理。
   */
  consume(jti: string, expiresAt: Date): Promise<boolean>;
}

/** 内存实现：单进程原子（JS 单线程），进程重启即失忆，**不可用于多实例部署**。 */
export class MemoryJtiStore implements JtiStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(jti: string, expiresAt: Date): Promise<boolean> {
    this.purgeExpired();
    // Map 的 has + set 之间没有 await，单线程下即原子。
    if (this.entries.has(jti)) return false;
    this.entries.set(jti, expiresAt.getTime());
    return true;
  }

  /** 清理过期占用。 */
  purgeExpired(): number {
    const current = this.now();
    let removed = 0;
    for (const [jti, expiresAt] of this.entries) {
      if (expiresAt <= current) {
        this.entries.delete(jti);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
