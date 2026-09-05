/** §3.1 SAT claims 矩阵与 §3.3 端点 × act 授权矩阵。 */
import { matchPathPrefix, normalizePathname } from './path.js';
import { JTI_MIN_LENGTH, RESERVED_PATH_PREFIXES } from './types/constants.js';
import { SAT_ACTS, type ClaimRequirement, type SatAct } from './types/claims.js';
import type { EndpointActor } from './types/claims.js';
import type { ManifestPathPrefixes } from './types/manifest.js';

/** §3.1 claims 矩阵：必 / 禁 / 可选。表中没有列出的 claim 一律放行（不属于契约）。 */
export const SAT_CLAIM_MATRIX: Readonly<
  Record<SatAct, Readonly<Record<string, ClaimRequirement>>>
> = {
  user: {
    iss: 'required',
    aud: 'required',
    tid: 'required',
    iid: 'required',
    sub: 'required',
    tadm: 'required',
    pfx: 'required',
    cap: 'forbidden',
    lcid: 'forbidden',
    dig: 'forbidden',
    apr: 'forbidden',
    aph: 'forbidden',
    sid: 'forbidden',
    rid: 'forbidden',
    name: 'optional',
    iat: 'required',
    nbf: 'required',
    exp: 'required',
    jti: 'required',
  },
  agent: {
    iss: 'required',
    aud: 'required',
    tid: 'required',
    iid: 'required',
    sub: 'required',
    tadm: 'required',
    pfx: 'forbidden',
    cap: 'required',
    lcid: 'required',
    dig: 'required',
    apr: 'optional',
    aph: 'optional',
    sid: 'required',
    rid: 'required',
    name: 'forbidden',
    iat: 'required',
    nbf: 'required',
    exp: 'required',
    jti: 'required',
  },
  platform: {
    iss: 'required',
    aud: 'required',
    tid: 'required',
    iid: 'required',
    sub: 'forbidden',
    tadm: 'forbidden',
    pfx: 'forbidden',
    cap: 'forbidden',
    lcid: 'forbidden',
    dig: 'optional',
    apr: 'forbidden',
    aph: 'forbidden',
    sid: 'forbidden',
    rid: 'required',
    name: 'forbidden',
    iat: 'required',
    nbf: 'required',
    exp: 'required',
    jti: 'required',
  },
};

const HEX_64 = /^[0-9a-f]{64}$/u;

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isEpochSeconds(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPrefixArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'string' && item.startsWith('/') && item.endsWith('/') && item !== '/',
    )
  );
}

const CLAIM_TYPE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  iss: isNonEmptyString,
  aud: isNonEmptyString,
  tid: isNonEmptyString,
  iid: isNonEmptyString,
  sub: isNonEmptyString,
  cap: isNonEmptyString,
  lcid: isNonEmptyString,
  sid: isNonEmptyString,
  rid: isNonEmptyString,
  apr: isNonEmptyString,
  name: isNonEmptyString,
  tadm: (value) => typeof value === 'boolean',
  pfx: isPrefixArray,
  dig: (value) => typeof value === 'string' && HEX_64.test(value),
  aph: (value) => typeof value === 'string' && HEX_64.test(value),
  iat: isEpochSeconds,
  nbf: isEpochSeconds,
  exp: isEpochSeconds,
  jti: (value) => typeof value === 'string' && value.length >= JTI_MIN_LENGTH,
};

export interface SatClaimsCheckResult {
  ok: boolean;
  /** 未知 act 时为 null。 */
  act: SatAct | null;
  errors: string[];
}

/** 按 §3.1 矩阵检查 SAT payload；不做验签、不做时间校验。 */
export function checkSatClaims(payload: unknown): SatClaimsCheckResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, act: null, errors: ['SAT payload 必须是对象'] };
  }
  const claims = payload as Record<string, unknown>;
  const act = claims.act;
  if (typeof act !== 'string' || !(SAT_ACTS as readonly string[]).includes(act)) {
    return { ok: false, act: null, errors: [`未知 act：${JSON.stringify(act)}`] };
  }

  const errors: string[] = [];
  const row = SAT_CLAIM_MATRIX[act as SatAct];
  for (const [claim, requirement] of Object.entries(row)) {
    const present = claims[claim] !== undefined;
    if (requirement === 'forbidden' && present) {
      errors.push(`act=${act} 禁止携带 claim ${claim}`);
      continue;
    }
    if (requirement === 'required' && !present) {
      errors.push(`act=${act} 缺少必填 claim ${claim}`);
      continue;
    }
    if (present) {
      const check = CLAIM_TYPE_CHECKS[claim];
      if (check && !check(claims[claim])) errors.push(`claim ${claim} 取值不合法`);
    }
  }

  // apr / aph 必须成对（§3.1、§4.3）。
  const hasApr = claims.apr !== undefined;
  const hasAph = claims.aph !== undefined;
  if (hasApr !== hasAph) errors.push('apr 与 aph 必须成对出现');

  return { ok: errors.length === 0, act: act as SatAct, errors };
}

export interface EndpointAuthorizationOptions {
  /** manifest 声明的路径前缀。 */
  pathPrefixes: ManifestPathPrefixes;
  /** `act=user` 访问 admin 前缀时必须为 true。 */
  tadm?: boolean;
  /** 兜底模式是否开启：关闭时 `/ky-local/*`（除 enable）一律 404。 */
  localMode?: boolean;
  /** `KY_ENV=test` 时开放 `/ky/v1/test/*`。 */
  testEndpoints?: boolean;
}

const CAPABILITY_INVOKE = /^\/ky\/v1\/capabilities\/[^/]+$/u;
const CAPABILITY_EXECUTION = /^\/ky\/v1\/capabilities\/[^/]+\/executions\/[^/]+$/u;

/**
 * §3.3 端点 × act 授权矩阵。不在表内一律 false（由调用方回 403）。
 * pathname 非法（`%2f`/`%2e`、`..` 段、反斜杠等）同样 false。
 */
export function isEndpointAllowed(
  act: EndpointActor,
  method: string,
  pathname: string,
  options: EndpointAuthorizationOptions,
): boolean {
  let path: string;
  try {
    path = normalizePathname(pathname);
  } catch {
    return false;
  }
  const verb = method.toUpperCase();

  // 公开行：任何主体（含未携带令牌的 public）都可访问。
  if (verb === 'GET' && path === '/ky/v1/health/live') return true;
  if (verb === 'GET' && path === '/ky/v1/attest') return true;
  if (verb === 'POST' && path === '/ky-local/enable') return true;
  if (path.startsWith('/ky-local/')) return options.localMode === true;
  if (path.startsWith('/ky/v1/test/')) return options.testEndpoints === true;

  switch (act) {
    case 'platform':
      if (verb === 'GET' && path === '/ky/v1/health/ready') return true;
      if (verb === 'GET' && path === '/ky/v1/manifest') return true;
      if (verb === 'POST' && path === '/ky/v1/events') return true;
      return false;
    case 'agent':
      if (verb === 'POST' && CAPABILITY_INVOKE.test(path)) return true;
      if (verb === 'GET' && CAPABILITY_EXECUTION.test(path)) return true;
      return false;
    case 'user':
      if (verb === 'GET' && path === '/ky/v1/me') return true;
      return matchesBusinessPrefix(path, options, { admin: options.tadm === true });
    case 'local_admin':
      if (verb === 'GET' && path === '/ky/v1/me') return true;
      return matchesBusinessPrefix(path, options, { admin: true });
    case 'local_user':
      if (verb === 'GET' && path === '/ky/v1/me') return true;
      return matchesBusinessPrefix(path, options, { admin: false });
    default:
      return false;
  }
}

function matchesBusinessPrefix(
  path: string,
  options: EndpointAuthorizationOptions,
  scope: { admin: boolean },
): boolean {
  // 纵深防御：保留前缀永远不走 pathPrefixes 匹配，即使 manifest 违规声明了它们。
  for (const reserved of RESERVED_PATH_PREFIXES) {
    if (path.startsWith(reserved)) return false;
  }
  if (matchPathPrefix(path, options.pathPrefixes.user)) return true;
  if (scope.admin && matchPathPrefix(path, options.pathPrefixes.admin)) return true;
  return false;
}
