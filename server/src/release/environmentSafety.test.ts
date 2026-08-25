import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../app/config.js';
import { assertRuntimeEnvironmentSafety } from './environmentSafety.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const stagingEnv = {
  AGENT_SAAS_ENVIRONMENT: 'staging',
  AGENT_SAAS_RELEASE_ID: 'rc-20260825-01',
  AGENT_SAAS_RELEASE_SHA: SHA,
  AGENT_SAAS_SERVER_DIGEST: DIGEST,
  AGENT_SAAS_WEB_DIGEST: DIGEST,
  AGENT_SAAS_STAGING_ROOT: '/srv/agent-saas-staging',
  AGENT_SAAS_STAGING_DATABASE_HOSTS: 'staging-db.internal',
};

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    agent: { cwd: '/srv/agent-saas-staging/workspace' },
    server: {},
    cron: { enabled: false },
    runtimeEventStore: { backend: 'pg', connectionString: 'postgresql://staging@staging-db.internal/runtime' },
    egress: { server: { enabled: true, proxyUrl: 'http://proxy.internal', matchDomains: ['api.example.test'], bypassDomains: [], timeoutMs: 20_000, failOpen: false }, sandbox: { enabled: false, proxyUrl: '', noProxy: [] }, packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' } },
    tenantRemoteHands: { hands: [] },
    ...overrides,
  } as AppConfig;
}

describe('assertRuntimeEnvironmentSafety', () => {
  it('attests a fully isolated staging identity', () => {
    expect(assertRuntimeEnvironmentSafety(config(), stagingEnv)).toMatchObject({ environment: 'staging', releaseSha: SHA, safetyAttested: true });
  });

  it('fails closed when cron is absent or enabled', () => {
    expect(() => assertRuntimeEnvironmentSafety(config({ cron: undefined }), stagingEnv)).toThrow(/cron.enabled/);
    expect(() => assertRuntimeEnvironmentSafety(config({ cron: { enabled: true } }), stagingEnv)).toThrow(/cron.enabled/);
  });

  it('fails closed for a production database reference or unsafe egress', () => {
    expect(() => assertRuntimeEnvironmentSafety(config({ runtimeEventStore: { backend: 'pg', connectionString: 'postgresql://app@db.prod.internal/runtime' } }), stagingEnv)).toThrow(/database host|production marker/);
    expect(() => assertRuntimeEnvironmentSafety(config({ egress: undefined }), stagingEnv)).toThrow(/egress/);
  });

  it('does not apply staging-specific assertions to production', () => {
    expect(assertRuntimeEnvironmentSafety(config({ cron: { enabled: true }, egress: undefined }), { AGENT_SAAS_ENVIRONMENT: 'production' })).toMatchObject({ environment: 'production', safetyAttested: true });
  });
});
