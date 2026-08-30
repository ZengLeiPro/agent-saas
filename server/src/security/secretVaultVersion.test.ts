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

describe('HttpSecretVault metadata-only version inspection（TASK-318）', () => {
  it('metadata TTL 到期或 invalidate 后重检远端 version，且不解析 secret 明文', async () => {
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
    now += 5_001;
    expect((await vault.inspectRef!('remote-ref-id', CALLER))?.version).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    remoteVersion = 6;
    vault.invalidate('remote-ref-id');
    expect((await vault.inspectRef!('remote-ref-id', CALLER))?.version).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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
