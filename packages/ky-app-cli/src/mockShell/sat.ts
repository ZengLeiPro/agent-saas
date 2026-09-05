/**
 * mock 壳按 §3.1 / 附录 B 造三种 act 的 SAT claims。
 *
 * 一致性测试要能任意改写单个 claim（含删除），因此工厂统一接受 overrides：
 * 值为 `undefined` 的键会被**删掉**（造「缺必填 claim」的负向用例）。
 */
import { randomBytes } from 'node:crypto';

/** mock 壳需要知道的被测安装实例身份。 */
export interface AppIdentity {
  /** SAT 的 `iss`（`KY_ENV=test` 固定 `https://test.ky.invalid`）。 */
  issuer: string;
  /** SAT 的 `aud` = manifest `systemId`。 */
  systemId: string;
  tenantId: string;
  installationId: string;
  manifestDigest: string;
  pathPrefixes: { user: string[]; admin: string[] };
}

export type ClaimOverrides = Record<string, unknown>;

/** ≥ 128 bit 的 `jti`（22 字符 base64url）。 */
export function randomJti(): string {
  return randomBytes(16).toString('base64url');
}

/** ≥ 128 bit 的握手 nonce。 */
export function randomNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** overrides 里显式写 `undefined` 表示删除该 claim。 */
function applyOverrides(
  base: Record<string, unknown>,
  overrides: ClaimOverrides,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

export interface ClaimTime {
  /** 秒级 epoch，默认当前时间。 */
  nowSeconds?: number;
  /** 覆盖 TTL（秒）。 */
  ttlSeconds?: number;
}

function times(time: ClaimTime, defaultTtl: number): { iat: number; nbf: number; exp: number } {
  const iat = time.nowSeconds ?? Math.floor(Date.now() / 1000);
  return { iat, nbf: iat, exp: iat + (time.ttlSeconds ?? defaultTtl) };
}

/** `act=user`：TTL 300 s。 */
export function userClaims(
  app: AppIdentity,
  options: { sub?: string; tadm?: boolean; name?: string } & ClaimTime = {},
  overrides: ClaimOverrides = {},
): Record<string, unknown> {
  const tadm = options.tadm ?? false;
  return applyOverrides(
    {
      iss: app.issuer,
      aud: app.systemId,
      tid: app.tenantId,
      iid: app.installationId,
      sub: options.sub ?? 'test-member',
      act: 'user',
      tadm,
      pfx: tadm
        ? [...app.pathPrefixes.user, ...app.pathPrefixes.admin]
        : [...app.pathPrefixes.user],
      ...(options.name === undefined ? {} : { name: options.name }),
      ...times(options, 300),
      jti: randomJti(),
    },
    overrides,
  );
}

export interface AgentClaimOptions extends ClaimTime {
  sub?: string;
  tadm?: boolean;
  cap: string;
  lcid: string;
  rid: string;
  sid?: string;
  /** 确认绑定：`apr` 与 `aph` 必须成对。 */
  apr?: string;
  aph?: string;
}

/** `act=agent`：TTL 60 s，每个 HTTP attempt 新签。 */
export function agentClaims(
  app: AppIdentity,
  options: AgentClaimOptions,
  overrides: ClaimOverrides = {},
): Record<string, unknown> {
  return applyOverrides(
    {
      iss: app.issuer,
      aud: app.systemId,
      tid: app.tenantId,
      iid: app.installationId,
      sub: options.sub ?? 'test-member',
      act: 'agent',
      tadm: options.tadm ?? false,
      cap: options.cap,
      lcid: options.lcid,
      dig: app.manifestDigest,
      sid: options.sid ?? 'sess_doctor',
      rid: options.rid,
      ...(options.apr === undefined ? {} : { apr: options.apr }),
      ...(options.aph === undefined ? {} : { aph: options.aph }),
      ...times(options, 60),
      jti: randomJti(),
    },
    overrides,
  );
}

/** `act=platform`：TTL 60 s，用于 manifest / ready / events。 */
export function platformClaims(
  app: AppIdentity,
  options: { rid: string; dig?: string } & ClaimTime,
  overrides: ClaimOverrides = {},
): Record<string, unknown> {
  return applyOverrides(
    {
      iss: app.issuer,
      aud: app.systemId,
      tid: app.tenantId,
      iid: app.installationId,
      act: 'platform',
      rid: options.rid,
      ...(options.dig === undefined ? {} : { dig: options.dig }),
      ...times(options, 60),
      jti: randomJti(),
    },
    overrides,
  );
}
