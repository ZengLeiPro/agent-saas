import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

import { createAuthMiddleware } from '../auth/middleware.js';
import { TENANT_DISABLED_MESSAGE, wrapDispatchWithTenantAccess } from '../data/tenants/access.js';

describe('disabled tenant hard-stop guards', () => {
  it('auth middleware rejects an existing token when the user tenant is disabled', () => {
    const secret = 'tenant-disabled-secret';
    const token = jwt.sign(
      { sub: 'u-wain', username: 'wain_user', role: 'user', tenantId: 'wain' },
      secret,
      { expiresIn: '1h' },
    );
    const middleware = createAuthMiddleware(
      secret,
      {
        findById: vi.fn(() => ({
          id: 'u-wain',
          username: 'wain_user',
          role: 'user',
          tenantId: 'wain',
        })),
      } as any,
      {
        findById: vi.fn(() => ({ id: 'wain', name: '唯恩', disabled: true })),
      } as any,
    );
    const req = {
      method: 'GET',
      path: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
      query: {},
    } as any;
    const res = fakeResponse();
    const next = vi.fn();

    middleware(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: TENANT_DISABLED_MESSAGE, code: 'TENANT_DISABLED' });
  });

  it('dispatch wrapper short-circuits runs for disabled tenants', async () => {
    const dispatch = vi.fn(async function* () {
      yield { type: 'done' } as any;
    });
    const guarded = wrapDispatchWithTenantAccess(dispatch as any, {
      findById: vi.fn(() => ({ id: 'wain', name: '唯恩', disabled: true })),
    } as any);

    const events = [];
    for await (const event of guarded(
      { channel: 'web', chatId: 's1', content: 'hello' },
      { channel: 'web', user: { id: 'u1', username: 'alice', role: 'user', tenantId: 'wain' } },
    )) {
      events.push(event);
    }

    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'error', error: TENANT_DISABLED_MESSAGE }]);
  });
});

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
  };
}
