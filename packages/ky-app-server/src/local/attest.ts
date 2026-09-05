/**
 * §3.2 / §5.4 安装证明（attest JWT）。
 *
 * header `{alg:"HS256", typ:"ky-attest+jwt", kid:"<keyVersion>"}`；
 * claims `iss="local:<iid>"`、`aud`=环境 `iss`、`iid`、`origin`、`nonce`、`dig`、`iat`、`exp=iat+60`、`jti`。
 * 同一 `nonce` 60 s 内重复请求返回同一 JWT（§4.6）。
 */
import { randomBytes } from 'node:crypto';

import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';

import { ATTEST_TTL_SECONDS, JWT_TYP, type AttestClaims } from '@kaiyan/ky-app-contract';

import type { KyAppConfig } from '../config/index.js';
import { KyAppError } from '../errors.js';
import type { InstallationKeys, LocalKeyRing } from './keys.js';
import { selectVerificationKeys } from './keys.js';

/** nonce 至少 128 bit（§5.4），按 base64url 折算 ≥ 22 字符。 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;

export interface IssueAttestationInput {
  nonce: string;
  /** 当前 manifest digest，仅记录。 */
  dig: string;
  /** = `KY_ORIGIN`。 */
  origin: string;
  iid: string;
  /** 环境 `iss`，作为 attest 的 `aud`（§3.2）。 */
  audience: string;
  keys: InstallationKeys;
  /** 毫秒时钟。 */
  nowMs?: number;
}

/** 生成单个安装证明 JWT（无缓存）。 */
export async function issueAttestation(input: IssueAttestationInput): Promise<string> {
  if (!NONCE_PATTERN.test(input.nonce)) {
    throw new KyAppError('invalid_input', { message: 'nonce 必须是 ≥ 128 bit 的 base64url 串' });
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const claims: AttestClaims = {
    iss: `local:${input.iid}`,
    aud: input.audience,
    iid: input.iid,
    origin: input.origin,
    nonce: input.nonce,
    dig: input.dig,
    iat: nowSeconds,
    exp: nowSeconds + ATTEST_TTL_SECONDS,
    jti: randomBytes(16).toString('base64url'),
  };
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: JWT_TYP.attest, kid: input.keys.keyVersion })
    .sign(input.keys.attest);
}

export interface AttestationIssuerOptions {
  config: KyAppConfig;
  keys: LocalKeyRing;
  /** 当前 manifest digest。 */
  manifestDigest: () => string;
  now?: () => number;
}

export interface AttestationIssuer {
  /** 同一 nonce 在 60 s 内返回同一 JWT（幂等，§4.6）。 */
  issue(nonce: string): Promise<string>;
}

/** 带 nonce 幂等缓存的签发器。 */
export function createAttestationIssuer(options: AttestationIssuerOptions): AttestationIssuer {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAt: number }>();

  return {
    async issue(nonce: string): Promise<string> {
      const current = now();
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= current) cache.delete(key);
      }
      const hit = cache.get(nonce);
      if (hit !== undefined) return hit.token;

      const token = await issueAttestation({
        nonce,
        dig: options.manifestDigest(),
        origin: options.config.origin,
        iid: options.config.installationId,
        audience: options.config.issuer,
        keys: options.keys.current,
        nowMs: current,
      });
      cache.set(nonce, { token, expiresAt: current + ATTEST_TTL_SECONDS * 1000 });
      return token;
    },
  };
}

export interface VerifyAttestationOptions {
  config: KyAppConfig;
  keys: LocalKeyRing;
  /** 期望的 nonce；壳侧校验时必传。 */
  nonce?: string;
  now?: () => number;
}

/**
 * 校验安装证明。定制项目自身不需要，供 `ky-app doctor` 的 mock 壳与平台侧参考实现使用：
 * 按 `kid` 取该安装实例 current / previous 派生密钥，`iid`/`origin` 与登记一致，
 * `dig` 只记录、不作为拒绝条件（§5.4-3）。
 */
export async function verifyAttestation(
  token: string,
  options: VerifyAttestationOptions,
): Promise<AttestClaims> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new KyAppError('unauthorized', { message: '安装证明不是合法 JWT' });
  }
  if (typeof kid !== 'string')
    throw new KyAppError('unauthorized', { message: '安装证明缺少 kid' });
  const keys = selectVerificationKeys(options.keys, kid, nowMs);
  if (keys === null) throw new KyAppError('unauthorized', { message: `安装证明 kid 未知：${kid}` });

  let payload: AttestClaims;
  try {
    const verified = await jwtVerify(token, keys.attest, {
      algorithms: ['HS256'],
      typ: JWT_TYP.attest,
      currentDate: new Date(nowMs),
      clockTolerance: 0,
    });
    payload = verified.payload as unknown as AttestClaims;
  } catch (error) {
    throw new KyAppError('unauthorized', {
      message: `安装证明验签失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (payload.iss !== `local:${options.config.installationId}`) {
    throw new KyAppError('unauthorized', { message: '安装证明 iss 与安装实例不符' });
  }
  if (payload.aud !== options.config.issuer) {
    throw new KyAppError('unauthorized', { message: '安装证明 aud 与环境 iss 不符' });
  }
  if (payload.iid !== options.config.installationId) {
    throw new KyAppError('unauthorized', { message: '安装证明 iid 与安装实例不符' });
  }
  if (payload.origin !== options.config.origin) {
    throw new KyAppError('unauthorized', { message: '安装证明 origin 与登记不符' });
  }
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new KyAppError('unauthorized', { message: '安装证明 nonce 与请求不符' });
  }
  return payload;
}
