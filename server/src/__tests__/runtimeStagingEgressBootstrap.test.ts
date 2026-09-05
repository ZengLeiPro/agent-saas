import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeRuntimeGovernanceCredentials } from '../app/runtimeGovernanceCredentials.js';
import { shutdownRuntimeStagingEgressBootstrap } from '../app/runtimeStagingEgressBootstrap.js';
import type { AppConfig } from '../types/index.js';

afterEach(async () => {
  await shutdownRuntimeStagingEgressBootstrap();
});

describe('runtime Staging egress bootstrap', () => {
  it('routes versioned HTTP Vault reads through fail-closed egress before credentials resolve', async () => {
    const directFetch = vi.fn(async () => {
      throw new Error('direct fetch must not be used');
    }) as unknown as typeof fetch;
    const proxyFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({
          value: 'vault-secret',
          ref: {
            id: 'ref-1',
            ownerId: '__system__',
            kind: 'client_daemon',
            version: 1,
            metadata: {},
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const target = { fetch: directFetch };
    const config = {
      agent: {},
      server: {},
      secretVault: {
        backend: 'http',
        baseUrl: 'https://vault.staging.internal',
        authToken: 'staging-vault-token',
      },
      egress: {
        server: {
          enabled: true,
          proxyUrl: 'http://proxy.staging.internal:7890',
          matchDomains: [],
          bypassDomains: [],
          timeoutMs: 20_000,
          failOpen: false,
        },
        sandbox: { enabled: false, proxyUrl: '', noProxy: [] },
        packageMirrors: {
          enabled: false,
          pipIndexUrl: '',
          pipTrustedHost: '',
          npmRegistry: '',
        },
      },
    } as AppConfig;

    const runtime = await initializeRuntimeGovernanceCredentials(config, '/tmp', {
      stagingEgress: {
        environment: 'staging',
        target,
        baseFetch: directFetch,
        proxyFetch: proxyFetch as never,
      },
    });
    await expect(
      runtime.secretVault.getSecret('ref-1', {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:client_daemon:read'],
      }),
    ).resolves.toBe('vault-secret');
    expect(proxyFetch).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
    expect(target.fetch).not.toBe(directFetch);

    await shutdownRuntimeStagingEgressBootstrap();
    expect(target.fetch).toBe(directFetch);
  });
});
