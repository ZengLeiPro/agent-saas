import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NativeOAuthHandoffStore, type NativeOAuthHandoffPersistence } from '../connectors/nativeOAuthHandoff.js';

const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const binding = {
  clientState: 's'.repeat(64), pkceChallenge: challenge, provider: 'google-workspace',
  redirectUri: 'https://mobile.example.test/oauth/callback', identityGeneration: 7, createdAt: Date.now(),
};
function persistence(): NativeOAuthHandoffPersistence {
  return {
    beginNativeHandoff: vi.fn().mockResolvedValue(undefined),
    completeNativeHandoff: vi.fn().mockResolvedValue({ code: 'a'.repeat(48), ...binding }),
    consumeNativeHandoff: vi.fn().mockResolvedValue({ connectorId: 'google-workspace', status: 'succeeded' }),
  };
}

describe('M30-01 server OAuth callback/code exchange boundary', () => {
  it('production shape accepts only fixed HTTPS callback and rejects open redirect/custom scheme by default', () => {
    expect(() => new NativeOAuthHandoffStore(persistence(), 'agent-saas://oauth/callback')).toThrow('allowlisted HTTPS');
    expect(() => new NativeOAuthHandoffStore(persistence(), 'https://app.example.com/oauth/callback?next=evil')).toThrow('allowlisted HTTPS');
    expect(() => new NativeOAuthHandoffStore(persistence(), 'https://user@app.example.com/oauth/callback')).toThrow('allowlisted HTTPS');
    expect(() => new NativeOAuthHandoffStore(persistence(), 'https://app.example.com/other')).toThrow('allowlisted HTTPS');
  });

  it('preview custom scheme requires explicit opt-in', () => {
    expect(() => new NativeOAuthHandoffStore(persistence(), 'agent-saas://oauth/callback', { allowCustomScheme: true })).not.toThrow();
  });

  it('binds user/tenant/provider/redirect/state/PKCE/generation and callback URL contains no access token', async () => {
    const authority = persistence();
    const store = new NativeOAuthHandoffStore(authority, binding.redirectUri);
    await store.begin({ providerState: 'state-provider', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'google-workspace', deviceId: 'device-1234', ...binding });
    const redirect = await store.complete('state-provider', { status: 'succeeded' });
    expect(redirect).toContain(`code=${'a'.repeat(48)}`);
    expect(redirect).toContain(`state=${binding.clientState}`);
    expect(redirect).not.toMatch(/access_token|refresh_token|user-1|tenant-a|device-1234/);
    expect(redirect).not.toContain(verifier);
    await store.consume({ code: 'a'.repeat(48), userId: 'user-1', tenantId: 'tenant-a', deviceId: 'device-1234', pkceVerifier: verifier, ...binding });
    expect(authority.consumeNativeHandoff).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-a', provider: 'google-workspace' }));
  });

  it('rejects PKCE mismatch before persistence exchange', async () => {
    const authority = persistence();
    const store = new NativeOAuthHandoffStore(authority, binding.redirectUri);
    await expect(store.consume({ code: 'a'.repeat(48), userId: 'user-1', tenantId: 'tenant-a', deviceId: 'device-1234', pkceVerifier: 'x'.repeat(64), ...binding })).resolves.toBeNull();
    expect(authority.consumeNativeHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ['provider', { provider: 'other' }], ['redirect', { redirectUri: 'https://other.test/oauth/callback' }],
    ['createdAt', { createdAt: 0 }], ['device', { deviceId: '../bad' }],
  ])('rejects invalid %s binding at start', async (_label, change) => {
    const store = new NativeOAuthHandoffStore(persistence(), binding.redirectUri);
    await expect(store.begin({ providerState: 'state-provider', userId: 'u', tenantId: 't', connectorId: 'google-workspace', deviceId: 'device-1234', ...binding, ...change })).rejects.toThrow('Invalid native OAuth');
  });
});
