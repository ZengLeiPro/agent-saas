/**
 * MCP 路由覆盖测试（routes/mcp.ts）
 *
 * 现有 mcpRouterTenantIsolation.test.ts 覆盖 admin server CRUD 的组织隔离；
 * 本文件只补未覆盖的分支（真 express + 真 McpConfigStore + 真 fetch）：
 *   - /me 系列 401（无 req.user）
 *   - 依赖缺失：oauthService 未装配 → 503 / secretVault 未装配 → 501
 *   - GET /templates、POST /diagnose（成功 + 失败降级为 200 ok:false）
 *   - PUT /me/servers/:id 个人连接器：校验 400 / stdio 拒绝 400 / id 冲突 409 / 成功 200
 *   - DELETE /me/servers/:id：404 非本人 / 200 本人
 *   - PUT /me/servers/:serverId/secrets/:key：server 不可见 404 / requirement 不存在 404 /
 *     非 user scope 400 / 成功 200
 *   - /me/selections 400 校验
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpRouter } from '../routes/mcp.js';
import type { McpRouterDeps } from '../routes/mcp.js';
import { McpConfigStore } from '../data/mcpConfig.js';
import type { ManagedMcpServer } from '../data/mcpConfig.js';
import type { JwtPayload } from '../auth/types.js';
import type { UserStore } from '../data/users/store.js';
import type { McpClientManager, McpToolDescriptor } from '../mcp/clientManager.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const USER: JwtPayload = { sub: 'u-ku', username: 'alice', role: 'user', tenantId: 'kaiyan' };

function fakeUserStore(): UserStore {
  const users = [{ id: 'u-ku', username: 'alice', role: 'user' as const, tenantId: 'kaiyan' }];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    findById: (id: string) => users.find(u => u.id === id),
    listAll: () => users.map(u => ({ ...u })),
  } as unknown as UserStore;
}

function fakeMcpManager(tools: McpToolDescriptor[] = [], failEnsure = false): McpClientManager {
  return {
    invalidateUser: async () => undefined,
    ensureUser: async () => {
      if (failEnsure) throw new Error('boom connecting to MCP');
      return tools;
    },
  } as unknown as McpClientManager;
}

interface RigOptions {
  withSecretVault?: boolean;
  withOAuthService?: boolean;
  manager?: McpClientManager;
  user?: JwtPayload | undefined;
}

interface Rig {
  baseUrl: string;
  store: McpConfigStore;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeRig(opts: RigOptions = {}): Promise<Rig> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-routes-cov-'));
  const store = new McpConfigStore(join(tmpDir, 'mcp-config.json'));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if ('user' in opts ? opts.user : USER) req.user = ('user' in opts ? opts.user : USER) as JwtPayload;
    next();
  });
  const deps: Partial<McpRouterDeps> & { store: McpConfigStore; userStore: UserStore; manager: McpClientManager; agentCwd: string } = {
    store,
    userStore: fakeUserStore(),
    manager: opts.manager ?? fakeMcpManager(),
    agentCwd: tmpDir,
  };
  if (opts.withSecretVault) deps.secretVault = new InMemorySecretVault();
  // oauthService 默认不装配（覆盖 503 分支）；withOAuthService 暂不需要真实实例
  app.use('/api/mcp', createMcpRouter(deps as McpRouterDeps));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    store,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** 一个对 kaiyan 可见、带 user-scope secret requirement 的个人 http server */
async function seedPersonalServer(store: McpConfigStore, id: string): Promise<void> {
  await store.upsertServer({
    id,
    name: id,
    enabledByDefault: false,
    riskLevel: 'read_only',
    config: { type: 'http', url: 'https://example.com/mcp' },
    tenantId: 'kaiyan',
    ownerUsername: 'alice',
    secretRequirements: [
      { key: 'TOKEN', label: 'API Token', target: 'header', name: 'Authorization', scope: 'user', required: true },
    ],
  } as ManagedMcpServer);
}

describe('MCP routes coverage', () => {
  let rigs: Rig[] = [];
  async function rig(opts?: RigOptions): Promise<Rig> {
    const r = await makeRig(opts);
    rigs.push(r);
    return r;
  }

  beforeEach(() => { rigs = []; });
  afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });

  it('GET /templates 返回模板列表（公开，无需权限）', async () => {
    const r = await rig();
    const res = await r.request('/api/mcp/templates');
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json() as { templates: unknown[] }).templates)).toBe(true);
  });

  it('/me 系列 401：无 req.user', async () => {
    const r = await rig({ user: undefined });
    expect((await r.request('/api/mcp/me')).status).toBe(401);
    expect((await r.request('/api/mcp/me/selections', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabledServers: [] }),
    })).status).toBe(401);
    expect((await r.request('/api/mcp/diagnose', { method: 'POST' })).status).toBe(401);
  });

  it('GET /me 返回 configVersion 与可见 server 视图', async () => {
    const r = await rig();
    const res = await r.request('/api/mcp/me');
    expect(res.status).toBe(200);
    const body = await res.json() as { configVersion: number; servers: unknown[] };
    expect(typeof body.configVersion).toBe('number');
    expect(Array.isArray(body.servers)).toBe(true);
  });

  it('OAuth 未装配 → 503：client-metadata / me oauth start / oauth callback', async () => {
    const r = await rig();
    expect((await r.request('/api/mcp/oauth/client-metadata')).status).toBe(503);
    // callback 是文本响应
    expect((await r.request('/api/mcp/oauth/callback?state=x')).status).toBe(503);
    await seedPersonalServer(r.store, 'srv1');
    const start = await r.request('/api/mcp/me/servers/srv1/oauth/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(start.status).toBe(503);
  });

  it('POST /diagnose：成功返回 tools；ensureUser 抛错时降级为 200 ok:false', async () => {
    const okRig = await rig({ manager: fakeMcpManager([
      { serverName: 's', toolName: 't', description: 'd' } as McpToolDescriptor,
    ]) });
    const okRes = await okRig.request('/api/mcp/diagnose', { method: 'POST' });
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json() as { ok: boolean; toolCount: number };
    expect(okBody.ok).toBe(true);
    expect(okBody.toolCount).toBe(1);

    const failRig = await rig({ manager: fakeMcpManager([], true) });
    const failRes = await failRig.request('/api/mcp/diagnose', { method: 'POST' });
    // 失败也返回 200（前端据 ok 字段判断）
    expect(failRes.status).toBe(200);
    const failBody = await failRes.json() as { ok: boolean; error: string };
    expect(failBody.ok).toBe(false);
    expect(failBody.error).toContain('boom');
  });

  it('GET /me 暴露最近真实连接状态；force diagnose 会重新建连并按 server 返回错误', async () => {
    const invalidateUser = vi.fn(async () => undefined);
    const manager = {
      invalidateUser,
      ensureUser: vi.fn(async () => []),
      getUserConnectionStatuses: vi.fn(() => [{
        serverName: 'srv1',
        status: 'error' as const,
        toolCount: 0,
        checkedAt: '2026-07-20T14:00:00.000Z',
        lastError: 'OAuth connection is not authorized for this user',
        nextRetryAt: '2026-07-20T14:00:05.000Z',
      }]),
    } as unknown as McpClientManager;
    const r = await rig({ manager });
    await seedPersonalServer(r.store, 'srv1');
    await r.store.setUserEnabledServers('alice', ['srv1'], 'kaiyan');

    const me = await r.request('/api/mcp/me');
    const meBody = await me.json() as { servers: Array<{ id: string; connection?: { status: string; lastError?: string } }> };
    expect(meBody.servers.find(server => server.id === 'srv1')?.connection).toMatchObject({
      status: 'error',
      lastError: 'OAuth connection is not authorized for this user',
    });

    const diagnosed = await r.request('/api/mcp/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    const diagnosedBody = await diagnosed.json() as {
      ok: boolean;
      error?: string;
      connections: Array<{ serverName: string; status: string }>;
    };
    expect(invalidateUser).toHaveBeenCalledWith('alice');
    expect(diagnosedBody).toMatchObject({
      ok: false,
      error: 'OAuth connection is not authorized for this user',
      connections: [{ serverName: 'srv1', status: 'error' }],
    });
  });

  it('PUT /me/servers/:id 个人连接器：stdio 拒绝 400 / 成功 200 / id 冲突 409', async () => {
    const r = await rig();
    // stdio command 个人连接器不支持 → 400
    const stdioRes = await r.request('/api/mcp/me/servers/mine', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mine', config: { type: 'stdio', command: 'node' } }),
    });
    expect(stdioRes.status).toBe(400);

    // 合法 http 个人连接器 → 200
    const okRes = await r.request('/api/mcp/me/servers/mine', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'mine', config: { type: 'http', url: 'https://example.com/mcp' } }),
    });
    expect(okRes.status).toBe(200);
    expect((await okRes.json() as { ok: boolean }).ok).toBe(true);

    // 平台预置一个非本人 owner 的 server，然后个人 PUT 同 id → 409
    await r.store.upsertServer({
      id: 'shared', name: 'shared', config: { type: 'http', url: 'https://x.com/mcp' }, tenantId: 'kaiyan',
    } as ManagedMcpServer);
    const conflict = await r.request('/api/mcp/me/servers/shared', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'shared', config: { type: 'http', url: 'https://example.com/mcp' } }),
    });
    expect(conflict.status).toBe(409);
  });

  it('DELETE /me/servers/:id：非本人/不存在 404 / 本人 200', async () => {
    const r = await rig();
    expect((await r.request('/api/mcp/me/servers/ghost', { method: 'DELETE' })).status).toBe(404);
    await seedPersonalServer(r.store, 'mine2');
    const ok = await r.request('/api/mcp/me/servers/mine2', { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ok: boolean }).ok).toBe(true);
  });

  it('PUT /me/servers/:serverId/secrets/:key：vault 未装配 501 / server 不可见 404 / 非 user-scope 400 / 成功 200', async () => {
    // 501：secretVault 未装配
    const noVault = await rig();
    await seedPersonalServer(noVault.store, 'srv');
    const res501 = await noVault.request('/api/mcp/me/servers/srv/secrets/TOKEN', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'v' }),
    });
    expect(res501.status).toBe(501);

    const r = await rig({ withSecretVault: true });
    // server 不存在 → 404
    const res404 = await r.request('/api/mcp/me/servers/ghost/secrets/TOKEN', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'v' }),
    });
    expect(res404.status).toBe(404);

    await seedPersonalServer(r.store, 'srv');
    // requirement 不存在的 key → 404
    const badKey = await r.request('/api/mcp/me/servers/srv/secrets/NOPE', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'v' }),
    });
    expect(badKey.status).toBe(404);

    // 成功：user-scope secret → 200
    const okRes = await r.request('/api/mcp/me/servers/srv/secrets/TOKEN', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'sk-123' }),
    });
    expect(okRes.status).toBe(200);
    const okBody = await okRes.json() as { ok: boolean; ref: { id: string } };
    expect(okBody.ok).toBe(true);
    expect(okBody.ref.id).toBeTruthy();

    // 值校验失败（空 value）→ 400
    const badVal = await r.request('/api/mcp/me/servers/srv/secrets/TOKEN', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: '' }),
    });
    expect(badVal.status).toBe(400);
  });

  it('PUT /me/servers/:serverId/secrets/:key：tenant-scope requirement → 400 引导走 /admin', async () => {
    const r = await rig({ withSecretVault: true });
    // 预置一个带 tenant-scope requirement 的组织 server（对 kaiyan user 可见）
    await r.store.upsertServer({
      id: 'tsrv', name: 'tsrv', config: { type: 'http', url: 'https://x.com/mcp' }, tenantId: 'kaiyan',
      secretRequirements: [
        { key: 'TKEY', label: 'Tenant Key', target: 'header', name: 'X-Key', scope: 'tenant', required: true },
      ],
    } as ManagedMcpServer);
    const res = await r.request('/api/mcp/me/servers/tsrv/secrets/TKEY', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'v' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('/admin');
  });

  it('PUT GitHub token：绑定前拒绝非 PAT，接受 classic/fine-grained PAT 与可选 Bearer 前缀', async () => {
    const r = await rig({ withSecretVault: true });
    await r.store.upsertServer({
      id: 'github',
      name: 'GitHub',
      createdFromTemplateId: 'github',
      config: { type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' },
      tenantId: '*',
      secretRequirements: [
        { key: 'token', label: 'GitHub PAT', target: 'header', name: 'Authorization', prefix: 'Bearer ', scope: 'user', required: true },
      ],
    } as ManagedMcpServer);

    const invalid = await r.request('/api/mcp/me/servers/github/secrets/token', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'not-a-personal-access-token' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: string }).error).toContain('GitHub Token 格式不正确');

    const classic = await r.request('/api/mcp/me/servers/github/secrets/token', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: `Bearer ghp_${'a'.repeat(36)}` }),
    });
    expect(classic.status).toBe(200);

    const fineGrained = await r.request('/api/mcp/me/servers/github/secrets/token', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: `github_pat_${'b'.repeat(40)}` }),
    });
    expect(fineGrained.status).toBe(200);
  });

  it('PUT /me/selections：非法请求体 400', async () => {
    const r = await rig();
    const res = await r.request('/api/mcp/me/selections', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabledServers: 'not-array' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('Invalid selections');
  });
});
