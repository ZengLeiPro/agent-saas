/**
 * agents 路由多组织隔离测试（PR 8）
 *
 * 核心修复：原 canAccess (`role === 'admin' || username === self`) 让任意组织 admin
 * 都能改其他组织用户的 PERSONA.md / MEMORY.md / 头像。这是严重越权。
 *
 * 覆盖：
 *   - PATCH /:username      跨组织 admin → 403
 *   - GET /:username        跨组织 admin → 403；返回路径按 target 组织解析
 *   - PUT /:username/persona  跨组织 admin → 403
 *   - PUT /:username/memory   跨组织 admin → 403
 *   - GET /                 platform admin 看全部；组织 admin 仅本组织
 *   - 普通用户改/读 self    OK
 *   - 普通用户改/读他人      403
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentsRouter } from '../routes/agents.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import type { AgentStore } from '../data/agents/store.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const KAIYAN_USER: JwtPayload = { sub: 'u-ku', username: 'alice', role: 'user', tenantId: 'kaiyan' };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };

interface TestRig {
  baseUrl: string;
  agentCwd: string;
  setCaller(caller: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

function userRecord(id: string, username: string, role: 'admin' | 'user', tenantId: string): UserRecord {
  return {
    id,
    username,
    passwordHash: 'x',
    role,
    tenantId,
    realName: username,
    createdAt: '2026-06-23T00:00:00Z',
    createdBy: 'system',
    updatedAt: '2026-06-23T00:00:00Z',
  };
}

function fakeUserStore(): UserStore {
  const users: UserRecord[] = [
    userRecord('u-platform', 'admin', 'admin', DEFAULT_TENANT_ID),
    userRecord('u-ka', 'zengky', 'admin', 'kaiyan'),
    userRecord('u-ku', 'alice', 'user', 'kaiyan'),
    userRecord('u-wa', 'wain_admin', 'admin', 'wain'),
    userRecord('u-wu', 'wain_user', 'user', 'wain'),
  ];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    listAll: () => users.map(u => ({ ...u })),
  } as unknown as UserStore;
}

function fakeAgentStore(): AgentStore {
  const store = new Map<string, { username: string; name?: string; signature?: string; avatar?: string; avatarVersion?: number }>([
    ['admin', { username: 'admin', name: 'admin' }],
    ['zengky', { username: 'zengky', name: 'zengky' }],
    // alice 故意缺 profile，验证列表以真实用户为准并使用默认 agent 展示
    ['wain_admin', { username: 'wain_admin', name: 'wain_admin' }],
    ['wain_user', { username: 'wain_user', name: 'wain_user' }],
    // data/agents.json 中可能残留已删除用户；列表不应被陈旧 profile 驱动
    ['stale_ghost', { username: 'stale_ghost', name: 'stale_ghost' }],
  ]);
  return {
    get: (username: string) => store.get(username),
    getAll: () => Array.from(store.values()),
    set: async (username: string, data: Record<string, unknown>) => {
      const existing = store.get(username) ?? { username };
      const next = { ...existing, ...data, username };
      store.set(username, next as never);
      return next as never;
    },
  } as unknown as AgentStore;
}

async function makeTestRig(): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agents-tenant-iso-'));
  const agentCwd = join(tmpRoot, 'workspace');
  const agentAvatarsDir = join(tmpRoot, 'avatars');
  const sharedDir = join(tmpRoot, 'shared');
  mkdirSync(agentCwd, { recursive: true });
  mkdirSync(agentAvatarsDir, { recursive: true });
  mkdirSync(sharedDir, { recursive: true });
  // 种 PERSONA / MEMORY 文件验证读路径正确
  for (const [tenant, username, userId] of [
    ['kaiyan', 'zengky', 'u-ka'],
    ['kaiyan', 'alice', 'u-ku'],
    [DEFAULT_TENANT_ID, 'admin', 'u-platform'],
    ['wain', 'wain_admin', 'u-wa'],
    ['wain', 'wain_user', 'u-wu'],
  ] as const) {
    const dir = join(agentCwd, tenant, userId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PERSONA.md'), `# ${username} persona`);
    writeFileSync(join(dir, 'MEMORY.md'), `# ${username} memory`);
  }
  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/agents', createAgentsRouter({
    agentStore: fakeAgentStore(),
    agentAvatarsDir,
    agentCwd,
    sharedDir,
    userStore: fakeUserStore(),
  }));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    agentCwd,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('agents 路由多组织隔离 (PR 8)', () => {
  let h: TestRig;

  beforeEach(async () => { h = await makeTestRig(); });
  afterEach(async () => { await h.close(); });

  // ============================================================
  // canAccess / authorizeAgentAccess 跨组织防御
  // ============================================================
  describe('跨组织 admin 防御', () => {
    it('组织 admin (wain) GET kaiyan 用户 → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/agents/zengky');
      expect(res.status).toBe(403);
    });

    it('组织 admin (wain) PATCH kaiyan 用户 → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/agents/zengky', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hijacked' }),
      });
      expect(res.status).toBe(403);
    });

    it('组织 admin (wain) GET kaiyan 用户 persona → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/agents/zengky/persona');
      expect(res.status).toBe(403);
    });

    it('组织 admin (wain) PUT kaiyan 用户 persona → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/agents/zengky/persona', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hijacked persona' }),
      });
      expect(res.status).toBe(403);
      // 原文件未被写
      const orig = readFileSync(join(h.agentCwd, 'kaiyan', 'u-ka', 'PERSONA.md'), 'utf-8');
      expect(orig).not.toContain('hijacked');
    });

    it('组织 admin (wain) PUT kaiyan 用户 memory → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/agents/zengky/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hijacked memory' }),
      });
      expect(res.status).toBe(403);
      const orig = readFileSync(join(h.agentCwd, 'kaiyan', 'u-ka', 'MEMORY.md'), 'utf-8');
      expect(orig).not.toContain('hijacked');
    });
  });

  // ============================================================
  // 同组织 admin / platform admin 正常路径
  // ============================================================
  describe('同组织与 platform admin 正常路径', () => {
    it('组织 admin (wain) GET 本组织用户 → 200', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/agents/wain_user');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.username).toBe('wain_user');
      expect(body.persona).toContain('wain_user persona');
    });

    it('platform admin GET wain 用户 → 200 (跨组织允许)', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/agents/wain_user');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.persona).toContain('wain_user persona');
    });

    it('platform admin PUT wain 用户 memory → 200 + 写入路径按 target 组织解析', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/agents/wain_user/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# updated by platform admin' }),
      });
      expect(res.status).toBe(200);
      // 路径修复验证：写入应在 <agentCwd>/wain/<userId>/MEMORY.md，不是 <agentCwd>/wain_user/MEMORY.md
      const written = readFileSync(join(h.agentCwd, 'wain', 'u-wu', 'MEMORY.md'), 'utf-8');
      expect(written).toBe('# updated by platform admin');
    });
  });

  // ============================================================
  // 普通用户自己/他人
  // ============================================================
  describe('普通用户权限', () => {
    it('普通用户读自己 persona → 200', async () => {
      h.setCaller(WAIN_USER);
      const res = await h.request('/api/agents/wain_user/persona');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toContain('wain_user persona');
    });

    it('普通用户读自己 profile：缺 agent profile 时用默认展示 → 200', async () => {
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/agents/alice');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.username).toBe('alice');
      expect(body.name).toBe('开开');
      expect(body.persona).toContain('alice persona');
    });

    it('普通用户读他人 persona (同组织) → 403', async () => {
      h.setCaller(WAIN_USER);
      const res = await h.request('/api/agents/wain_admin/persona');
      expect(res.status).toBe(403);
    });

    it('普通用户改他人 (含 admin) → 403', async () => {
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/agents/zengky', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'attempt' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // GET / 列表过滤
  // ============================================================
  describe('GET / 列表 admin 视图按组织过滤', () => {
    it('platform admin → 完整列表（含 wain 用户）', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/agents/');
      expect(res.status).toBe(200);
      const body = await res.json() as { username: string }[];
      const usernames = body.map(p => p.username).sort();
      expect(usernames).toContain('admin');
      expect(usernames).toContain('alice');
      expect(usernames).toContain('wain_admin');
      expect(usernames).toContain('wain_user');
      expect(usernames).toContain('zengky');
      expect(usernames).not.toContain('stale_ghost');
    });

    it('组织 admin (wain) → 仅本组织用户', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/agents/');
      expect(res.status).toBe(200);
      const body = await res.json() as { username: string }[];
      const usernames = body.map(p => p.username).sort();
      expect(usernames).toEqual(['wain_admin', 'wain_user']);
    });

    it('platform admin + scope=currentTenant → 仅当前组织用户', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/agents/?scope=currentTenant');
      expect(res.status).toBe(200);
      const body = await res.json() as { username: string }[];
      const usernames = body.map(p => p.username).sort();
      expect(usernames).toEqual(['admin']);
    });

    it('普通用户 → 仅本组织用户公开字段（非 admin 视图不暴露 realName）', async () => {
      h.setCaller(WAIN_USER);
      const res = await h.request('/api/agents/');
      expect(res.status).toBe(200);
      const body = await res.json() as { username: string; realName?: string }[];
      const usernames = body.map(p => p.username).sort();
      expect(usernames).toEqual(['wain_admin', 'wain_user']);
      expect(body.every(p => !('realName' in p))).toBe(true);
      expect(body.every(p => !('personaPreview' in p))).toBe(true);
    });

    it('普通用户 → 以真实用户为准：缺 profile 用默认展示，陈旧 profile 不出现', async () => {
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/agents/');
      expect(res.status).toBe(200);
      const body = await res.json() as { username: string; name?: string }[];
      const usernames = body.map(p => p.username).sort();
      expect(usernames).toEqual(['alice', 'zengky']);
      expect(body.find(p => p.username === 'alice')?.name).toBe('开开');
      expect(usernames).not.toContain('stale_ghost');
    });
  });
});
