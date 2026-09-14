import { describe, expect, it } from 'vitest';

import { createKyAppV2Router } from './v2Router.js';

describe('V2 接入路由', () => {
  it('业务管理员未允许接入时返回隐藏端点，而不是泄露内部 500', async () => {
    const router = createKyAppV2Router({
      enabled: true,
      manifestDigest: 'sha256:test',
      enrollment: {
        challenge: async () => {
          throw new Error('enrollment_disabled');
        },
      } as never,
      bindings: {} as never,
      keys: {} as never,
      authorizeStatus: async () => false,
    });
    const response = await router.request('/ky/v2/enrollment/challenge', {
      method: 'POST',
      headers: {
        authorization: 'Bearer platform-proof',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operationId: 'op-1',
        nonce: 'nonce-1',
        platformIssuer: 'https://platform.example.com',
        installationId: 'iid-1',
        tenantId: 'tenant-1',
        systemId: 'system-1',
        origin: 'https://app.example.com',
        callbackUrl: 'https://app.example.com/ky/v2/enrollment/callback',
      }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});
