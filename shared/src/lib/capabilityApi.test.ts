import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./authFetch', () => ({ authFetch: vi.fn() }));
import { authFetch } from './authFetch';
import { fetchAuthConnectionCapability } from './capabilityApi';
import { evaluateCapability } from './authConnectionCapability';
const mocked = vi.mocked(authFetch);
const input = { userId: 'u1', tenantId: 't1', provider: 'google-workspace', channel: 'mobile' as const, operation: 'connection' as const };
const authoritative = evaluateCapability({ ...input, correlationId: 'server-correlation', observedAt: '2026-08-30T00:00:00Z', providerConfigured: true, callbackDomainConfigured: true, ssoAvailable: true, credential: 'valid', network: 'online', server: 'healthy', tenantAllowed: true });

describe('capability API fail-closed policy', () => {
  beforeEach(() => mocked.mockReset());
  it('hydrates valid authoritative status', async () => {
    mocked.mockResolvedValue({ ok: true, json: async () => authoritative } as Response);
    await expect(fetchAuthConnectionCapability(input)).resolves.toEqual(authoritative);
  });
  it('server 5xx becomes unknown and blocked', async () => {
    mocked.mockResolvedValue({ ok: false, status: 503 } as Response);
    await expect(fetchAuthConnectionCapability(input)).resolves.toMatchObject({ mode: 'blocked', reasonCode: 'unknown_server_capability' });
  });
  it('N-1 404 becomes unknown and blocked', async () => {
    mocked.mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchAuthConnectionCapability(input)).resolves.toMatchObject({ mode: 'blocked', allowedActions: [] });
  });
  it('invalid response cannot be guessed normal', async () => {
    mocked.mockResolvedValue({ ok: true, json: async () => ({ mode: 'normal' }) } as Response);
    await expect(fetchAuthConnectionCapability(input)).resolves.toMatchObject({ reasonCode: 'unknown_server_capability' });
  });
  it('network failure becomes unknown', async () => {
    mocked.mockImplementationOnce(async () => { throw new Error('offline'); });
    await expect(fetchAuthConnectionCapability(input)).resolves.toMatchObject({ authoritative: false, requiresServerRevalidation: true });
  });
  it('explicit browser N-1 only permits browser flow', async () => {
    mocked.mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchAuthConnectionCapability({ ...input, explicitBrowserFlow: true })).resolves.toMatchObject({ allowedActions: ['use_system_browser_sso'] });
  });
});
