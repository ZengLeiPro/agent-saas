import { describe, expect, it, vi } from 'vitest';

import { HttpSecretVault, type VaultCaller } from '../security/secretVault.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestPath(input: string | URL | Request): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(url).pathname;
}

function makeFetch(responder: (path: string, body: any) => unknown) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const path = new URL(u).pathname;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return jsonResponse(responder(path, body));
  }) as unknown as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it('rejects an in-flight metadata response invalidated before it returns', async () => {
    const firstResponse = deferred<Response>();
    let inspectCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const path = new URL(input instanceof URL ? input : input.toString()).pathname;
      if (path !== '/secrets/inspect') throw new Error(`unexpected path ${path}`);
      inspectCount += 1;
      if (inspectCount === 1) return await firstResponse.promise;
      return jsonResponse({ ...remoteRef('ref-a'), version: 2 });
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      metadataCacheTtlMs: 60_000,
    });

    const pendingInspect = vault.inspectRef('ref-a', caller);
    await vi.waitFor(() => expect(inspectCount).toBe(1));
    vault.invalidate('ref-a');
    firstResponse.resolve(jsonResponse(remoteRef('ref-a')));

    await expect(pendingInspect).rejects.toThrow('response was invalidated while request was in flight');
    await expect(vault.inspectRef('ref-a', caller)).resolves.toMatchObject({ version: 2 });
    expect(inspectCount).toBe(2);
  });

  it('rejects an in-flight plaintext response invalidated before it returns', async () => {
    const firstResponse = deferred<Response>();
    let resolveCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const path = new URL(input instanceof URL ? input : input.toString()).pathname;
      if (path !== '/secrets/resolve') throw new Error(`unexpected path ${path}`);
      resolveCount += 1;
      if (resolveCount === 1) return await firstResponse.promise;
      return jsonResponse({ value: 'new', ref: { ...remoteRef('ref-a'), version: 2 } });
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 60_000,
    });

    const pendingResolve = vault.getSecret('ref-a', caller);
    await vi.waitFor(() => expect(resolveCount).toBe(1));
    vault.invalidate('ref-a');
    firstResponse.resolve(jsonResponse({ value: 'old', ref: remoteRef('ref-a') }));

    await expect(pendingResolve).rejects.toThrow('response was invalidated while request was in flight');
    await expect(vault.getSecret('ref-a', caller)).resolves.toBe('new');
    expect(resolveCount).toBe(2);
  });

  it('prevents a completed rotate from being crossed by an older in-flight resolve', async () => {
    const firstResponse = deferred<Response>();
    let resolveCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const path = new URL(input instanceof URL ? input : input.toString()).pathname;
      if (path === '/secrets/resolve') {
        resolveCount += 1;
        if (resolveCount === 1) return await firstResponse.promise;
        return jsonResponse({ value: 'new', ref: { ...remoteRef('ref-a'), version: 2 } });
      }
      if (path === '/secrets/ref-a/rotate') {
        return jsonResponse({ ...remoteRef('ref-a'), version: 2 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local',
      authToken: 'test-token-xyz',
      fetchImpl,
      cacheTtlMs: 60_000,
    });

    const pendingResolve = vault.getSecret('ref-a', caller);
    await vi.waitFor(() => expect(resolveCount).toBe(1));
    await vault.rotateSecret('ref-a', 'new', caller);
    firstResponse.resolve(jsonResponse({ value: 'old', ref: remoteRef('ref-a') }));

    await expect(pendingResolve).rejects.toThrow('response was invalidated while request was in flight');
    await expect(vault.getSecret('ref-a', caller)).resolves.toBe('new');
    expect(resolveCount).toBe(2);
  });

  it('invalidates plaintext and metadata when rotate commits remotely but returns HTTP 500', async () => {
    let value = 'old';
    let version = 1;
    let resolveCount = 0;
    let inspectCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const path = requestPath(input);
      if (path === '/secrets/resolve') {
        resolveCount += 1;
        return jsonResponse({ value, ref: { ...remoteRef('ref-a'), version } });
      }
      if (path === '/secrets/inspect') {
        inspectCount += 1;
        return jsonResponse({ ...remoteRef('ref-a'), version });
      }
      if (path === '/secrets/ref-a/rotate') {
        value = 'new';
        version = 2;
        return jsonResponse({ error: 'response lost after commit' }, 500);
      }
      throw new Error(`unexpected path ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local', authToken: 'test-token-xyz', fetchImpl,
      cacheTtlMs: 60_000, metadataCacheTtlMs: 60_000,
    });

    await expect(vault.getSecret('ref-a', caller)).resolves.toBe('old');
    await expect(vault.rotateSecret('ref-a', 'new', caller)).rejects.toThrow('HTTP 500');
    await expect(vault.inspectRef('ref-a', caller)).resolves.toMatchObject({ version: 2 });
    await expect(vault.getSecret('ref-a', caller)).resolves.toBe('new');
    expect({ resolveCount, inspectCount }).toEqual({ resolveCount: 2, inspectCount: 1 });
  });

  it('invalidates caches before validating a malformed rotate response', async () => {
    let value = 'old';
    let version = 1;
    let resolveCount = 0;
    let inspectCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const path = requestPath(input);
      if (path === '/secrets/resolve') {
        resolveCount += 1;
        return jsonResponse({ value, ref: { ...remoteRef('ref-a'), version } });
      }
      if (path === '/secrets/inspect') {
        inspectCount += 1;
        return jsonResponse({ ...remoteRef('ref-a'), version });
      }
      if (path === '/secrets/ref-a/rotate') {
        value = 'new';
        version = 2;
        return jsonResponse({ id: 'ref-a' });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local', authToken: 'test-token-xyz', fetchImpl,
      cacheTtlMs: 60_000, metadataCacheTtlMs: 60_000,
    });

    await expect(vault.getSecret('ref-a', caller)).resolves.toBe('old');
    await expect(vault.rotateSecret('ref-a', 'new', caller)).rejects.toThrow(/malformed/);
    await expect(vault.inspectRef('ref-a', caller)).resolves.toMatchObject({ version: 2 });
    await expect(vault.getSecret('ref-a', caller)).resolves.toBe('new');
    expect({ resolveCount, inspectCount }).toEqual({ resolveCount: 2, inspectCount: 1 });
  });

  it('invalidates caches when revoke commits remotely but its response times out', async () => {
    let revoked = false;
    let resolveCount = 0;
    let inspectCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const path = requestPath(input);
      if (path === '/secrets/resolve') {
        resolveCount += 1;
        if (revoked) return jsonResponse({ error: 'revoked' }, 410);
        return jsonResponse({ value: 'old', ref: remoteRef('ref-a') });
      }
      if (path === '/secrets/inspect') {
        inspectCount += 1;
        return jsonResponse({
          ...remoteRef('ref-a'), version: 2,
          revokedAt: '2026-09-05T00:00:00.000Z',
        });
      }
      if (path === '/secrets/ref-a/revoke') {
        revoked = true;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local', authToken: 'test-token-xyz', fetchImpl,
      requestTimeoutMs: 10, cacheTtlMs: 60_000, metadataCacheTtlMs: 60_000,
    });

    await expect(vault.getSecret('ref-a', caller)).resolves.toBe('old');
    await expect(vault.revokeSecret('ref-a', caller)).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(vault.inspectRef('ref-a', caller)).resolves.toMatchObject({ version: 2 });
    await expect(vault.getSecret('ref-a', caller)).rejects.toThrow('HTTP 410');
    expect({ resolveCount, inspectCount }).toEqual({ resolveCount: 2, inspectCount: 1 });
  });

  it('authorizes a metadata cache hit against the actual tenant-owned ref', async () => {
    const actual = {
      ...remoteRef('shared-id', 'tenant:tenant-a'),
      metadata: { probe: 'alice-only' },
    };
    const fetchImpl = makeFetch(() => actual);
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local', authToken: 'test-token-xyz', fetchImpl,
      metadataCacheTtlMs: 60_000,
    });
    const tenantA: VaultCaller = {
      actor: 'mcp_proxy', userId: 'alice', tenantId: 'tenant-a', scopes: ['secret:mcp:read'],
    };
    const tenantB: VaultCaller = {
      actor: 'mcp_proxy', userId: 'bob', tenantId: 'tenant-b', scopes: ['secret:mcp:read'],
    };
    const forgedForTenantB = { ...actual, ownerId: 'tenant:tenant-b', metadata: {} };

    await expect(vault.inspectRef('shared-id', tenantA)).resolves.toMatchObject(actual);
    await expect(vault.inspectRef(forgedForTenantB, tenantB)).rejects.toThrow(/tenant owner mismatch/);
    await expect(vault.inspectRef('shared-id', {
      actor: 'system', userId: '__system__', scopes: ['secret:metadata:read'],
    })).resolves.toMatchObject(actual);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not trust a forged owner or kind when a user-owned metadata ref is cached', async () => {
    const actual = { ...remoteRef('shared-id', 'alice'), metadata: { probe: 'alice-only' } };
    const fetchImpl = makeFetch(() => actual);
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.local', authToken: 'test-token-xyz', fetchImpl,
      metadataCacheTtlMs: 60_000,
    });
    const forgedForBob = { ...actual, ownerId: 'bob', kind: 'connector', metadata: {} };
    const bob: VaultCaller = {
      actor: 'connector_proxy', userId: 'bob', scopes: ['secret:connector:read'],
    };

    await expect(vault.inspectRef('shared-id', caller)).resolves.toMatchObject(actual);
    await expect(vault.inspectRef(forgedForBob, bob)).rejects.toThrow(/missing secret:mcp:read/);
    expect(fetchImpl).toHaveBeenCalledOnce();
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
