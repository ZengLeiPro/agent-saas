import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import {
  EncryptedFileSecretVault,
  HttpSecretVault,
  type VaultCaller,
} from '../security/secretVault.js';
import {
  buildConfigIdentityVault,
  readEnvironmentFile,
  resolveVaultFile,
} from './configIdentityCli.js';

const roots: string[] = [];
const CALLER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:tenant-hand:write', 'secret:tenant-hand:read'],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'config-identity-cli-'));
  roots.push(root);
  return root;
}

describe('config-identity-cli vault 定位（TASK-318）', () => {
  it('systemd BindPaths 下 data/* 映射到主机 runtime-data-dir，不误读 release artifact', () => {
    expect(
      resolveVaultFile(
        './data/secrets.enc',
        '/opt/agent-saas-app/releases/abc/server',
        '/mnt/agent-saas/server-data',
      ),
    ).toBe('/mnt/agent-saas/server-data/secrets.enc');
    expect(
      resolveVaultFile(
        'custom/secrets.enc',
        '/opt/agent-saas-app/releases/abc/server',
        '/mnt/agent-saas/server-data',
      ),
    ).toBe('/opt/agent-saas-app/releases/abc/server/custom/secrets.enc');
    expect(
      resolveVaultFile(
        '/var/lib/agent-saas/secrets.enc',
        '/opt/agent-saas-app/releases/abc/server',
        '/mnt/agent-saas/server-data',
      ),
    ).toBe('/var/lib/agent-saas/secrets.enc');
  });

  it('读取 systemd EnvironmentFile 的普通值与引号值，不做 shell 执行或展开', () => {
    const root = tempRoot();
    const file = join(root, 'server.env');
    writeFileSync(
      file,
      [
        '# comment',
        'VAULT_KEY="quoted-secret-key-value"',
        "OTHER='literal-$HOME'",
        'EMPTY=',
        '',
      ].join('\n'),
    );
    expect(readEnvironmentFile(file)).toEqual({
      VAULT_KEY: 'quoted-secret-key-value',
      OTHER: 'literal-$HOME',
      EMPTY: '',
    });
  });

  it('显式 vault 覆盖拒绝 argv 明文 key，只接受 env 变量名', async () => {
    const root = tempRoot();
    const vaultFile = join(root, 'override-secrets.enc');
    const envFile = join(root, 'server.env');
    const key = 'override-vault-key-at-least-16';
    writeFileSync(envFile, `OVERRIDE_VAULT_KEY=${key}\n`);
    const writer = new EncryptedFileSecretVault(vaultFile, key);
    const ref = await writer.putSecret('global', 'tenant-hand', 'plaintext', CALLER);
    const config = parseAppConfig({ agent: {}, server: {} });

    expect(() =>
      buildConfigIdentityVault({ 'vault-file': vaultFile, 'vault-key': key }, config),
    ).toThrow(/--vault-key is forbidden/);

    const reader = buildConfigIdentityVault(
      {
        'vault-file': vaultFile,
        'vault-key-env': 'OVERRIDE_VAULT_KEY',
        'env-file': envFile,
      },
      config,
    );
    expect((await reader?.inspectRef?.(ref.id, CALLER))?.version).toBe(1);
  });

  it('显式 encrypted-file 配置从 env-file 取 key，并打开 runtime-data-dir 中的同一 vault', async () => {
    const root = tempRoot();
    const dataDir = join(root, 'runtime-data');
    const envFile = join(root, 'server.env');
    const key = 'configured-vault-key-at-least-16';
    writeFileSync(envFile, `CONFIGURED_VAULT_KEY=${key}\n`);

    const writer = new EncryptedFileSecretVault(join(dataDir, 'secrets.enc'), key);
    const ref = await writer.putSecret('global', 'tenant-hand', 'plaintext', CALLER);
    const config = parseAppConfig({
      agent: {},
      server: {},
      secretVault: {
        backend: 'encrypted-file',
        filePath: './data/secrets.enc',
        encryptionKeyEnv: 'CONFIGURED_VAULT_KEY',
      },
    });
    const reader = buildConfigIdentityVault(
      {
        'process-cwd': join(root, 'release', 'server'),
        'runtime-data-dir': dataDir,
        'env-file': envFile,
      },
      config,
    );
    expect((await reader?.inspectRef?.(ref.id, CALLER))?.version).toBe(1);
  });

  it('HTTP vault 从 EnvironmentFile 取 bootstrap token，并使用 metadata-only adapter', () => {
    const root = tempRoot();
    const envFile = join(root, 'server.env');
    writeFileSync(envFile, 'HTTP_VAULT_TOKEN=http-vault-bootstrap-token\n');
    const config = parseAppConfig({
      agent: {},
      server: {},
      secretVault: {
        backend: 'http',
        baseUrl: 'https://vault.example.com',
        authTokenEnv: 'HTTP_VAULT_TOKEN',
      },
    });

    expect(buildConfigIdentityVault({ 'env-file': envFile }, config)).toBeInstanceOf(
      HttpSecretVault,
    );
  });

  it('HTTP vault bootstrap token 缺失时拒绝伪造可验证版本', () => {
    const config = parseAppConfig({
      agent: {},
      server: {},
      secretVault: {
        backend: 'http',
        baseUrl: 'https://vault.example.com',
        authTokenEnv: 'MISSING_HTTP_VAULT_TOKEN',
      },
    });

    expect(() => buildConfigIdentityVault({}, config)).toThrow(/http vault auth token is missing/);
  });

  it('无显式 vault 时复刻 production/PG 的 JWT 派生 key 与持久 data 目录', async () => {
    const root = tempRoot();
    const dataDir = join(root, 'server-data');
    const jwtSecret = 'production-jwt-secret-at-least-32-characters';
    const writer = new EncryptedFileSecretVault(
      join(dataDir, 'secrets.enc'),
      `agent-saas/secret-vault/v1:${jwtSecret}`,
    );
    const ref = await writer.putSecret('global', 'tenant-hand', 'plaintext', CALLER);
    const config = parseAppConfig({
      agent: {},
      server: {},
      auth: { enabled: true, jwtSecret },
      runtimeEventStore: {
        backend: 'pg',
        connectionString: 'postgresql://u:p@db.internal:5432/runtime',
      },
    });
    const reader = buildConfigIdentityVault(
      {
        'process-cwd': join(root, 'release', 'server'),
        'runtime-data-dir': dataDir,
      },
      config,
    );
    expect((await reader?.inspectRef?.(ref.id, CALLER))?.version).toBe(1);
  });
});
