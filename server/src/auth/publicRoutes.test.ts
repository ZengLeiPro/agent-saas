import { describe, expect, it } from 'vitest';

import { isPublicRoute } from './publicRoutes.js';

function request(method: string, path: string) {
  return { method, path } as Parameters<typeof isPublicRoute>[0];
}

describe('isPublicRoute KY App V2', () => {
  it.each([
    '/app-contract/v2/oauth/token',
    '/app-contract/v2/installations/iid-1/activate',
    '/app-contract/v2/installations/iid-1/keys/prepare',
    '/app-contract/v2/installations/iid-1/keys/commit',
  ])('allows the self-authenticated POST route %s through session auth', (path) => {
    expect(isPublicRoute(request('POST', path))).toBe(true);
  });

  it.each([
    '/app-contract/v2/installations/iid-1/activate/extra',
    '/app-contract/v2/installations/iid-1/keys',
    '/app-contract/v2/installations//activate',
  ])('does not broaden the public route boundary to %s', (path) => {
    expect(isPublicRoute(request('POST', path))).toBe(false);
  });

  it('does not allow other methods on self-authenticated endpoints', () => {
    expect(isPublicRoute(request('GET', '/app-contract/v2/installations/iid-1/activate'))).toBe(
      false,
    );
  });
});
