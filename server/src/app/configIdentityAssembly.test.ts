import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpSecretVault, InMemorySecretVault } from '../security/secretVault.js';
import { projectRuntimeWorkerReadyFile } from '../runtime/runtimeWorkerReadiness.js';
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

  it('Production 在 wall-clock 回拨后重算轮换身份，并撤销 Worker 门禁', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const root = mkdtempSync(join(tmpdir(), 'config-identity-periodic-'));
    const snapshotPath = join(root, 'config-identity.json');
    const workerReadyPath = join(root, 'worker.ready');
    try {
      let remoteVersion = 1;
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        id: 'remote-ref-id',
        ownerId: 'global',
        kind: 'tenant-hand',
        version: remoteVersion,
        metadata: {},
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      })));
      const vault = new HttpSecretVault({
        baseUrl: 'https://vault.example.com',
        authToken: 'bootstrap-token',
        fetchImpl: fetchImpl as typeof fetch,
        metadataCacheTtlMs: 5_000,
      });
      const config = parseAppConfig({
        agent: { cwd: '/srv/agent' },
        server: {},
        runtimeEventStore: {
          backend: 'pg',
          connectionString: 'postgresql://u:p@db.internal:5432/runtime',
        },
        tenantRemoteHands: {
          hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: 'remote-ref-id' }],
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
      projectRuntimeWorkerReadyFile(
        workerReadyPath,
        { state: 'healthy', admitting: true },
        assembly.getSummary(),
        assembly.isPrivateSummaryCurrent(),
        4321,
      );
      expect(existsSync(workerReadyPath)).toBe(true);

      remoteVersion = 2;
      vi.setSystemTime(new Date(0));
      expect(assembly.getSummary().status).toBe('consistent');
      expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toMatchObject({
        status: 'consistent',
      });

      expect((await assembly.refreshSummary()).status).toBe('drifted');
      expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toMatchObject({
        status: 'drifted',
      });
      expect(assembly.isPrivateSummaryCurrent()).toBe(true);
      projectRuntimeWorkerReadyFile(
        workerReadyPath,
        { state: 'healthy', admitting: true },
        assembly.getSummary(),
        assembly.isPrivateSummaryCurrent(),
        4321,
      );
      expect(existsSync(workerReadyPath)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
