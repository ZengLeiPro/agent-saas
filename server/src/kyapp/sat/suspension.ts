/**
 * WP2a 停签联动（规范 §3.1「残留风险」）。
 *
 * SAT 是离线验证的，登出 / 撤销 / 禁用之后已签发的 `act=user` SAT 最长仍有 5 分钟有效期，
 * 契约要求**签发侧立即停签停续**。做法：订阅 `AuthEpochAuthority` 的 audit 回调，
 * 收到 `auth_epoch_fenced` / `auth_generation_revoked` 就把该用户标记为 5 分钟内拒签。
 *
 * 只做「拒签」这一件事，不缓存任何身份信息，也不参与验签。
 */

/** 触发停签的 audit 事件类型。 */
export const KY_APP_SUSPENDING_AUTH_EVENTS = [
  'auth_epoch_fenced',
  'auth_generation_revoked',
] as const;

/** 停签窗口 = SAT `act=user` 的 TTL（5 分钟，规范 §3.1 TTL 表）。 */
export const KY_APP_SUSPENSION_WINDOW_MS = 5 * 60 * 1000;

/** 只取 `AuthEpochAuditEvent` 里本模块真正用到的字段，避免耦合 auth 模块的完整形态。 */
export interface KyAppAuthAuditEventLike {
  event: string;
  userId: string;
}

export interface KyAppSuspensionRegistryOptions {
  windowMs?: number;
  now?: () => number;
  /** 上限，防止异常放大导致内存无界增长；超出后按最早写入淘汰。 */
  maxEntries?: number;
}

export class KyAppSuspensionRegistry {
  /** userId → 停签截止时刻（毫秒）。插入序即淘汰序。 */
  private readonly until = new Map<string, number>();
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: KyAppSuspensionRegistryOptions = {}) {
    this.windowMs = options.windowMs ?? KY_APP_SUSPENSION_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** 直接挂到 `new AuthEpochAuthority(filePath, audit)` 的 audit 回调上。 */
  readonly onAuthEpochAudit = (event: KyAppAuthAuditEventLike): void => {
    if (!(KY_APP_SUSPENDING_AUTH_EVENTS as readonly string[]).includes(event.event)) return;
    this.suspend(event.userId);
  };

  /** 手动停签（用户禁用、组织成员停用等非 epoch 通道也走它）。 */
  suspend(userId: string): void {
    if (!userId) return;
    this.until.delete(userId);
    this.until.set(userId, this.now() + this.windowMs);
    while (this.until.size > this.maxEntries) {
      const oldest = this.until.keys().next();
      if (oldest.done === true) break;
      this.until.delete(oldest.value);
    }
  }

  /** 是否处于停签窗口内。窗口过期即自动解除。 */
  isSuspended(userId: string, nowMs = this.now()): boolean {
    const deadline = this.until.get(userId);
    if (deadline === undefined) return false;
    if (deadline <= nowMs) {
      this.until.delete(userId);
      return false;
    }
    return true;
  }

  /** 清理过期条目，返回清理条数（供后台循环调用）。 */
  prune(nowMs = this.now()): number {
    let removed = 0;
    for (const [userId, deadline] of this.until) {
      if (deadline <= nowMs) {
        this.until.delete(userId);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.until.size;
  }
}
