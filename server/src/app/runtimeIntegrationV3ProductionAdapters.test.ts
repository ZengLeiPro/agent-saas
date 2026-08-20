import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from './config.js';
import {
  createAcsRuntimeIsolationAttestationProvider,
  createGithubAppInstallationTokenProvider,
  resolveProductionIntegrationV3Adapters,
} from './runtimeIntegrationV3ProductionAdapters.js';

const NOW = Date.parse('2026-08-19T08:00:00.000Z');

function acsConfig() {
  return parseAppConfig({
    agent: {}, server: {}, runtimeEventStore: { backend: 'pg', connectionString: 'postgres://localhost/test' },
    tenantRemoteHands: { hands: [{ id: 'agent-saas-acs', baseUrl: 'http://acs:3400', authToken: 'test-token' }] },
  });
}

function probeBody(overrides: Record<string, unknown> = {}) {
  const name = 'as-network-probe-abc';
  return {
    status: 'ok',
    networkPolicy: {
      effectivePolicy: {
        enforcement: 'enforced', privateEgressBlocked: true, metadataBlocked: true,
        dnsRebindingProtected: true, probeSandboxName: name, checkedAt: new Date(NOW).toISOString(),
      },
      probe: { checks: {
        publicRegistry: { exitCode: 0 }, privateApi: { exitCode: 1 },
        metadata: { exitCode: 1 }, dnsRebinding: { exitCode: 1 },
      } },
      ...overrides,
    },
  };
}

describe('production integration v3 adapters', () => {
  it('attests only an authenticated fresh ACS probe with all three protections actually blocked', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' });
      return new Response(JSON.stringify(probeBody()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = createAcsRuntimeIsolationAttestationProvider({ config: acsConfig(), fetchImpl, now: () => NOW });
    await expect(provider.attest({ admission: 'integration_v3_worker' })).resolves.toMatchObject({
      runtimeAdapterId: 'acs-orchestrator/network-policy-probe', isolationBoundaryId: 'acs-sandbox/as-network-probe-abc',
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://acs:3400/network-policy/probe', expect.objectContaining({ method: 'POST' }));
  });

  it.each([
    ['enforcement', { effectivePolicy: { enforcement: 'not_enforced', privateEgressBlocked: true, metadataBlocked: true, dnsRebindingProtected: true, probeSandboxName: 'as-network-probe-abc' } }],
    ['private', { probe: { checks: { publicRegistry: { exitCode: 0 }, privateApi: { exitCode: 0 }, metadata: { exitCode: 1 }, dnsRebinding: { exitCode: 1 } } } }],
    ['metadata', { probe: { checks: { publicRegistry: { exitCode: 0 }, privateApi: { exitCode: 1 }, metadata: { exitCode: 0 }, dnsRebinding: { exitCode: 1 } } } }],
    ['dns rebinding', { probe: { checks: { publicRegistry: { exitCode: 0 }, privateApi: { exitCode: 1 }, metadata: { exitCode: 1 }, dnsRebinding: { exitCode: 0 } } } }],
  ])('fails closed when ACS %s evidence is broken', async (_label, overrides) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(probeBody(overrides)), { status: 200 })) as unknown as typeof fetch;
    const provider = createAcsRuntimeIsolationAttestationProvider({ config: acsConfig(), fetchImpl, now: () => NOW });
    await expect(provider.attest({ admission: 'integration_v3_worker' })).resolves.toBeUndefined();
  });

  it('signs a short-lived server-side App JWT and requests a token bound to one numeric repository', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ repository_ids: [123] }));
      const authorization = (init?.headers as Record<string, string>).authorization;
      const jwt = authorization.slice('Bearer '.length);
      const [header, payload, signature] = jwt.split('.');
      expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ iss: '42' });
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
      return new Response(JSON.stringify({
        token: 'ghs_abcdefghijklmnopqrstuvwxyz', expires_at: new Date(NOW + 60 * 60_000).toISOString(),
        repository_selection: 'selected', repositories: [{ id: 123 }], permissions: { contents: 'write' },
      }), { status: 201 });
    }) as unknown as typeof fetch;
    const provider = createGithubAppInstallationTokenProvider({
      appId: 42, privateKey: async () => privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      fetchImpl, now: () => NOW,
    });
    await expect(provider.getInstallationToken({ repositoryId: 123, installationId: 456 })).resolves.toMatchObject({
      repositoryId: 123, installationId: 456, token: 'ghs_abcdefghijklmnopqrstuvwxyz',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/app/installations/456/access_tokens', expect.anything());
  });

  it('binds a legacy canonical repository name to the one numeric repository returned by GitHub', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ repositories: ['agent-saas'] }));
      return new Response(JSON.stringify({
        token: 'ghs_abcdefghijklmnopqrstuvwxyz', expires_at: new Date(NOW + 60 * 60_000).toISOString(),
        repository_selection: 'selected', repositories: [{ id: 123, full_name: 'ZengLeiPro/agent-saas' }],
      }), { status: 201 });
    }) as unknown as typeof fetch;
    const provider = createGithubAppInstallationTokenProvider({
      appId: 42, privateKey: async () => privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), fetchImpl, now: () => NOW,
    });
    await expect(provider.getInstallationToken({
      repositoryOwner: 'ZengLeiPro', repositoryName: 'agent-saas', installationId: 456,
    })).resolves.toMatchObject({ repositoryId: 123, installationId: 456 });
  });

  it('rejects a token response that is not exclusively bound to the requested immutable repository', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      token: 'ghs_abcdefghijklmnopqrstuvwxyz', expires_at: new Date(NOW + 60 * 60_000).toISOString(),
      repository_selection: 'selected', repositories: [{ id: 999 }],
    }), { status: 201 })) as unknown as typeof fetch;
    const provider = createGithubAppInstallationTokenProvider({
      appId: 42, privateKey: async () => privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), fetchImpl, now: () => NOW,
    });
    await expect(provider.getInstallationToken({ repositoryId: 123, installationId: 456 })).resolves.toBeUndefined();
  });

  it('production assembly preserves explicit injections and otherwise leaves missing GitHub config unavailable', () => {
    const config = parseAppConfig({ agent: {}, server: {}, integrationV3ControlPlane: {
      enabled: true, controlledMirrorRoot: '/mirrors', githubAppInstallationId: 456,
    } });
    const attestation = { attest: vi.fn() } as any;
    const github = { getInstallationToken: vi.fn() } as any;
    const vault = { getSecret: vi.fn() } as any;
    expect(resolveProductionIntegrationV3Adapters({ config, secretVault: vault, runtimeIsolationAttestationProvider: attestation, githubAppInstallationTokenProvider: github }))
      .toEqual({ runtimeIsolationAttestationProvider: attestation, githubAppInstallationTokenProvider: github });
    expect(resolveProductionIntegrationV3Adapters({ config, secretVault: vault }).githubAppInstallationTokenProvider).toBeUndefined();
    const configured = parseAppConfig({ agent: {}, server: {}, integrationV3ControlPlane: {
      enabled: true, controlledMirrorRoot: '/mirrors', githubAppInstallationId: 456,
      githubApp: { appId: 42, privateKeyRef: 'vault-github-app-key' },
    } });
    expect(resolveProductionIntegrationV3Adapters({ config: configured, secretVault: vault })).toMatchObject({
      runtimeIsolationAttestationProvider: expect.any(Object), githubAppInstallationTokenProvider: expect.any(Object),
    });
  });
});
