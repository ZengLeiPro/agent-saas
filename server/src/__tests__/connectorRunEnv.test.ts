import { describe, expect, it, vi } from 'vitest';

import { buildConnectorRunEnv, reconcileConnectorRunEnv } from '../runtime/connectorRunEnv.js';

describe('buildConnectorRunEnv', () => {
  it('passes immutable userId, username and tenantId to the resolver', async () => {
    const resolver = vi.fn().mockResolvedValue({
      ALIBABA_CLOUD_ACCESS_KEY_ID: 'STS.test',
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'secret',
      ALIBABA_CLOUD_SECURITY_TOKEN: 'token',
    });
    const env = await buildConnectorRunEnv({ resolveConnectorRuntimeEnv: resolver }, {
      id: 'user-immutable-1',
      username: 'alice',
      tenantId: 'tenant-a',
    });

    expect(resolver).toHaveBeenCalledWith({
      userId: 'user-immutable-1',
      username: 'alice',
      tenantId: 'tenant-a',
    });
    expect(env.ALIBABA_CLOUD_ACCESS_KEY_ID).toBe('STS.test');
  });

  it('strips an admin actor connector env and rebuilds it for the immutable session owner', async () => {
    const resolver = vi.fn().mockResolvedValue({ ALIBABA_CLOUD_ACCESS_KEY_ID: 'STS.owner' });
    const env = await reconcileConnectorRunEnv({ resolveConnectorRuntimeEnv: resolver }, {
      identity: { userId: 'user-owner', username: 'alice', tenantId: 'tenant-a' },
      resolvedFor: { userId: 'admin-1', username: 'admin', tenantId: 'pantheon' },
      injectedKeys: ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'],
      env: {
        ALIBABA_CLOUD_ACCESS_KEY_ID: 'STS.admin',
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'admin-secret',
        UNRELATED_ENV: 'keep-me',
      },
    });

    expect(resolver).toHaveBeenCalledWith({ userId: 'user-owner', username: 'alice', tenantId: 'tenant-a' });
    expect(env).toMatchObject({ ALIBABA_CLOUD_ACCESS_KEY_ID: 'STS.owner', UNRELATED_ENV: 'keep-me' });
    expect(env.ALIBABA_CLOUD_ACCESS_KEY_SECRET).toBeUndefined();
  });

  it.each([
    { username: 'alice', tenantId: 'tenant-a' },
    { id: 'user-1', tenantId: 'tenant-a' },
    { id: 'user-1', username: 'alice' },
  ])('fails closed when the immutable identity is incomplete: %j', async identity => {
    const resolver = vi.fn().mockResolvedValue({ GH_TOKEN: 'should-not-resolve' });
    await expect(buildConnectorRunEnv({ resolveConnectorRuntimeEnv: resolver }, identity)).resolves.toEqual({});
    expect(resolver).not.toHaveBeenCalled();
  });
});
