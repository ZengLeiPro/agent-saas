import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../app/config.js';
import { assertRuntimeEnvironmentSafety } from './environmentSafety.js';
import { readRuntimeIdentity } from './runtimeIdentity.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const stagingRoot = mkdtempSync(join(tmpdir(), 'agent-saas-staging-'));
const workspace = join(stagingRoot, 'workspace');
mkdirSync(workspace);
afterAll(() => rmSync(stagingRoot, { recursive: true, force: true }));

const stagingEnv = {
  AGENT_SAAS_ENVIRONMENT: 'staging',
  AGENT_SAAS_RELEASE_ID: 'rc-20260825-01',
  AGENT_SAAS_RELEASE_SHA: SHA,
  AGENT_SAAS_SERVER_DIGEST: DIGEST,
  AGENT_SAAS_WEB_DIGEST: DIGEST,
  AGENT_SAAS_STAGING_ROOT: stagingRoot,
  AGENT_SAAS_STAGING_DATABASE_HOSTS: 'staging-db.internal',
};

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    agent: { cwd: workspace },
    server: {},
    cron: { enabled: false },
    runtimeEventStore: { backend: 'pg', connectionString: 'postgresql://staging@staging-db.internal/runtime' },
    egress: { server: { enabled: true, proxyUrl: 'http://proxy.internal', matchDomains: ['api.example.test'], bypassDomains: [], timeoutMs: 20_000, failOpen: false }, sandbox: { enabled: false, proxyUrl: '', noProxy: [] }, packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' } },
    tenantRemoteHands: { hands: [] },
    ...overrides,
  } as AppConfig;
}

describe('assertRuntimeEnvironmentSafety', () => {
  it('rejects missing or invalid environment identities unless an explicit development/test exception applies', () => {
    expect(() => readRuntimeIdentity({})).toThrow(/must explicitly be staging or production/);
    expect(() => readRuntimeIdentity({ AGENT_SAAS_ENVIRONMENT: 'stagin' })).toThrow(/must be staging or production/);
    expect(readRuntimeIdentity({ NODE_ENV: 'test' })).toMatchObject({ environment: 'test', safetyAttested: true });
    expect(readRuntimeIdentity({ NODE_ENV: 'development', AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT: '1' })).toMatchObject({ environment: 'development', safetyAttested: true });
  });

  it('attests a fully isolated staging identity', () => {
    expect(assertRuntimeEnvironmentSafety(config(), stagingEnv)).toMatchObject({ environment: 'staging', releaseSha: SHA, safetyAttested: true });
  });

  it('fails closed when cron is absent or enabled', () => {
    expect(() => assertRuntimeEnvironmentSafety(config({ cron: undefined }), stagingEnv)).toThrow(/cron.enabled/);
    expect(() => assertRuntimeEnvironmentSafety(config({ cron: { enabled: true } }), stagingEnv)).toThrow(/cron.enabled/);
  });

  it('rejects staging root prefix collisions and relative isolated paths', () => {
    expect(() => assertRuntimeEnvironmentSafety(config({ agent: { cwd: '/srv/agent-saas-staging-evil/workspace' } }), stagingEnv)).toThrow(/agent workspace/);
    expect(() => assertRuntimeEnvironmentSafety(config({ agent: { cwd: './workspace' } }), stagingEnv)).toThrow(/agent workspace/);
    expect(() => assertRuntimeEnvironmentSafety(config({ secretVault: { backend: 'encrypted-file', filePath: '/srv/agent-saas-staging-evil/secrets.json' } }), stagingEnv)).toThrow(/SecretVault file/);
    expect(() => assertRuntimeEnvironmentSafety(config({ secretVault: { backend: 'encrypted-file', filePath: './secrets.json' } }), stagingEnv)).toThrow(/SecretVault file/);
  });

  it('rejects workspace and SecretVault symlinks escaping the staging root', () => {
    const productionRoot = mkdtempSync(join(tmpdir(), 'agent-saas-production-'));
    const escapedWorkspace = join(stagingRoot, 'escaped-workspace');
    const productionSecret = join(productionRoot, 'secrets.json');
    const escapedSecret = join(stagingRoot, 'escaped-secrets.json');
    mkdirSync(join(productionRoot, 'workspace'));
    writeFileSync(productionSecret, '{}');
    symlinkSync(join(productionRoot, 'workspace'), escapedWorkspace);
    symlinkSync(productionSecret, escapedSecret);

    expect(() => assertRuntimeEnvironmentSafety(config({ agent: { cwd: escapedWorkspace } }), stagingEnv)).toThrow(/agent workspace/);
    expect(() => assertRuntimeEnvironmentSafety(config({ secretVault: { backend: 'encrypted-file', filePath: escapedSecret } }), stagingEnv)).toThrow(/SecretVault file/);
    rmSync(productionRoot, { recursive: true, force: true });
  });

  it('fails closed for a production database reference or unsafe egress', () => {
    expect(() => assertRuntimeEnvironmentSafety(config({ runtimeEventStore: { backend: 'pg', connectionString: 'postgresql://app@db.prod.internal/runtime' } }), stagingEnv)).toThrow(/database host|production marker/);
    expect(() => assertRuntimeEnvironmentSafety(config({ egress: undefined }), stagingEnv)).toThrow(/egress/);
  });

  it('does not apply staging-specific assertions to production', () => {
    expect(assertRuntimeEnvironmentSafety(config({ cron: { enabled: true }, egress: undefined }), { AGENT_SAAS_ENVIRONMENT: 'production' })).toMatchObject({ environment: 'production', safetyAttested: true });
  });
});
