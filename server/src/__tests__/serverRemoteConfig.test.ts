import { describe, expect, it, vi } from 'vitest';

import { resolveServerRemoteDispatchConfig } from '../app/serverRemoteConfig.js';

describe('serverRemote runtime config resolution', () => {
  it('keeps the safe SecretVault reference beside the resolved token', async () => {
    const getSecret = vi.fn(async () => 'resolved-token');

    await expect(
      resolveServerRemoteDispatchConfig(
        {
          baseUrl: 'https://acs.example.test',
          authTokenRef: 'secret://server-remote/current',
        },
        { getSecret } as never,
      ),
    ).resolves.toEqual({
      baseUrl: 'https://acs.example.test',
      authToken: 'resolved-token',
      authTokenRef: 'secret://server-remote/current',
    });
    expect(getSecret).toHaveBeenCalledWith('secret://server-remote/current', {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:server_remote:read'],
    });
  });

  it('does not invent a reference for an inline development token', async () => {
    await expect(
      resolveServerRemoteDispatchConfig(
        {
          baseUrl: 'http://127.0.0.1:3300',
          authToken: 'inline-token',
          invokeTimeoutMs: 30_000,
        },
        {} as never,
      ),
    ).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:3300',
      authToken: 'inline-token',
      invokeTimeoutMs: 30_000,
    });
  });
});
