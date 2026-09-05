/**
 * Hono 适配器的共享运行时：验签、安装实例状态、兜底模式、目录门禁、限速与日志。
 * 路由与业务侧中间件（`requireUser()`）共用同一个实例，避免两处各写一遍判定。
 */
import { decodeProtectedHeader } from 'jose';

import {
  HTTP_HEADERS,
  JWT_TYP,
  manifestDigest as computeManifestDigest,
  type InstallationState,
} from '@kaiyan/ky-app-contract';

import { KyAppError, unauthorized } from '../errors.js';
import { createJwksClient, type JwksClient } from '../jwks/client.js';
import { verifyLocalToken } from '../local/token.js';
import { readBearerToken, verifySat } from '../sat/verify.js';
import type { DirectoryStalenessGate } from '../directory/staleness.js';
import type { KyAppRouterConfig, KyRequestIdentity } from './types.js';

/** `disabled` 状态下仍然可达的端点前缀（§3.7）。 */
const ALWAYS_REACHABLE = ['/ky/v1/events', '/ky/v1/health/'];

export interface AuthenticateInput {
  method: string;
  pathname: string;
  authorization: string | null;
  requestId: string;
  /** 能力端点传 false：`jti` 占用推迟到输入校验之后（§3.1-6）。 */
  consumeJti?: boolean;
}

export interface KyAppRuntime {
  readonly options: KyAppRouterConfig;
  readonly jwks: JwksClient;
  readonly manifestDigest: string;
  now(): number;
  /** 测试环境的时钟偏移（`/ky/v1/test/clock`）。 */
  setClockOffset(offsetMs: number): void;
  clockOffset(): number;
  testEndpointsEnabled(): boolean;
  installationState(): Promise<InstallationState>;
  localModeActive(): Promise<boolean>;
  assertInstallationUsable(pathname: string): Promise<void>;
  stalenessGate(): Promise<DirectoryStalenessGate | null>;
  clientIp(headers: Headers): string | undefined;
  requestId(headers: Headers): string;
  authenticate(input: AuthenticateInput): Promise<KyRequestIdentity>;
}

function defaultClientIp(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded !== '') return forwarded.split(',')[0].trim();
  const real = headers.get('x-real-ip');
  return real === null || real === '' ? undefined : real;
}

let requestIdCounter = 0;

export function createKyAppRuntime(options: KyAppRouterConfig): KyAppRuntime {
  const baseNow = options.now ?? Date.now;
  let clockOffsetMs = 0;
  const jwks =
    options.jwks ??
    createJwksClient({ url: options.config.jwksUrl, now: () => baseNow() + clockOffsetMs });
  const manifestDigest = options.manifestDigest ?? computeManifestDigest(options.manifest);

  const runtime: KyAppRuntime = {
    options,
    jwks,
    manifestDigest,
    now: () => baseNow() + clockOffsetMs,
    setClockOffset(offsetMs: number) {
      clockOffsetMs = offsetMs;
    },
    clockOffset: () => clockOffsetMs,
    testEndpointsEnabled: () => options.config.env === 'test',

    async installationState(): Promise<InstallationState> {
      return (await options.events.state()).state;
    },

    async localModeActive(): Promise<boolean> {
      if (options.breakGlass === undefined) return false;
      return options.breakGlass.isActive();
    },

    /** §3.7：`disabled` 时除 `events` / `health` 外一律 403 `installation_disabled`。 */
    async assertInstallationUsable(pathname: string): Promise<void> {
      const state = await runtime.installationState();
      if (state === 'enabled') return;
      if (ALWAYS_REACHABLE.some((prefix) => pathname.startsWith(prefix))) return;
      throw new KyAppError('installation_disabled', {
        message: `安装实例处于 ${state}`,
      });
    },

    async stalenessGate(): Promise<DirectoryStalenessGate | null> {
      if (options.directoryStaleness === undefined) return null;
      return options.directoryStaleness();
    },

    clientIp: options.clientIp ?? defaultClientIp,

    requestId(headers: Headers): string {
      const value = headers.get(HTTP_HEADERS.requestId);
      if (value !== null && value !== '' && value.length <= 128) return value;
      requestIdCounter += 1;
      return `local-${String(baseNow())}-${String(requestIdCounter)}`;
    },

    async authenticate(input: AuthenticateInput): Promise<KyRequestIdentity> {
      const token = readBearerToken(input.authorization);
      if (token === null) throw unauthorized('缺少 Authorization: Bearer 令牌');

      let typ: string | undefined;
      try {
        typ = decodeProtectedHeader(token).typ;
      } catch {
        throw unauthorized('令牌不是合法 JWT');
      }

      if (typ === JWT_TYP.localToken) {
        if (options.localKeys === undefined) throw unauthorized('本部署未启用 Local Token');
        const local = await verifyLocalToken(token, {
          config: options.config,
          keys: options.localKeys,
          localMode: await runtime.localModeActive(),
          installationState: await runtime.installationState(),
          request: { method: input.method, pathname: input.pathname },
          pathPrefixes: options.manifest.pathPrefixes,
          testEndpoints: runtime.testEndpointsEnabled(),
          now: runtime.now,
        });
        return { act: local.act, sub: local.sub, tadm: local.tadm, pfx: local.pfx, local };
      }

      const sat = await verifySat(token, {
        config: options.config,
        jwks,
        jtiStore: options.jtiStore,
        request: {
          method: input.method,
          pathname: input.pathname,
          requestId: input.requestId,
        },
        pathPrefixes: options.manifest.pathPrefixes,
        manifestDigest,
        localMode: await runtime.localModeActive(),
        testEndpoints: runtime.testEndpointsEnabled(),
        ...(input.consumeJti === undefined ? {} : { consumeJti: input.consumeJti }),
        now: runtime.now,
      });
      return {
        act: sat.act,
        ...(sat.sub === undefined ? {} : { sub: sat.sub }),
        tadm: sat.tadm,
        pfx: sat.pfx,
        sat,
      };
    },
  };

  return runtime;
}
