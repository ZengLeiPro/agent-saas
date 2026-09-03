import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import {
  buildCanonicalConfigProjection,
  calculateConfigIdentityDigest,
  CONFIG_IDENTITY_SCHEMA_VERSION,
} from '../release/configIdentity.js';
import { parseAppConfig } from './config.js';
import { initializeRuntimeConfigIdentityAssembly } from './configIdentityAssembly.js';

afterEach(() => {
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
});
