/**
 * WP2a 壳侧握手（规范 §5.4-3、§3.1、§4.6）。
 *
 * 流程：壳请求 `nonce`（≥128 bit，绑定壳会话 + 用户 + 安装实例，10 分钟 TTL、原子消费）
 * → 子帧拿 nonce 找自己要 attest JWT → 壳把 attestation 交回平台
 * → 平台按 `kid` 取该实例 current/previous 安装密钥派生 HS256 子密钥验签，
 *   校验 `iid`/`origin`/`nonce`（`dig` 只记录）
 * → 通过后签 `act=user` SAT 并返回 `init` 载荷。
 *
 * 幂等：同一 nonce + 同一 attestation 重复提交返回缓存结果（壳会每秒重发 `ready`，≤10 s）；
 * 同一 nonce 换了别的 attestation 一律拒绝并记安全事件。
 */
import { createHash, randomBytes } from 'node:crypto';

import type { KyAppPlatformConfig } from '../config.js';
import type { KyAppCredentialManager } from '../installations/credentials.js';
import type { KyAppSatIssuer, KyAppPathPrefixes } from '../sat/issuer.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppInstallation } from '../systems/types.js';
import { KyAppAttestationError, verifyKyAppAttestation } from './verify.js';
import type { KyAppNonceStore } from './nonceStore.js';

/** §5.4：nonce 10 分钟内有效，过期即作废。 */
export const KY_APP_NONCE_TTL_MS = 10 * 60 * 1000;
/** 壳只接受 `contractVersion=1`（§8.3）。 */
export const KY_APP_SHELL_CONTRACT_VERSION = 1;

export class KyAppHandshakeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'KyAppHandshakeError';
  }
}

/** 壳会话里的当前用户（由会话 JWT 推导，不接受客户端自报）。 */
export interface KyAppShellUser {
  userId: string;
  tenantId: string;
  /** 壳会话标识：会话 JWT 的 `jti`；缺失时由调用方回落成稳定组合值。 */
  sessionId: string;
  displayName: string;
  isTenantAdmin: boolean;
  authBinding: { authEpoch?: number; generation?: number } | null;
}

export interface KyAppHandshakeResult {
  token: string;
  tokenExp: number;
  user: { id: string; displayName: string; isTenantAdmin: boolean };
  installationId: string;
  contractVersion: number;
}

/** 安全事件回调（§5.4-3「记安全事件」、§8.5「安装证明失败」）。 */
export type KyAppSecurityEventSink = (event: {
  kind: 'attest_failed' | 'nonce_invalid' | 'attestation_mismatch';
  installationId: string;
  userId: string;
  reason: string;
}) => void;

export interface KyAppHandshakeServiceOptions {
  config: KyAppPlatformConfig;
  systems: PgKyAppSystemStore;
  nonces: KyAppNonceStore;
  credentials: KyAppCredentialManager;
  issuer: KyAppSatIssuer;
  canAccessInstallation(installation: KyAppInstallation, user: KyAppShellUser): Promise<boolean>;
  onSecurityEvent?: KyAppSecurityEventSink;
  now?: () => number;
  /** 缓存上限，防止异常放大导致内存无界增长。 */
  maxCachedHandshakes?: number;
}

interface CachedHandshake {
  binding: string;
  attestationSha256: string;
  result: KyAppHandshakeResult;
  expiresAt: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** manifest 里的 `pathPrefixes`；缺失即视为空集（SAT 的 `pfx` 会是空数组）。 */
function readPathPrefixes(manifest: Record<string, unknown>): KyAppPathPrefixes {
  const raw = manifest.pathPrefixes;
  if (typeof raw !== 'object' || raw === null) return { user: [], admin: [] };
  const value = raw as { user?: unknown; admin?: unknown };
  const pick = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];
  return { user: pick(value.user), admin: pick(value.admin) };
}

export class KyAppHandshakeService {
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedHandshake>();
  private readonly maxCached: number;
  /** §8.5 观测：安装证明失败计数（进程内，供运行状态与告警读取）。 */
  private readonly failureCounts = new Map<string, number>();

  constructor(private readonly options: KyAppHandshakeServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxCached = options.maxCachedHandshakes ?? 5000;
  }

  /** 签发 nonce：32 字节随机（256 bit），绑定壳会话 + 用户 + 安装实例。 */
  async issueNonce(input: {
    installationId: string;
    user: KyAppShellUser;
  }): Promise<{ nonce: string; expiresAt: string }> {
    const installation = await this.requireUsableInstallation(
      input.installationId,
      input.user,
    );
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now() + KY_APP_NONCE_TTL_MS);
    await this.options.nonces.issue({
      nonce,
      installationId: installation.installationId,
      tenantId: installation.tenantId,
      userId: input.user.userId,
      sessionId: input.user.sessionId,
      expiresAt,
    });
    return { nonce, expiresAt: expiresAt.toISOString() };
  }

  /** 校验安装证明并签发 `act=user` SAT。 */
  async verifyHandshake(input: {
    installationId: string;
    nonce: string;
    attestation: string;
    user: KyAppShellUser;
  }): Promise<KyAppHandshakeResult> {
    this.pruneCache();
    const installation = await this.requireUsableInstallation(input.installationId, input.user);
    const cacheBinding = JSON.stringify([input.installationId, input.user.tenantId, input.user.userId, input.user.sessionId, input.user.authBinding]);
    const attestationSha256 = sha256(input.attestation);
    const cached = this.cache.get(input.nonce);
    if (cached) {
      if (cached.binding !== cacheBinding) throw new KyAppHandshakeError('握手缓存不属于当前用户与会话', 'installation_forbidden');
      if (cached.attestationSha256 === attestationSha256) return cached.result;
      this.recordSecurityEvent(
        'attestation_mismatch',
        input.installationId,
        input.user.userId,
        '同一 nonce 收到了不同的安装证明',
      );
      throw new KyAppHandshakeError('同一 nonce 不接受第二份安装证明', 'attestation_mismatch');
    }

    const binding = await this.options.nonces.consume(input.nonce, new Date(this.now()));
    if (!binding) {
      this.recordSecurityEvent(
        'nonce_invalid',
        input.installationId,
        input.user.userId,
        'nonce 未知、已消费或已过期',
      );
      throw new KyAppHandshakeError('握手 nonce 无效或已使用', 'nonce_invalid');
    }
    if (
      binding.installationId !== input.installationId ||
      binding.userId !== input.user.userId ||
      binding.sessionId !== input.user.sessionId ||
      binding.tenantId !== input.user.tenantId
    ) {
      this.recordSecurityEvent(
        'nonce_invalid',
        input.installationId,
        input.user.userId,
        'nonce 与当前壳会话 / 用户 / 安装实例的绑定不符',
      );
      throw new KyAppHandshakeError('握手 nonce 与当前会话不匹配', 'nonce_binding_mismatch');
    }

    const keys = await this.options.credentials.listAcceptableInstallationKeys(
      input.installationId,
    );
    if (keys.length === 0) {
      throw new KyAppHandshakeError('该安装实例尚未签发安装密钥', 'installation_key_missing');
    }
    try {
      await verifyKyAppAttestation({
        token: input.attestation,
        installationId: installation.installationId,
        expectedOrigin: installation.origin,
        audience: this.options.config.issuer,
        nonce: input.nonce,
        keys,
        nowMs: this.now(),
      });
    } catch (error) {
      const reason = error instanceof KyAppAttestationError ? error.reason : 'unknown';
      this.recordSecurityEvent('attest_failed', input.installationId, input.user.userId, reason);
      throw new KyAppHandshakeError('安装证明校验未通过', 'attestation_invalid');
    }

    const result = await this.issueUserToken(installation, input.user);
    this.cache.set(input.nonce, {
      binding: cacheBinding,
      attestationSha256,
      result,
      expiresAt: this.now() + KY_APP_NONCE_TTL_MS,
    });
    return result;
  }

  /** user SAT 续期：跳过 attest，但用户/成员/AuthEpoch/实例状态的四道前置一个不少（由签发器执行）。 */
  async refreshUserToken(input: {
    installationId: string;
    user: KyAppShellUser;
  }): Promise<KyAppHandshakeResult> {
    const installation = await this.requireUsableInstallation(
      input.installationId,
      input.user,
    );
    return this.issueUserToken(installation, input.user);
  }

  /** 进程内的安装证明失败计数（§8.5 观测项）。 */
  failureCount(installationId: string): number {
    return this.failureCounts.get(installationId) ?? 0;
  }

  private async issueUserToken(
    installation: KyAppInstallation,
    user: KyAppShellUser,
  ): Promise<KyAppHandshakeResult> {
    const pathPrefixes = await this.resolvePathPrefixes(installation);
    const issued = await this.options.issuer.issue({
      act: 'user',
      tenantId: installation.tenantId,
      installationId: installation.installationId,
      systemId: installation.systemId,
      userId: user.userId,
      tadm: user.isTenantAdmin,
      pathPrefixes,
      authBinding: user.authBinding,
      ...(user.displayName ? { name: user.displayName } : {}),
    });
    return {
      token: issued.token,
      tokenExp: issued.expiresAt,
      user: {
        id: user.userId,
        displayName: user.displayName,
        isTenantAdmin: user.isTenantAdmin,
      },
      installationId: installation.installationId,
      contractVersion: KY_APP_SHELL_CONTRACT_VERSION,
    };
  }

  /** `pfx` 的来源是**已发布版本**的 manifest，不是部署上报的 digest。 */
  private async resolvePathPrefixes(installation: KyAppInstallation): Promise<KyAppPathPrefixes> {
    const definition = await this.options.systems.getDefinition(installation.systemId);
    const digest = installation.registeredDigest ?? definition?.publishedDigest ?? null;
    if (!digest) return { user: [], admin: [] };
    const version = await this.options.systems.getVersion(installation.systemId, digest);
    return version ? readPathPrefixes(version.manifest) : { user: [], admin: [] };
  }

  private async requireUsableInstallation(
    installationId: string,
    user: KyAppShellUser,
  ): Promise<KyAppInstallation> {
    const installation = await this.options.systems.getInstallation(installationId);
    if (!installation || installation.status === 'deleted') {
      throw new KyAppHandshakeError('安装实例不存在', 'installation_not_found');
    }
    if (installation.tenantId !== user.tenantId) {
      throw new KyAppHandshakeError('安装实例不属于当前组织', 'installation_forbidden');
    }
    if (installation.status !== 'enabled') {
      throw new KyAppHandshakeError('安装实例已停用', 'installation_disabled');
    }
    const definition = await this.options.systems.getDefinition(installation.systemId);
    if (definition?.status !== 'published') throw new KyAppHandshakeError('业务系统已停用', 'installation_disabled');
    if (!await this.options.canAccessInstallation(installation, user)) {
      throw new KyAppHandshakeError('当前成员未获业务系统访问授权', 'installation_forbidden');
    }
    return installation;
  }

  private recordSecurityEvent(
    kind: 'attest_failed' | 'nonce_invalid' | 'attestation_mismatch',
    installationId: string,
    userId: string,
    reason: string,
  ): void {
    this.failureCounts.set(installationId, (this.failureCounts.get(installationId) ?? 0) + 1);
    this.options.onSecurityEvent?.({ kind, installationId, userId, reason });
  }

  private pruneCache(): void {
    const nowMs = this.now();
    for (const [nonce, entry] of this.cache) {
      if (entry.expiresAt <= nowMs) this.cache.delete(nonce);
    }
    while (this.cache.size > this.maxCached) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }
}
