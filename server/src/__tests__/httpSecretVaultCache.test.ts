import { describe, expect, it, vi } from 'vitest';

import { HttpSecretVault, type VaultCaller } from '../security/secretVault.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(responder: (path: string, body: any) => unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const path = new URL(u).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return jsonResponse(responder(path, body));
  }) as unknown as typeof fetch;
}

function remoteRef(id: string, ownerId = 'alice') {
  return {
    id,
    ownerId,
    kind: 'mcp',
    version: 1,
    metadata: {},
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const caller = {
  actor: 'mcp_proxy' as const,
  userId: 'alice',
  tenantId: 'tenant-a',
  scopes: ['secret:mcp:read', 'secret:mcp:rotate', 'secret:mcp:revoke'],
};

describe('HttpSecretVault cache (A3)', () => {
  it('caches plaintext only within nonnegative TTL and refetches after clock rollback or expiry', async () => {
    let now = 1_000_000;
    let fetchCount = 0;
    const fetchImpl = makeFetch((path, body) => {
      if (path === '/secrets/resolve') {
        fetchCount += 1;
        return { value: `v${fetchCount}-${body.ref}`, ref: remoteRef(body.ref) };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 5_000,
      nowMs: () => now,
    });
    expect(await vault.getSecret('ref-a', caller)).toBe('v1-ref-a');
    expect(await vault.getSecret('ref-a', caller)).toBe('v1-ref-a');
    expect(fetchCount).toBe(1);
    now = 0;
    expect(await vault.getSecret('ref-a', caller)).toBe('v2-ref-a');
    expect(fetchCount).toBe(2);
    now += 5_001;
    expect(await vault.getSecret('ref-a', caller)).toBe('v3-ref-a');
    expect(fetchCount).toBe(3);
  });

  it('cacheTtlMs=0 disables cache entirely', async () => {
    let fetchCount = 0;
    const fetchImpl = makeFetch((_path, body) => {
      fetchCount += 1;
      return { value: `v${fetchCount}`, ref: remoteRef(body.ref) };
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 0,
    });
    await vault.getSecret('ref-a', caller);
    await vault.getSecret('ref-a', caller);
    await vault.getSecret('ref-a', caller);
    expect(fetchCount).toBe(3);
  });

  it('rotateSecret invalidates the cache for that ref without regressing its version', async () => {
    let now = 1_000_000;
    let resolveCount = 0;
    const fetchImpl = makeFetch((path, body) => {
      if (path === '/secrets/resolve') {
        resolveCount += 1;
        return { value: `v${resolveCount}`, ref: { ...remoteRef(body.ref), version: resolveCount } };
      }
      if (path === '/secrets/ref-a/rotate') {
        return { id: 'ref-a', ownerId: 'alice', kind: 'mcp', version: 2, metadata: {}, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 60_000,
      nowMs: () => now,
    });
    expect(await vault.getSecret('ref-a', caller)).toBe('v1');
    expect(await vault.getSecret('ref-a', caller)).toBe('v1');
    expect(resolveCount).toBe(1);

    await vault.rotateSecret('ref-a', 'new-plaintext', caller);
    expect(await vault.getSecret('ref-a', caller)).toBe('v2');
    expect(resolveCount).toBe(2);
  });

  it('different caller tenant contexts do not share secret cache entries', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ value: 'tenant-a-secret', ref: remoteRef('sec_shared', 'alice') }))
      .mockResolvedValueOnce(jsonResponse({ value: 'tenant-b-secret', ref: remoteRef('sec_shared', 'alice') }));
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.internal',
      authToken: 'service-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const tenantACaller: VaultCaller = {
      actor: 'mcp_proxy', userId: 'alice', tenantId: 'tenant-a', scopes: ['secret:mcp:read'],
    };
    const tenantBCaller: VaultCaller = {
      actor: 'mcp_proxy', userId: 'alice', tenantId: 'tenant-b', scopes: ['secret:mcp:read'],
    };
    await expect(vault.getSecret('sec_shared', tenantACaller)).resolves.toBe('tenant-a-secret');
    await expect(vault.getSecret('sec_shared', tenantBCaller)).resolves.toBe('tenant-b-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('revokeSecret invalidates the cache for that ref', async () => {
    let resolveCount = 0;
    const fetchImpl = makeFetch((path, body) => {
      if (path === '/secrets/resolve') {
        resolveCount += 1;
        return { value: `v${resolveCount}`, ref: remoteRef(body.ref) };
      }
      if (path === '/secrets/ref-a/revoke') {
        return {};
      }
      throw new Error(`unexpected path ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 60_000,
    });
    await vault.getSecret('ref-a', caller);
    await vault.revokeSecret('ref-a', caller);
    // After revoke the upstream would 4xx; here we just confirm cache miss → refetch.
    await vault.getSecret('ref-a', caller).catch(() => undefined);
    expect(resolveCount).toBe(2);
  });

  it('invalidate(ref) public method forces immediate refetch', async () => {
    let resolveCount = 0;
    const fetchImpl = makeFetch((_path, body) => {
      resolveCount += 1;
      return { value: `v${resolveCount}`, ref: remoteRef(body.ref) };
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 60_000,
    });
    expect(await vault.getSecret('ref-a', caller)).toBe('v1');
    expect(await vault.getSecret('ref-a', caller)).toBe('v1');
    expect(resolveCount).toBe(1);
    vault.invalidate('ref-a');
    expect(await vault.getSecret('ref-a', caller)).toBe('v2');
    expect(resolveCount).toBe(2);
  });

  it('evicts least-recently-used entries when maxCacheEntries is reached', async () => {
    let resolveCount = 0;
    const fetchImpl = makeFetch((_path, body) => {
      resolveCount += 1;
      return { value: `${body.ref}-#${resolveCount}`, ref: remoteRef(body.ref) };
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 60_000,
      maxCacheEntries: 2,
    });
    // Fill cache with 2 entries (resolveCount=1,2)
    await vault.getSecret('ref-a', caller);
    await vault.getSecret('ref-b', caller);
    // Both hot cached - re-reading returns cached values without new fetch
    await vault.getSecret('ref-a', caller);
    await vault.getSecret('ref-b', caller);
    expect(resolveCount).toBe(2);
    // ref-a is now LRU (b was last touched). Add ref-c (resolveCount=3) → evicts ref-a.
    await vault.getSecret('ref-c', caller);
    expect(resolveCount).toBe(3);
    // Re-reading ref-a should miss cache and refetch (resolveCount=4).
    // 注意：ref-a 重 fetch 时 cache=[b, c, a] → 立刻挤掉 head b → cache=[c, a]，
    // 所以 ref-b 也已被淘汰，下一次读会再 fetch。
    await vault.getSecret('ref-a', caller);
    expect(resolveCount).toBe(4);
    await vault.getSecret('ref-b', caller);
    expect(resolveCount).toBe(5);
  });

  it('LRU touch updates ordering on every cache hit', async () => {
    let resolveCount = 0;
    const fetchImpl = makeFetch((_path, body) => {
      resolveCount += 1;
      return { value: body.ref, ref: remoteRef(body.ref) };
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 60_000,
      maxCacheEntries: 2,
    });
    await vault.getSecret('ref-a', caller); // fetch
    await vault.getSecret('ref-b', caller); // fetch
    // Touch ref-a → ref-b becomes LRU.
    await vault.getSecret('ref-a', caller); // hit
    expect(resolveCount).toBe(2);
    // Add ref-c → evict ref-b.
    await vault.getSecret('ref-c', caller); // fetch
    expect(resolveCount).toBe(3);
    // ref-a still cached, ref-b evicted.
    await vault.getSecret('ref-a', caller); // hit
    await vault.getSecret('ref-b', caller); // fetch
    expect(resolveCount).toBe(4);
  });

  it('aborts a Vault HTTP request after requestTimeoutMs', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      requestTimeoutMs: 10,
      cacheTtlMs: 0,
    });

    await expect(vault.getSecret('ref-a', caller)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
