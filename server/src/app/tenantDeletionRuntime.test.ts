import { describe, expect, it, vi } from 'vitest';

import { createTenantExternalRuntimeLifecycle } from './tenantDeletionRuntime.js';

const config = {
  tenantRemoteHands: {
    hands: [{
      id: 'agent-saas-acs', baseUrl: 'http://acs-hand:3400', rollout: { mode: 'all' },
      authToken: 'token', invokeTimeoutMs: 300_000,
      networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    }],
  },
} as never;

describe('tenant external runtime lifecycle', () => {
  it('deletes only the target tenant sandboxes and verifies Sandbox/TrafficPolicy/SNAT from ACS authority', async () => {
    let sandboxes = [
      { name: 'as-acme-1', workspaceId: 'ws_acme__u-1' },
      { name: 'as-other-1', workspaceId: 'ws_other__u-2' },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sandboxes') && init?.method === 'GET') {
        return new Response(JSON.stringify({ status: 'ok', sandboxes }), { status: 200 });
      }
      if (url.endsWith('/sandboxes/as-acme-1') && init?.method === 'DELETE') {
        sandboxes = sandboxes.filter(item => item.name !== 'as-acme-1');
        return new Response(JSON.stringify({ status: 'ok', deleted: true }), { status: 200 });
      }
      throw new Error(`unexpected request ${init?.method} ${url}`);
    }) as typeof fetch;
    const lifecycle = createTenantExternalRuntimeLifecycle(config, undefined, fetchImpl);

    await expect(lifecycle.verify('acme')).resolves.toMatchObject({
      sandboxes: 1, trafficPolicies: 1, snat: 1,
      authority: expect.stringContaining('acs-orchestrator:/sandboxes'),
    });
    await expect(lifecycle.cleanup('acme')).resolves.toMatchObject({
      sandboxes: 0, trafficPolicies: 0, snat: 0,
    });
    expect(sandboxes).toEqual([{ name: 'as-other-1', workspaceId: 'ws_other__u-2' }]);
  });

  it('fails closed when ACS cannot provide the authoritative sandbox inventory', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'offline' }), { status: 503 })) as typeof fetch;
    const lifecycle = createTenantExternalRuntimeLifecycle(config, undefined, fetchImpl);
    await expect(lifecycle.verify('acme')).rejects.toThrow('TENANT_DELETE_ACS_VERIFY_FAILED:503');
  });
});
