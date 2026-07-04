/**
 * 手机验证码服务（自助注册试用用）
 *
 * 存储用进程内存：agent-saas-server 是单实例 systemd 部署，无需共享存储；
 * 重启丢失未验证的码，用户重新获取即可。
 *
 * phone 维度的约束在本服务内收口（IP 维度频控由路由层负责）：
 *   - 发送冷却：同号 60s
 *   - 日限额：同号每自然日 10 条（防短信费被刷）
 *   - 有效期：5 分钟
 *   - 防爆破：同一验证码错误尝试 5 次后作废
 *   - 一次性：验证成功即消费删除
 */

import { randomInt } from "node:crypto";
import { apiLogger } from "../../utils/logger.js";

/** 短信发送器抽象：dev（只打日志）/ aliyun（真实发送） */
export interface SmsSender {
  /** 发送验证码短信；失败时 throw（由调用方决定如何呈现） */
  sendCode(phone: string, code: string): Promise<void>;
  readonly providerName: string;
}

/** dev 发送器：不真发短信，验证码打到 server log，配合万能码做本地/内测闭环 */
export class DevSmsSender implements SmsSender {
  readonly providerName = "dev";

  async sendCode(phone: string, code: string): Promise<void> {
    apiLogger.info(`[sms:dev] 验证码（未真实发送） phone=${phone} code=${code}`);
  }
}

interface CodeEntry {
  code: string;
  expiresAt: number;
  /** 错误尝试次数；达到上限即作废 */
  attempts: number;
}

interface PhoneSendState {
  lastSentAt: number;
  /** 自然日（YYYY-MM-DD，本地时区）内已发送条数 */
  day: string;
  dayCount: number;
}

export interface RequestCodeResult {
  ok: boolean;
  /** ok=false 时的用户可读错误 */
  error?: string;
  /** 冷却剩余秒数（error 为冷却时提供） */
  retryAfterSeconds?: number;
}

export interface VerificationCodeServiceOptions {
  sender: SmsSender;
  /** 验证码有效期，默认 5 分钟 */
  codeTtlMs?: number;
  /** 同号发送冷却，默认 60s */
  cooldownMs?: number;
  /** 同号每自然日发送上限，默认 10 */
  dailyLimitPerPhone?: number;
  /**
   * 万能码（仅 dev/内测用；env AGENT_SMS_DEV_CODE 注入）。
   * 配置后任何手机号都可用它通过验证；生产切 aliyun provider 后必须移除。
   */
  universalCode?: string;
}

const DEFAULT_CODE_TTL_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_DAILY_LIMIT = 10;
const MAX_VERIFY_ATTEMPTS = 5;

function localDayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class VerificationCodeService {
  private readonly codes = new Map<string, CodeEntry>();
  private readonly sendState = new Map<string, PhoneSendState>();
  private readonly codeTtlMs: number;
  private readonly cooldownMs: number;
  private readonly dailyLimit: number;
  private readonly universalCode?: string;
  readonly sender: SmsSender;

  constructor(options: VerificationCodeServiceOptions) {
    this.sender = options.sender;
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.dailyLimit = options.dailyLimitPerPhone ?? DEFAULT_DAILY_LIMIT;
    this.universalCode = options.universalCode || undefined;

    // 定期清理过期条目（10 分钟一次），unref 不阻止进程退出
    const timer = setInterval(() => this.sweep(), 10 * 60_000);
    timer.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [phone, entry] of this.codes) {
      if (entry.expiresAt < now) this.codes.delete(phone);
    }
    const today = localDayKey(now);
    for (const [phone, state] of this.sendState) {
      if (state.day !== today && now - state.lastSentAt > this.cooldownMs) {
        this.sendState.delete(phone);
      }
    }
  }

  /** 生成并发送验证码。冷却/限额不满足时返回用户可读错误，发送失败时 throw。 */
  async requestCode(phone: string): Promise<RequestCodeResult> {
    const now = Date.now();
    const state = this.sendState.get(phone);
    const today = localDayKey(now);

    if (state && now - state.lastSentAt < this.cooldownMs) {
      const retryAfterSeconds = Math.ceil(
        (state.lastSentAt + this.cooldownMs - now) / 1000,
      );
      return {
        ok: false,
        error: `发送过于频繁，请 ${retryAfterSeconds} 秒后再试`,
        retryAfterSeconds,
      };
    }
    if (state && state.day === today && state.dayCount >= this.dailyLimit) {
      return { ok: false, error: "该手机号今日获取验证码次数已达上限" };
    }

    // 6 位数字验证码（crypto 随机）
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.sender.sendCode(phone, code);

    this.codes.set(phone, {
      code,
      expiresAt: now + this.codeTtlMs,
      attempts: 0,
    });
    this.sendState.set(phone, {
      lastSentAt: now,
      day: today,
      dayCount: state?.day === today ? state.dayCount + 1 : 1,
    });
    return { ok: true };
  }

  /**
   * 校验并消费验证码（成功即删除，一次性）。
   * 错误尝试达到上限后该码作废，需重新获取。
   */
  verifyAndConsume(phone: string, code: string): boolean {
    if (this.universalCode && code === this.universalCode) {
      apiLogger.warn(`[sms] 万能码验证通过 phone=${phone}（仅限内测，生产须移除）`);
      this.codes.delete(phone);
      return true;
    }
    const entry = this.codes.get(phone);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      this.codes.delete(phone);
      return false;
    }
    if (entry.code !== code) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
        this.codes.delete(phone);
      }
      return false;
    }
    this.codes.delete(phone);
    return true;
  }
}
