import { describe, expect, it, vi } from 'vitest';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CapabilityTokenService } from '../security/capabilityToken.js';
import { EncryptedFileSecretVault, InMemorySecretVault } from '../security/secretVault.js';

describe('CapabilityTokenService', () => {
  it('issues scoped short-lived tokens and verifies required scopes', () => {
    const service = new CapabilityTokenService({ signingKey: 'test-key', now: () => new Date('2026-06-17T00:00:00Z') });
    const issued = service.issue({ sessionId: 's1', userId: 'u1', scopes: ['mcp:invoke'], toolName: 'search' });

    expect(service.verify(issued.token, ['mcp:invoke'])).toMatchObject({
      sessionId: 's1',
      userId: 'u1',
      scopes: ['mcp:invoke'],
      toolName: 'search',
    });
    expect(() => service.verify(issued.token, ['secret:*:read'])).toThrow(/missing scope/);
  });

  it('rejects expired tokens', () => {
    let now = new Date('2026-06-17T00:00:00Z');
    const service = new CapabilityTokenService({ signingKey: 'test-key', defaultTtlMs: 1000, now: () => now });
    const issued = service.issue({ sessionId: 's1', userId: 'u1', scopes: ['mcp:invoke'] });

    now = new Date('2026-06-17T00:00:02Z');
    expect(() => service.verify(issued.token)).toThrow(/expired/);
  });
});

describe('InMemorySecretVault', () => {
  it('returns only refs from putSecret and enforces caller scopes', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('user-1', 'oauth', 'secret-token', { provider: 'demo' });

    expect(ref).not.toHaveProperty('value');
    await expect(vault.getSecret(ref, { actor: 'mcp_proxy', userId: 'user-1', scopes: ['secret:oauth:read'] })).resolves.toBe('secret-token');
    await expect(vault.getSecret(ref, { actor: 'mcp_proxy', userId: 'user-2', scopes: ['secret:oauth:read'] })).rejects.toThrow(/denied/);
    await expect(vault.getSecret(ref, { actor: 'mcp_proxy', userId: 'user-1', scopes: [] })).rejects.toThrow(/denied/);
    await expect(vault.getSecret(ref, { actor: 'mcp_proxy', scopes: ['secret:oauth:read'] })).rejects.toThrow(/denied/);
  });
});


describe('EncryptedFileSecretVault', () => {
  it('persists encrypted secrets without plaintext in the vault file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-test-'));
    try {
      const file = join(dir, 'vault.json');
      const vault = new EncryptedFileSecretVault(file, 'local-dev-key');
      const ref = await vault.putSecret('user-1', 'mcp', 'super-secret-token');
      const raw = await readFile(file, 'utf-8');
      expect(raw).not.toContain('super-secret-token');

      const reopened = new EncryptedFileSecretVault(file, 'local-dev-key');
      await expect(reopened.getSecret(ref, { actor: 'mcp_proxy', userId: 'user-1', scopes: ['secret:mcp:read'] })).resolves.toBe('super-secret-token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('HttpSecretVault', async () => {
  const { HttpSecretVault } = await import('../security/secretVault.js');

  it('rejects unsafe remote configuration and sends bearer auth to external vault', async () => {
    expect(() => new HttpSecretVault({ baseUrl: 'http://example.com', authToken: 'secret-token' })).toThrow(/https/);
    expect(() => new HttpSecretVault({ baseUrl: 'https://vault.example.com', authToken: '' })).toThrow(/authToken/);

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ value: 'resolved-secret' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const vault = new HttpSecretVault({ baseUrl: 'https://vault.example.com/', authToken: 'secret-token', fetchImpl });
    await expect(vault.getSecret('ref-1', { actor: 'mcp_proxy', userId: 'user-1', scopes: ['secret:mcp:read'] })).resolves.toBe('resolved-secret');
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('https://vault.example.com/secrets/resolve');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
  });
});
