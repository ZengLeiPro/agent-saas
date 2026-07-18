/**
 * MCP 路由 OAuth 与 admin secrets 覆盖测试（routes/mcp.ts）
 *
 * 与 mcpRoutesCoverage.test.ts 的分工：那边覆盖 /me 系列 401、依赖缺失
 * （oauthService 503 / secretVault 501 on /me）、templates、/diagnose、
 * 个人连接器 CRUD、/me secrets 的 user-scope 链路与 tenant-scope 400 引导。
 * 本文件只补剩余未覆盖分支（同款 rig：fake oauthService/manager/vault +
 * 真 McpConfigStore + 真 express listen(0) + fetch）：
 *   - GET /oauth/callback：state 缺失/超长/无效 400、service 抛错 500、
 *     open-redirect 防御（https://evil.com、//evil.com、裸串等攻击向量强制回 /）、
 *     失败分支回滚 enabledServers、303 Location 携带 mcp_oauth/server 参数、
 *     webBaseUrl 与 redirectUrl-origin 两种基址
 *   - POST /me/servers/:id/oauth/start：401/400/404/409/成功（自动启用 + 幂等）
 *   - DELETE /me/servers/:id/oauth：503/404/成功（disconnect + 移出 enabledServers）
 *   - PUT /admin/servers/:serverId/secrets/:key：403/501/400/404 + scope 矩阵
 *     （user→400、tenant-on-global→400、global 非平台 admin→403、
 *     global 非全局 server→400、跨组织→403）+ tenant/global 成功链路
 *     （putSecret ownerId → setServerSecretRef → invalidate 全体用户）
 *   - POST /admin/users/:username/diagnose：404/403/成功/失败降级 200 ok:false
 *   - oauthRedirectUrl：非 localhost 未配置 env → throw；env 非 HTTPS / path
 *     错误 / 带 query → throw；localhost 同源默认值；合法 env 透传
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMcpRouter } from '../routes/mcp.js';
import type { McpRouterDeps } from '../routes/mcp.js';
import { McpConfigStore } from '../data/mcpConfig.js';
import type { ManagedMcpServer, McpSecretRequirement } from '../data/mcpConfig.js';
import type { JwtPayload } from '../auth/types.js';
import type { UserStore } from '../data/users/store.js';
import type { McpClientManager } from '../mcp/clientManager.js';
import type { McpOAuthFinishResult, McpOAuthService, McpOAuthStartResult } from '../mcp/oauthService.js';
import type { SecretRef, SecretVault } from '../security/secretVault.js';
import { GLOBAL_OWNER_ID, tenantOwnerId } from '../security/secretVault.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const ALICE: JwtPayload = { sub: 'u-alice', username: 'alice', role: 'user', tenantId: 'kaiyan' };
const KAIYAN_ADMIN: JwtPayload = { sub: 'u-kadmin', username: 'kadmin', role: 'admin', tenantId: 'kaiyan' };
const ACME_ADMIN: JwtPayload = { sub: 'u-aadmin', username: 'aadmin', role: 'admin', tenantId: 'acme' };
const PLATFORM_ADMIN: JwtPayload = { sub: 'u-root', username: 'root', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const ALL_USERNAMES = ['alice', 'kadmin', 'aadmin', 'root'];

function fakeUserStore(): UserStore {
  const users = [ALICE, KAIYAN_ADMIN, ACME_ADMIN, PLATFORM_ADMIN]
    .map(u => ({ id: u.sub, username: u.username, role: u.role, tenantId: u.tenantId }));
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    findById: (id: string) => users.find(u => u.id === id),
    listAll: () => users.map(u => ({ ...u })),
  } as unknown as UserStore;
}

function recordingManager(opts: { failEnsure?: boolean } = {}) {
  const invalidated: string[] = [];
  const manager = {
    invalidateUser: async (username: string) => { invalidated.push(username); },
    ensureUser: async () => {
      if (opts.failEnsure) throw new Error('diagnose boom');
      return [];
    },
  } as unknown as McpClientManager;
  return { manager, invalidated };
}

/** 记录所有 putSecret 调用（负向用例断言「未触碰 vault」，正向用例断言 ownerId/metadata） */
class RecordingVault implements SecretVault {
  puts: Array<{ ownerId: string; kind: string; value: string; metadata: Record<string, unknown> }> = [];
  private seq = 0;
  async putSecret(ownerId: string, kind: string, value: string, metadata: Record<string, unknown> = {}): Promise<SecretRef> {
    this.puts.push({ ownerId, kind, value, metadata });
    const now = new Date().toISOString();
    return { id: `ref-${++this.seq}`, ownerId, kind, metadata, createdAt: now, updatedAt: now };
  }
  async getSecret(): Promise<string> { throw new Error('not used in this test'); }
  async rotateSecret(): Promise<SecretRef> { throw new Error('not used in this test'); }
  async revokeSecret(): Promise<void> { throw new Error('not used in this test'); }
}

interface FakeOAuth {
  service: McpOAuthService;
  startCalls: Array<{ username: string; tenantId: string; serverId: string; redirectUrl: string; returnTo: string }>;
  disconnectCalls: Array<[string, string, string]>;
  metadataCalls: string[];
  startImpl: () => Promise<McpOAuthStartResult>;
  finishImpl: () => Promise<McpOAuthFinishResult | undefined>;
}

function fakeOAuthService(): FakeOAuth {
  const f: FakeOAuth = {
    startCalls: [],
    disconnectCalls: [],
    metadataCalls: [],
    startImpl: async () => ({ status: 'pending', authorizationUrl: 'https://provider.example.com/authorize?state=abc' }),
    finishImpl: async () => undefined,
    service: undefined as unknown as McpOAuthService,
  };
  f.service = {
    summary: () => undefined,
    clientMetadata: (redirectUrl: string) => {
      f.metadataCalls.push(redirectUrl);
      return { redirect_uris: [redirectUrl] };
    },
    start: async (args: { username: string; tenantId: string; server: ManagedMcpServer; redirectUrl: string; returnTo: string }) => {
      f.startCalls.push({ username: args.username, tenantId: args.tenantId, serverId: args.server.id, redirectUrl: args.redirectUrl, returnTo: args.returnTo });
      return f.startImpl();
    },
    finish: async () => f.finishImpl(),
    disconnect: async (username: string, tenantId: string, serverId: string) => {
      f.disconnectCalls.push([username, tenantId, serverId]);
    },
    disconnectServerUsers: async () => undefined,
  } as unknown as McpOAuthService;
  return f;
}

function finishResult(overrides: Partial<McpOAuthFinishResult> = {}): McpOAuthFinishResult {
  return {
    ok: true,
    username: 'alice',
    serverId: 'srv1',
    tenantId: 'kaiyan',
    redirectUrl: 'https://api.example.com/api/mcp/oauth/callback',
    returnTo: '/',
    ...overrides,
  };
}

interface RigOptions {
  vault?: SecretVault;
  oauth?: FakeOAuth;
  webBaseUrl?: string;
  manager?: McpClientManager;
  /** null = 匿名请求；缺省 = ALICE */
  user?: JwtPayload | null;
}

interface Rig {
  baseUrl: string;
  port: number;
  store: McpConfigStore;
  setUser(user: JwtPayload | null): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeRig(opts: RigOptions = {}): Promise<Rig> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-routes-oauth-'));
  const store = new McpConfigStore(join(tmpDir, 'mcp-config.json'));
  let currentUser: JwtPayload | null = opts.user === undefined ? ALICE : opts.user;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentUser) req.user = currentUser;
    next();
  });
  const deps: McpRouterDeps = {
    store,
    userStore: fakeUserStore(),
    manager: opts.manager ?? recordingManager().manager,
    agentCwd: tmpDir,
    secretVault: opts.vault,
    oauthService: opts.oauth?.service,
    webBaseUrl: opts.webBaseUrl,
  };
  app.use('/api/mcp', createMcpRouter(deps));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    port,
    store,
    setUser: u => { currentUser = u; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function seedServer(
  store: McpConfigStore,
  id: string,
  tenantId: string,
  secretRequirements?: McpSecretRequirement[],
): Promise<void> {
  await store.upsertServer({
    id,
    name: id,
    enabledByDefault: false,
    riskLevel: 'read_only',
    config: { type: 'http', url: 'https://example.com/mcp' },
    tenantId,
    secretRequirements,
  } as ManagedMcpServer);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** 用原生 http 客户端发请求以便伪造 Host 头（fetch 会剥掉 forbidden 的 Host 头） */
function rawGetStatus(port: number, path: string, hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Host: hostHeader } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const ENV_KEY = 'MCP_OAUTH_CALLBACK_URL';

describe('MCP routes: oauth callback/start/disconnect + admin secrets + oauthRedirectUrl', () => {
  let rigs: Rig[] = [];
  let savedCallbackEnv: string | undefined;

  async function rig(opts?: RigOptions): Promise<Rig> {
    const r = await makeRig(opts);
    rigs.push(r);
    return r;
  }

  beforeEach(() => {
    rigs = [];
    savedCallbackEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(async () => {
    if (savedCallbackEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedCallbackEnv;
    for (const r of rigs.splice(0)) await r.close();
  });

  // ---------------------------------------------------------------- callback

  describe('GET /oauth/callback', () => {
    it('state 缺失 / 超长 / finish 判定无效 → 400；finish 抛错 → 500', async () => {
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, user: null });

      expect((await r.request('/api/mcp/oauth/callback')).status).toBe(400);
      // stringQuery maxLength=1000：超长 state 等价于缺失
      expect((await r.request(`/api/mcp/oauth/callback?state=${'x'.repeat(1001)}`)).status).toBe(400);

      oauth.finishImpl = async () => undefined; // 一次性 state 已被消费
      const invalid = await r.request('/api/mcp/oauth/callback?state=used');
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain('invalid or has already been used');

      oauth.finishImpl = async () => { throw new Error('token exchange exploded'); };
      const crashed = await r.request('/api/mcp/oauth/callback?state=boom');
      expect(crashed.status).toBe(500);
      expect(await crashed.text()).toContain('OAuth callback failed');
    });

    it('open-redirect 防御：绝对 URL / 协议相对 / 非 / 开头的 returnTo 一律强制回 /', async () => {
      const oauth = fakeOAuthService();
      const { manager, invalidated } = recordingManager();
      const r = await rig({ oauth, manager, webBaseUrl: 'https://web.example.com', user: null });

      const attackVectors = ['https://evil.com', '//evil.com', '//evil.com/phish', 'evil.com', 'javascript:alert(1)', '\\evil.com'];
      for (const returnTo of attackVectors) {
        oauth.finishImpl = async () => finishResult({ returnTo });
        const res = await r.request('/api/mcp/oauth/callback?state=s&code=c', { redirect: 'manual' });
        expect(res.status).toBe(303);
        // 全部被钉回 webBaseUrl 根路径，绝不落到 evil.com
        expect(res.headers.get('location')).toBe('https://web.example.com/?mcp_oauth=connected&server=srv1');
      }
      expect(invalidated).toContain('alice');
    });

    it('已知缺陷记录：反斜杠向量 /\\evil.com 绕过路由层检查（上游 sanitizeReturnTo 兜底）', async () => {
      // routes/mcp.ts L269 只检查 startsWith('/') && !startsWith('//')，
      // 而 WHATWG URL 把 '/\\evil.com' 的反斜杠归一化为 '//evil.com' → https://evil.com/。
      // 生产链路上 oauthService.start 已用 sanitizeReturnTo（origin 比对）拦截该向量，
      // 但路由层独立防御存在缺口。本用例固化当前行为，修复后应改为断言回 '/'。
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, webBaseUrl: 'https://web.example.com', user: null });
      oauth.finishImpl = async () => finishResult({ returnTo: '/\\evil.com' });
      const res = await r.request('/api/mcp/oauth/callback?state=s&code=c', { redirect: 'manual' });
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('location') ?? '').hostname).toBe('evil.com');
    });

    it('合法站内 returnTo 保留 path+query，303 Location 追加 mcp_oauth/server 参数', async () => {
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, webBaseUrl: 'https://web.example.com', user: null });
      oauth.finishImpl = async () => finishResult({ returnTo: '/settings/connectors?tab=mcp' });
      const res = await r.request('/api/mcp/oauth/callback?state=s&code=c', { redirect: 'manual' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location'))
        .toBe('https://web.example.com/settings/connectors?tab=mcp&mcp_oauth=connected&server=srv1');
    });

    it('失败分支：回滚 enabledServers（仅移除该 server）并 redirect mcp_oauth=error', async () => {
      const oauth = fakeOAuthService();
      const { manager, invalidated } = recordingManager();
      const r = await rig({ oauth, manager, webBaseUrl: 'https://web.example.com', user: null });
      await seedServer(r.store, 'srv1', 'kaiyan');
      await seedServer(r.store, 'srv2', 'kaiyan');
      await r.store.setUserEnabledServers('alice', ['srv1', 'srv2'], 'kaiyan');

      oauth.finishImpl = async () => finishResult({ ok: false, error: 'access_denied' });
      const res = await r.request('/api/mcp/oauth/callback?state=s&error=access_denied', { redirect: 'manual' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://web.example.com/?mcp_oauth=error&server=srv1');
      expect(r.store.getUserConfig('alice').enabledServers).toEqual(['srv2']);
      expect(invalidated).toContain('alice');
    });

    it('失败分支：username 不在 userStore 时 tenantId 回退 result.tenantId，仍能完成回滚重定向', async () => {
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, webBaseUrl: 'https://web.example.com', user: null });
      oauth.finishImpl = async () => finishResult({ ok: false, username: 'ghost', tenantId: 'kaiyan' });
      const res = await r.request('/api/mcp/oauth/callback?state=s', { redirect: 'manual' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://web.example.com/?mcp_oauth=error&server=srv1');
    });

    it('未配置 webBaseUrl：基址回退 result.redirectUrl 同源（单域部署）', async () => {
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, user: null });
      oauth.finishImpl = async () => finishResult({ returnTo: 'https://evil.com' });
      const res = await r.request('/api/mcp/oauth/callback?state=s&code=c', { redirect: 'manual' });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('https://api.example.com/?mcp_oauth=connected&server=srv1');
    });
  });

  // ------------------------------------------------------- oauth start / disconnect

  describe('POST /me/servers/:serverId/oauth/start', () => {
    it('401 匿名 / 400 非法请求体 / 404 不存在或跨组织不可见', async () => {
      const oauth = fakeOAuthService();
      const anon = await rig({ oauth, user: null });
      expect((await anon.request('/api/mcp/me/servers/srv1/oauth/start', jsonInit('POST', {}))).status).toBe(401);

      const r = await rig({ oauth });
      await seedServer(r.store, 'srv1', 'kaiyan');
      expect((await r.request('/api/mcp/me/servers/srv1/oauth/start', jsonInit('POST', { returnTo: 123 }))).status).toBe(400);
      expect((await r.request('/api/mcp/me/servers/srv1/oauth/start', jsonInit('POST', { extra: true }))).status).toBe(400);
      expect((await r.request('/api/mcp/me/servers/ghost/oauth/start', jsonInit('POST', {}))).status).toBe(404);
      // 其他组织的 server 对 alice(kaiyan) 不可见 → 404 而非 403（不泄露存在性）
      await seedServer(r.store, 'acme-srv', 'acme');
      expect((await r.request('/api/mcp/me/servers/acme-srv/oauth/start', jsonInit('POST', {}))).status).toBe(404);
      expect(oauth.startCalls).toHaveLength(0);
    });

    it('成功：透传 returnTo、redirectUrl 指向本机回调路径、自动启用 server 且重复 start 不重复启用', async () => {
      const oauth = fakeOAuthService();
      const { manager, invalidated } = recordingManager();
      const r = await rig({ oauth, manager });
      await seedServer(r.store, 'srv1', 'kaiyan');

      const res = await r.request('/api/mcp/me/servers/srv1/oauth/start', jsonInit('POST', { returnTo: '/after-connect' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'pending', authorizationUrl: 'https://provider.example.com/authorize?state=abc' });
      expect(oauth.startCalls[0]).toMatchObject({
        username: 'alice',
        tenantId: 'kaiyan',
        serverId: 'srv1',
        returnTo: '/after-connect',
        // localhost 且未配置 env：oauthRedirectUrl 落到「回调 URL 同源」默认分支
        redirectUrl: `${r.baseUrl}/api/mcp/oauth/callback`,
      });
      expect(r.store.getUserConfig('alice').enabledServers).toEqual(['srv1']);
      expect(invalidated).toContain('alice');

      // 二次 start（已启用）：不重复追加；returnTo 缺省为 '/'
      const again = await r.request('/api/mcp/me/servers/srv1/oauth/start', jsonInit('POST', {}));
      expect(again.status).toBe(200);
      expect(oauth.startCalls[1]?.returnTo).toBe('/');
      expect(r.store.getUserConfig('alice').enabledServers).toEqual(['srv1']);
    });

    it('oauthService.start 抛错 → 409 携带错误消息', async () => {
      const oauth = fakeOAuthService();
      oauth.startImpl = async () => { throw new Error('platform OAuth client not configured'); };
      const r = await rig({ oauth });
      await seedServer(r.store, 'srv1', 'kaiyan');
      const res = await r.request('/api/mcp/me/servers/srv1/oauth/start', jsonInit('POST', {}));
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('not configured');
    });

    it('oauthRedirectUrl 抛错（env 非 HTTPS）经 start 的 try/catch 降级为 409', async () => {
      process.env[ENV_KEY] = 'http://api.example.com/api/mcp/oauth/callback';
      const oauth = fakeOAuthService();
      const r = await rig({ oauth });
      await seedServer(r.store, 'srv1', 'kaiyan');
      const res = await r.request('/api/mcp/me/servers/srv1/oauth/start', jsonInit('POST', {}));
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('HTTPS');
      expect(oauth.startCalls).toHaveLength(0);
    });
  });

  describe('DELETE /me/servers/:serverId/oauth', () => {
    it('oauthService 未装配 503 / 不可见 404 / 成功断开并移出 enabledServers', async () => {
      const noOauth = await rig();
      expect((await noOauth.request('/api/mcp/me/servers/srv1/oauth', { method: 'DELETE' })).status).toBe(503);

      const oauth = fakeOAuthService();
      const { manager, invalidated } = recordingManager();
      const r = await rig({ oauth, manager });
      expect((await r.request('/api/mcp/me/servers/ghost/oauth', { method: 'DELETE' })).status).toBe(404);

      await seedServer(r.store, 'srv1', 'kaiyan');
      await seedServer(r.store, 'srv2', 'kaiyan');
      await r.store.setUserEnabledServers('alice', ['srv1', 'srv2'], 'kaiyan');
      const res = await r.request('/api/mcp/me/servers/srv1/oauth', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(oauth.disconnectCalls).toEqual([['alice', 'kaiyan', 'srv1']]);
      expect(r.store.getUserConfig('alice').enabledServers).toEqual(['srv2']);
      expect(invalidated).toContain('alice');
    });
  });

  // ------------------------------------------------------------ admin secrets

  describe('PUT /admin/servers/:serverId/secrets/:key', () => {
    const TENANT_REQ: McpSecretRequirement = { key: 'TKEY', label: 'Tenant Key', target: 'header', name: 'X-Key', scope: 'tenant', required: true };
    const GLOBAL_REQ: McpSecretRequirement = { key: 'GKEY', label: 'Global Key', target: 'env', name: 'G_KEY', scope: 'global', required: true };
    const USER_REQ: McpSecretRequirement = { key: 'UKEY', label: 'User Key', target: 'header', name: 'Authorization', scope: 'user', required: true };

    async function seedMatrix(store: McpConfigStore): Promise<void> {
      await seedServer(store, 'ksrv', 'kaiyan', [USER_REQ, TENANT_REQ, GLOBAL_REQ]);
      await seedServer(store, 'gsrv', '*', [TENANT_REQ, GLOBAL_REQ]);
    }

    it('非 admin 403 / vault 未装配 501 / 请求体校验 400，全部不触碰 vault', async () => {
      const vault = new RecordingVault();
      const r = await rig({ vault, user: ALICE });
      await seedMatrix(r.store);
      expect((await r.request('/api/mcp/admin/servers/ksrv/secrets/TKEY', jsonInit('PUT', { value: 'v' }))).status).toBe(403);

      r.setUser(PLATFORM_ADMIN);
      expect((await r.request('/api/mcp/admin/servers/ksrv/secrets/TKEY', jsonInit('PUT', { value: '' }))).status).toBe(400);
      expect((await r.request('/api/mcp/admin/servers/ksrv/secrets/TKEY', jsonInit('PUT', { nope: 1 }))).status).toBe(400);
      expect(vault.puts).toHaveLength(0);

      const noVault = await rig({ user: PLATFORM_ADMIN });
      await seedMatrix(noVault.store);
      expect((await noVault.request('/api/mcp/admin/servers/ksrv/secrets/TKEY', jsonInit('PUT', { value: 'v' }))).status).toBe(501);
    });

    it('404（server / requirement 不存在）与 scope 错配矩阵，全部不写 vault', async () => {
      const vault = new RecordingVault();
      const r = await rig({ vault, user: PLATFORM_ADMIN });
      await seedMatrix(r.store);

      expect((await r.request('/api/mcp/admin/servers/ghost/secrets/TKEY', jsonInit('PUT', { value: 'v' }))).status).toBe(404);
      expect((await r.request('/api/mcp/admin/servers/ksrv/secrets/NOPE', jsonInit('PUT', { value: 'v' }))).status).toBe(404);

      // user scope → 400 引导走 /me
      const userScope = await r.request('/api/mcp/admin/servers/ksrv/secrets/UKEY', jsonInit('PUT', { value: 'v' }));
      expect(userScope.status).toBe(400);
      expect((await userScope.json() as { error: string }).error).toContain('/me/servers');

      // tenant scope on 全局 server → 400（归属含糊）
      const ambiguous = await r.request('/api/mcp/admin/servers/gsrv/secrets/TKEY', jsonInit('PUT', { value: 'v' }));
      expect(ambiguous.status).toBe(400);
      expect((await ambiguous.json() as { error: string }).error).toContain('ambiguous');

      // global scope + 平台 admin，但 server 非全局 → 400
      const notGlobal = await r.request('/api/mcp/admin/servers/ksrv/secrets/GKEY', jsonInit('PUT', { value: 'v' }));
      expect(notGlobal.status).toBe(400);
      expect((await notGlobal.json() as { error: string }).error).toContain('tenantId === "*"');

      // global scope + 组织 admin（能写 ksrv 但非平台 admin）→ 403
      r.setUser(KAIYAN_ADMIN);
      const orgGlobal = await r.request('/api/mcp/admin/servers/ksrv/secrets/GKEY', jsonInit('PUT', { value: 'v' }));
      expect(orgGlobal.status).toBe(403);
      expect((await orgGlobal.json() as { error: string }).error).toContain('platform admin');

      // 跨组织：acme admin 写 kaiyan server → 403
      r.setUser(ACME_ADMIN);
      expect((await r.request('/api/mcp/admin/servers/ksrv/secrets/TKEY', jsonInit('PUT', { value: 'v' }))).status).toBe(403);
      // 组织 admin 写全局 server（canWriteServerForTenant 先拦）→ 403
      expect((await r.request('/api/mcp/admin/servers/gsrv/secrets/GKEY', jsonInit('PUT', { value: 'v' }))).status).toBe(403);

      expect(vault.puts).toHaveLength(0);
    });

    it('tenant-scope 成功链路：putSecret(ownerId=tenant:kaiyan) → setServerSecretRef → invalidate 全体用户', async () => {
      const vault = new RecordingVault();
      const { manager, invalidated } = recordingManager();
      const r = await rig({ vault, manager, user: KAIYAN_ADMIN });
      await seedMatrix(r.store);

      const res = await r.request('/api/mcp/admin/servers/ksrv/secrets/TKEY', jsonInit('PUT', { value: 'sk-tenant-1' }));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; ref: { id: string } };
      expect(body.ok).toBe(true);
      expect(vault.puts).toHaveLength(1);
      expect(vault.puts[0]).toMatchObject({ ownerId: tenantOwnerId('kaiyan'), kind: 'mcp', value: 'sk-tenant-1' });
      expect(vault.puts[0]?.metadata).toMatchObject({ serverId: 'ksrv', key: 'TKEY', scope: 'tenant' });
      // ref 落到 server 级 secretRefs（非用户命名空间）
      expect(r.store.getServer('ksrv')?.secretRefs?.TKEY).toBe(body.ref.id);
      expect(r.store.getUserConfig('kadmin').secretRefs).toEqual({});
      // 全体用户的 MCP client 缓存失效
      for (const username of ALL_USERNAMES) expect(invalidated).toContain(username);
    });

    it('global-scope 成功链路：平台 admin + 全局 server → ownerId=global', async () => {
      const vault = new RecordingVault();
      const { manager, invalidated } = recordingManager();
      const r = await rig({ vault, manager, user: PLATFORM_ADMIN });
      await seedMatrix(r.store);

      const res = await r.request('/api/mcp/admin/servers/gsrv/secrets/GKEY', jsonInit('PUT', { value: 'sk-global-1' }));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; ref: { id: string } };
      expect(vault.puts).toHaveLength(1);
      expect(vault.puts[0]).toMatchObject({ ownerId: GLOBAL_OWNER_ID, kind: 'mcp', value: 'sk-global-1' });
      expect(vault.puts[0]?.metadata).toMatchObject({ serverId: 'gsrv', key: 'GKEY', scope: 'global' });
      expect(r.store.getServer('gsrv')?.secretRefs?.GKEY).toBe(body.ref.id);
      for (const username of ALL_USERNAMES) expect(invalidated).toContain(username);
    });
  });

  // ------------------------------------------------------------ admin diagnose

  describe('POST /admin/users/:username/diagnose', () => {
    it('404 未知用户 / 403 跨组织 / 成功 ok:true / manager 失败降级 200 ok:false 且带 workspaceRoot', async () => {
      const r = await rig({ user: PLATFORM_ADMIN });
      expect((await r.request('/api/mcp/admin/users/ghost/diagnose', { method: 'POST' })).status).toBe(404);

      r.setUser(ACME_ADMIN);
      expect((await r.request('/api/mcp/admin/users/alice/diagnose', { method: 'POST' })).status).toBe(403);

      r.setUser(KAIYAN_ADMIN);
      const ok = await r.request('/api/mcp/admin/users/alice/diagnose', { method: 'POST' });
      expect(ok.status).toBe(200);
      const okBody = await ok.json() as { ok: boolean; workspaceRoot: string; toolCount: number };
      expect(okBody.ok).toBe(true);
      expect(okBody.toolCount).toBe(0);
      expect(okBody.workspaceRoot).toContain('kaiyan');

      const failRig = await rig({ user: PLATFORM_ADMIN, manager: recordingManager({ failEnsure: true }).manager });
      const fail = await failRig.request('/api/mcp/admin/users/alice/diagnose', { method: 'POST' });
      expect(fail.status).toBe(200);
      const failBody = await fail.json() as { ok: boolean; error: string; workspaceRoot: string; tools: unknown[] };
      expect(failBody.ok).toBe(false);
      expect(failBody.error).toContain('diagnose boom');
      expect(failBody.workspaceRoot).toContain('kaiyan');
      expect(failBody.tools).toEqual([]);
    });
  });

  // ------------------------------------------------------------ oauthRedirectUrl

  describe('oauthRedirectUrl（经 GET /oauth/client-metadata 观察）', () => {
    it('localhost 且未配置 env：回退回调 URL 同源，200 + Cache-Control', async () => {
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, user: null });
      const res = await r.request('/api/mcp/oauth/client-metadata');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(await res.json()).toEqual({ redirect_uris: [`${r.baseUrl}/api/mcp/oauth/callback`] });
    });

    it('非 localhost 且未配置 env → throw（express 兜底 500）', async () => {
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, user: null });
      expect(await rawGetStatus(r.port, '/api/mcp/oauth/client-metadata', 'api.example.com')).toBe(500);
      expect(oauth.metadataCalls).toHaveLength(0);
    });

    it('env 非 HTTPS / path 错误 / 带 query → throw 500；合法 HTTPS env 透传 200', async () => {
      const oauth = fakeOAuthService();
      const r = await rig({ oauth, user: null });

      process.env[ENV_KEY] = 'http://api.example.com/api/mcp/oauth/callback';
      expect((await r.request('/api/mcp/oauth/client-metadata')).status).toBe(500);

      process.env[ENV_KEY] = 'https://api.example.com/oauth/callback';
      expect((await r.request('/api/mcp/oauth/client-metadata')).status).toBe(500);

      process.env[ENV_KEY] = 'https://api.example.com/api/mcp/oauth/callback?extra=1';
      expect((await r.request('/api/mcp/oauth/client-metadata')).status).toBe(500);
      expect(oauth.metadataCalls).toHaveLength(0);

      process.env[ENV_KEY] = 'https://api.example.com/api/mcp/oauth/callback';
      const ok = await r.request('/api/mcp/oauth/client-metadata');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ redirect_uris: ['https://api.example.com/api/mcp/oauth/callback'] });
    });
  });
});
