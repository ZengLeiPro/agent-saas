import { describe, expect, it, vi } from 'vitest';

import { createPersonalAccessTokenIntegrationPushTokenResolver } from './integrationPushService.js';

describe('Integration v3 personal access token resolver', () => {
  it('returns a credential only after GitHub confirms the exact repository and push permission', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: 123, full_name: 'ZengLeiPro/agent-saas', permissions: { pull: true, push: true },
    }), { status: 200 })) as unknown as typeof fetch;
    const resolver = createPersonalAccessTokenIntegrationPushTokenResolver({
      resolveToken: async () => 'github-pat', fetchImpl,
    });
    await expect(resolver({ tenantId: 'tenant', ownerUserId: 'owner',
      repositoryId: 'github:kaiyan:zengleipro/agent-saas', repositoryOwner: 'ZengLeiPro', repositoryName: 'agent-saas' })).resolves.toEqual({
      token: 'github-pat', mode: 'personal_access_token', repositoryId: 123,
      configuredRepositoryId: 'github:kaiyan:zengleipro/agent-saas',
      configuredRepositoryOwner: 'ZengLeiPro', configuredRepositoryName: 'agent-saas',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/zengleipro/agent-saas', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer github-pat' }),
    }));
  });

  it('rejects github-id:numeric when full_name disagrees with the board owner/name', async () => {
    const resolver = createPersonalAccessTokenIntegrationPushTokenResolver({
      resolveToken: async () => 'github-pat',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        id: 123, full_name: 'other/repo', permissions: { push: true },
      }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(resolver({
      tenantId: 'tenant', ownerUserId: 'owner', repositoryId: 'github-id:123',
      repositoryOwner: 'ZengLeiPro', repositoryName: 'agent-saas',
    })).resolves.toBeUndefined();
  });

  it.each([
    [{ id: 123, full_name: 'other/repo', permissions: { push: true } }, 200],
    [{ id: 123, full_name: 'ZengLeiPro/agent-saas', permissions: { push: false } }, 200],
    [{ id: 123, full_name: 'ZengLeiPro/agent-saas', permissions: { push: true } }, 403],
  ])('fails closed for mismatched or non-writable repository %#', async (body, status) => {
    const resolver = createPersonalAccessTokenIntegrationPushTokenResolver({
      resolveToken: async () => 'github-pat',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
    });
    await expect(resolver({ tenantId: 'tenant', ownerUserId: 'owner',
      repositoryId: 'github:kaiyan:zengleipro/agent-saas', repositoryOwner: 'ZengLeiPro', repositoryName: 'agent-saas' })).resolves.toBeUndefined();
  });
});
