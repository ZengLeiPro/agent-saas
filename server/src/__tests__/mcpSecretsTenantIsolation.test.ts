/**
 * MCP secrets 跨租户凭据隔离 · 防回归测试
 *
 * 目标端点：PUT /admin/servers/:serverId/secrets/:key（mcp.ts:507）
 *
 * 覆盖 6 条守卫 + vault 两层隔离（守卫编排 + vault ACL 端到端读回）：
 *   守卫 1  组织 admin 写别组织 server 的 secret        → 403
 *   守卫 2  admin 写 user-scope requirement            → 400（引导走 /me）
 *   守卫 3  tenant-scope 但 server.tenantId='*'（歧义） → 400
 *   守卫 4  非平台 admin 写 global-scope               → 403
 *   守卫 5  平台 admin 写 global-scope 但 server≠'*'    → 400
 *   守卫 6  组织 admin 写 own tenant secret            → 200（成功路径 + ownerId 正确）
 *   vault 隔离  KAIYAN_ADMIN 写入后：kaiyan caller 能读回 / wain caller access denied
 *
 * 关于本文件为何自带一份 rig（而非直接扩 mcpRouterTenantIsolation.test.ts）：
 *   vault 读回隔离断言需要测试持有 InMemorySecretVault 实例引用，原 harness 在
 *   makeTestRig 内联 new InMemorySecretVault()、未对外暴露。为不改动共享 harness，
 *   这里复刻同风格 rig 并把 vault 暴露到 rig.vault，其余 fixture / 断言口径与原文件一致。
 *
 * 测试方式：起真 express app + createMcpRouter，注入 fake user middleware，用 fetch 调路由，
 * 用真实 InMemorySecretVault（不 mock）让 putSecret / getSecret 真实走 ACL。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpRouter } from '../routes/mcp.js';
import { GLOBAL_TENANT_ID, McpConfigStore } from '../data/mcpConfig.js';
import type { ManagedMcpServer } from '../data/mcpConfig.js';
import type { JwtPayload } from '../auth/types.js';
import type { UserStore } from '../data/users/store.js';
import type { McpClientManager } from '../mcp/clientManager.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import type { VaultCaller } from '../security/secretVault.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const KAIYAN_ADMIN: JwtPayload = { sub: 'u-ka', username: 'zengky', role: 'admin', tenantId: 'kaiyan' };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };

type Caller = JwtPayload;

interface TestRig {
  baseUrl: string;
  store: McpConfigStore;
  vault: InMemorySecretVault;
  setCaller(caller: Caller): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

function fakeUserStore(): UserStore {
  const users = [
    { id: 'u-ka', username: 'zengky', role: 'admin' as const, tenantId: 'kaiyan' },
    { id: 'u-ku', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' },
    { id: 'u-wa', username: 'wain_admin', role: 'admin' as const, tenantId: 'wain' },
    { id: 'u-wu', username: 'wain_user', role: 'user' as const, tenantId: 'wain' },
  ];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    listAll: () => users.map(u => ({ ...u })),
  } as unknown as UserStore;
}

function fakeMcpManager(): McpClientManager {
  return {
    invalidateUser: async () => undefined,
    ensureUser: async () => [],
  } as unknown as McpClientManager;
}

async function makeTestRig(): Promise<TestRig> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-secrets-iso-'));
  const store = new McpConfigStore(join(tmpDir, 'mcp-config.json'));
  const vault = new InMemorySecretVault();
  const app = express();
  app.use(express.json());
  let currentCaller: Caller = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/mcp', createMcpRouter({
    store,
    userStore: fakeUserStore(),
    manager: fakeMcpManager(),
    agentCwd: tmpDir,
    secretVault: vault,
  }));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    store,
    vault,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function basicServerBody(id: string, extra: Partial<ManagedMcpServer> = {}) {
  return {
    name: id,
    enabledByDefault: false,
    riskLevel: 'read_only',
    config: { type: 'stdio', command: 'node', args: ['/tmp/dummy.mjs'] },
    ...extra,
  };
}

function putSecret(h: TestRig, serverId: string, key: string, value: string): Promise<Response> {
  return h.request(`/api/mcp/admin/servers/${serverId}/secrets/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

describe('PUT /admin/servers/:id/secrets/:key — 跨租户凭据隔离', () => {
  let h: TestRig;

  beforeEach(async () => {
    h = await makeTestRig();
  });

  afterEach(async () => {
    await h.close();
  });

  // 种带 secretRequirements 的 server（直接写 store，跳过路由权限做 fixture setup）
  async function seedServers() {
    // kaiyan 组织的 server，含 user / tenant scope requirement
    await h.store.upsertServer({
      ...basicServerBody('kaiyan_srv', {
        tenantId: 'kaiyan',
        secretRequirements: [
          { key: 'user_pat', label: 'User PAT', target: 'env', name: 'USER_PAT', scope: 'user', required: true },
          { key: 'tenant_pat', label: 'Tenant PAT', target: 'env', name: 'TENANT_PAT', scope: 'tenant', required: true },
        ],
      }),
      id: 'kaiyan_srv',
    } as ManagedMcpServer);

    // 全局 server（tenantId='*'），含 tenant（歧义）/ global scope requirement
    await h.store.upsertServer({
      ...basicServerBody('global_srv', {
        tenantId: GLOBAL_TENANT_ID,
        secretRequirements: [
          { key: 'tenant_pat', label: 'Tenant PAT', target: 'env', name: 'TENANT_PAT', scope: 'tenant', required: true },
          { key: 'global_pat', label: 'Global PAT', target: 'env', name: 'GLOBAL_PAT', scope: 'global', required: true },
        ],
      }),
      id: 'global_srv',
    } as ManagedMcpServer);
  }

  // ============================================================
  // 守卫 6：组织 admin 写 own tenant secret → 200（成功路径 + ownerId 正确）
  // ============================================================
  it('守卫 6：KAIYAN_ADMIN 写 own tenant secret → 200，ownerId=tenant:kaiyan', async () => {
    await seedServers();
    h.setCaller(KAIYAN_ADMIN);
    const res = await putSecret(h, 'kaiyan_srv', 'tenant_pat', 'kaiyan_tenant_pat');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ref?.id).toBeTruthy();

    // 落库：server.secretRefs 已绑定该 ref
    const boundRef = h.store.getServer('kaiyan_srv')?.secretRefs?.tenant_pat;
    expect(boundRef).toBe(body.ref.id);

    // ownerId 计算正确性：以 kaiyan caller 读回成功即证明 ownerId=tenant:kaiyan（见下方 vault 隔离用例做严证）
  });

  // ============================================================
  // 守卫 1：组织 admin 写别组织的 server → 403
  // ============================================================
  it('守卫 1：WAIN_ADMIN 写 kaiyan 组织 server 的 secret → 403，且未落库', async () => {
    await seedServers();
    h.setCaller(WAIN_ADMIN);
    const res = await putSecret(h, 'kaiyan_srv', 'tenant_pat', 'hijack');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/跨组织|denied/i);
    // 未落库
    expect(h.store.getServer('kaiyan_srv')?.secretRefs?.tenant_pat).toBeUndefined();
  });

  // ============================================================
  // 守卫 2：admin 写 user scope requirement → 400（引导走 /me）
  // ============================================================
  it('守卫 2：KAIYAN_ADMIN 写 user-scope secret → 400，提示走 /me', async () => {
    await seedServers();
    h.setCaller(KAIYAN_ADMIN);
    const res = await putSecret(h, 'kaiyan_srv', 'user_pat', 'whatever');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/\/me\/servers/i);
    expect(h.store.getServer('kaiyan_srv')?.secretRefs?.user_pat).toBeUndefined();
  });

  // ============================================================
  // 守卫 3：tenant-scope 但 server.tenantId='*'（歧义）→ 400
  // ============================================================
  it('守卫 3：PLATFORM_ADMIN 对全局 server 写 tenant-scope → 400（歧义拒绝）', async () => {
    await seedServers();
    h.setCaller(PLATFORM_ADMIN);
    const res = await putSecret(h, 'global_srv', 'tenant_pat', 'whatever');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/ambiguous|global instead/i);
    expect(h.store.getServer('global_srv')?.secretRefs?.tenant_pat).toBeUndefined();
  });

  // ============================================================
  // 守卫 4：非平台 admin 写 global-scope → 403
  // ============================================================
  it('守卫 4：WAIN_ADMIN 对全局 server 写 global-scope → 403（仅平台 admin）', async () => {
    await seedServers();
    h.setCaller(WAIN_ADMIN);
    const res = await putSecret(h, 'global_srv', 'global_pat', 'whatever');
    // 组织 admin 对全局 server：守卫 1 已拦（server.tenantId='*' !== 'wain'）→ 403
    expect(res.status).toBe(403);
    expect(h.store.getServer('global_srv')?.secretRefs?.global_pat).toBeUndefined();
  });

  // ============================================================
  // 守卫 5：平台 admin 写 global-scope 但 server.tenantId≠'*' → 400
  // ============================================================
  it('守卫 5：PLATFORM_ADMIN 对非全局 server 写 global-scope → 400', async () => {
    // 造一个 tenantId=kaiyan 但 requirement.scope=global 的错配 server
    await h.store.upsertServer({
      ...basicServerBody('kaiyan_misconfig', {
        tenantId: 'kaiyan',
        secretRequirements: [
          { key: 'global_pat', label: 'Global PAT', target: 'env', name: 'GLOBAL_PAT', scope: 'global', required: true },
        ],
      }),
      id: 'kaiyan_misconfig',
    } as ManagedMcpServer);
    h.setCaller(PLATFORM_ADMIN);
    const res = await putSecret(h, 'kaiyan_misconfig', 'global_pat', 'whatever');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/global-scope secret requires/i);
    expect(h.store.getServer('kaiyan_misconfig')?.secretRefs?.global_pat).toBeUndefined();
  });

  // ============================================================
  // vault 读回验证租户隔离（核心防串读锁）
  //   KAIYAN_ADMIN 写入 tenant secret 后：
  //     - kaiyan caller  → 能读回原值
  //     - wain caller    → rejects access denied
  //     - 缺 scope caller → rejects（scope 闸门）
  //   一组用例同时锁死守卫编排 + vault 两层隔离。
  // ============================================================
  describe('vault 端到端读回隔离', () => {
    const SECRET_VALUE = 'kaiyan_tenant_pat_value';

    function mcpCaller(tenantId: string): VaultCaller {
      return { actor: 'mcp_proxy', userId: 'someuser', tenantId, scopes: ['secret:mcp:read'] };
    }

    it('KAIYAN 写入 → kaiyan caller 读回原值；wain caller access denied', async () => {
      await seedServers();
      h.setCaller(KAIYAN_ADMIN);
      const res = await putSecret(h, 'kaiyan_srv', 'tenant_pat', SECRET_VALUE);
      expect(res.status).toBe(200);
      const refId: string = (await res.json()).ref.id;

      // 正向：同租户 kaiyan caller 能读回真实值
      await expect(h.vault.getSecret(refId, mcpCaller('kaiyan'))).resolves.toBe(SECRET_VALUE);

      // 隔离（最关键）：别租户 wain caller 被拒
      await expect(h.vault.getSecret(refId, mcpCaller('wain'))).rejects.toThrow(/access denied/);
    });

    it('缺 secret:mcp:read scope 的同租户 caller 也被拒（scope 闸门）', async () => {
      await seedServers();
      h.setCaller(KAIYAN_ADMIN);
      const res = await putSecret(h, 'kaiyan_srv', 'tenant_pat', SECRET_VALUE);
      const refId: string = (await res.json()).ref.id;

      const noScopeCaller: VaultCaller = { actor: 'mcp_proxy', userId: 'someuser', tenantId: 'kaiyan', scopes: [] };
      await expect(h.vault.getSecret(refId, noScopeCaller)).rejects.toThrow(/access denied/);
    });

    it('global-scope secret：wain caller 也能读回（验证 global 跨租户语义未被误伤）', async () => {
      await seedServers();
      h.setCaller(PLATFORM_ADMIN);
      const res = await putSecret(h, 'global_srv', 'global_pat', 'global_shared_value');
      expect(res.status).toBe(200);
      const refId: string = (await res.json()).ref.id;

      // global ownerId 设计上对所有租户 proxy caller 可读
      await expect(h.vault.getSecret(refId, mcpCaller('kaiyan'))).resolves.toBe('global_shared_value');
      await expect(h.vault.getSecret(refId, mcpCaller('wain'))).resolves.toBe('global_shared_value');
    });
  });

  // ============================================================
  // 边界：secretVault 未装配 → 501（对照，确保守卫前置项存在）
  // ============================================================
  it('边界：secretVault 未装配 → 501', async () => {
    // 用一个不带 secretVault 的独立 app
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-secrets-novault-'));
    const store = new McpConfigStore(join(tmpDir, 'mcp-config.json'));
    await store.upsertServer({
      ...basicServerBody('srv', {
        tenantId: 'kaiyan',
        secretRequirements: [{ key: 'tenant_pat', label: 'T', target: 'env', name: 'T', scope: 'tenant', required: true }],
      }),
      id: 'srv',
    } as ManagedMcpServer);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = KAIYAN_ADMIN; next(); });
    app.use('/api/mcp', createMcpRouter({
      store,
      userStore: fakeUserStore(),
      manager: fakeMcpManager(),
      agentCwd: tmpDir,
      // secretVault 故意不传
    }));
    const server: Server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/api/mcp/admin/servers/srv/secrets/tenant_pat`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x' }),
      });
      expect(res.status).toBe(501);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
