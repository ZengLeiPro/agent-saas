import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import {
  GROK_DISCOVERY_ENDPOINT,
  GROK_OAUTH_ISSUER,
  GROK_DEVICE_GRANT,
  GrokProtocolError,
  trustedGrokOAuthUrl,
  positiveSeconds,
} from '../runtime/responses/grokProtocol.js';
import { grokTokens, jsonResponse } from './grokTestFixtures.js';
const discovery = {
  issuer: GROK_OAUTH_ISSUER,
  device_authorization_endpoint: 'https://auth.x.ai/device',
  token_endpoint: 'https://auth.x.ai/token',
  userinfo_endpoint: 'https://auth.x.ai/userinfo',
  revocation_endpoint: 'https://auth.x.ai/revoke',
};
afterEach(() => vi.restoreAllMocks());
describe('Grok trusted OAuth contracts T13-T17', () => {
  it('discovers once, sends RFC8628 form fields, and trusts authenticated userinfo rather than JWT claims', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === GROK_DISCOVERY_ENDPOINT) return jsonResponse(discovery);
      if (String(url).endsWith('/device'))
        return jsonResponse({
          device_code: 'private-device',
          user_code: 'FIXTURE-CODE',
          verification_uri: 'https://auth.x.ai/activate',
          interval: 5,
          expires_in: 600,
        });
      if (String(url).endsWith('/token'))
        return jsonResponse({
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          id_token: 'untrusted.jwt.fixture',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      if (String(url).endsWith('/userinfo')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-access');
        return jsonResponse({
          sub: 'trusted-account',
          email: 'a@example.invalid',
          email_verified: true,
        });
      }
      throw new Error('unexpected fixture URL');
    });
    const client = new GrokOAuthClient(fetcher as typeof fetch, () => 1000);
    const device = await client.start('registered-test-client');
    const token = await client.poll(device);
    expect(token).toMatchObject({
      accountId: 'trusted-account',
      clientId: 'registered-test-client',
      expiresAt: new Date(3_601_000).toISOString(),
    });
    const tokenCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/token'))!;
    expect(Object.fromEntries(new URLSearchParams(String(tokenCall[1]?.body)))).toEqual({
      grant_type: GROK_DEVICE_GRANT,
      device_code: 'private-device',
      client_id: 'registered-test-client',
    });
    expect(
      fetcher.mock.calls.filter(([url]) => String(url) === GROK_DISCOVERY_ENDPOINT),
    ).toHaveLength(1);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
  it.each([
    'http://auth.x.ai/token',
    'https://auth.x.ai.evil.invalid/token',
    'https://127.0.0.1/token',
    'https://secret@auth.x.ai/token',
    'https://auth.x.ai:444/token',
    'https://auth.x.ai/token#secret',
  ])('rejects untrusted discovery URL %s', async (url) => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ ...discovery, token_endpoint: url }));
    await expect(new GrokOAuthClient(fetcher).discover()).rejects.toThrow(
      'untrusted_oauth_endpoint',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a wrong issuer and unsafe verification links', async () => {
    await expect(
      new GrokOAuthClient(
        vi.fn().mockResolvedValue(jsonResponse({ ...discovery, issuer: 'https://evil.invalid' })),
      ).discover(),
    ).rejects.toThrow('invalid_issuer');
    expect(() => trustedGrokOAuthUrl('javascript:alert(1)', true)).toThrow();
    expect(() => trustedGrokOAuthUrl('https://x.ai.evil.invalid', true)).toThrow();
  });
  it.each([null, '3600', -1, 0, 0.5, Number.MAX_SAFE_INTEGER, Infinity])(
    'rejects malformed expires_in %s',
    (value) => {
      expect(() => positiveSeconds(value)).toThrow('invalid_expiration');
    },
  );
  it('refresh uses the original client and rejects changed identity or unknown network outcomes', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === GROK_DISCOVERY_ENDPOINT) return jsonResponse(discovery);
      if (String(url).endsWith('/token')) {
        expect(new URLSearchParams(String(init?.body)).get('client_id')).toBe('fixture-client');
        return jsonResponse({
          access_token: 'fixture-new',
          refresh_token: 'fixture-rotated',
          expires_in: 3600,
        });
      }
      return jsonResponse({ sub: 'different-identity' });
    });
    await expect(
      new GrokOAuthClient(fetcher as typeof fetch).refresh(grokTokens()),
    ).rejects.toMatchObject({ code: 'identity_changed', outcomeUnknown: true });
    await expect(
      new GrokOAuthClient(vi.fn().mockRejectedValue(new Error('fixture-secret'))).discover(),
    ).rejects.toMatchObject({ code: 'network_outcome_unknown', outcomeUnknown: true });
  });
  it('enforces pending/slow_down deadlines and single exchange without publishing configuration', async () => {
    let now = 0;
    const client = new GrokOAuthClient();
    vi.spyOn(client, 'start').mockResolvedValue({
      deviceCode: 'private-device',
      userCode: 'FIXTURE',
      verificationUri: 'https://auth.x.ai/activate',
      expiresAt: 600_000,
      intervalMs: 5000,
      clientId: 'fixture',
    });
    const poll = vi
      .spyOn(client, 'poll')
      .mockRejectedValueOnce(new GrokProtocolError('authorization_pending', 400))
      .mockRejectedValueOnce(new GrokProtocolError('slow_down', 400))
      .mockResolvedValue(grokTokens());
    const service = new GrokDeviceAuthService(client, { now: () => now });
    const session = await service.start('admin-a');
    expect(JSON.stringify(session)).not.toContain('private-device');
    await expect(service.poll(session.sessionId, 'admin-a')).resolves.toMatchObject({
      status: 'pending',
    });
    expect(poll).not.toHaveBeenCalled();
    now = 5000;
    await service.poll(session.sessionId, 'admin-a');
    now = 10000;
    expect(await service.poll(session.sessionId, 'admin-a')).toMatchObject({
      status: 'pending',
      intervalMs: 10000,
    });
    now = 15000;
    await service.poll(session.sessionId, 'admin-a');
    expect(poll).toHaveBeenCalledTimes(2);
    now = 20000;
    const results = await Promise.all([
      service.poll(session.sessionId, 'admin-a'),
      service.poll(session.sessionId, 'admin-a'),
    ]);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(results.every((r) => r.status === 'authorized_pending_publication')).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(
      /accessToken|refreshToken|deviceCode|fixture-access/,
    );
    expect(() => service.authorizedResult(session.sessionId, 'admin-b')).toThrow(
      'authorization_not_found',
    );
    service.complete(session.sessionId, 'admin-a');
    expect(service.status(session.sessionId, 'admin-a').status).toBe('applied');
    expect(() => service.authorizedResult(session.sessionId, 'admin-a')).toThrow(
      'authorization_not_ready',
    );
  });
  it.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
    ['upstream_error', 'error'],
  ])('stops polling after %s', async (code, status) => {
    let now = 0;
    const client = new GrokOAuthClient();
    vi.spyOn(client, 'start').mockResolvedValue({
      deviceCode: 'private',
      userCode: 'TEST',
      verificationUri: 'https://auth.x.ai',
      expiresAt: 100000,
      intervalMs: 1000,
      clientId: 'test',
    });
    const poll = vi.spyOn(client, 'poll').mockRejectedValue(new GrokProtocolError(code, 403));
    const service = new GrokDeviceAuthService(client, { now: () => now });
    const s = await service.start('a');
    now = 1000;
    expect(await service.poll(s.sessionId, 'a')).toMatchObject({ status });
    now = 10000;
    await service.poll(s.sessionId, 'a');
    expect(poll).toHaveBeenCalledOnce();
  });
  it('caps sessions, expires secrets and refuses a cancelled in-flight exchange', async () => {
    let now = 0;
    let release!: (value: ReturnType<typeof grokTokens>) => void;
    const client = new GrokOAuthClient();
    vi.spyOn(client, 'start').mockResolvedValue({
      deviceCode: 'private',
      userCode: 'TEST',
      verificationUri: 'https://auth.x.ai',
      expiresAt: 100000,
      intervalMs: 1000,
      clientId: 'test',
    });
    vi.spyOn(client, 'poll').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const service = new GrokDeviceAuthService(client, { now: () => now, maxSessions: 1 });
    const s = await service.start('a');
    await expect(service.start('b')).rejects.toThrow('authorization_capacity');
    now = 1000;
    const pending = service.poll(s.sessionId, 'a');
    const rejected = expect(pending).rejects.toThrow('authorization_not_found');
    service.cancel(s.sessionId, 'a');
    release(grokTokens());
    await rejected;
    const second = await service.start('b');
    now = 100001;
    expect(service.status(second.sessionId, 'b').status).toBe('expired');
    expect(() => service.authorizedResult(second.sessionId, 'b')).toThrow();
  });
});
