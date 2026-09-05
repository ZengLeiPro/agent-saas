/** 测试公用夹具：本地 ES256 SAT 签发器、可控 JWKS 服务、部署配置与 manifest。 */
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';

import { EXAMPLE_MANIFEST, manifestDigest, type Manifest } from '@kaiyan/ky-app-contract';

import { decodeInstallationKey, type KyAppConfig } from '../config/index.js';

export const TEST_MANIFEST = EXAMPLE_MANIFEST as unknown as Manifest;
export const TEST_MANIFEST_DIGEST = manifestDigest(EXAMPLE_MANIFEST);

/** 32 字节安装密钥（固定值，仅测试用）。 */
export const TEST_INSTALLATION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function createTestConfig(overrides: Partial<KyAppConfig> = {}): KyAppConfig {
  return {
    env: 'test',
    systemId: 'demo-erp',
    tenantId: 't_demo',
    installationId: 'tsi_01',
    origin: 'https://t-demo.apps.kaiyancn.com',
    serviceCredential: 'svc_test_credential',
    issuer: 'https://test.ky.invalid',
    jwksUrl: 'https://test.ky.invalid/.well-known/ky-app-jwks.json',
    installationKey: decodeInstallationKey(TEST_INSTALLATION_KEY, 'TEST'),
    installationKeyVersion: 'v1',
    localLoginEnabled: true,
    ...overrides,
  };
}

export interface SatSigner {
  kid: string;
  jwk: JWK;
  privateKey: CryptoKey;
  /** 用给定 claims 与 header 覆盖项签一枚 SAT。 */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

/** 生成一对 ES256 密钥，模拟 KY Agent 的 SAT 签发端。 */
export async function createSatSigner(kid = 'k-test-1'): Promise<SatSigner> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    kid,
    jwk: { ...jwk, kid, use: 'sig', alg: 'ES256' },
    privateKey: privateKey as CryptoKey,
    async sign(claims, header = {}) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', typ: 'ky-sat+jwt', kid, ...header })
        .sign(privateKey);
    },
  };
}

/** 基准时间：2026-09-05T00:00:00Z。 */
export const BASE_NOW_MS = Date.parse('2026-09-05T00:00:00.000Z');
export const BASE_NOW_SECONDS = Math.floor(BASE_NOW_MS / 1000);

export interface SatClaimOverrides {
  [claim: string]: unknown;
}

/** 造一份合法的 `act=user` claims。 */
export function userClaims(
  config: KyAppConfig,
  overrides: SatClaimOverrides = {},
  nowSeconds = BASE_NOW_SECONDS,
): Record<string, unknown> {
  return {
    iss: config.issuer,
    aud: config.systemId,
    tid: config.tenantId,
    iid: config.installationId,
    sub: 'u_8f3a',
    act: 'user',
    tadm: true,
    pfx: ['/api/app/', '/api/admin/'],
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 300,
    jti: randomJti(),
    ...overrides,
  };
}

/** 造一份合法的 `act=agent` claims。 */
export function agentClaims(
  config: KyAppConfig,
  overrides: SatClaimOverrides = {},
  nowSeconds = BASE_NOW_SECONDS,
): Record<string, unknown> {
  return {
    iss: config.issuer,
    aud: config.systemId,
    tid: config.tenantId,
    iid: config.installationId,
    sub: 'u_8f3a',
    act: 'agent',
    tadm: false,
    cap: 'order.search',
    lcid: 'lc_9c2',
    dig: TEST_MANIFEST_DIGEST,
    sid: 'sess_77',
    rid: 'req_x',
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 60,
    jti: randomJti(),
    ...overrides,
  };
}

/** 造一份合法的 `act=platform` claims。 */
export function platformClaims(
  config: KyAppConfig,
  overrides: SatClaimOverrides = {},
  nowSeconds = BASE_NOW_SECONDS,
): Record<string, unknown> {
  return {
    iss: config.issuer,
    aud: config.systemId,
    tid: config.tenantId,
    iid: config.installationId,
    act: 'platform',
    rid: 'req_p',
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 60,
    jti: randomJti(),
    ...overrides,
  };
}

let jtiCounter = 0;
/** ≥ 128 bit 的 jti（22 字符 base64url）。 */
export function randomJti(): string {
  jtiCounter += 1;
  return `jti${String(jtiCounter).padStart(19, '0')}`;
}

export interface FakeJwksServer {
  /** 交给 createJwksClient 的 fetch。 */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** 已发生的请求次数。 */
  calls: number;
  /** 当前对外提供的 JWK 列表。 */
  keys: JWK[];
  /** 设为非 null 时，下一次（及之后）请求都抛这个错误。 */
  failure: Error | null;
  /** 设为非 null 时，用这段原始文本作为响应体。 */
  rawBody: string | null;
  /** 模拟 302 重定向。 */
  redirect: boolean;
  /** 每次请求前的延迟（毫秒），用于并发单飞测试。 */
  delayMs: number;
}

/** 可编程的 JWKS 服务替身。 */
export function createFakeJwksServer(keys: JWK[]): FakeJwksServer {
  const server: FakeJwksServer = {
    calls: 0,
    keys: [...keys],
    failure: null,
    rawBody: null,
    redirect: false,
    delayMs: 0,
    fetch: async () => {
      server.calls += 1;
      if (server.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, server.delayMs));
      }
      if (server.failure !== null) throw server.failure;
      if (server.redirect) {
        return new Response(null, { status: 302, headers: { location: 'https://elsewhere' } });
      }
      const body = server.rawBody ?? JSON.stringify({ keys: server.keys });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return server;
}

/** 可推进的假时钟。 */
export function createClock(startMs = BASE_NOW_MS): {
  now: () => number;
  advance(ms: number): void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}
