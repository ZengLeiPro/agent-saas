/**
 * §3.2 Local Token（兜底模式下的本地令牌）。
 *
 * header `{alg:"HS256", typ:"ky-local+jwt", kid}`；claims `iss="local:<iid>"`、`aud=systemId`、
 * `tid`、`iid`、`sub`、`act ∈ local_admin|local_user`、`pfx`、`iat`、`exp ≤ 4 小时`、`jti`；多次使用。
 * **兜底模式关闭、或安装实例 `disabled`/`deleted` 时一律拒绝**（撤销粒度 = 模式级）。
 */
import { randomBytes } from 'node:crypto';

import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';

import {
  JTI_MIN_LENGTH,
  JWT_TYP,
  LOCAL_ACTS,
  LOCAL_TOKEN_MAX_TTL_SECONDS,
  isEndpointAllowed,
  normalizePathname,
  type InstallationState,
  type LocalAct,
  type LocalTokenClaims,
  type ManifestPathPrefixes,
} from '@kaiyan/ky-app-contract';

import type { KyAppConfig } from '../config/index.js';
import { KyAppError, forbidden, unauthorized } from '../errors.js';
import { selectVerificationKeys, type LocalKeyRing } from './keys.js';

/** 兜底态身份，与 SAT 的 `VerifiedIdentity` 平行。 */
export interface VerifiedLocalIdentity {
  act: LocalAct;
  sub: string;
  pfx: string[];
  /** `local_admin` 视同组织管理员（§3.2）。 */
  tadm: boolean;
  jti: string;
  claims: LocalTokenClaims;
}

export interface IssueLocalTokenInput {
  config: KyAppConfig;
  keys: LocalKeyRing;
  sub: string;
  act: LocalAct;
  /** manifest 声明的路径前缀，用于推导 `pfx`。 */
  pathPrefixes: ManifestPathPrefixes;
  /** 有效期（秒），上限 4 小时。 */
  ttlSeconds?: number;
  nowMs?: number;
}

/** `local_user` = `pathPrefixes.user`；`local_admin` = user ∪ admin（§3.2）。 */
export function localTokenPrefixes(act: LocalAct, pathPrefixes: ManifestPathPrefixes): string[] {
  return act === 'local_admin'
    ? [...pathPrefixes.user, ...pathPrefixes.admin]
    : [...pathPrefixes.user];
}

/** 签发 Local Token。 */
export async function issueLocalToken(input: IssueLocalTokenInput): Promise<string> {
  const ttl = Math.min(
    input.ttlSeconds ?? LOCAL_TOKEN_MAX_TTL_SECONDS,
    LOCAL_TOKEN_MAX_TTL_SECONDS,
  );
  if (ttl <= 0) throw new Error('Local Token 有效期必须为正');
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const claims: LocalTokenClaims = {
    iss: `local:${input.config.installationId}`,
    aud: input.config.systemId,
    tid: input.config.tenantId,
    iid: input.config.installationId,
    sub: input.sub,
    act: input.act,
    pfx: localTokenPrefixes(input.act, input.pathPrefixes),
    iat: nowSeconds,
    exp: nowSeconds + ttl,
    jti: randomBytes(16).toString('base64url'),
  };
  return new SignJWT({ ...claims })
    .setProtectedHeader({
      alg: 'HS256',
      typ: JWT_TYP.localToken,
      kid: input.keys.current.keyVersion,
    })
    .sign(input.keys.current.localToken);
}

export interface VerifyLocalTokenOptions {
  config: KyAppConfig;
  keys: LocalKeyRing;
  /** 兜底模式是否开启；关闭时一律拒绝（模式级撤销）。 */
  localMode: boolean;
  installationState: InstallationState;
  request: { method: string; pathname: string };
  pathPrefixes: ManifestPathPrefixes;
  testEndpoints?: boolean;
  now?: () => number;
}

function checkClaimShape(claims: LocalTokenClaims, config: KyAppConfig): void {
  if (claims.iss !== `local:${config.installationId}`) throw unauthorized('Local Token iss 不符');
  if (claims.aud !== config.systemId) throw unauthorized('Local Token aud 必须是 systemId');
  if (claims.tid !== config.tenantId) throw unauthorized('Local Token tid 不符');
  if (claims.iid !== config.installationId) throw unauthorized('Local Token iid 不符');
  if (typeof claims.sub !== 'string' || claims.sub === '')
    throw unauthorized('Local Token 缺少 sub');
  if (!(LOCAL_ACTS as readonly string[]).includes(claims.act)) {
    throw unauthorized(`Local Token act 非法：${String(claims.act)}`);
  }
  if (!Array.isArray(claims.pfx) || claims.pfx.some((item) => typeof item !== 'string')) {
    throw unauthorized('Local Token pfx 必须是字符串数组');
  }
  if (typeof claims.jti !== 'string' || claims.jti.length < JTI_MIN_LENGTH) {
    throw unauthorized('Local Token jti 长度不足 128 bit');
  }
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
    throw unauthorized('Local Token 时间戳非法');
  }
  if (claims.exp - claims.iat > LOCAL_TOKEN_MAX_TTL_SECONDS) {
    throw unauthorized('Local Token 有效期超过 4 小时');
  }
}

/** 校验 Local Token 并返回兜底态身份。 */
export async function verifyLocalToken(
  token: string,
  options: VerifyLocalTokenOptions,
): Promise<VerifiedLocalIdentity> {
  const now = options.now ?? Date.now;
  const nowMs = now();

  // 模式级撤销与安装实例状态先于验签：关闭 / 停用后旧令牌一律无效（§3.2）。
  if (options.installationState !== 'enabled') {
    throw new KyAppError('installation_disabled', {
      message: `安装实例处于 ${options.installationState}，Local Token 一律拒绝`,
    });
  }
  if (!options.localMode) throw unauthorized('兜底模式未开启，Local Token 一律拒绝');

  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw unauthorized('Local Token 不是合法 JWT');
  }
  if (header.alg !== 'HS256') throw unauthorized('Local Token alg 必须是 HS256');
  if (header.typ !== JWT_TYP.localToken)
    throw unauthorized(`Local Token typ 必须是 ${JWT_TYP.localToken}`);
  if (typeof header.kid !== 'string') throw unauthorized('Local Token 缺少 kid');

  const keys = selectVerificationKeys(options.keys, header.kid, nowMs);
  if (keys === null) throw unauthorized(`Local Token kid 未知或已超轮换窗口：${header.kid}`);

  let claims: LocalTokenClaims;
  try {
    const verified = await jwtVerify(token, keys.localToken, {
      algorithms: ['HS256'],
      typ: JWT_TYP.localToken,
      currentDate: new Date(nowMs),
      clockTolerance: 0,
    });
    claims = verified.payload as unknown as LocalTokenClaims;
  } catch (error) {
    throw unauthorized(
      `Local Token 验签失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  checkClaimShape(claims, options.config);

  let pathname: string;
  try {
    pathname = normalizePathname(options.request.pathname);
  } catch {
    throw forbidden('请求路径非法');
  }
  const allowed = isEndpointAllowed(claims.act, options.request.method, pathname, {
    pathPrefixes: options.pathPrefixes,
    localMode: true,
    testEndpoints: options.testEndpoints === true,
  });
  if (!allowed)
    throw forbidden(`act=${claims.act} 不允许访问 ${options.request.method} ${pathname}`);

  return {
    act: claims.act,
    sub: claims.sub,
    pfx: claims.pfx,
    tadm: claims.act === 'local_admin',
    jti: claims.jti,
    claims,
  };
}
