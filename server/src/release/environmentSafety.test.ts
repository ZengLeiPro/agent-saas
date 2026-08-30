import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../app/config.js';
import { assertRuntimeEnvironmentSafety as assertSafetyImpl } from './environmentSafety.js';
import { readRuntimeIdentity } from './runtimeIdentity.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const stagingRoot = mkdtempSync(join(tmpdir(), 'agent-saas-staging-'));
const workspace = join(stagingRoot, 'workspace');
const processCwd = join(stagingRoot, 'app', 'server');
const stagingReleaseRoot = join(stagingRoot, 'releases');
const releaseSharedDir = join(stagingReleaseRoot, 'rc-20260825-01', 'server', 'workspace-shared');
const vaultFile = join(stagingRoot, 'vault', 'secrets.enc');
const JWT_SECRET = 'staging-jwt-secret-that-is-at-least-32-characters';
mkdirSync(workspace);
mkdirSync(join(workspace, '.shared'));
mkdirSync(join(workspace, 'uploads'));
mkdirSync(join(processCwd, 'data'), { recursive: true });
mkdirSync(releaseSharedDir, { recursive: true });
mkdirSync(join(stagingRoot, 'vault'));
writeFileSync(vaultFile, 'encrypted');
afterAll(() => rmSync(stagingRoot, { recursive: true, force: true }));

const stagingEnv = {
  AGENT_SAAS_ENVIRONMENT: 'staging',
  AGENT_SAAS_RELEASE_ID: 'rc-20260825-01',
  AGENT_SAAS_RELEASE_SHA: SHA,
  AGENT_SAAS_SERVER_DIGEST: DIGEST,
  AGENT_SAAS_WEB_DIGEST: DIGEST,
  AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST: DIGEST,
  AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST: DIGEST,
  AGENT_SAAS_STAGING_ROOT: stagingRoot,
  AGENT_SAAS_STAGING_RELEASE_ROOT: stagingReleaseRoot,
  AGENT_SAAS_STAGING_DATABASE_HOSTS: 'staging-db.internal',
  AGENT_SAAS_STAGING_DATABASE_NAME: 'runtime',
  AGENT_SAAS_STAGING_DATABASE_USER: 'staging',
  AGENT_SAAS_STAGING_ACS_HOSTS: 'acs.staging.internal',
  AGENT_SAAS_STAGING_CREDENTIAL_NAMESPACE: 'STAGING_AGENT_SAAS',
  AGENT_SAAS_PRODUCTION_CREDENTIAL_NAMESPACE: 'PRODUCTION_AGENT_SAAS',
  AGENT_SAAS_STAGING_JWT_SECRET_SHA256: `sha256:${createHash('sha256').update(JWT_SECRET).digest('hex')}`,
  AGENT_SAAS_PRODUCTION_JWT_SECRET_SHA256: `sha256:${'c'.repeat(64)}`,
  AGENT_SAAS_STAGING_HAND_STORE_NAMESPACE: 'staging-hands',
  AGENT_SAAS_PRODUCTION_HAND_STORE_NAMESPACE: 'production-hands',
  AGENT_SAAS_STAGING_ACS_NAMESPACE: 'agent-saas-staging',
  AGENT_SAAS_PRODUCTION_ACS_NAMESPACE: 'agent-saas-production',
  AGENT_SAAS_STAGING_ACS_PVC: 'agent-saas-staging-workspace',
  AGENT_SAAS_PRODUCTION_ACS_PVC: 'agent-saas-production-workspace',
  AGENT_SAAS_STAGING_ACS_SERVICE_ACCOUNT: 'agent-saas-staging',
  AGENT_SAAS_PRODUCTION_ACS_SERVICE_ACCOUNT: 'agent-saas-production',
  AGENT_SAAS_STAGING_ACS_READY: '0',
  AGENT_SAAS_STAGING_OAUTH_ENABLED: '0',
  AGENT_SAAS_STAGING_NOTIFICATION_MODE: 'disabled',
};

function assertRuntimeEnvironmentSafety(
  value: AppConfig,
  env: NodeJS.ProcessEnv = stagingEnv,
  options: { processCwd?: string } = { processCwd },
) {
  return assertSafetyImpl(value, env, options);
}

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    agent: { cwd: workspace },
    server: {},
    auth: {
      enabled: true,
      jwtSecret: JWT_SECRET,
      tokenExpiresIn: '30d',
      usersFile: './data/users.json',
    },
    cron: { enabled: false },
    secretVault: {
      backend: 'encrypted-file',
      filePath: vaultFile,
      encryptionKeyEnv: 'STAGING_AGENT_SAAS_VAULT_KEY',
    },
    toolControls: { enabled: false },
    runtimeEventStore: {
      backend: 'pg',
      connectionString: 'postgresql://staging@staging-db.internal/runtime',
    },
    egress: {
      server: {
        enabled: true,
        proxyUrl: 'http://proxy.internal',
        matchDomains: [],
        bypassDomains: [],
        timeoutMs: 20_000,
        failOpen: false,
      },
      sandbox: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    },
    tenantRemoteHands: { hands: [] },
    ...overrides,
  } as AppConfig;
}

describe('assertRuntimeEnvironmentSafety', () => {
  it('rejects missing or invalid environment identities unless an explicit development/test exception applies', () => {
    expect(() => readRuntimeIdentity({})).toThrow(/must explicitly be staging or production/);
    expect(() => readRuntimeIdentity({ AGENT_SAAS_ENVIRONMENT: 'stagin' })).toThrow(
      /must be staging or production/,
    );
    expect(readRuntimeIdentity({ NODE_ENV: 'test' })).toMatchObject({
      environment: 'test',
      safetyAttested: true,
    });
    expect(
      readRuntimeIdentity({
        NODE_ENV: 'development',
        AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT: '1',
      }),
    ).toMatchObject({ environment: 'development', safetyAttested: true });
  });

  it('attests a fully isolated staging identity', () => {
    expect(assertRuntimeEnvironmentSafety(config(), stagingEnv, { processCwd })).toMatchObject({
      environment: 'staging',
      releaseSha: SHA,
      safetyAttested: true,
    });
  });

  it('allows immutable shared assets inside the explicit Staging release root', () => {
    expect(
      assertRuntimeEnvironmentSafety(
        config({ agent: { cwd: workspace, sharedDir: releaseSharedDir } }),
        stagingEnv,
        { processCwd },
      ),
    ).toMatchObject({ environment: 'staging', safetyAttested: true });
  });

  it('fails closed when cron is absent or enabled', () => {
    expect(() =>
      assertRuntimeEnvironmentSafety(config({ cron: undefined }), stagingEnv, { processCwd }),
    ).toThrow(/cron.enabled/);
    expect(() =>
      assertRuntimeEnvironmentSafety(config({ cron: { enabled: true } }), stagingEnv, {
        processCwd,
      }),
    ).toThrow(/cron.enabled/);
  });

  it('rejects staging root prefix collisions and relative isolated paths', () => {
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({ agent: { cwd: '/srv/agent-saas-staging-evil/workspace' } }),
        stagingEnv,
      ),
    ).toThrow(/agent workspace/);
    expect(() =>
      assertRuntimeEnvironmentSafety(config({ agent: { cwd: './workspace' } }), stagingEnv),
    ).toThrow(/agent workspace/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          secretVault: {
            backend: 'encrypted-file',
            filePath: '/srv/agent-saas-staging-evil/secrets.json',
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/SecretVault file/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({ secretVault: { backend: 'encrypted-file', filePath: './secrets.json' } }),
        stagingEnv,
      ),
    ).toThrow(/SecretVault file/);
  });

  it('rejects workspace and SecretVault symlinks escaping the staging root', () => {
    const productionRoot = mkdtempSync(join(tmpdir(), 'agent-saas-production-'));
    const escapedWorkspace = join(stagingRoot, 'escaped-workspace');
    const productionSecret = join(productionRoot, 'secrets.json');
    const escapedSecret = join(stagingRoot, 'escaped-secrets.json');
    const escapedSharedDir = join(stagingReleaseRoot, 'escaped-shared');
    mkdirSync(join(productionRoot, 'workspace'));
    writeFileSync(productionSecret, '{}');
    symlinkSync(join(productionRoot, 'workspace'), escapedWorkspace);
    symlinkSync(productionSecret, escapedSecret);
    symlinkSync(join(productionRoot, 'workspace'), escapedSharedDir);

    expect(() =>
      assertRuntimeEnvironmentSafety(config({ agent: { cwd: escapedWorkspace } }), stagingEnv),
    ).toThrow(/agent workspace/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({ secretVault: { backend: 'encrypted-file', filePath: escapedSecret } }),
        stagingEnv,
      ),
    ).toThrow(/SecretVault file/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({ agent: { cwd: workspace, sharedDir: escapedSharedDir } }),
        stagingEnv,
      ),
    ).toThrow(/sharedDir/);
    rmSync(productionRoot, { recursive: true, force: true });
  });

  it('fails closed for a production database reference or egress that permits direct traffic', () => {
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          runtimeEventStore: {
            backend: 'pg',
            connectionString: 'postgresql://app@db.prod.internal/runtime',
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/database host|production marker/);
    expect(() => assertRuntimeEnvironmentSafety(config({ egress: undefined }), stagingEnv)).toThrow(
      /egress/,
    );
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          egress: {
            ...config().egress,
            server: { ...config().egress!.server, proxyUrl: 'nonsense' },
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/valid HTTP\(S\) proxy/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          egress: {
            ...config().egress,
            server: { ...config().egress!.server, matchDomains: ['api.example.test'] },
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/proxy all domains/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          egress: {
            ...config().egress,
            server: { ...config().egress!.server, bypassDomains: ['localhost'] },
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/proxy all domains/);
  });

  it('allows only explicitly named Staging ACS/Hand hosts and exact database identity', () => {
    expect(
      assertRuntimeEnvironmentSafety(
        config({
          tenantRemoteHands: {
            hands: [
              {
                id: 'staging-acs',
                baseUrl: 'https://acs.staging.internal',
                authTokenRef: 'STAGING_AGENT_SAAS/acs-token',
              },
            ],
          },
        }),
        stagingEnv,
      ),
    ).toMatchObject({ environment: 'staging', acsOrchestratorDigest: DIGEST });
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          tenantRemoteHands: {
            hands: [{ id: 'production-acs', baseUrl: 'https://acs.production.internal' }],
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/allowed Staging ACS host|production marker/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          runtimeEventStore: {
            backend: 'pg',
            connectionString: 'postgresql://staging@staging-db.internal/production',
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/database name|production marker/);
  });

  it('requires explicit staging identities for NAS, Vault, Hand, OAuth, and notifications', () => {
    expect(() =>
      assertRuntimeEnvironmentSafety(config(), {
        ...stagingEnv,
        AGENT_SAAS_STAGING_RELEASE_ROOT: undefined,
      }),
    ).toThrow(/AGENT_SAAS_STAGING_RELEASE_ROOT/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({ agent: { cwd: workspace, sharedDir: '/mnt/shared-without-prod-marker' } }),
        stagingEnv,
      ),
    ).toThrow(/sharedDir/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          secretVault: {
            backend: 'http',
            baseUrl: 'https://vault.example.internal',
            authToken: 'test-token',
          },
        }),
        stagingEnv,
      ),
    ).toThrow(/SecretVault host/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          serverRemote: { baseUrl: 'https://hand.example.internal', authToken: 'test-token' },
        }),
        stagingEnv,
      ),
    ).toThrow(/serverRemote host/);
    expect(() =>
      assertRuntimeEnvironmentSafety(config({ codexSubscription: { enabled: true } }), stagingEnv),
    ).toThrow(/OAuth endpoint/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({
          dingtalkSendMessage: { enabled: true, endpoint: 'https://notify.example.internal' },
        }),
        stagingEnv,
      ),
    ).toThrow(/send endpoint/);
  });

  it('fails closed for shared credentials, unisolated runtime paths, and tools before ACS readiness', () => {
    expect(() =>
      assertRuntimeEnvironmentSafety(config(), stagingEnv, { processCwd: '/tmp' }),
    ).toThrow(/processCwd\/data/);
    expect(() =>
      assertRuntimeEnvironmentSafety(config(), {
        ...stagingEnv,
        AGENT_SAAS_PRODUCTION_CREDENTIAL_NAMESPACE:
          stagingEnv.AGENT_SAAS_STAGING_CREDENTIAL_NAMESPACE,
      }),
    ).toThrow(/credential namespaces/);
    expect(() =>
      assertRuntimeEnvironmentSafety(config(), {
        ...stagingEnv,
        AGENT_SAAS_PRODUCTION_JWT_SECRET_SHA256: stagingEnv.AGENT_SAAS_STAGING_JWT_SECRET_SHA256,
      }),
    ).toThrow(/JWT fingerprint/);
    expect(() =>
      assertRuntimeEnvironmentSafety(config({ toolControls: { enabled: true } }), stagingEnv),
    ).toThrow(/tool execution/);
    expect(() =>
      assertRuntimeEnvironmentSafety(
        config({ auth: { ...config().auth, selfSignup: { sms: { provider: 'aliyun' } } } }),
        stagingEnv,
      ),
    ).toThrow(/notification paths/);
  });

  it('does not apply staging-specific assertions to production', () => {
    expect(
      assertRuntimeEnvironmentSafety(config({ cron: { enabled: true }, egress: undefined }), {
        AGENT_SAAS_ENVIRONMENT: 'production',
      }),
    ).toMatchObject({ environment: 'production', safetyAttested: true });
  });
});
