import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KY_APP_JWKS_PATH,
  DEFAULT_SAT_TTL_SECONDS,
  KyAppConfigError,
  resolveKyAppConfig,
} from './config.js';

describe('kyApp 平台配置域', () => {
  it('缺失 kyApp 时整体关闭', () => {
    expect(resolveKyAppConfig({})).toBeNull();
    expect(resolveKyAppConfig({ kyApp: null })).toBeNull();
    expect(resolveKyAppConfig(null)).toBeNull();
  });

  it('prod 按规范 §3.8 / §3.1 推导 iss 与 JWKS 地址', () => {
    const config = resolveKyAppConfig({ kyApp: { environment: 'prod' } });
    expect(config?.issuer).toBe('https://agent.kaiyan.net');
    expect(config?.jwksUrl).toBe('https://api.agent.kaiyan.net/.well-known/ky-app-jwks.json');
    expect(config?.jwksPath).toBe(DEFAULT_KY_APP_JWKS_PATH);
    expect(config?.satTtlSeconds).toEqual({ ...DEFAULT_SAT_TTL_SECONDS });
    expect(config?.allowInsecureOutbound).toBe(false);
  });

  it('staging 取 staging 域，local 必须显式给 publicIssuer 且 JWKS 与之同源', () => {
    expect(resolveKyAppConfig({ kyApp: { environment: 'staging' } })?.jwksUrl).toBe(
      'https://api.staging.agent.kaiyan.net/.well-known/ky-app-jwks.json',
    );
    expect(() => resolveKyAppConfig({ kyApp: { environment: 'local' } })).toThrow(KyAppConfigError);
    const local = resolveKyAppConfig({
      kyApp: { environment: 'local', publicIssuer: 'http://localhost:3001' },
    });
    expect(local?.issuer).toBe('http://localhost:3001');
    expect(local?.jwksUrl).toBe('http://localhost:3001/.well-known/ky-app-jwks.json');
  });

  it('覆盖 TTL / 探测 / 事件窗口，未知键与 prod 明文出站被拒', () => {
    const config = resolveKyAppConfig({
      kyApp: {
        environment: 'staging',
        jwksPath: '/keys/ky.json',
        satTtlSeconds: { user: 600 },
        probe: { failureThreshold: 3 },
        events: { retryWindowMs: 60_000 },
        allowInsecureOutbound: true,
      },
    });
    expect(config?.jwksUrl).toBe('https://api.staging.agent.kaiyan.net/keys/ky.json');
    expect(config?.satTtlSeconds).toEqual({ user: 600, agent: 60, platform: 60 });
    expect(config?.probe.failureThreshold).toBe(3);
    expect(config?.events.retryWindowMs).toBe(60_000);
    expect(config?.allowInsecureOutbound).toBe(true);

    expect(() => resolveKyAppConfig({ kyApp: { environment: 'prod', unknown: 1 } })).toThrow(
      KyAppConfigError,
    );
    expect(() =>
      resolveKyAppConfig({ kyApp: { environment: 'prod', allowInsecureOutbound: true } }),
    ).toThrow(/allowInsecureOutbound/u);
    expect(() =>
      resolveKyAppConfig({ kyApp: { environment: 'prod', publicIssuer: 'https://a.example/x' } }),
    ).toThrow(KyAppConfigError);
  });

  it('WP3 gateway 子域：缺省取规范默认值，显式配置逐项覆盖，未知键被拒', () => {
    const fallback = resolveKyAppConfig({ kyApp: { environment: 'prod' } });
    expect(fallback?.gateway).toEqual({
      enabled: true,
      maxToolsPerSession: 64,
      meTimeoutMs: 5_000,
      logicalCallDeadlineMs: 60_000,
      executionPollIntervalMs: 2_000,
      approvalTtlMs: 10 * 60 * 1000,
      maxResponseBytes: 6_000,
      limits: {
        perInstallationConcurrency: 8,
        perRunPerCapability: 20,
        perTenantPerMinute: 300,
        perTenantPerDay: 5_000,
        breakerFailureThreshold: 20,
        breakerCooldownMs: 5 * 60 * 1000,
      },
    });

    const overridden = resolveKyAppConfig({
      kyApp: {
        environment: 'prod',
        gateway: { enabled: false, maxToolsPerSession: 8, limits: { perTenantPerMinute: 30 } },
      },
    });
    expect(overridden?.gateway.enabled).toBe(false);
    expect(overridden?.gateway.maxToolsPerSession).toBe(8);
    expect(overridden?.gateway.limits.perTenantPerMinute).toBe(30);
    // 未显式覆盖的子项仍走默认值
    expect(overridden?.gateway.limits.perInstallationConcurrency).toBe(8);
    expect(overridden?.gateway.maxResponseBytes).toBe(6_000);

    expect(() =>
      resolveKyAppConfig({ kyApp: { environment: 'prod', gateway: { unknown: 1 } } }),
    ).toThrow(KyAppConfigError);
    expect(() =>
      resolveKyAppConfig({ kyApp: { environment: 'prod', gateway: { maxResponseBytes: 10 } } }),
    ).toThrow(KyAppConfigError);
  });
});
