import { describe, expect, it } from 'vitest';
import {
  assertTrustedServiceUrl,
  decideServiceOriginChange,
  normalizeTrustedOrigin,
  resolveMobileServicePolicy,
  TrustedServiceConfigurationError,
} from './trustedServiceOrigin';

const PROD_INPUT = {
  profileEnv: 'production',
  apiOrigin: 'https://api.mobile.test',
  apiAllowlist: 'https://api.mobile.test',
} as const;

function expectIssue(
  input: Parameters<typeof resolveMobileServicePolicy>[0],
  code: string,
  savedOrigin?: string,
) {
  const policy = resolveMobileServicePolicy(input, savedOrigin);
  expect(policy.ready).toBe(false);
  expect(policy.issue?.code).toBe(code);
  return policy;
}

describe('M10-01 build-time trusted service policy', () => {
  it('accepts a production HTTPS API origin and derives its WSS allowlist', () => {
    const policy = resolveMobileServicePolicy(PROD_INPUT);
    expect(policy).toMatchObject({
      profile: 'production',
      ready: true,
      editable: false,
      lanEnabled: false,
      apiOrigin: 'https://api.mobile.test',
      wsUrl: 'wss://api.mobile.test/ws',
      issue: null,
    });
    expect(policy.apiAllowlist).toEqual(['https://api.mobile.test']);
    expect(policy.wsAllowlist).toEqual(['wss://api.mobile.test']);
  });

  it('rejects the legacy example.com endpoint in every profile', () => {
    expectIssue({
      profileEnv: 'production',
      apiOrigin: 'https://agent-saas.example.com',
      apiAllowlist: 'https://agent-saas.example.com',
    }, 'EXAMPLE_DOMAIN');
  });

  it('rejects HTTP and WS in production', () => {
    expectIssue({
      profileEnv: 'production',
      apiOrigin: 'http://api.mobile.test',
      apiAllowlist: 'http://api.mobile.test',
    }, 'PRODUCTION_REQUIRES_HTTPS');

    expectIssue({
      ...PROD_INPUT,
      wsAllowlist: 'ws://api.mobile.test',
    }, 'PRODUCTION_REQUIRES_WSS');
  });

  it('rejects userinfo and fragments instead of normalizing them away', () => {
    expectIssue({
      ...PROD_INPUT,
      apiAllowlist: 'https://user:secret@api.mobile.test',
    }, 'USERINFO_NOT_ALLOWED');
    expectIssue({
      ...PROD_INPUT,
      apiAllowlist: 'https://api.mobile.test#ignored',
    }, 'FRAGMENT_NOT_ALLOWED');
  });

  it('rejects an active origin outside the build allowlist', () => {
    expectIssue({
      ...PROD_INPUT,
      apiOrigin: 'https://other.mobile.test',
    }, 'ORIGIN_NOT_ALLOWED');
  });

  it('rejects invalid hosts and ports', () => {
    expect(() => normalizeTrustedOrigin(
      'https://bad_host.mobile.test',
      'http',
      'production',
    )).toThrowError(TrustedServiceConfigurationError);
    expect(() => normalizeTrustedOrigin(
      'https://api.mobile.test:0',
      'http',
      'production',
    )).toThrowError(TrustedServiceConfigurationError);
    expect(() => normalizeTrustedOrigin(
      'https://api.mobile.test:99999',
      'http',
      'production',
    )).toThrowError(TrustedServiceConfigurationError);
  });

  it('fails closed when production configuration is absent', () => {
    const policy = expectIssue(
      { profileEnv: 'production' },
      'MISSING_API_ALLOWLIST',
    );
    expect(policy.apiOrigin).toBeNull();
    expect(policy.wsUrl).toBeNull();
    expect(policy.editable).toBe(false);
  });

  it('treats an unknown profile as production and ignores a saved override', () => {
    const policy = expectIssue({
      profileEnv: 'staging-typo',
      apiOrigin: 'http://127.0.0.1:3000',
      apiAllowlist: 'http://127.0.0.1:3000',
    }, 'PRODUCTION_REQUIRES_HTTPS', 'https://override.mobile.test');
    expect(policy.profile).toBe('production');
    expect(policy.editable).toBe(false);
  });

  it('keeps LAN routing disabled with no implicit fallback', () => {
    const policy = resolveMobileServicePolicy(PROD_INPUT);
    expect(policy.lanEnabled).toBe(false);
    expect(policy.apiOrigin).not.toContain('agent.local');
  });

  it('accepts explicitly allowlisted development HTTP and preview HTTPS origins', () => {
    const development = resolveMobileServicePolicy({
      profileEnv: 'development',
      apiOrigin: 'http://127.0.0.1:3000',
      apiAllowlist: 'http://127.0.0.1:3000,http://192.168.1.20:3000',
    });
    expect(development).toMatchObject({
      ready: true,
      editable: true,
      apiOrigin: 'http://127.0.0.1:3000',
      wsUrl: 'ws://127.0.0.1:3000/ws',
    });

    const preview = resolveMobileServicePolicy({
      profileEnv: 'preview',
      apiOrigin: 'https://preview-a.mobile.test',
      apiAllowlist: 'https://preview-a.mobile.test,https://preview-b.mobile.test',
    }, 'https://preview-b.mobile.test/');
    expect(preview).toMatchObject({
      ready: true,
      editable: true,
      apiOrigin: 'https://preview-b.mobile.test',
      wsUrl: 'wss://preview-b.mobile.test/ws',
    });
  });
});

describe('M10-01 final transport policy', () => {
  const policy = resolveMobileServicePolicy({
    profileEnv: 'preview',
    apiOrigin: 'https://preview-a.mobile.test',
    apiAllowlist: 'https://preview-a.mobile.test,https://preview-b.mobile.test',
  });

  it('allows API paths and the selected WS endpoint on the active origin', () => {
    expect(() => assertTrustedServiceUrl(
      policy,
      'https://preview-a.mobile.test/api/upload?name=a',
      'http',
    )).not.toThrow();
    expect(() => assertTrustedServiceUrl(
      policy,
      'wss://preview-a.mobile.test/ws',
      'websocket',
    )).not.toThrow();
  });

  it('rejects non-allowlist and inactive allowlist origins before transport', () => {
    expect(() => assertTrustedServiceUrl(
      policy,
      'https://attacker.mobile.test/api/upload',
      'http',
    )).toThrowError(/可信服务清单/);
    expect(() => assertTrustedServiceUrl(
      policy,
      'https://preview-b.mobile.test/api/upload',
      'http',
    )).toThrowError(/当前已确认/);
  });

  it('rejects userinfo, fragments, and alternate WS paths at request time', () => {
    expect(() => assertTrustedServiceUrl(
      policy,
      'https://user@preview-a.mobile.test/api/upload',
      'http',
    )).toThrowError(/用户名或密码/);
    expect(() => assertTrustedServiceUrl(
      policy,
      'https://preview-a.mobile.test/api/upload#leak',
      'http',
    )).toThrowError(/片段/);
    expect(() => assertTrustedServiceUrl(
      policy,
      'wss://preview-a.mobile.test/other',
      'websocket',
    )).toThrowError(/实时服务端点/);
  });

  it('marks every actual origin change as requiring re-login', () => {
    expect(decideServiceOriginChange(
      'https://preview-a.mobile.test',
      'https://preview-b.mobile.test',
    )).toEqual({ changed: true, requiresReauthentication: true });
    expect(decideServiceOriginChange(
      'https://preview-a.mobile.test',
      'https://preview-a.mobile.test',
    )).toEqual({ changed: false, requiresReauthentication: false });
  });
});
