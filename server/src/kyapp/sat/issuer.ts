/**
 * WP2a SAT 签发（规范 §3.1、附录 B）。
 *
 * 三种 `act` 的 claims 严格按矩阵组装，签发前用 `@kaiyan/ky-app-contract` 的 `checkSatClaims`
 * 自检（必 / 禁 / 可选、类型、apr+aph 成对），不合矩阵一律不签。
 * header `{alg:'ES256', typ:'ky-sat+jwt', kid}`；`jti` 128 bit base64url；`nbf = iat`。
 * `act=user` 额外做四道前置：用户存在且未禁用、组织成员有效、AuthEpochAuthority 校验通过、
 * 安装实例 enabled；并受停签登记表约束（§3.1 残留风险）。
 */
import { randomBytes } from 'node:crypto';

import { SignJWT } from 'jose';

import { JWT_TYP, checkSatClaims, type SatClaims } from '@kaiyan/ky-app-contract';

import type { KyAppPlatformConfig } from '../config.js';
import type { ActiveSigningKey } from '../keys/service.js';
import type { KyAppInstallation } from '../systems/types.js';
import type { KyAppSuspensionRegistry } from './suspension.js';

/** manifest 声明的路径前缀（规范 §3.3）。 */
export interface KyAppPathPrefixes {
  user: string[];
  admin: string[];
}

export interface IssueUserSatInput {
  act: 'user';
  tenantId: string;
  installationId: string;
  systemId: string;
  userId: string;
  tadm: boolean;
  pathPrefixes: KyAppPathPrefixes;
  /** 会话令牌里的 epoch 绑定，交给 `AuthEpochAuthority.validates()` 复核。 */
  authBinding: { authEpoch?: number; generation?: number } | null | undefined;
  name?: string;
}

export interface IssueAgentSatInput {
  act: 'agent';
  tenantId: string;
  installationId: string;
  systemId: string;
  userId: string;
  tadm: boolean;
  cap: string;
  lcid: string;
  /** 安装实例的登记 digest（`registeredDigest`）。 */
  dig: string;
  sid: string;
  rid: string;
  apr?: string;
  aph?: string;
}

export interface IssuePlatformSatInput {
  act: 'platform';
  tenantId: string;
  installationId: string;
  systemId: string;
  rid: string;
  dig?: string;
  /**
   * 指定签名密钥（仅 `jwks.probe` 用）：探针 SAT 必须由待切换的 `next` 密钥签名，
   * 定制项目回的 `verifiedKid` 才构成 §8.4 的切换证据。缺省用当前 active。
   */
  signWithKid?: string;
}

export type IssueSatInput = IssueUserSatInput | IssueAgentSatInput | IssuePlatformSatInput;

export interface IssuedSat {
  token: string;
  /** 过期时刻（Unix 秒），壳侧据此安排单飞续期。 */
  expiresAt: number;
  kid: string;
  jti: string;
}

/** 拒签：客户面文案由上层渲染，这里的 message 只进日志（规范 §3.5 纪律）。 */
export class KyAppSatDeniedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'KyAppSatDeniedError';
  }
}

/** `act=user` 的四道前置检查所需的协作者；Phase B 由运行时装配真实实现。 */
export interface KyAppUserSatGuard {
  /** 用户不存在返回 null。 */
  getUser(userId: string): Promise<{ disabled: boolean } | null>;
  /** 组织成员不存在返回 null。 */
  getMembership(tenantId: string, userId: string): Promise<{ status: string } | null>;
  getInstallation(installationId: string): Promise<KyAppInstallation | null>;
  /** `AuthEpochAuthority.validates(userId, binding)`。 */
  validatesAuthEpoch(userId: string, binding: IssueUserSatInput['authBinding']): boolean;
}

export interface KyAppSatIssuerOptions {
  config: KyAppPlatformConfig;
  keys: {
    getActiveSigningKey(): Promise<ActiveSigningKey>;
    /** 仅 `jwks.probe` 需要；未提供时 `signWithKid` 会被拒。 */
    getSigningKeyByKid?(kid: string): Promise<ActiveSigningKey>;
  };
  guard: KyAppUserSatGuard;
  suspensions: KyAppSuspensionRegistry;
  /** 毫秒时钟，默认 `Date.now`。 */
  now?: () => number;
}

/** `pfx = pathPrefixes.user ∪（tadm ? pathPrefixes.admin : ∅）`（规范 §3.1）。 */
export function computePathPrefixes(prefixes: KyAppPathPrefixes, tadm: boolean): string[] {
  const merged = tadm ? [...prefixes.user, ...prefixes.admin] : [...prefixes.user];
  return [...new Set(merged)];
}

/** `jti` ≥ 128 bit：16 字节随机数的 base64url（22 字符）。 */
function newJti(): string {
  return randomBytes(16).toString('base64url');
}

export class KyAppSatIssuer {
  private readonly now: () => number;

  constructor(private readonly options: KyAppSatIssuerOptions) {
    this.now = options.now ?? Date.now;
  }

  async issue(input: IssueSatInput): Promise<IssuedSat> {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (input.act === 'user') await this.assertUserIssuable(input);
    const ttl = this.options.config.satTtlSeconds[input.act];
    const claims = this.buildClaims(input, nowSeconds, ttl);

    const matrix = checkSatClaims(claims);
    if (!matrix.ok) {
      throw new KyAppSatDeniedError(
        `SAT claims 不合矩阵：${matrix.errors.join('；')}`,
        'claims_invalid',
      );
    }

    const { kid, privateKey } = await this.resolveSigningKey(input);
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: JWT_TYP.sat, kid })
      .sign(privateKey);
    return { token, expiresAt: claims.exp, kid, jti: claims.jti };
  }

  private async resolveSigningKey(input: IssueSatInput): Promise<ActiveSigningKey> {
    const requested = input.act === 'platform' ? input.signWithKid : undefined;
    if (requested === undefined) return this.options.keys.getActiveSigningKey();
    const byKid = this.options.keys.getSigningKeyByKid;
    if (!byKid) throw new KyAppSatDeniedError('签名密钥服务不支持按 kid 签发', 'kid_unavailable');
    return byKid.call(this.options.keys, requested);
  }

  private buildClaims(input: IssueSatInput, nowSeconds: number, ttl: number): SatClaims {
    const base = {
      iss: this.options.config.issuer,
      aud: input.systemId,
      tid: input.tenantId,
      iid: input.installationId,
      iat: nowSeconds,
      nbf: nowSeconds,
      exp: nowSeconds + ttl,
      jti: newJti(),
    };
    if (input.act === 'user') {
      return {
        ...base,
        act: 'user',
        sub: input.userId,
        tadm: input.tadm,
        pfx: computePathPrefixes(input.pathPrefixes, input.tadm),
        ...(input.name === undefined ? {} : { name: input.name }),
      };
    }
    if (input.act === 'agent') {
      if ((input.apr === undefined) !== (input.aph === undefined)) {
        throw new KyAppSatDeniedError('apr 与 aph 必须成对出现', 'claims_invalid');
      }
      return {
        ...base,
        act: 'agent',
        sub: input.userId,
        tadm: input.tadm,
        cap: input.cap,
        lcid: input.lcid,
        dig: input.dig,
        sid: input.sid,
        rid: input.rid,
        ...(input.apr === undefined ? {} : { apr: input.apr, aph: input.aph! }),
      };
    }
    return {
      ...base,
      act: 'platform',
      rid: input.rid,
      ...(input.dig === undefined ? {} : { dig: input.dig }),
    };
  }

  /** 规范 §3.1：`act=user` 签发前的四道前置 + 停签窗口。 */
  private async assertUserIssuable(input: IssueUserSatInput): Promise<void> {
    if (this.options.suspensions.isSuspended(input.userId, this.now())) {
      throw new KyAppSatDeniedError('该用户处于停签窗口内', 'suspended');
    }
    const user = await this.options.guard.getUser(input.userId);
    if (!user) throw new KyAppSatDeniedError('用户不存在', 'user_not_found');
    if (user.disabled) throw new KyAppSatDeniedError('用户已禁用', 'user_disabled');

    const membership = await this.options.guard.getMembership(input.tenantId, input.userId);
    if (!membership) throw new KyAppSatDeniedError('用户不是该组织成员', 'membership_missing');
    if (membership.status !== 'active') {
      throw new KyAppSatDeniedError('组织成员已停用', 'membership_inactive');
    }
    if (!this.options.guard.validatesAuthEpoch(input.userId, input.authBinding)) {
      throw new KyAppSatDeniedError('会话已失效', 'auth_epoch_invalid');
    }
    const installation = await this.options.guard.getInstallation(input.installationId);
    if (!installation) throw new KyAppSatDeniedError('安装实例不存在', 'installation_not_found');
    if (installation.status !== 'enabled') {
      throw new KyAppSatDeniedError('安装实例未启用', 'installation_disabled');
    }
    if (installation.tenantId !== input.tenantId) {
      throw new KyAppSatDeniedError('安装实例不属于该组织', 'installation_tenant_mismatch');
    }
  }
}
