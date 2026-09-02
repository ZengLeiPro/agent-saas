import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  parseOAuthCallbackUrl,
  validateOAuthCallback,
  type OAuthCallbackTransaction,
} from './oauthCallbackBridge';

const redirect = 'agent-saas://oauth/callback';
const identity = { userId: 'user-a', tenantId: 'tenant-a', generation: 7 };
const transaction: OAuthCallbackTransaction = {
  state: 's'.repeat(43), pkceVerifier: 'v'.repeat(64), provider: 'google-workspace',
  redirectUri: redirect, identity, createdAt: 1_000,
};
function payload(overrides: Record<string, string | number> = {}) {
  const query = new URLSearchParams({ state: transaction.state, code: 'c'.repeat(48), provider: transaction.provider, redirect, generation: '7' });
  for (const [key, value] of Object.entries(overrides)) query.set(key, String(value));
  return parseOAuthCallbackUrl(`${redirect}?${query}`, [redirect])!;
}

describe('M30-01 OAuth callback pure state machine', () => {
  it('accepts allowlisted custom scheme and verified HTTPS callback shapes', () => {
    expect(payload()).toMatchObject({ state: transaction.state, code: 'c'.repeat(48) });
    const https = 'https://mobile.example.test/oauth/callback';
    expect(parseOAuthCallbackUrl(`${https}?state=${'a'.repeat(43)}&error=ACCESS_DENIED&provider=p&redirect=${encodeURIComponent(https)}&generation=1`, [https]))
      .toMatchObject({ error: 'ACCESS_DENIED' });
  });

  it('fails closed for unknown domain/route, fragments, and code/error ambiguity', () => {
    expect(parseOAuthCallbackUrl(`https://evil.test/oauth/callback?state=${'a'.repeat(43)}&code=${'c'.repeat(48)}&provider=p&generation=1`, [redirect])).toBeNull();
    expect(parseOAuthCallbackUrl(`${redirect}/extra?state=${'a'.repeat(43)}&code=${'c'.repeat(48)}&provider=p&generation=1`, [redirect])).toBeNull();
    expect(parseOAuthCallbackUrl(`${redirect}?state=${'a'.repeat(43)}&code=${'c'.repeat(48)}&error=DENIED&provider=p&generation=1`, [redirect])).toBeNull();
  });

  it.each([
    ['state', { state: 'x'.repeat(43) }, 'OAUTH_STATE_MISMATCH'],
    ['provider', { provider: 'mcp-other' }, 'OAUTH_PROVIDER_MISMATCH'],
    ['redirect', { redirect: 'https://other.test/oauth/callback' }, null],
    ['generation', { generation: 8 }, 'OAUTH_IDENTITY_BOUNDARY_CHANGED'],
  ])('rejects %s mismatch', (_label, change, expected) => {
    const parsed = payload(change);
    if (!expected) return expect(parsed).toBeNull();
    expect(validateOAuthCallback({ transaction, payload: parsed, currentIdentity: identity, now: 2_000 })).toMatchObject({ ok: false, code: expected });
  });

  it('rejects expiry and A-account start/B-account return', () => {
    expect(validateOAuthCallback({ transaction, payload: payload(), currentIdentity: identity, now: 700_001, ttlMs: 600_000 })).toMatchObject({ code: 'OAUTH_TRANSACTION_EXPIRED' });
    expect(validateOAuthCallback({ transaction, payload: payload(), currentIdentity: { ...identity, userId: 'user-b' }, now: 2_000 })).toMatchObject({ code: 'OAUTH_IDENTITY_BOUNDARY_CHANGED' });
  });

  it('constant-time comparator handles equal, length and value mismatch', () => {
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'samf')).toBe(false);
    expect(constantTimeEqual('same', 'same-longer')).toBe(false);
  });
});
