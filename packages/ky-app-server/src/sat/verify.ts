/**
 * §3.1 SAT 验签。
 *
 * 顺序：签名 / header → claims 矩阵 → `iss/aud/tid/iid` → 时间窗 → 端点 × act 矩阵
 * → `act=agent` 的 `cap`/`lcid`/`rid` 绑定 → `dig` 比对 → `jti` 单次消费。
 * 未认证 → 401；已认证但端点 / `cap` / `lcid` / `pfx` / `rid` 不符 → 403（§3.1-8）。
 */
import { decodeProtectedHeader, jwtVerify } from 'jose';

import {
  JWT_TYP,
  SAT_CLOCK_TOLERANCE_SECONDS,
  checkSatClaims,
  isEndpointAllowed,
  normalizePathname,
  timingSafeEqualHex,
  type ManifestPathPrefixes,
  type SatAct,
  type SatClaims,
} from '@kaiyan/ky-app-contract';

import type { KyAppConfig } from '../config/index.js';
import { KyAppError, forbidden, unauthorized } from '../errors.js';
import type { JwksClient } from '../jwks/client.js';
import type { JtiStore } from './jtiStore.js';

/** 验签通过后的结构化身份。业务侧 `ctx` 只允许由它构造（§9.2）。 */
export interface VerifiedIdentity {
  act: SatAct;
  /** `platform` 无 `sub`。 */
  sub?: string;
  /** `platform` 恒为 false。 */
  tadm: boolean;
  /** `user` 的路径前缀；`agent`/`platform` 为空数组。 */
  pfx: string[];
  cap?: string;
  lcid?: string;
  dig?: string;
  apr?: string;
  aph?: string;
  rid?: string;
  sid?: string;
  name?: string;
  jti: string;
  claims: SatClaims;
  /** SAT 验签用到的 JWKS `kid`。 */
  kid: string;
  /**
   * 消费 `jti`（§3.1-6：占用在鉴权与输入校验之后、执行之前）。
   * `act=user` 是空操作；重复消费抛 401 `token_replayed`。幂等：同一身份多次调用只占一次。
   */
  consumeJti(): Promise<void>;
}

export interface VerifySatRequest {
  method: string;
  pathname: string;
  /** `X-KY-Request-Id`，`agent`/`platform` 必须等于 claim `rid`。 */
  requestId?: string;
}

export interface VerifySatOptions {
  config: KyAppConfig;
  jwks: JwksClient;
  jtiStore: JtiStore;
  request: VerifySatRequest;
  /** manifest 声明的路径前缀（§3.3）。 */
  pathPrefixes: ManifestPathPrefixes;
  /** 当前 manifest digest，只在 `/ky/v1/capabilities/*` 比对（§3.1 claims 表）。 */
  manifestDigest: string;
  localMode?: boolean;
  testEndpoints?: boolean;
  /** 默认 true：验签末尾立即消费 `jti`。能力端点传 false，改在输入校验后调用 `consumeJti()`。 */
  consumeJti?: boolean;
  /** 毫秒时钟，默认 `Date.now`。 */
  now?: () => number;
}

const CAPABILITY_PATH = /^\/ky\/v1\/capabilities\/([^/]+)(?:\/executions\/([^/]+))?$/u;

/** `Authorization: Bearer <token>` 取值；缺失或格式不对返回 null。 */
export function readBearerToken(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer[ ]([A-Za-z0-9._-]+)$/u.exec(headerValue.trim());
  return match === null ? match : match[1];
}

/**
 * 时间窗按 §3.1 TTL 表逐 act 严格复核。
 *
 * jose 只有单一 `clockTolerance`，无法表达「`user` 的 nbf 容忍 30 s 而 exp 容忍 0」。
 * 做法：给 jose 传本表里最大的容忍值（30 s）让它先粗筛，随后在这里按 act 严格复核，
 * 两道都通过才算合法。这样既保留 jose 的格式校验，又不会放宽任何一格。
 */
function checkTimeWindow(act: SatAct, claims: SatClaims, nowSeconds: number): void {
  const tolerance = SAT_CLOCK_TOLERANCE_SECONDS[act];
  if (claims.nbf - tolerance.nbf > nowSeconds) {
    throw unauthorized(`SAT 尚未生效（act=${act}，nbf 容忍 ${tolerance.nbf}s）`);
  }
  if (claims.exp + tolerance.exp <= nowSeconds) {
    throw unauthorized(`SAT 已过期（act=${act}，exp 容忍 ${tolerance.exp}s）`);
  }
  if (claims.iat - tolerance.nbf > nowSeconds) {
    throw unauthorized('SAT 的 iat 在未来');
  }
}

function checkDeployment(config: KyAppConfig, claims: SatClaims): void {
  if (claims.iss !== config.issuer) throw unauthorized('SAT iss 与部署配置不符');
  if (claims.aud !== config.systemId) throw unauthorized('SAT aud 与部署配置不符');
  if (claims.tid !== config.tenantId) throw unauthorized('SAT tid 与部署配置不符');
  if (claims.iid !== config.installationId) throw unauthorized('SAT iid 与部署配置不符');
}

/** §3.1-7 `act=agent` 的路径绑定；`platform` 只校验 `rid`。 */
function checkBinding(claims: SatClaims, options: VerifySatOptions, pathname: string): void {
  const requestId = options.request.requestId;
  if (claims.act === 'agent' || claims.act === 'platform') {
    if (typeof requestId !== 'string' || requestId !== claims.rid) {
      throw forbidden('X-KY-Request-Id 与 SAT rid 不符');
    }
  }
  if (claims.act !== 'agent') return;

  const match = CAPABILITY_PATH.exec(pathname);
  if (match === null) throw forbidden('act=agent 只能访问能力端点');
  const [, rawCap, rawLcid] = match;
  let cap: string;
  let lcid: string | undefined;
  try {
    cap = decodeURIComponent(rawCap);
    lcid = rawLcid === undefined ? undefined : decodeURIComponent(rawLcid);
  } catch {
    throw forbidden('能力端点路径的百分号编码非法');
  }
  if (cap !== claims.cap) throw forbidden('路径中的 capabilityId 与 SAT cap 不符');
  if (lcid !== undefined && lcid !== claims.lcid) {
    throw forbidden('路径中的 lcid 与 SAT lcid 不符');
  }
}

/** `dig` 只在 `/ky/v1/capabilities/*` 比对，不等 → 409 `digest_mismatch`（§3.1 claims 表）。 */
function checkDigest(claims: SatClaims, options: VerifySatOptions, pathname: string): void {
  if (claims.act !== 'agent') return;
  if (!pathname.startsWith('/ky/v1/capabilities/')) return;
  if (!timingSafeEqualHex(claims.dig, options.manifestDigest)) {
    throw new KyAppError('digest_mismatch', { message: 'SAT dig 与当前 manifest digest 不符' });
  }
}

function toIdentity(
  claims: SatClaims,
  kid: string,
  consume: () => Promise<void>,
): VerifiedIdentity {
  const base: VerifiedIdentity = {
    act: claims.act,
    tadm: claims.act === 'platform' ? false : claims.tadm,
    pfx: claims.act === 'user' ? claims.pfx : [],
    jti: claims.jti,
    claims,
    kid,
    consumeJti: consume,
  };

  if (claims.act === 'user') {
    return {
      ...base,
      sub: claims.sub,
      ...(claims.name === undefined ? {} : { name: claims.name }),
    };
  }
  if (claims.act === 'agent') {
    return {
      ...base,
      sub: claims.sub,
      cap: claims.cap,
      lcid: claims.lcid,
      dig: claims.dig,
      sid: claims.sid,
      rid: claims.rid,
      ...(claims.apr === undefined ? {} : { apr: claims.apr, aph: claims.aph }),
    };
  }
  return { ...base, rid: claims.rid, ...(claims.dig === undefined ? {} : { dig: claims.dig }) };
}

/** 验签并返回结构化身份；任何失败都抛 `KyAppError`（401 / 403 / 409）。 */
export async function verifySat(
  token: string,
  options: VerifySatOptions,
): Promise<VerifiedIdentity> {
  const now = options.now ?? Date.now;
  const nowMs = now();

  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw unauthorized('SAT 不是合法的 JWS Compact 序列化');
  }
  if (header.alg !== 'ES256')
    throw unauthorized(`SAT header alg 必须是 ES256，收到 ${String(header.alg)}`);
  if (header.typ !== JWT_TYP.sat) throw unauthorized(`SAT header typ 必须是 ${JWT_TYP.sat}`);
  if (typeof header.kid !== 'string' || header.kid === '')
    throw unauthorized('SAT header 缺少 kid');
  const kid = header.kid;

  const key = await options.jwks.getKey(kid);
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: ['ES256'],
      typ: JWT_TYP.sat,
      // 先用表中最大容忍（user 的 nbf 30 s）粗筛，随后 checkTimeWindow 按 act 严格复核。
      clockTolerance: SAT_CLOCK_TOLERANCE_SECONDS.user.nbf,
      currentDate: new Date(nowMs),
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    throw unauthorized(`SAT 验签失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const matrix = checkSatClaims(payload);
  if (!matrix.ok || matrix.act === null) {
    throw unauthorized(`SAT claims 不合矩阵：${matrix.errors.join('；')}`);
  }
  const claims = payload as unknown as SatClaims;
  checkDeployment(options.config, claims);
  checkTimeWindow(matrix.act, claims, Math.floor(nowMs / 1000));

  let pathname: string;
  try {
    pathname = normalizePathname(options.request.pathname);
  } catch {
    throw forbidden('请求路径非法');
  }
  const allowed = isEndpointAllowed(matrix.act, options.request.method, pathname, {
    pathPrefixes: options.pathPrefixes,
    tadm: claims.act === 'platform' ? false : claims.tadm,
    localMode: options.localMode === true,
    testEndpoints: options.testEndpoints === true,
  });
  if (!allowed)
    throw forbidden(`act=${matrix.act} 不允许访问 ${options.request.method} ${pathname}`);

  checkBinding(claims, options, pathname);
  checkDigest(claims, options, pathname);

  let consumed = false;
  const consume = async (): Promise<void> => {
    if (claims.act === 'user' || consumed) return;
    consumed = true;
    const expiresAt = new Date((claims.exp + SAT_CLOCK_TOLERANCE_SECONDS[claims.act].exp) * 1000);
    const ok = await options.jtiStore.consume(claims.jti, expiresAt);
    if (!ok) throw new KyAppError('token_replayed', { message: 'SAT jti 已被消费' });
  };

  const identity = toIdentity(claims, kid, consume);
  if (options.consumeJti !== false) await consume();
  return identity;
}
