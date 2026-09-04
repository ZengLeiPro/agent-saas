import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import {
  buildCanonicalConfigProjection,
  calculateConfigIdentityDigest,
  computeObservedConfigIdentity,
  CONFIG_IDENTITY_SCHEMA_VERSION,
} from '../release/configIdentity.js';
import { parseAppConfig } from './config.js';
import { initializeRuntimeConfigIdentityAssembly } from './configIdentityAssembly.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('initializeRuntimeConfigIdentityAssembly', () => {
  it('将 createRuntime 的真实 processCwd 透传给 observed identity', async () => {
    const processCwd = '/a';
    const reference = parseAppConfig({
      agent: {},
      server: {},
      artifact: { backend: 'local', rootDir: '../../private-target' },
    });
    const config = parseAppConfig({
      agent: {},
      server: {},
      artifact: { backend: 'local', rootDir: '../../../private-target' },
    });
    const expectedDigest = calculateConfigIdentityDigest(
      buildCanonicalConfigProjection(reference, processCwd).projection,
    );
    vi.stubEnv('AGENT_SAAS_ENVIRONMENT', 'production');
    vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_DIGEST', expectedDigest);
    vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION', String(CONFIG_IDENTITY_SCHEMA_VERSION));
    vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_PATH', '');

    const assembly = await initializeRuntimeConfigIdentityAssembly({
      config,
      secretVault: new InMemorySecretVault(),
      processCwd,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(assembly.getSummary().status).toBe('consistent');
    expect(assembly.getSummary().observed?.digest).toBe(expectedDigest);
  });

  it('Production 强一致读取等待轮换重算，并原子发布 drifted 私有快照', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const root = mkdtempSync(join(tmpdir(), 'config-identity-periodic-'));
    const snapshotPath = join(root, 'config-identity.json');
    try {
      const vault = new InMemorySecretVault();
      const caller = {
        actor: 'system' as const,
        userId: '__system__',
        scopes: ['secret:tenant-hand:write', 'secret:tenant-hand:read'],
      };
      const ref = await vault.putSecret('global', 'tenant-hand', 'v1', caller);
      const config = parseAppConfig({
        agent: { cwd: '/srv/agent' },
        server: {},
        runtimeEventStore: {
          backend: 'pg',
          connectionString: 'postgresql://u:p@db.internal:5432/runtime',
        },
        tenantRemoteHands: {
          hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: ref.id }],
        },
      });
      const deployTime = await computeObservedConfigIdentity(config, vault, root);
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('AGENT_SAAS_ENVIRONMENT', 'production');
      vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_DIGEST', deployTime.digest);
      vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION', String(CONFIG_IDENTITY_SCHEMA_VERSION));
      vi.stubEnv(
        'AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST',
        deployTime.credentialVersionDigest ?? '',
      );
      vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_PATH', snapshotPath);
      const assembly = await initializeRuntimeConfigIdentityAssembly({
        config,
        secretVault: vault,
        processCwd: root,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      expect(assembly.getSummary().status).toBe('consistent');

      await vault.rotateSecret(ref.id, 'v2', {
        ...caller,
        scopes: [...caller.scopes, 'secret:tenant-hand:rotate'],
      });
      vi.setSystemTime(new Date(6_000));
      expect(assembly.getSummary().status).toBe('consistent');
      expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toMatchObject({
        status: 'consistent',
      });

      expect((await assembly.refreshSummary()).status).toBe('drifted');
      expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toMatchObject({
        status: 'drifted',
      });
      expect(assembly.isPrivateSummaryCurrent()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
