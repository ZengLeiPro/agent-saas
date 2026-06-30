/**
 * Secret Vault 多 scope ACL 测试（PR 11 tenant-scoped secret）
 *
 * 覆盖：
 *   - user scope (ownerId === username 或 user:<x>) → caller.userId 必须匹配
 *   - tenant scope (ownerId === tenant:<id>) → caller.tenantId 必须匹配
 *   - global scope (ownerId === 'global') → 任意 caller（在 proxy actor + scope 闸门下）
 *   - admin/system actor → 全部放行（管理路径不受 scope 约束）
 *   - revoke 后任何 caller 都拿不到
 */

import { describe, expect, it } from 'vitest';
import {
  InMemorySecretVault,
  GLOBAL_OWNER_ID,
  TENANT_OWNER_PREFIX,
  tenantOwnerId,
  parseTenantOwnerId,
} from '../security/secretVault.js';
import type { VaultCaller } from '../security/secretVault.js';

const proxyKaiyan = (username: string): VaultCaller => ({
  actor: 'mcp_proxy',
  userId: username,
  tenantId: 'kaiyan',
  scopes: ['secret:mcp:read'],
});
const proxyWain = (username: string): VaultCaller => ({
  actor: 'mcp_proxy',
  userId: username,
  tenantId: 'wain',
  scopes: ['secret:mcp:read'],
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

describe('InMemorySecretVault — user scope ACL', () => {
  it('caller.userId 匹配裸 username ownerId → 通过', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret('zengky', 'mcp', 'pat_xxx');
    const value = await v.getSecret(ref, proxyKaiyan('zengky'));
    expect(value).toBe('pat_xxx');
  });

  it('caller.userId 不匹配 → vault access denied', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret('alice', 'mcp', 'secret');
    await expect(v.getSecret(ref, proxyKaiyan('bob'))).rejects.toThrow(/access denied/);
  });

  it('caller 缺 scope → 拒', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret('alice', 'mcp', 'secret');
    await expect(
      v.getSecret(ref, { actor: 'mcp_proxy', userId: 'alice', tenantId: 'kaiyan', scopes: [] }),
    ).rejects.toThrow(/access denied/);
  });

  it('user:<username> 命名空间格式与裸 username 等价', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret('user:alice', 'mcp', 'value-ns');
    const value = await v.getSecret(ref, proxyKaiyan('alice'));
    expect(value).toBe('value-ns');
  });
});

describe('InMemorySecretVault — tenant scope ACL', () => {
  it('同组织 caller → 通过（user A 拿 tenant kaiyan 的 secret，因为 A 属 kaiyan）', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(tenantOwnerId('kaiyan'), 'mcp', 'shared_tenant_pat');
    const value = await v.getSecret(ref, proxyKaiyan('alice'));
    expect(value).toBe('shared_tenant_pat');
  });

  it('同组织但不同 user → 通过（只要 tenantId 匹配，user 是谁不限）', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(tenantOwnerId('kaiyan'), 'mcp', 'tenant_shared');
    const v1 = await v.getSecret(ref, proxyKaiyan('alice'));
    const v2 = await v.getSecret(ref, proxyKaiyan('bob'));
    expect(v1).toBe('tenant_shared');
    expect(v2).toBe('tenant_shared');
  });

  it('跨组织 caller → 拒（wain user 拿 tenant:kaiyan 的 secret）', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(tenantOwnerId('kaiyan'), 'mcp', 'kaiyan_only');
    await expect(v.getSecret(ref, proxyWain('wain_user'))).rejects.toThrow(/access denied/);
  });

  it('caller 没传 tenantId → 拒', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(tenantOwnerId('kaiyan'), 'mcp', 'x');
    await expect(
      v.getSecret(ref, { actor: 'mcp_proxy', userId: 'alice', scopes: ['secret:mcp:read'] }),
    ).rejects.toThrow(/access denied/);
  });
});

describe('InMemorySecretVault — global scope ACL', () => {
  it('任意组织的 proxy caller 都可读 global secret', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(GLOBAL_OWNER_ID, 'mcp', 'platform_shared');
    const fromKaiyan = await v.getSecret(ref, proxyKaiyan('alice'));
    const fromWain = await v.getSecret(ref, proxyWain('wain_user'));
    expect(fromKaiyan).toBe('platform_shared');
    expect(fromWain).toBe('platform_shared');
  });

  it('global secret 仍受 scope 闸门约束（无 scope 时拒）', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(GLOBAL_OWNER_ID, 'mcp', 'x');
    await expect(
      v.getSecret(ref, { actor: 'mcp_proxy', userId: 'alice', tenantId: 'kaiyan', scopes: [] }),
    ).rejects.toThrow(/access denied/);
  });
});

describe('InMemorySecretVault — actor bypass', () => {
  it('actor=admin → ACL 不约束（管理工具读任意 scope）', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(tenantOwnerId('kaiyan'), 'mcp', 'k_secret');
    const value = await v.getSecret(ref, { actor: 'admin' });
    expect(value).toBe('k_secret');
  });

  it('actor=system → 同上放行', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(GLOBAL_OWNER_ID, 'mcp', 'g_secret');
    const value = await v.getSecret(ref, { actor: 'system' });
    expect(value).toBe('g_secret');
  });
});

describe('InMemorySecretVault — revoke', () => {
  it('revoke 后任何 caller 都拿不到（即使 admin）', async () => {
    const v = new InMemorySecretVault();
    const ref = await v.putSecret(tenantOwnerId('kaiyan'), 'mcp', 'value');
    await v.revokeSecret(ref, { actor: 'admin' });
    await expect(v.getSecret(ref, proxyKaiyan('alice'))).rejects.toThrow(/revoked/);
    await expect(v.getSecret(ref, { actor: 'admin' })).rejects.toThrow(/revoked/);
  });
});
