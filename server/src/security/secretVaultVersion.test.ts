import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EncryptedFileSecretVault,
  HttpSecretVault,
  InMemorySecretVault,
  type VaultCaller,
} from './secretVault.js';

const roots: string[] = [];
const ENCRYPTION_KEY = 'test-vault-encryption-key';
const CALLER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:tenant-hand:read', 'secret:tenant-hand:rotate'],
};
const REVOKE_CALLER: VaultCaller = {
  actor: 'connector_proxy',
  scopes: ['secret:tenant-hand:revoke'],
};
const HTTP_CALLER: VaultCaller = {
  actor: 'mcp_proxy',
  userId: 'alice',
  scopes: ['secret:mcp:read', 'secret:mcp:write', 'secret:mcp:rotate'],
};

function remoteRef(id: string) {
  return {
    id,
    ownerId: 'alice',
    kind: 'mcp',
    metadata: { purpose: 'test' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    version: 2,
    value: 'remote-ref-plaintext-must-be-dropped',
    extra: 'remote-extra-must-be-dropped',
  };
}

function cleanRemoteRef(id: string) {
  return {
    id,
    ownerId: 'alice',
    kind: 'mcp',
    metadata: { purpose: 'test' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    version: 2,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeLegacyVault(version: number | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'secret-vault-version-'));
  roots.push(root);
  const file = join(root, 'secrets.enc');
  const secret = {
    id: 'legacy-ref-id',
    ownerId: 'global',
    kind: 'tenant-hand',
    value: 'legacy-plaintext-must-never-leak',
    metadata: {},
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...(version === undefined ? {} : { version }),
  };
  const payload = JSON.stringify({ version: 1, secrets: [secret] });
  const key = createHash('sha256').update(ENCRYPTION_KEY).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()]);
  writeFileSync(
    file,
    JSON.stringify({
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    }),
    { mode: 0o600 },
  );
  return file;
}

describe('EncryptedFileSecretVault opaque version migration（TASK-318）', () => {
  it('旧数据缺少 version 时 inspectRef 显式视为 1，且不返回明文', async () => {
    const file = writeLegacyVault(undefined);
    const vault = new EncryptedFileSecretVault(file, ENCRYPTION_KEY);
    const inspected = await vault.inspectRef!('legacy-ref-id', CALLER);

    expect(inspected?.version).toBe(1);
    expect(JSON.stringify(inspected)).not.toContain('legacy-plaintext-must-never-leak');
  });

  it('旧数据首次 rotate 从 1 递增为 2，并在重新实例化后持久保持', async () => {
    const file = writeLegacyVault(undefined);
    const vault = new EncryptedFileSecretVault(file, ENCRYPTION_KEY);
    const rotated = await vault.rotateSecret('legacy-ref-id', 'rotated-secret', CALLER);
    expect(rotated.version).toBe(2);

    const reopened = new EncryptedFileSecretVault(file, ENCRYPTION_KEY);
    const inspected = await reopened.inspectRef!('legacy-ref-id', CALLER);
    expect(inspected?.version).toBe(2);
    expect(JSON.stringify(inspected)).not.toContain('rotated-secret');
  });

  it('非法 opaque version 不静默回退，inspect 与 rotate 都 fail closed', async () => {
    const file = writeLegacyVault(0);
    const vault = new EncryptedFileSecretVault(file, ENCRYPTION_KEY);
    await expect(vault.inspectRef!('legacy-ref-id', CALLER)).rejects.toThrow(
      /invalid opaque version/,
    );
    await expect(vault.rotateSecret('legacy-ref-id', 'rotated', CALLER)).rejects.toThrow(
      /invalid opaque version/,
    );
  });
});

  it('revoke 递增 opaque version、写入 revokedAt，并在重新实例化后保持', async () => {
    const file = writeLegacyVault(undefined);
    const vault = new EncryptedFileSecretVault(file, ENCRYPTION_KEY);
    await vault.revokeSecret('legacy-ref-id', REVOKE_CALLER);

    const reopened = new EncryptedFileSecretVault(file, ENCRYPTION_KEY);
    const inspected = await reopened.inspectRef!('legacy-ref-id', CALLER);
    expect(inspected?.version).toBe(2);
    expect(inspected?.revokedAt).toBeTruthy();
    expect(JSON.stringify(inspected)).not.toContain('legacy-plaintext-must-never-leak');
  });

describe('HttpSecretVault hostile ref 与 rotation version validation（TASK-318）', () => {
  it('get/put/rotate 缓存和返回前丢弃 ref 明文与额外字段', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/secrets/resolve') {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ value: 'resolved-plaintext', ref: remoteRef(body.ref) }));
      }
      if (path === '/secrets') return new Response(JSON.stringify(remoteRef('put-ref-id')));
      if (path === '/secrets/rotate-ref-id/rotate') {
        return new Response(JSON.stringify(remoteRef('rotate-ref-id')));
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: fetchImpl as typeof fetch,
      metadataCacheTtlMs: 60_000,
    });

    expect(await vault.getSecret('get-ref-id', HTTP_CALLER)).toBe('resolved-plaintext');
    expect(await vault.inspectRef!('get-ref-id', HTTP_CALLER)).toEqual(cleanRemoteRef('get-ref-id'));
    expect(await vault.putSecret('alice', 'mcp', 'put-plaintext', HTTP_CALLER)).toEqual(cleanRemoteRef('put-ref-id'));
    expect(await vault.inspectRef!('put-ref-id', HTTP_CALLER)).toEqual(cleanRemoteRef('put-ref-id'));
    expect(await vault.rotateSecret('rotate-ref-id', 'rotate-plaintext', HTTP_CALLER)).toEqual(cleanRemoteRef('rotate-ref-id'));
    expect(await vault.inspectRef!('rotate-ref-id', HTTP_CALLER)).toEqual(cleanRemoteRef('rotate-ref-id'));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rotate 已知 ref 时要求远端 version 严格递增并发送 expectedVersion', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/secrets/resolve') {
        return new Response(JSON.stringify({ value: 'old-plaintext', ref: remoteRef('rotate-ref-id') }));
      }
      if (path === '/secrets/rotate-ref-id/rotate') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedVersion: 2 });
        return new Response(JSON.stringify(remoteRef('rotate-ref-id')));
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await vault.getSecret('rotate-ref-id', HTTP_CALLER);
    await expect(vault.rotateSecret('rotate-ref-id', 'rotated', HTTP_CALLER)).rejects.toThrow(
      /version must advance/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { operation: 'put', id: 'put-ref-id' },
    { operation: 'rotate', id: 'rotate-ref-id' },
  ])('$operation 远端响应缺少 version 时 fail closed', async ({ operation, id }) => {
    const response: Partial<ReturnType<typeof remoteRef>> = remoteRef(id);
    delete response.version;
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify(response))) as typeof fetch,
    });

    const request = operation === 'put'
      ? vault.putSecret('alice', 'mcp', 'plaintext', HTTP_CALLER)
      : vault.rotateSecret(id, 'rotated', HTTP_CALLER);
    await expect(request).rejects.toThrow(/version must be a positive safe integer/);
  });

  it.each([
    { name: 'owner mismatch', ref: { ...remoteRef('put-ref-id'), ownerId: 'bob' }, error: /ownerId mismatch/ },
    { name: 'global substitution', ref: { ...remoteRef('put-ref-id'), ownerId: 'global' }, error: /ownerId mismatch/ },
    { name: 'kind mismatch', ref: { ...remoteRef('put-ref-id'), kind: 'git' }, error: /kind mismatch/ },
  ])('put 远端返回 $name 时 fail closed', async ({ ref, error }) => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify(ref))) as typeof fetch,
    });

    await expect(vault.putSecret('alice', 'mcp', 'plaintext', HTTP_CALLER)).rejects.toThrow(error);
  });

  it('get 远端省略权威 ref 时 fail closed', async () => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify({
        value: 'resolved-plaintext',
      }))) as typeof fetch,
    });

    await expect(vault.getSecret('remote-ref-id', HTTP_CALLER)).rejects.toThrow(/response ref is malformed/);
  });

  it('get 远端返回错误 ref id 时 fail closed', async () => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify({
        value: 'resolved-plaintext',
        ref: remoteRef('different-ref-id'),
      }))) as typeof fetch,
    });

    await expect(vault.getSecret('remote-ref-id', HTTP_CALLER)).rejects.toThrow(/ref id mismatch/);
  });

  it('get 远端返回 ref ACL 不匹配时 fail closed', async () => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify({
        value: 'resolved-plaintext',
        ref: { ...remoteRef('remote-ref-id'), ownerId: 'bob' },
      }))) as typeof fetch,
    });

    await expect(vault.getSecret('remote-ref-id', HTTP_CALLER)).rejects.toThrow(/owner mismatch/);
  });

  it('rotate 远端返回错误 ref id 时 fail closed', async () => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify(remoteRef('different-ref-id')))) as typeof fetch,
    });

    await expect(vault.rotateSecret('remote-ref-id', 'rotated', HTTP_CALLER)).rejects.toThrow(/ref id mismatch/);
  });
});

describe('HttpSecretVault metadata-only version inspection（TASK-318）', () => {
  it('inspect 远端响应缺少 version 时 fail closed', async () => {
    const response: Partial<ReturnType<typeof remoteRef>> = remoteRef('remote-ref-id');
    delete response.version;
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify(response))) as typeof fetch,
    });

    await expect(vault.inspectRef!('remote-ref-id', HTTP_CALLER)).rejects.toThrow(
      /version must be a positive safe integer/,
    );
  });

  it.each([
    { name: 'zero', version: 0 },
    { name: 'negative', version: -1 },
    { name: 'fractional', version: 1.5 },
    { name: 'string', version: '2' },
  ])('inspect 远端响应 version=$name 时 fail closed', async ({ version }) => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify({
        ...remoteRef('remote-ref-id'),
        version,
      }))) as typeof fetch,
    });

    await expect(vault.inspectRef!('remote-ref-id', CALLER)).rejects.toThrow(
      /version must be a positive safe integer/,
    );
  });

  it('inspect 保留合法正整数 opaque version', async () => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () => new Response(JSON.stringify({
        ...remoteRef('remote-ref-id'),
        version: 9,
      }))) as typeof fetch,
    });

    await expect(vault.inspectRef!('remote-ref-id', HTTP_CALLER)).resolves.toMatchObject({ version: 9 });
  });

  it('metadata TTL 到期、时钟回拨或 invalidate 后重检远端 version', async () => {
    let now = 10_000;
    let remoteVersion = 4;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://vault.example.com/secrets/inspect');
      expect(String(init?.body)).not.toContain('plaintext');
      return new Response(
        JSON.stringify({
          id: 'remote-ref-id',
          ownerId: 'global',
          kind: 'tenant-hand',
          version: remoteVersion,
          value: 'remote-plaintext-must-be-dropped',
          metadata: {},
          createdAt: '2026-08-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: fetchImpl as typeof fetch,
      metadataCacheTtlMs: 5_000,
      nowMs: () => now,
    });

    const inspected = await vault.inspectRef!('remote-ref-id', CALLER);
    expect(inspected?.version).toBe(4);
    expect(JSON.stringify(inspected)).not.toContain('remote-plaintext-must-be-dropped');
    expect((await vault.inspectRef!('remote-ref-id', CALLER))?.version).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    remoteVersion = 5;
    now = 0;
    expect((await vault.inspectRef!('remote-ref-id', CALLER))?.version).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    remoteVersion = 6;
    now += 5_001;
    expect((await vault.inspectRef!('remote-ref-id', CALLER))?.version).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    remoteVersion = 7;
    vault.invalidate('remote-ref-id');
    expect((await vault.inspectRef!('remote-ref-id', CALLER))?.version).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('inspect 发现外部 version 前进时失效 plaintext cache，下一次读取获取新 Secret', async () => {
    let resolveCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/secrets/resolve') {
        resolveCount += 1;
        return new Response(JSON.stringify({
          value: resolveCount === 1 ? 'old-plaintext' : 'new-plaintext',
          ref: { ...remoteRef('remote-ref-id'), version: resolveCount === 1 ? 4 : 5 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === '/secrets/inspect') {
        return new Response(JSON.stringify({ ...remoteRef('remote-ref-id'), version: 5 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: fetchImpl as typeof fetch,
      cacheTtlMs: 60_000,
      metadataCacheTtlMs: 0,
    });

    await expect(vault.getSecret('remote-ref-id', HTTP_CALLER)).resolves.toBe('old-plaintext');
    await expect(vault.getSecret('remote-ref-id', HTTP_CALLER)).resolves.toBe('old-plaintext');
    await expect(vault.inspectRef!('remote-ref-id', HTTP_CALLER)).resolves.toMatchObject({ version: 5 });
    await expect(vault.getSecret('remote-ref-id', HTTP_CALLER)).resolves.toBe('new-plaintext');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('已观察新 version 后拒绝迟到的旧 resolve 响应与旧明文', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/secrets/inspect') {
        return new Response(JSON.stringify({ ...remoteRef('remote-ref-id'), version: 5 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/secrets/resolve') {
        return new Response(JSON.stringify({
          value: 'stale-plaintext',
          ref: { ...remoteRef('remote-ref-id'), version: 4 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: fetchImpl as typeof fetch,
      metadataCacheTtlMs: 0,
    });

    await expect(vault.inspectRef!('remote-ref-id', HTTP_CALLER)).resolves.toMatchObject({ version: 5 });
    await expect(vault.getSecret('remote-ref-id', HTTP_CALLER)).rejects.toThrow(
      /version regressed below observed version/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('远端 revoked metadata 被保留且不携带明文', async () => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 'remote-ref-id',
            ownerId: 'global',
            kind: 'tenant-hand',
            version: 8,
            revokedAt: '2026-08-30T00:00:00.000Z',
            value: 'remote-plaintext-must-be-dropped',
            metadata: {},
            createdAt: '2026-08-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });

    const inspected = await vault.inspectRef!('remote-ref-id', CALLER);
    expect(inspected?.version).toBe(8);
    expect(inspected?.revokedAt).toBe('2026-08-30T00:00:00.000Z');
    expect(JSON.stringify(inspected)).not.toContain('remote-plaintext-must-be-dropped');
  });

  it('HTTP revoke 会失效 metadata cache，下一次 inspect 观测 revoked version', async () => {
    let revoked = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/secrets/remote-ref-id/revoke')) {
        revoked = true;
        return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(url).toBe('https://vault.example.com/secrets/inspect');
      return new Response(
        JSON.stringify({
          id: 'remote-ref-id',
          ownerId: 'global',
          kind: 'tenant-hand',
          version: revoked ? 8 : 7,
          ...(revoked ? { revokedAt: '2026-08-30T00:00:00.000Z' } : {}),
          metadata: {},
          createdAt: '2026-08-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: fetchImpl as typeof fetch,
      metadataCacheTtlMs: 60_000,
    });

    const initial = await vault.inspectRef!('remote-ref-id', CALLER);
    expect(initial?.version).toBe(7);
    await vault.revokeSecret(initial!, REVOKE_CALLER);
    const after = await vault.inspectRef!('remote-ref-id', CALLER);
    expect(after?.version).toBe(8);
    expect(after?.revokedAt).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('远端返回错误 ref id 时 fail closed', async () => {
    const vault = new HttpSecretVault({
      baseUrl: 'https://vault.example.com',
      authToken: 'bootstrap-token',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 'different-ref-id',
            ownerId: 'global',
            kind: 'tenant-hand',
            version: 1,
            metadata: {},
            createdAt: '2026-08-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });

    await expect(vault.inspectRef!('remote-ref-id', CALLER)).rejects.toThrow(/ref id mismatch/);
  });
});

describe('Config identity metadata-only vault capability（TASK-318）', () => {
  it('InMemory revoke 递增 opaque version 并暴露 revoked metadata', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('global', 'tenant-hand', 'plaintext', {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:tenant-hand:write'],
    });
    await vault.revokeSecret(ref.id, REVOKE_CALLER);
    const inspected = await vault.inspectRef!(ref.id, CALLER);
    expect(inspected?.version).toBe(2);
    expect(inspected?.revokedAt).toBeTruthy();
  });

  it('可 inspect opaque version，但不能借 metadata scope 读取明文', async () => {
    const vault = new InMemorySecretVault();
    const writer: VaultCaller = {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:tenant-hand:write'],
    };
    const metadataCaller: VaultCaller = {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:metadata:read'],
    };
    const ref = await vault.putSecret(
      'global',
      'tenant-hand',
      'plaintext-must-stay-in-vault',
      writer,
    );

    expect((await vault.inspectRef!(ref.id, metadataCaller))?.version).toBe(1);
    await expect(vault.getSecret(ref.id, metadataCaller)).rejects.toThrow(
      /missing secret:tenant-hand:read/,
    );
  });
});
