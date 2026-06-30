/**
 * MCP 路由多组织隔离测试（PR：sessionOwner fix 后续 P0 安全修复）
 *
 * 覆盖目标：
 *   1. GET /admin/servers           - platform admin 看全部；组织 admin 仅 own + global
 *   2. PUT /admin/servers/:id       - 创建/修改的 tenantId 强制规则
 *      - 平台 admin：默认 own，可指定任意 tenant 或 '*'
 *      - 组织 admin：强制 own，禁 '*'，禁跨组织改归属，禁改非自己组织的现有 server
 *   3. DELETE /admin/servers/:id    - 跨组织写防御
 *   4. GET /me                      - 普通 user 仅看 same tenant + global
 *   5. PUT /me/selections           - 入参跨组织 serverId 静默过滤掉
 *   6. GET /admin/users/:username   - 跨组织读防御
 *
 * 测试方式：起真 express app + createMcpRouter，注入 fake user middleware，用 fetch 调路由。
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
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const KAIYAN_ADMIN: JwtPayload = { sub: 'u-ka', username: 'zengky', role: 'admin', tenantId: 'kaiyan' };
const KAIYAN_USER: JwtPayload = { sub: 'u-ku', username: 'alice', role: 'user', tenantId: 'kaiyan' };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };

type Caller = JwtPayload;

interface TestRig {
  baseUrl: string;
  store: McpConfigStore;
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-tenant-iso-'));
  const store = new McpConfigStore(join(tmpDir, 'mcp-config.json'));
  const app = express();
  app.use(express.json());
  let currentCaller: Caller = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/mcp', createMcpRouter({
    store,
    userStore: fakeUserStore(),
    manager: fakeMcpManager(),
    agentCwd: tmpDir,
    secretVault: new InMemorySecretVault(),
  }));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    store,
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

describe('MCP 路由组织隔离', () => {
  let h: TestRig;

  beforeEach(async () => {
    h = await makeTestRig();
  });

  afterEach(async () => {
    await h.close();
  });

  // ============================================================
  // 准备：种几条 server
  // ============================================================
  async function seedServers() {
    // 用 store 直接写，跳过路由权限（fixture setup）
    await h.store.upsertServer({ ...basicServerBody('kaiyan_only'), id: 'kaiyan_only', tenantId: 'kaiyan' } as ManagedMcpServer);
    await h.store.upsertServer({ ...basicServerBody('wain_only'), id: 'wain_only', tenantId: 'wain' } as ManagedMcpServer);
    await h.store.upsertServer({ ...basicServerBody('global_shared'), id: 'global_shared', tenantId: GLOBAL_TENANT_ID } as ManagedMcpServer);
  }

  // ============================================================
  // 1. GET /admin/servers
  // ============================================================
  describe('GET /admin/servers', () => {
    it('平台 admin 看全部 server (含跨组织 + 全局)', async () => {
      await seedServers();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/mcp/admin/servers');
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.servers.map((s: ManagedMcpServer) => s.id).sort();
      expect(ids).toEqual(['global_shared', 'kaiyan_only', 'wain_only']);
    });

    it('组织 admin (wain) 仅看本组织 + 全局', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers');
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.servers.map((s: ManagedMcpServer) => s.id).sort();
      expect(ids).toEqual(['global_shared', 'wain_only']);
      expect(ids).not.toContain('kaiyan_only');
    });
  });

  // ============================================================
  // 2. PUT /admin/servers/:id
  // ============================================================
  describe('PUT /admin/servers/:id', () => {
    it('平台 admin 创建不指定 tenantId → 默认 own (pantheon)', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/new_default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('new_default')),
      });
      expect(res.status).toBe(200);
      expect(h.store.getServer('new_default')?.tenantId).toBe(DEFAULT_TENANT_ID);
    });

    it('平台 admin 显式 tenantId="*" → 创建全局 server', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/new_global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('new_global', { tenantId: GLOBAL_TENANT_ID })),
      });
      expect(res.status).toBe(200);
      expect(h.store.getServer('new_global')?.tenantId).toBe(GLOBAL_TENANT_ID);
    });

    it('平台 admin 显式 tenantId="wain" → 跨组织创建 OK', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/new_for_wain', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('new_for_wain', { tenantId: 'wain' })),
      });
      expect(res.status).toBe(200);
      expect(h.store.getServer('new_for_wain')?.tenantId).toBe('wain');
    });

    it('组织 admin (wain) 试图指定 tenantId="*" → 403 (禁创建全局)', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/wain_attempt_global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('wain_attempt_global', { tenantId: GLOBAL_TENANT_ID })),
      });
      expect(res.status).toBe(403);
      expect(h.store.getServer('wain_attempt_global')).toBeUndefined();
    });

    it('组织 admin (wain) 试图跨组织创建 (tenantId="kaiyan") → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/wain_attempt_xtenant', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('wain_attempt_xtenant', { tenantId: 'kaiyan' })),
      });
      expect(res.status).toBe(403);
      expect(h.store.getServer('wain_attempt_xtenant')).toBeUndefined();
    });

    it('组织 admin (wain) 不指定 tenantId 创建 → 默认绑 own (wain)', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/wain_default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('wain_default')),
      });
      expect(res.status).toBe(200);
      expect(h.store.getServer('wain_default')?.tenantId).toBe('wain');
    });

    it('组织 admin (wain) 改自己组织的现有 server → OK', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/wain_only', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('wain_only', { name: 'wain_renamed' })),
      });
      expect(res.status).toBe(200);
      expect(h.store.getServer('wain_only')?.name).toBe('wain_renamed');
      expect(h.store.getServer('wain_only')?.tenantId).toBe('wain'); // 未变
    });

    it('组织 admin (wain) 改 kaiyan 的现有 server → 403', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/kaiyan_only', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('kaiyan_only', { name: 'hijacked' })),
      });
      expect(res.status).toBe(403);
      expect(h.store.getServer('kaiyan_only')?.name).toBe('kaiyan_only'); // 未变
    });

    it('组织 admin (wain) 试图把 own server 改成 tenantId="kaiyan" → 403', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/wain_only', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('wain_only', { tenantId: 'kaiyan' })),
      });
      expect(res.status).toBe(403);
      expect(h.store.getServer('wain_only')?.tenantId).toBe('wain'); // 未变
    });

    it('平台 admin 修改 server tenantId (迁移归属) → OK', async () => {
      await seedServers();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/wain_only', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicServerBody('wain_only', { tenantId: GLOBAL_TENANT_ID })),
      });
      expect(res.status).toBe(200);
      expect(h.store.getServer('wain_only')?.tenantId).toBe(GLOBAL_TENANT_ID);
    });
  });

  // ============================================================
  // 3. DELETE /admin/servers/:id
  // ============================================================
  describe('DELETE /admin/servers/:id', () => {
    it('组织 admin (wain) 删 kaiyan 的 server → 403', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/kaiyan_only', { method: 'DELETE' });
      expect(res.status).toBe(403);
      expect(h.store.getServer('kaiyan_only')).toBeDefined();
    });

    it('组织 admin (wain) 删 own server → OK', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/wain_only', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(h.store.getServer('wain_only')).toBeUndefined();
    });

    it('组织 admin (wain) 删全局 server → 403', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/global_shared', { method: 'DELETE' });
      expect(res.status).toBe(403);
      expect(h.store.getServer('global_shared')).toBeDefined();
    });

    it('平台 admin 删全局 server → OK', async () => {
      await seedServers();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/mcp/admin/servers/global_shared', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(h.store.getServer('global_shared')).toBeUndefined();
    });
  });

  // ============================================================
  // 4. GET /me - 普通用户视图
  // ============================================================
  describe('GET /me 用户视图', () => {
    it('wain 普通 user → 仅 wain + 全局 server 可见', async () => {
      await seedServers();
      h.setCaller(WAIN_USER);
      const res = await h.request('/api/mcp/me');
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.servers.map((s: { id: string }) => s.id).sort();
      expect(ids).toEqual(['global_shared', 'wain_only']);
      expect(ids).not.toContain('kaiyan_only');
    });

    it('kaiyan 普通 user → 仅 kaiyan + 全局 server 可见', async () => {
      await seedServers();
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/mcp/me');
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.servers.map((s: { id: string }) => s.id).sort();
      expect(ids).toEqual(['global_shared', 'kaiyan_only']);
    });
  });

  // ============================================================
  // 5. PUT /me/selections - 跨组织启用过滤
  // ============================================================
  describe('PUT /me/selections', () => {
    it('wain user 试图启用 kaiyan_only → 静默过滤 (不计入)', async () => {
      await seedServers();
      h.setCaller(WAIN_USER);
      const res = await h.request('/api/mcp/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledServers: ['wain_only', 'kaiyan_only', 'global_shared'] }),
      });
      expect(res.status).toBe(200);
      const cfg = h.store.getUserConfig('wain_user');
      expect(cfg.enabledServers.sort()).toEqual(['global_shared', 'wain_only']);
      expect(cfg.enabledServers).not.toContain('kaiyan_only');
    });
  });

  // ============================================================
  // 6b. PUT /me/servers/:serverId/secrets/:key - scope 严格校验（修 silent bug）
  // ============================================================
  describe('PUT /me/.../secrets/:key — scope 严格校验', () => {
    async function seedServerWithRequirements() {
      await h.store.upsertServer({
        ...basicServerBody('with_secrets', {
          tenantId: GLOBAL_TENANT_ID,
          secretRequirements: [
            { key: 'user_token', label: 'User Token', target: 'env', name: 'TOKEN', scope: 'user', required: true },
            { key: 'tenant_token', label: 'Tenant Token', target: 'env', name: 'T_TOKEN', scope: 'tenant', required: true },
            { key: 'global_token', label: 'Global Token', target: 'env', name: 'G_TOKEN', scope: 'global', required: true },
          ],
        }),
        id: 'with_secrets',
      } as ManagedMcpServer);
    }

    it('user scope secret 通过 /me → 200（scope 检查放过 user）', async () => {
      await seedServerWithRequirements();
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/mcp/me/servers/with_secrets/secrets/user_token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'abc' }),
      });
      expect(res.status).toBe(200);
    });

    it('tenant scope secret 通过 /me → 400 提示走 /admin', async () => {
      await seedServerWithRequirements();
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/mcp/me/servers/with_secrets/secrets/tenant_token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'abc' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/admin/i);
      expect(body.details?.scope).toBe('tenant');
    });

    it('global scope secret 通过 /me → 400 提示走 /admin', async () => {
      await seedServerWithRequirements();
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/mcp/me/servers/with_secrets/secrets/global_token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'abc' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.details?.scope).toBe('global');
    });
  });

  // ============================================================
  // 6. GET /admin/users/:username - 跨组织读防御
  // ============================================================
  describe('GET /admin/users/:username', () => {
    it('组织 admin (wain) 查 kaiyan 用户 → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/users/alice');
      expect(res.status).toBe(403);
    });

    it('平台 admin 查 wain 用户 → 200', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/mcp/admin/users/wain_user');
      expect(res.status).toBe(200);
    });

    it('组织 admin (wain) 查 own 用户 → 200, 仅见 wain + 全局', async () => {
      await seedServers();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/mcp/admin/users/wain_user');
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.servers.map((s: { id: string }) => s.id).sort();
      expect(ids).toEqual(['global_shared', 'wain_only']);
    });
  });

  describe('个人 MCP server', () => {
    it('普通用户可创建自己的 HTTP MCP，并自动只对本人可见和启用', async () => {
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/mcp/me/servers/alice_http', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Alice HTTP',
          description: 'personal',
          riskLevel: 'credentialed_external_write',
          config: { type: 'streamable-http', url: 'https://example.com/mcp' },
          secretRequirements: [{ key: 'token', label: 'Token', target: 'header', name: 'Authorization', scope: 'user', prefix: 'Bearer ' }],
        }),
      });
      expect(res.status).toBe(200);

      const mine = await (await h.request('/api/mcp/me')).json();
      expect(mine.servers.some((s: { id: string; personal?: boolean; enabled?: boolean }) => s.id === 'alice_http' && s.personal && s.enabled)).toBe(true);

      h.setCaller(WAIN_USER);
      const other = await (await h.request('/api/mcp/me')).json();
      expect(other.servers.some((s: { id: string }) => s.id === 'alice_http')).toBe(false);
    });

    it('普通用户不能创建 stdio 或 tenant-scope secret 的个人 MCP', async () => {
      h.setCaller(KAIYAN_USER);
      const stdio = await h.request('/api/mcp/me/servers/bad_stdio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bad', config: { type: 'stdio', command: 'node' } }),
      });
      expect(stdio.status).toBe(400);

      const tenantSecret = await h.request('/api/mcp/me/servers/bad_secret', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad Secret',
          config: { type: 'streamable-http', url: 'https://example.com/mcp' },
          secretRequirements: [{ key: 'token', label: 'Token', target: 'header', name: 'Authorization', scope: 'tenant' }],
        }),
      });
      expect(tenantSecret.status).toBe(400);
    });

    it('管理员 Catalog 不列出用户私有 MCP', async () => {
      h.setCaller(KAIYAN_USER);
      await h.request('/api/mcp/me/servers/alice_private', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Private', config: { type: 'streamable-http', url: 'https://example.com/mcp' } }),
      });

      h.setCaller(KAIYAN_ADMIN);
      const admin = await (await h.request('/api/mcp/admin/servers')).json();
      expect(admin.servers.some((s: { id: string }) => s.id === 'alice_private')).toBe(false);
    });
  });
});
