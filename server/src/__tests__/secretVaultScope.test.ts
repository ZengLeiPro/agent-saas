import { describe, expect, it } from 'vitest';
import {
  GLOBAL_OWNER_ID,
  InMemorySecretVault,
  TENANT_OWNER_PREFIX,
  parseTenantOwnerId,
  tenantOwnerId,
  type VaultCaller,
  type VaultOperation,
} from '../security/secretVault.js';

const proxy = (
  userId: string,
  tenantId: string,
  operation: VaultOperation,
  kind = 'mcp',
): VaultCaller => ({
  actor: 'mcp_proxy',
  userId,
  tenantId,
  scopes: [`secret:${kind}:${operation}`],
});

describe('SecretVault ownerId helpers', () => {
  it('tenantOwnerId / parseTenantOwnerId 往返', () => {
    expect(tenantOwnerId('kaiyan')).toBe('tenant:kaiyan');
    expect(parseTenantOwnerId('tenant:kaiyan')).toBe('kaiyan');
    expect(parseTenantOwnerId('global')).toBeNull();
    expect(parseTenantOwnerId('zengky')).toBeNull();
    expect(TENANT_OWNER_PREFIX).toBe('tenant:');
  });
});

describe('InMemorySecretVault operation ACL', () => {
  it('putSecret 必须校验 write scope 与 owner', async () => {
    const vault = new InMemorySecretVault();
    await expect(vault.putSecret('alice', 'mcp', 'secret', proxy('alice', 'kaiyan', 'read')))
      .rejects.toThrow(/missing secret:mcp:write/);
    await expect(vault.putSecret('alice', 'mcp', 'secret', proxy('bob', 'kaiyan', 'write')))
      .rejects.toThrow(/owner mismatch/);
    await expect(vault.putSecret('alice', 'mcp', 'secret', proxy('alice', 'kaiyan', 'write')))
      .resolves.toMatchObject({ ownerId: 'alice', kind: 'mcp' });
  });

  it('read/rotate/revoke 按 operation scope 分离，read scope 不能改写', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('alice', 'mcp', 'v1', proxy('alice', 'kaiyan', 'write'));
    await expect(vault.getSecret(ref, proxy('alice', 'kaiyan', 'read'))).resolves.toBe('v1');
    await expect(vault.rotateSecret(ref, 'v2', proxy('alice', 'kaiyan', 'read')))
      .rejects.toThrow(/missing secret:mcp:rotate/);
    await expect(vault.revokeSecret(ref, proxy('alice', 'kaiyan', 'read')))
      .rejects.toThrow(/missing secret:mcp:revoke/);
    await vault.rotateSecret(ref, 'v2', proxy('alice', 'kaiyan', 'rotate'));
    await expect(vault.getSecret(ref, proxy('alice', 'kaiyan', 'read'))).resolves.toBe('v2');
    await vault.revokeSecret(ref, proxy('alice', 'kaiyan', 'revoke'));
    await expect(vault.getSecret(ref, proxy('alice', 'kaiyan', 'read'))).rejects.toThrow(/revoked/);
  });

  it('拒绝 wildcard scope，必须是 kind + operation 精确 scope', async () => {
    const vault = new InMemorySecretVault();
    await expect(vault.putSecret('alice', 'mcp', 'secret', {
      actor: 'mcp_proxy',
      userId: 'alice',
      tenantId: 'kaiyan',
      scopes: ['secret:*:write'],
    })).rejects.toThrow(/missing secret:mcp:write/);
  });
});

describe('InMemorySecretVault owner scope ACL', () => {
  it('user owner 只允许本人，兼容 user:<id> 命名空间', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret('user:alice', 'mcp', 'personal', proxy('alice', 'kaiyan', 'write'));
    await expect(vault.getSecret(ref, proxy('alice', 'kaiyan', 'read'))).resolves.toBe('personal');
    await expect(vault.getSecret(ref, proxy('bob', 'kaiyan', 'read'))).rejects.toThrow(/owner mismatch/);
  });

  it('tenant owner 允许同组织、拒绝跨组织或缺 tenantId', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret(
      tenantOwnerId('kaiyan'),
      'mcp',
      'shared',
      proxy('admin', 'kaiyan', 'write'),
    );
    await expect(vault.getSecret(ref, proxy('alice', 'kaiyan', 'read'))).resolves.toBe('shared');
    await expect(vault.getSecret(ref, proxy('bob', 'wain', 'read'))).rejects.toThrow(/tenant owner mismatch/);
    await expect(vault.getSecret(ref, {
      actor: 'mcp_proxy',
      userId: 'alice',
      scopes: ['secret:mcp:read'],
    })).rejects.toThrow(/tenant owner mismatch/);
  });

  it('global owner 对持有精确 scope 的 proxy 开放', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret(GLOBAL_OWNER_ID, 'mcp', 'global', proxy('admin', 'kaiyan', 'write'));
    await expect(vault.getSecret(ref, proxy('alice', 'kaiyan', 'read'))).resolves.toBe('global');
    await expect(vault.getSecret(ref, proxy('bob', 'wain', 'read'))).resolves.toBe('global');
  });
});

describe('InMemorySecretVault actor boundary', () => {
  it('admin actor 即使伪造精确 scope 也立即拒绝', async () => {
    const vault = new InMemorySecretVault();
    await expect(vault.putSecret(GLOBAL_OWNER_ID, 'web_tools', 'key', {
      actor: 'admin',
      scopes: ['secret:web_tools:write'],
    } as never)).rejects.toThrow(/unknown actor/);
  });

  it('GitHub App 私钥可由 git proxy 托管，并仅由系统 v3 运行时读取', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret(GLOBAL_OWNER_ID, 'github_app', 'private-key', {
      actor: 'git_proxy', userId: 'provisioner', scopes: ['secret:github_app:write'],
    });
    await expect(vault.getSecret(ref, {
      actor: 'system', userId: '__system__', scopes: ['secret:github_app:read'],
    })).resolves.toBe('private-key');
  });

  it('system 仅可访问基础设施 allowlist，仍需精确 operation scope', async () => {
    const vault = new InMemorySecretVault();
    const writer: VaultCaller = {
      actor: 'system',
      userId: 'tool_controls_admin',
      scopes: ['secret:web_tools:write'],
    };
    const ref = await vault.putSecret(GLOBAL_OWNER_ID, 'web_tools', 'key', writer);
    await expect(vault.getSecret(ref, {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:web_tools:read'],
    })).resolves.toBe('key');
    await expect(vault.getSecret(ref, writer)).rejects.toThrow(/missing secret:web_tools:read/);
    await expect(vault.getSecret(ref, {
      actor: 'system',
      userId: 'tool_controls_admin',
      scopes: ['secret:web_tools:read'],
    })).rejects.toThrow(/service principal mismatch/);
    await expect(vault.putSecret(GLOBAL_OWNER_ID, 'mcp', 'forbidden', {
      actor: 'system',
      userId: '__system__',
      scopes: ['secret:mcp:write'],
    })).rejects.toThrow(/not infrastructure allowlisted/);
  });
});
