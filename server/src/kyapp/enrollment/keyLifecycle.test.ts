import { describe, expect, it, vi } from 'vitest';

import { KyAppV2KeyLifecycleService } from './keyLifecycle.js';

const installation = {
  installationId: 'inst-1',
  tenantId: 'tenant-1',
  systemId: 'system-1',
  baseUrl: 'https://business.example.com',
  status: 'enabled',
  authMode: 'v2_asymmetric',
  deploymentId: 'deployment-1',
  currentKeyId: 'current-key',
  identityGeneration: 1,
};
const current = {
  installationId: 'inst-1',
  keyId: 'current-key',
  deploymentId: 'deployment-1',
  publicJwk: {},
  status: 'current',
  generation: 1,
};
const next = {
  installationId: 'inst-1',
  keyId: 'next-key',
  deploymentId: 'deployment-1',
  publicJwk: {},
  status: 'next',
  generation: 2,
};

function service(overrides: Record<string, unknown> = {}) {
  return new KyAppV2KeyLifecycleService({
    config: { issuer: 'https://platform.example.com', jwksUrl: 'https://api.example.com/jwks' },
    systems: { getInstallation: async () => installation },
    keys: {
      current: async () => current,
      next: async () => next,
      commitNext: vi.fn(async () => ({ ...next, status: 'current' })),
      revokeAll: vi.fn(async () => 2),
    },
    authenticator: {
      authenticateResource: async () => ({ installation, claims: {} }),
      authenticateTokenRequest: async () => ({}),
    },
    installations: {
      setStatus: vi.fn(async () => ({ ...installation, status: 'disabled' })),
      signalIdentityChanged: vi.fn(),
    },
    outbound: {},
    audit: {
      append: async (input: Record<string, unknown>) => ({
        ...input,
        auditId: `audit-${String(input.result)}`,
        occurredAt: new Date().toISOString(),
      }),
    },
    ...overrides,
  } as never);
}

describe('KyAppV2KeyLifecycleService', () => {
  it('有任一预期实例未报告 next key 时不切换', async () => {
    const commitNext = vi.fn();
    const lifecycle = service({
      keys: { current: async () => current, next: async () => next, commitNext },
    });
    await expect(
      lifecycle.commit({
        installationId: 'inst-1',
        accessToken: 'token',
        currentDpopProof: 'current-proof',
        nextClientAssertion: 'next-assertion',
        nextDpopProof: 'next-proof',
        generation: 2,
        expectedInstanceIds: ['pod-a', 'pod-b'],
        observations: [{ instanceId: 'pod-a', keyId: 'next-key', generation: 2 }],
      }),
    ).rejects.toMatchObject({ reason: 'instances_not_ready' });
    expect(commitNext).not.toHaveBeenCalled();
  });

  it('全部实例加载 next key 后才 CAS 切换并失效后续会话快照', async () => {
    const commitNext = vi.fn(async () => ({ ...next, status: 'current' }));
    const signalIdentityChanged = vi.fn();
    const lifecycle = service({
      keys: { current: async () => current, next: async () => next, commitNext },
      installations: { signalIdentityChanged },
    });
    await expect(
      lifecycle.commit({
        installationId: 'inst-1',
        accessToken: 'token',
        currentDpopProof: 'current-proof',
        nextClientAssertion: 'next-assertion',
        nextDpopProof: 'next-proof',
        generation: 2,
        expectedInstanceIds: ['pod-a', 'pod-b'],
        observations: [
          { instanceId: 'pod-a', keyId: 'next-key', generation: 2 },
          { instanceId: 'pod-b', keyId: 'next-key', generation: 2 },
        ],
      }),
    ).resolves.toMatchObject({ keyId: 'next-key', status: 'current' });
    expect(commitNext).toHaveBeenCalledWith(
      expect.objectContaining({
        currentKeyId: 'current-key',
        nextKeyId: 'next-key',
        generation: 2,
      }),
    );
    expect(signalIdentityChanged).toHaveBeenCalledWith('inst-1');
  });

  it('撤销先停用全部部署公钥，再停用安装实例并广播状态', async () => {
    const order: string[] = [];
    const lifecycle = service({
      keys: {
        revokeAll: async () => {
          order.push('keys');
          return 2;
        },
      },
      installations: {
        setStatus: async () => {
          order.push('status');
          return { ...installation, status: 'disabled' };
        },
        signalIdentityChanged: () => order.push('snapshot'),
      },
    });
    await expect(
      lifecycle.revoke('inst-1', { sub: 'admin', role: 'admin' }),
    ).resolves.toMatchObject({ status: 'disabled' });
    expect(order).toEqual(['keys', 'status', 'snapshot']);
  });
});
