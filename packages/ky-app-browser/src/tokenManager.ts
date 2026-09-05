/**
 * §3.1（`user` 行）+ §5.5 令牌续期：
 * 到期前 60 s 单飞续期；回前台 / 401 / 剩余 < 30 s 按需续期；版本号原子替换；
 * `temporary` 指数退避（1 s 起、上限 30 s），终止性 reason 停止请求并回调。
 */
import type { TokenRefreshErrorPayload, TokenRefreshPayload } from '@kaiyan/ky-app-contract';

import { KyAuthError, type KyAuthErrorReason } from './errors.js';
import type { AnyEnvelope, Messenger } from './messenger.js';
import { TokenStore } from './tokenStore.js';
import type { KyCounters, KyTimerHandle, KyTimers } from './types.js';

/** 到期前多久开始主动续期（毫秒，§3.1 `user` 行）。 */
export const PROACTIVE_REFRESH_LEAD_MS = 60_000;
/** 剩余不足多久时，请求必须先等续期完成（毫秒，§3.1 `user` 行）。 */
export const REFRESH_NOW_THRESHOLD_MS = 30_000;
/** `temporary` 指数退避：1 s 起、上限 30 s。 */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

export type KyRefreshOutcome = { ok: true } | { ok: false; reason: KyAuthErrorReason };

export interface TokenManagerDeps {
  messenger: Messenger;
  timers: KyTimers;
  counters: KyCounters;
  now: () => number;
  onTokenError: (reason: TokenRefreshErrorPayload['reason']) => void;
}

export class TokenManager {
  readonly store = new TokenStore();
  readonly #deps: TokenManagerDeps;
  #inflight: Promise<KyRefreshOutcome> | null = null;
  #proactiveTimer: KyTimerHandle = null;
  #backoffTimer: KyTimerHandle = null;
  #failures = 0;
  #stoppedReason: KyAuthErrorReason | null = null;
  #destroyed = false;

  constructor(deps: TokenManagerDeps) {
    this.#deps = deps;
  }

  get stoppedReason(): KyAuthErrorReason | null {
    return this.#stoppedReason;
  }

  /** `init` / 壳主动推送的 `token.refresh` 一律直接落地（它就是最新的）。 */
  accept(payload: TokenRefreshPayload): void {
    if (this.#destroyed) return;
    this.store.write(payload.token, payload.tokenExp);
    this.#failures = 0;
    this.#stoppedReason = null;
    this.#scheduleProactive();
  }

  /** 单飞续期：同一时刻只有一个 `token.request` 在途。 */
  refresh(): Promise<KyRefreshOutcome> {
    if (this.#destroyed) return Promise.resolve({ ok: false, reason: 'destroyed' as const });
    if (this.#stoppedReason !== null) {
      return Promise.resolve({ ok: false, reason: this.#stoppedReason });
    }
    if (this.#inflight !== null) return this.#inflight;
    const inflight = this.#run();
    this.#inflight = inflight;
    return inflight;
  }

  /**
   * 请求前的按需续期：没有令牌、或剩余 < 30 s 时必须等续期完成。
   * 令牌彻底不可用时抛 `KyAuthError`，交页面渲染客户面文案。
   */
  async ensureFresh(): Promise<string> {
    if (this.#stoppedReason !== null) {
      throw new KyAuthError(this.#stoppedReason, '令牌已失效，需要重新登录');
    }
    const remaining = this.store.remainingMs(this.#deps.now());
    if (remaining === null || remaining < REFRESH_NOW_THRESHOLD_MS) {
      const outcome = await this.refresh();
      if (!outcome.ok) throw new KyAuthError(outcome.reason, '续期失败，暂时无法访问');
    }
    const snapshot = this.store.read();
    if (snapshot === null) throw new KyAuthError('no_token', '当前没有可用令牌');
    return snapshot.token;
  }

  /** §5.4 表注：回前台先确保令牌有效。 */
  onVisible(): void {
    const remaining = this.store.remainingMs(this.#deps.now());
    if (remaining === null || remaining < REFRESH_NOW_THRESHOLD_MS) {
      void this.refresh();
    }
  }

  /** 壳主动推送 `token.refresh.error`（不是对某个 `token.request` 的应答）。 */
  handleErrorPush(payload: TokenRefreshErrorPayload): void {
    this.#applyError(payload.reason);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#clearTimers();
    this.store.clear();
  }

  async #run(): Promise<KyRefreshOutcome> {
    const versionAtRequest = this.store.version;
    try {
      const reply = await this.#deps.messenger.request('token.request');
      return this.#applyReply(reply, versionAtRequest);
    } catch {
      // 5 s 内没有应答：按 temporary 处理，进入退避重试。
      this.#deps.counters.refreshFailures += 1;
      this.#scheduleBackoff();
      return { ok: false, reason: 'timeout' };
    } finally {
      this.#inflight = null;
    }
  }

  #applyReply(reply: AnyEnvelope, versionAtRequest: number): KyRefreshOutcome {
    if (reply.type === 'token.refresh') {
      const payload = reply.payload as TokenRefreshPayload;
      // 版本号原子替换：期间若有更新的令牌落地，这份旧结果直接丢弃。
      this.store.writeIfCurrent(payload.token, payload.tokenExp, versionAtRequest);
      this.#deps.counters.refreshes += 1;
      this.#failures = 0;
      this.#clearBackoff();
      this.#scheduleProactive();
      return { ok: true };
    }
    const reason = (reply.payload as TokenRefreshErrorPayload | undefined)?.reason ?? 'temporary';
    this.#deps.counters.refreshFailures += 1;
    this.#applyError(reason);
    return { ok: false, reason };
  }

  #applyError(reason: TokenRefreshErrorPayload['reason']): void {
    if (reason === 'temporary') {
      this.#scheduleBackoff();
      return;
    }
    // session_expired / installation_disabled / user_disabled：停止请求并回调。
    this.#stoppedReason = reason;
    this.#clearTimers();
    this.store.clear();
    this.#deps.onTokenError(reason);
  }

  #scheduleProactive(): void {
    if (this.#destroyed) return;
    this.#deps.timers.clearTimeout(this.#proactiveTimer);
    this.#proactiveTimer = null;
    const remaining = this.store.remainingMs(this.#deps.now());
    if (remaining === null) return;
    const delay = Math.max(0, remaining - PROACTIVE_REFRESH_LEAD_MS);
    this.#proactiveTimer = this.#deps.timers.setTimeout(() => {
      this.#proactiveTimer = null;
      void this.refresh();
    }, delay);
  }

  #scheduleBackoff(): void {
    if (this.#destroyed || this.#stoppedReason !== null) return;
    this.#clearBackoff();
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.#failures);
    this.#failures += 1;
    this.#backoffTimer = this.#deps.timers.setTimeout(() => {
      this.#backoffTimer = null;
      void this.refresh();
    }, delay);
  }

  #clearBackoff(): void {
    this.#deps.timers.clearTimeout(this.#backoffTimer);
    this.#backoffTimer = null;
  }

  #clearTimers(): void {
    this.#deps.timers.clearTimeout(this.#proactiveTimer);
    this.#proactiveTimer = null;
    this.#clearBackoff();
  }
}
