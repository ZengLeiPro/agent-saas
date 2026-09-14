/** §2.4 / §3.8 部署配置读取与校验。 */
import { describe, expect, it } from 'vitest';

import {
  KyAppConfigError,
  decodeInstallationKey,
  loadKyAppConfig,
  loadKyAppIntegrationConfig,
} from './index.js';

const base = {
  KY_ENV: 'prod',
  KY_SYSTEM_ID: 'demo-erp',
  KY_TENANT_ID: 't_demo',
  KY_INSTALLATION_ID: 'tsi_01',
  KY_ORIGIN: 'https://t-demo.apps.kaiyancn.com',
  KY_SERVICE_CREDENTIAL: 'svc_x',
  KY_INSTALLATION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  KY_INSTALLATION_KEY_VERSION: 'v2026-09',
};

describe('loadKyAppConfig', () => {
  it('prod 环境按 §3.8 派生 iss 与 JWKS 地址', () => {
    const config = loadKyAppConfig(base);
    expect(config.issuer).toBe('https://agent.kaiyan.net');
    expect(config.jwksUrl).toBe('https://api.agent.kaiyan.net/.well-known/ky-app-jwks.json');
    expect(config.installationKey).toHaveLength(32);
    expect(config.localLoginEnabled).toBe(false);
  });

  it('staging 环境同理', () => {
    const config = loadKyAppConfig({ ...base, KY_ENV: 'staging' });
    expect(config.issuer).toBe('https://staging-agent.kaiyan.net');
    expect(config.jwksUrl).toBe(
      'https://staging-agent-api.kaiyan.net/.well-known/ky-app-jwks.json',
    );
  });

  it('prod / staging 不允许注入 KY_JWKS_URL', () => {
    expect(() => loadKyAppConfig({ ...base, KY_JWKS_URL: 'http://localhost:9/x' })).toThrow(
      KyAppConfigError,
    );
  });

  it('test 环境 iss 固定 https://test.ky.invalid，JWKS 由 doctor 注入', () => {
    const config = loadKyAppConfig({
      ...base,
      KY_ENV: 'test',
      KY_JWKS_URL: 'http://127.0.0.1:45123/.well-known/ky-app-jwks.json',
    });
    expect(config.issuer).toBe('https://test.ky.invalid');
    expect(config.jwksUrl).toBe('http://127.0.0.1:45123/.well-known/ky-app-jwks.json');
  });

  it('local 环境 iss 取 KY_JWKS_URL 的 origin', () => {
    const config = loadKyAppConfig({
      ...base,
      KY_ENV: 'local',
      KY_JWKS_URL: 'http://localhost:3010/.well-known/ky-app-jwks.json',
    });
    expect(config.issuer).toBe('http://localhost:3010');
  });

  it('local / test 缺 KY_JWKS_URL 直接报错', () => {
    expect(() => loadKyAppConfig({ ...base, KY_ENV: 'local' })).toThrow(KyAppConfigError);
  });

  it('缺任一必填项报错', () => {
    for (const key of Object.keys(base)) {
      const env: Record<string, string | undefined> = { ...base };
      delete env[key];
      expect(() => loadKyAppConfig(env)).toThrow(KyAppConfigError);
    }
  });

  it('KY_ENV 取值受限', () => {
    expect(() => loadKyAppConfig({ ...base, KY_ENV: 'dev' })).toThrow(/KY_ENV/u);
  });

  it('KY_ORIGIN 必须是纯 origin', () => {
    expect(() => loadKyAppConfig({ ...base, KY_ORIGIN: 'https://a.example/path' })).toThrow(
      KyAppConfigError,
    );
    expect(() => loadKyAppConfig({ ...base, KY_ORIGIN: 'not-a-url' })).toThrow(KyAppConfigError);
  });

  it('previous 安装密钥与其 keyVersion 必须成对', () => {
    expect(() =>
      loadKyAppConfig({ ...base, KY_INSTALLATION_KEY_PREVIOUS: base.KY_INSTALLATION_KEY }),
    ).toThrow(KyAppConfigError);
    const config = loadKyAppConfig({
      ...base,
      KY_INSTALLATION_KEY_PREVIOUS: base.KY_INSTALLATION_KEY,
      KY_INSTALLATION_KEY_PREVIOUS_VERSION: 'v2026-08',
    });
    expect(config.previousInstallationKeyVersion).toBe('v2026-08');
  });

  it('KY_LOCAL_LOGIN_ENABLED 只接受布尔字面量', () => {
    expect(loadKyAppConfig({ ...base, KY_LOCAL_LOGIN_ENABLED: 'true' }).localLoginEnabled).toBe(
      true,
    );
    expect(() => loadKyAppConfig({ ...base, KY_LOCAL_LOGIN_ENABLED: 'yes' })).toThrow(
      KyAppConfigError,
    );
  });
});

describe('loadKyAppIntegrationConfig', () => {
  it('默认关闭时不要求组织、安装或凭据配置', () => {
    expect(loadKyAppIntegrationConfig({})).toEqual({ enabled: false });
  });

  it('V2 开启时不读取 V1 组织秘密', () => {
    const result = loadKyAppIntegrationConfig({
      AGENT_INTEGRATION_ENABLED: 'true',
      KY_ENV: 'test',
      KY_SYSTEM_ID: 'system-1',
      KY_ORIGIN: 'https://business.example.com',
      KY_KEY_STORE_PROVIDER: 'test_memory',
      KY_DEPLOYMENT_MODE: 'single_tenant',
      KY_PLATFORM_API_BASE_URL: 'https://platform.example.com',
      KY_JWKS_URL: 'https://test.ky.invalid/.well-known/jwks.json',
    });
    expect(result).toMatchObject({ enabled: true, systemId: 'system-1' });
    expect(result).not.toHaveProperty('tenantId');
    expect(result).not.toHaveProperty('serviceCredential');
  });
});

describe('decodeInstallationKey', () => {
  it('接受 64 字符 hex 与 base64url，拒绝长度不符与标准 base64', () => {
    expect(decodeInstallationKey('a'.repeat(64), 'K')).toHaveLength(32);
    const base64url = Buffer.alloc(32, 7).toString('base64url');
    expect(decodeInstallationKey(base64url, 'K')).toHaveLength(32);
    expect(() => decodeInstallationKey('abc', 'K')).toThrow(KyAppConfigError);
    expect(() => decodeInstallationKey(`${'a'.repeat(42)}==`, 'K')).toThrow(KyAppConfigError);
  });
});
