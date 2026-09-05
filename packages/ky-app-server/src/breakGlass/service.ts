/**
 * §3.5 本地兜底登录（break-glass）。
 *
 * 具名恢复记录（argon2id m=64 MiB / t=3 / p=1）+ 8 个一次性恢复码（各 128 bit，哈希存储）；
 * `POST /ky-local/enable` 始终公开（每 IP ≤ 5 次/分钟；5 次失败锁 30 分钟并告警）；
 * 成功即进入兜底模式 4 小时（可续）并签发该 `sub` 的 `local_admin`；
 * 安装实例 `disabled`/`deleted` 时拒绝启用；员工一次性码 15 分钟 TTL、5 次错误锁定；
 * 撤销粒度 = 模式级；全程本地审计。时钟可注入。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { hash as argon2Hash, verify as argon2Verify, type Options } from '@node-rs/argon2';

import {
  BREAK_GLASS_SESSION_SECONDS,
  type InstallationState,
  type ManifestPathPrefixes,
} from '@kaiyan/ky-app-contract';

import type { KyAppConfig } from '../config/index.js';
import { KyAppError } from '../errors.js';
import type { LocalKeyRing } from '../local/keys.js';
import { issueLocalToken } from '../local/token.js';
import type {
  BreakGlassAuditAction,
  BreakGlassSession,
  BreakGlassStore,
  RecoveryRecord,
} from './store.js';

/** §3.5：argon2id，m=64 MiB（65536 KiB）、t=3、p=1。 */
export const ARGON2_OPTIONS: Options = {
  // `Algorithm` 在 @node-rs/argon2 里是 ambient const enum，isolatedModules 下不能直接引用，
  // 这里用它的数值 2（Argon2id）并显式收窄类型。
  algorithm: 2 as unknown as Options['algorithm'],
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
};

/** 恢复码数量与位宽（§3.5）。 */
export const RECOVERY_CODE_COUNT = 8;
export const RECOVERY_CODE_BYTES = 16;
/** 员工一次性码 TTL（秒）。 */
export const EMPLOYEE_CODE_TTL_SECONDS = 15 * 60;
/** 连续失败上限与锁定时长。 */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 30 * 60 * 1000;
/** `/ky-local/enable` 每 IP 每分钟上限（§3.3）。 */
export const ENABLE_RATE_LIMIT = { max: 5, windowMs: 60_000 } as const;

export interface BreakGlassAlert {
  kind: 'lockout' | 'enabled' | 'disabled';
  sub?: string;
  ip?: string;
  at: number;
}

export interface BreakGlassOptions {
  config: KyAppConfig;
  keys: LocalKeyRing;
  store: BreakGlassStore;
  pathPrefixes: ManifestPathPrefixes;
  /** 当前安装实例状态；`disabled`/`deleted` 一律拒绝启用（§3.5、§8.7）。 */
  installationState: () => InstallationState;
  /** 告警回调（锁定、启用、关闭）。 */
  onAlert?: (alert: BreakGlassAlert) => void;
  now?: () => number;
}

export interface BreakGlassTokenResult {
  token: string;
  /** Local Token 到期时刻（毫秒）。 */
  expiresAt: number;
  /** 兜底会话到期时刻（毫秒）。 */
  sessionExpiresAt: number;
}

export interface BreakGlass {
  /** 正常模式下由管理员设置恢复密码，返回 8 个明文恢复码（只此一次）。 */
  setupRecoveryRecord(input: { sub: string; password: string }): Promise<{ codes: string[] }>;
  /** `POST /ky-local/enable`。 */
  enable(input: {
    sub: string;
    password: string;
    code: string;
    ip?: string;
  }): Promise<BreakGlassTokenResult>;
  /** 续期 4 小时。 */
  renew(): Promise<BreakGlassSession>;
  /** 模式级撤销。 */
  disable(): Promise<void>;
  /** 当前兜底会话；已过期自动关闭并返回 null。 */
  session(): Promise<BreakGlassSession | null>;
  isActive(): Promise<boolean>;
  /** `local_admin` 为某位员工生成一次性登录码。 */
  issueEmployeeCode(input: { loginId: string; sub: string }): Promise<{
    code: string;
    expiresAt: number;
  }>;
  /** `POST /ky-local/login`。 */
  login(input: { loginId: string; code: string; ip?: string }): Promise<BreakGlassTokenResult>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 恒定时间比较两个 sha256 十六进制串。恢复码本身是 128 bit 随机值，
 * 熵足够高，用 sha256 存储即可（argon2id 只用于人选的口令）。
 */
function hashEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => nowMs - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}

export function createBreakGlass(options: BreakGlassOptions): BreakGlass {
  const now = options.now ?? Date.now;
  const limiter = new RateLimiter(ENABLE_RATE_LIMIT.max, ENABLE_RATE_LIMIT.windowMs);

  async function audit(
    action: BreakGlassAuditAction,
    outcome: 'success' | 'failure',
    extra: { sub?: string; loginId?: string; ip?: string; detail?: string } = {},
  ): Promise<void> {
    await options.store.appendAudit({ at: now(), action, outcome, ...extra });
  }

  function alert(alertEvent: BreakGlassAlert): void {
    options.onAlert?.(alertEvent);
  }

  async function currentSession(): Promise<BreakGlassSession | null> {
    const session = await options.store.getSession();
    if (session === null) return null;
    if (session.expiresAt <= now()) {
      await options.store.saveSession(null);
      return null;
    }
    return session;
  }

  async function requireActiveSession(): Promise<BreakGlassSession> {
    const session = await currentSession();
    if (session === null) {
      throw new KyAppError('unauthorized', { message: '兜底模式未开启' });
    }
    return session;
  }

  function assertInstallationUsable(): void {
    const state = options.installationState();
    if (state !== 'enabled') {
      throw new KyAppError('installation_disabled', {
        message: `安装实例处于 ${state}，拒绝启用兜底登录`,
      });
    }
  }

  /** 记一次失败并在达到阈值时锁定 30 分钟；返回待抛出的错误。 */
  async function lockAndAudit(
    record: RecoveryRecord,
    ip: string | undefined,
    detail: string,
  ): Promise<KyAppError> {
    record.failedAttempts += 1;
    record.updatedAt = now();
    if (record.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      record.lockedUntil = now() + LOCKOUT_MS;
      record.failedAttempts = 0;
      alert({ kind: 'lockout', sub: record.sub, ...(ip === undefined ? {} : { ip }), at: now() });
    }
    await options.store.saveRecord(record);
    await audit('enable', 'failure', {
      sub: record.sub,
      ...(ip === undefined ? {} : { ip }),
      detail,
    });
    return new KyAppError('unauthorized', { message: '恢复因子不正确' });
  }

  async function signToken(
    sub: string,
    act: 'local_admin' | 'local_user',
    sessionExpiresAt: number,
  ): Promise<BreakGlassTokenResult> {
    const nowMs = now();
    // Local Token 不得比兜底会话活得更久：模式关闭即整体失效（§3.2 模式级撤销）。
    const ttlSeconds = Math.max(1, Math.floor((sessionExpiresAt - nowMs) / 1000));
    const token = await issueLocalToken({
      config: options.config,
      keys: options.keys,
      sub,
      act,
      pathPrefixes: options.pathPrefixes,
      ttlSeconds,
      nowMs,
    });
    return { token, expiresAt: nowMs + ttlSeconds * 1000, sessionExpiresAt };
  }

  return {
    async setupRecoveryRecord({ sub, password }) {
      if (await currentSession()) {
        throw new KyAppError('forbidden', { message: '恢复因子只能在正常模式下设置' });
      }
      if (password.length < 12) {
        throw new KyAppError('invalid_input', { message: '恢复密码至少 12 位' });
      }
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
        randomBytes(RECOVERY_CODE_BYTES).toString('base64url'),
      );
      const record: RecoveryRecord = {
        sub,
        passwordHash: await argon2Hash(password, ARGON2_OPTIONS),
        codes: codes.map((code) => ({ hash: sha256(code), usedAt: null })),
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: now(),
        updatedAt: now(),
      };
      await options.store.saveRecord(record);
      await audit('recovery.setup', 'success', { sub });
      return { codes };
    },

    async enable({ sub, password, code, ip }) {
      assertInstallationUsable();
      const nowMs = now();
      if (ip !== undefined && !limiter.check(ip, nowMs)) {
        await audit('enable', 'failure', { sub, ip, detail: 'rate_limited' });
        throw new KyAppError('rate_limited', { message: '启用请求过于频繁' });
      }

      const record = await options.store.getRecord(sub);
      if (record === null) {
        await audit('enable', 'failure', {
          sub,
          ...(ip === undefined ? {} : { ip }),
          detail: 'no_record',
        });
        throw new KyAppError('unauthorized', { message: '恢复因子不正确' });
      }
      if (record.lockedUntil !== null && record.lockedUntil > nowMs) {
        await audit('enable', 'failure', {
          sub,
          ...(ip === undefined ? {} : { ip }),
          detail: 'locked',
        });
        throw new KyAppError('rate_limited', { message: '恢复记录已锁定，请稍后再试' });
      }
      if (record.lockedUntil !== null && record.lockedUntil <= nowMs) {
        record.lockedUntil = null;
        record.failedAttempts = 0;
      }

      const passwordOk = await argon2Verify(record.passwordHash, password, ARGON2_OPTIONS).catch(
        () => false,
      );
      const codeHash = sha256(code);
      const codeEntry = record.codes.find(
        (entry) => entry.usedAt === null && hashEquals(entry.hash, codeHash),
      );
      if (!passwordOk || codeEntry === undefined) {
        throw await lockAndAudit(record, ip, passwordOk ? 'bad_code' : 'bad_password');
      }

      codeEntry.usedAt = nowMs;
      record.failedAttempts = 0;
      record.lockedUntil = null;
      record.updatedAt = nowMs;
      await options.store.saveRecord(record);

      const session: BreakGlassSession = {
        enabledBy: sub,
        enabledAt: nowMs,
        expiresAt: nowMs + BREAK_GLASS_SESSION_SECONDS * 1000,
      };
      await options.store.saveSession(session);
      alert({ kind: 'enabled', sub, ...(ip === undefined ? {} : { ip }), at: nowMs });
      await audit('enable', 'success', { sub, ...(ip === undefined ? {} : { ip }) });
      return signToken(sub, 'local_admin', session.expiresAt);
    },

    async renew() {
      const session = await requireActiveSession();
      const renewed: BreakGlassSession = {
        ...session,
        expiresAt: now() + BREAK_GLASS_SESSION_SECONDS * 1000,
      };
      await options.store.saveSession(renewed);
      await audit('renew', 'success', { sub: session.enabledBy });
      return renewed;
    },

    async disable() {
      const session = await options.store.getSession();
      await options.store.saveSession(null);
      alert({
        kind: 'disabled',
        ...(session === null ? {} : { sub: session.enabledBy }),
        at: now(),
      });
      await audit('disable', 'success', session === null ? {} : { sub: session.enabledBy });
    },

    session: currentSession,

    async isActive() {
      return (await currentSession()) !== null;
    },

    async issueEmployeeCode({ loginId, sub }) {
      await requireActiveSession();
      const nowMs = now();
      const code = randomBytes(RECOVERY_CODE_BYTES).toString('base64url');
      await options.store.saveEmployeeCode({
        loginId,
        sub,
        hash: sha256(code),
        expiresAt: nowMs + EMPLOYEE_CODE_TTL_SECONDS * 1000,
        usedAt: null,
        failedAttempts: 0,
        lockedUntil: null,
      });
      await audit('employee-code.issue', 'success', { loginId, sub });
      return { code, expiresAt: nowMs + EMPLOYEE_CODE_TTL_SECONDS * 1000 };
    },

    async login({ loginId, code, ip }) {
      const session = await requireActiveSession();
      const nowMs = now();
      const entry = await options.store.getEmployeeCode(loginId);
      if (entry === null) {
        await audit('login', 'failure', {
          loginId,
          ...(ip === undefined ? {} : { ip }),
          detail: 'no_code',
        });
        throw new KyAppError('unauthorized', { message: '登录标识或恢复码不正确' });
      }
      if (entry.lockedUntil !== null && entry.lockedUntil > nowMs) {
        await audit('login', 'failure', {
          loginId,
          ...(ip === undefined ? {} : { ip }),
          detail: 'locked',
        });
        throw new KyAppError('rate_limited', { message: '该登录标识已锁定，请联系管理员' });
      }
      const expired = entry.expiresAt <= nowMs;
      const used = entry.usedAt !== null;
      if (expired || used || !hashEquals(entry.hash, sha256(code))) {
        entry.failedAttempts += 1;
        if (entry.failedAttempts >= MAX_FAILED_ATTEMPTS) {
          entry.lockedUntil = nowMs + LOCKOUT_MS;
          entry.failedAttempts = 0;
          alert({
            kind: 'lockout',
            sub: entry.sub,
            ...(ip === undefined ? {} : { ip }),
            at: nowMs,
          });
        }
        await options.store.saveEmployeeCode(entry);
        await audit('login', 'failure', {
          loginId,
          ...(ip === undefined ? {} : { ip }),
          detail: expired ? 'expired' : used ? 'used' : 'bad_code',
        });
        throw new KyAppError('unauthorized', { message: '登录标识或恢复码不正确' });
      }

      entry.usedAt = nowMs;
      entry.failedAttempts = 0;
      await options.store.saveEmployeeCode(entry);
      await audit('login', 'success', {
        loginId,
        sub: entry.sub,
        ...(ip === undefined ? {} : { ip }),
      });
      return signToken(entry.sub, 'local_user', session.expiresAt);
    },
  };
}
