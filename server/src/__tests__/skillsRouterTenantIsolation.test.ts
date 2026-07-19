/**
 * skills 路由多组织隔离测试（PR 9）
 *
 * 修复焦点：
 *   1. pool 写操作 (PATCH /pool/visibility, PUT /pool/:id/document,
 *      POST /custom/:id/promote) 改 requirePlatformAdmin —— 防止组织 admin
 *      改动平台共享的 skill 池（会影响所有组织用户）
 *   2. /custom 列表 / DELETE /custom/:u/:id / GET PUT /users/:u/... /
 *      POST /sync ?username= 都加跨组织校验（组织 admin 仅本组织用户）
 *   3. getUserSkillsDir(username) 改为 getUserSkillsDir(user) 用
 *      resolveUserCwd 解析——物理路径使用 tenantId/userId，非 kaiyan 组织用户读不到自建
 *      skill / 写到错路径
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSkillsRouter } from '../routes/skills.js';
import { requireAdmin } from '../auth/middleware.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const KAIYAN_USER: JwtPayload = { sub: 'u-ku', username: 'alice', role: 'user', tenantId: 'kaiyan' };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };

interface TestRig {
  baseUrl: string;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir: string;
  poolDir: string;
  skillConfigStore: SkillConfigStore;
  setCaller(caller: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

function userRecord(id: string, username: string, role: 'admin' | 'user', tenantId: string): UserRecord {
  return {
    id, username, passwordHash: 'x', role, tenantId,
    realName: username,
    createdAt: '2026-06-23T00:00:00Z',
    createdBy: 'system',
    updatedAt: '2026-06-23T00:00:00Z',
  };
}

function fakeUserStore(): UserStore {
  const users: UserRecord[] = [
    userRecord('u-ka', 'zengky', 'admin', 'kaiyan'),
    userRecord('u-ku', 'alice', 'user', 'kaiyan'),
    userRecord('u-wa', 'wain_admin', 'admin', 'wain'),
    userRecord('u-wu', 'wain_user', 'user', 'wain'),
  ];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    listAll: () => users.map(({ passwordHash: _, ...rest }) => rest as never),
  } as unknown as UserStore;
}

function fakeSkillConfigStore(): SkillConfigStore {
  const visibility: Record<string, boolean> = {};
  const platformConfig = new Map<string, { enabled: boolean; exposure: 'all' | 'allow_tenants' | 'deny_tenants'; tenantIds: string[] }>();
  const tenantRules = new Map<string, Map<string, { enabled: boolean; exposure: 'all' | 'allow_users' | 'deny_users'; usernames: string[] }>>();
  const tenantSelections = new Map<string, string[]>();
  const userSelections = new Map<string, string[]>();
  let configVersion = 1;
  const getPlatformSkillConfig = (skillId: string) => platformConfig.get(skillId) ?? {
    enabled: visibility[skillId] !== false,
    exposure: 'all' as const,
    tenantIds: [],
  };
  const isPoolSkillAvailableToTenant = (skillId: string, tenantId?: string) => {
    const config = getPlatformSkillConfig(skillId);
    if (!config.enabled) return false;
    if (!tenantId) return true;
    if (config.exposure === 'allow_tenants') return config.tenantIds.includes(tenantId);
    if (config.exposure === 'deny_tenants') return !config.tenantIds.includes(tenantId);
    return true;
  };
  const getTenantEnabledSkills = (tenantId?: string, visibleSkillIds?: string[]) => {
    const fallback = visibleSkillIds ?? Object.entries(visibility)
      .filter(([, visible]) => visible !== false)
      .map(([id]) => id);
    return (tenantId ? tenantSelections.get(tenantId) ?? fallback : fallback)
      .filter(id => isPoolSkillAvailableToTenant(id, tenantId));
  };
  const getTenantSkillRule = (tenantId: string | undefined, skillId: string) => {
    if (!tenantId) return { enabled: true, exposure: 'all' as const, usernames: [] };
    const configured = tenantRules.get(tenantId)?.get(skillId);
    if (configured) return configured;
    return {
      enabled: !tenantSelections.has(tenantId) || getTenantEnabledSkills(tenantId).includes(skillId),
      exposure: 'all' as const,
      usernames: [],
    };
  };
  const isTenantSkillAvailableToUser = (skillId: string, tenantId?: string, username?: string) => {
    if (!isPoolSkillAvailableToTenant(skillId, tenantId)) return false;
    if (!tenantId) return true;
    const rule = getTenantSkillRule(tenantId, skillId);
    if (!rule.enabled) return false;
    if (rule.exposure === 'allow_users') return !!username && rule.usernames.includes(username);
    if (rule.exposure === 'deny_users') return !username || !rule.usernames.includes(username);
    return true;
  };
  const tenantOwnRules = new Map<string, Map<string, { enabled: boolean; exposure: 'all' | 'allow_users' | 'deny_users'; usernames: string[] }>>();
  const getTenantOwnSkillRule = (tenantId: string, skillId: string) =>
    tenantOwnRules.get(tenantId)?.get(skillId) ?? { enabled: true, exposure: 'all' as const, usernames: [] };
  const isTenantOwnSkillAvailableToUser = (tenantId: string, skillId: string, username?: string) => {
    const rule = getTenantOwnSkillRule(tenantId, skillId);
    if (!rule.enabled) return false;
    if (rule.exposure === 'allow_users') return !!username && rule.usernames.includes(username);
    if (rule.exposure === 'deny_users') return !username || !rule.usernames.includes(username);
    return true;
  };
  return {
    getTenantOwnSkillRule,
    getTenantOwnSkillRules: (tenantId: string) => Object.fromEntries(tenantOwnRules.get(tenantId) ?? new Map()),
    isTenantOwnSkillAvailableToUser,
    getUserEffectiveTenantOwnSkills: (u: string, tenantId: string | undefined, availableOwnIds: Set<string>) => {
      if (!tenantId) return [];
      return (userSelections.get(u) ?? []).filter(id => availableOwnIds.has(id) && isTenantOwnSkillAvailableToUser(tenantId, id, u));
    },
    setTenantOwnSkillRules: async (tenantId: string, updates: Record<string, { enabled: boolean; exposure: 'all' | 'allow_users' | 'deny_users'; usernames: string[] }>) => {
      const rules = tenantOwnRules.get(tenantId) ?? new Map();
      for (const [id, rule] of Object.entries(updates)) rules.set(id, rule);
      tenantOwnRules.set(tenantId, rules);
      configVersion++;
    },
    getConfigVersion: () => configVersion,
    getPoolVisibility: () => ({ ...visibility }),
    getPlatformSkillConfig,
    isPoolSkillAvailableToTenant,
    setPoolVisibility: async (updates: Record<string, boolean>) => {
      Object.assign(visibility, updates);
      for (const [id, enabled] of Object.entries(updates)) {
        platformConfig.set(id, { ...getPlatformSkillConfig(id), enabled });
      }
      configVersion++;
    },
    setPlatformSkillConfigs: async (updates: Record<string, { enabled: boolean; exposure: 'all' | 'allow_tenants' | 'deny_tenants'; tenantIds: string[] }>) => {
      for (const [id, config] of Object.entries(updates)) {
        platformConfig.set(id, config);
        visibility[id] = config.enabled;
      }
      configVersion++;
    },
    getTenantEnabledSkills,
    setTenantEnabledSkills: async (tenantId: string, skills: string[]) => { tenantSelections.set(tenantId, skills); configVersion++; },
    getTenantSkillRule,
    isTenantSkillAvailableToUser,
    setTenantSkillRules: async (tenantId: string, updates: Record<string, { enabled: boolean; exposure: 'all' | 'allow_users' | 'deny_users'; usernames: string[] }>) => {
      const rules = tenantRules.get(tenantId) ?? new Map();
      for (const [id, rule] of Object.entries(updates)) rules.set(id, rule);
      tenantRules.set(tenantId, rules);
      configVersion++;
    },
    getUserSelectedSkills: (u: string) => userSelections.get(u) ?? [],
    setUserSelectedSkills: async (u: string, skills: string[]) => { userSelections.set(u, skills); configVersion++; },
    touchConfigVersion: async () => { configVersion++; },
    // syncSkills() 调到的方法：返回该 username 实际应同步的 pool skill ids
    getUserEffectivePoolSkills: (u: string, tenantId?: string) => {
      return (userSelections.get(u) ?? []).filter(id => isTenantSkillAvailableToUser(id, tenantId, u));
    },
    syncWithPool: (currentPoolIds: Set<string>) => {
      let added = 0;
      for (const id of currentPoolIds) {
        if (!(id in visibility)) {
          visibility[id] = true;
          added++;
        }
      }
      if (added > 0) configVersion++;
      return added;
    },
    pruneStaleSkills: (currentPoolIds: Set<string>) => {
      let pruned = 0;
      for (const id of Object.keys(visibility)) {
        if (!currentPoolIds.has(id)) {
          delete visibility[id];
          pruned++;
        }
      }
      for (const [username, skills] of userSelections) {
        const next = skills.filter(id => currentPoolIds.has(id));
        pruned += skills.length - next.length;
        userSelections.set(username, next);
      }
      for (const [tenantId, skills] of tenantSelections) {
        const next = skills.filter(id => currentPoolIds.has(id));
        pruned += skills.length - next.length;
        tenantSelections.set(tenantId, next);
      }
      if (pruned > 0) configVersion++;
      return pruned;
    },
  } as unknown as SkillConfigStore;
}

async function makeTestRig(): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-tenant-iso-'));
  const agentCwd = join(tmpRoot, 'workspace');
  const sharedDir = join(tmpRoot, 'shared');
  const tenantSkillsRootDir = join(tmpRoot, 'tenant-skills');
  const poolDir = join(sharedDir, '.ky-agent', 'skills-pool');
  mkdirSync(agentCwd, { recursive: true });
  mkdirSync(poolDir, { recursive: true });
  // 种 pool skills
  mkdirSync(join(poolDir, 'shared_skill'), { recursive: true });
  writeFileSync(join(poolDir, 'shared_skill', 'SKILL.md'), '---\nname: shared_skill\ndescription: shared\n---\nhi');
  mkdirSync(join(poolDir, 'hidden_skill'), { recursive: true });
  writeFileSync(join(poolDir, 'hidden_skill', 'SKILL.md'), '---\nname: hidden_skill\ndescription: hidden\n---\nhi');
  // 种用户自建 skill 在 tenant/userId 路径
  for (const [tenant, username, userId] of [
    ['kaiyan', 'alice', 'u-ku'],
    ['wain', 'wain_user', 'u-wu'],
  ] as const) {
    const customDir = join(agentCwd, tenant, userId, '.ky-agent', 'skills', `${username}_custom`);
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'SKILL.md'), `---\nname: ${username}_custom\ndescription: c\n---\nx`);
    // .ky-agent 目录（让 /sync 路径校验通过）
    mkdirSync(join(agentCwd, tenant, userId, '.ky-agent'), { recursive: true });
  }
  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  const skillConfigStore = fakeSkillConfigStore();
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/skills', createSkillsRouter({
      skillConfigStore,
      userStore: fakeUserStore(),
      agentCwd,
      sharedDir,
      tenantSkillsRootDir,
    }));
  // 跑 requireAdmin error 路径需要中间件链；这里整链已挂
  void requireAdmin;
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl,
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    poolDir,
    skillConfigStore,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('skills 路由多组织隔离 (PR 9)', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeTestRig(); });
  afterEach(async () => { await h.close(); });

  // ============================================================
  // Pool 写操作仅 platform admin
  // ============================================================
  describe('Pool 写操作 platform-admin only', () => {
    it('组织 admin GET /pool → 仅返回平台可见 skill', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await h.request('/api/skills/pool/visibility', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden_skill: false }),
      });

      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/pool');
      expect(res.status).toBe(200);
      const body = await res.json() as { skills: { id: string; visible: boolean }[] };
      expect(body.skills.map(s => s.id)).toContain('shared_skill');
      expect(body.skills.map(s => s.id)).not.toContain('hidden_skill');
      expect(body.skills.every(s => s.visible)).toBe(true);
    });

    it('platform admin GET /pool → 返回完整 pool 和 visibility 状态', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await h.request('/api/skills/pool/visibility', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden_skill: false }),
      });

      const res = await h.request('/api/skills/pool');
      expect(res.status).toBe(200);
      const body = await res.json() as { skills: { id: string; visible: boolean }[] };
      expect(body.skills.find(s => s.id === 'shared_skill')?.visible).toBe(true);
      expect(body.skills.find(s => s.id === 'hidden_skill')?.visible).toBe(false);
    });

    it('组织 admin (wain) PATCH /pool/visibility → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/pool/visibility', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared_skill: false }),
      });
      expect(res.status).toBe(403);
    });

    it('组织 admin (wain) PUT /pool/:id/document → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/pool/shared_skill/document', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hijacked content' }),
      });
      expect(res.status).toBe(403);
    });

    it('platform admin PATCH /pool/visibility → 200', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/pool/visibility', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared_skill: false }),
      });
      expect(res.status).toBe(200);
    });

    it('组织 admin (wain) POST /custom/:id/promote → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/custom/wain_user_custom/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUser: 'wain_user' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // 租户级 Skill 开关
  // ============================================================
  describe('租户级 Skill 开关', () => {
    it('组织 admin GET /tenants/:tenantId/pool → 看到平台已开放 skill 并默认启用', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await h.request('/api/skills/pool/visibility', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden_skill: false }),
      });

      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/tenants/wain/pool');
      expect(res.status).toBe(200);
      const body = await res.json() as { tenantId: string; skills: { id: string; enabled: boolean }[] };
      expect(body.tenantId).toBe('wain');
      expect(body.skills.map(s => s.id)).toEqual(['shared_skill']);
      expect(body.skills[0]?.enabled).toBe(true);
    });

    it('组织 admin 可关闭本租户 skill，用户列表与保存选择都会被租户开关过滤', async () => {
      h.setCaller(WAIN_ADMIN);
      let res = await h.request('/api/skills/users/wain_user/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['shared_skill'] }),
      });
      expect(res.status).toBe(200);

      res = await h.request('/api/skills/tenants/wain/pool/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledSkills: [] }),
      });
      expect(res.status).toBe(200);

      res = await h.request('/api/skills/tenants/wain/pool');
      expect(res.status).toBe(200);
      const tenantBody = await res.json() as { skills: { id: string; enabled: boolean }[] };
      expect(tenantBody.skills.find(s => s.id === 'shared_skill')?.enabled).toBe(false);

      res = await h.request('/api/skills/users/wain_user');
      expect(res.status).toBe(200);
      const userBody = await res.json() as { poolSkills: { id: string }[] };
      expect(userBody.poolSkills.map(s => s.id)).not.toContain('shared_skill');

      res = await h.request('/api/skills/users/wain_user/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['shared_skill'] }),
      });
      expect(res.status).toBe(200);
      res = await h.request('/api/skills/users/wain_user');
      const userBodyAfterSave = await res.json() as { poolSkills: { id: string; selected: boolean }[] };
      expect(userBodyAfterSave.poolSkills.map(s => s.id)).not.toContain('shared_skill');
    });

    it('组织 admin 不能修改其他租户；platform admin 可以修改任意租户', async () => {
      h.setCaller(WAIN_ADMIN);
      let res = await h.request('/api/skills/tenants/kaiyan/pool/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledSkills: [] }),
      });
      expect(res.status).toBe(403);

      h.setCaller(PLATFORM_ADMIN);
      res = await h.request('/api/skills/tenants/wain/pool/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledSkills: [] }),
      });
      expect(res.status).toBe(200);
    });

    it('platform admin 可将 skill 仅开放给指定租户', async () => {
      h.setCaller(PLATFORM_ADMIN);
      let res = await h.request('/api/skills/pool/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shared_skill: { enabled: true, exposure: 'allow_tenants', tenantIds: ['wain'] },
        }),
      });
      expect(res.status).toBe(200);

      h.setCaller(WAIN_ADMIN);
      res = await h.request('/api/skills/tenants/wain/pool');
      expect(res.status).toBe(200);
      const wainBody = await res.json() as { skills: { id: string }[] };
      expect(wainBody.skills.map(s => s.id)).toContain('shared_skill');

      h.setCaller(PLATFORM_ADMIN);
      res = await h.request('/api/skills/tenants/kaiyan/pool');
      expect(res.status).toBe(200);
      const kaiyanBody = await res.json() as { skills: { id: string }[] };
      expect(kaiyanBody.skills.map(s => s.id)).not.toContain('shared_skill');
    });

    it('租户 admin 可将 skill 仅开放给指定成员', async () => {
      h.setCaller(WAIN_ADMIN);
      let res = await h.request('/api/skills/tenants/wain/pool/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shared_skill: { enabled: true, exposure: 'allow_users', usernames: ['wain_admin'] },
        }),
      });
      expect(res.status).toBe(200);

      h.setCaller(WAIN_USER);
      res = await h.request('/api/skills/me');
      expect(res.status).toBe(200);
      const blockedBody = await res.json() as { poolSkills: { id: string }[] };
      expect(blockedBody.poolSkills.map(s => s.id)).not.toContain('shared_skill');

      h.setCaller(WAIN_ADMIN);
      res = await h.request('/api/skills/tenants/wain/pool/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shared_skill: { enabled: true, exposure: 'allow_users', usernames: ['wain_user'] },
        }),
      });
      expect(res.status).toBe(200);

      h.setCaller(WAIN_USER);
      res = await h.request('/api/skills/me');
      expect(res.status).toBe(200);
      const allowedBody = await res.json() as { poolSkills: { id: string }[] };
      expect(allowedBody.poolSkills.map(s => s.id)).toContain('shared_skill');
    });
  });

  // ============================================================
  // /custom 列表 + DELETE 跨组织防御
  // ============================================================
  describe('Custom 列表与删除按组织隔离', () => {
    it('组织 admin (wain) GET /custom → 仅本组织用户的自建 skill', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/custom');
      expect(res.status).toBe(200);
      const body = await res.json() as { users: Record<string, unknown[]> };
      expect(Object.keys(body.users)).toEqual(['wain_user']);
      expect(body.users).not.toHaveProperty('alice');
    });

    it('platform admin GET /custom → 看全部用户的自建 skill', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/custom');
      expect(res.status).toBe(200);
      const body = await res.json() as { users: Record<string, unknown[]> };
      expect(Object.keys(body.users).sort()).toEqual(['alice', 'wain_user']);
    });

    it('GET /custom 不把已从 pool 删除但仍在配置历史中的系统 skill 误判为自建', async () => {
      await h.skillConfigStore.setPoolVisibility({ old_system: true });
      const staleDir = join(h.agentCwd, 'kaiyan', 'u-ku', '.ky-agent', 'skills', 'old_system');
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, 'SKILL.md'), '---\nname: old_system\ndescription: stale\n---\nx');

      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/custom');
      expect(res.status).toBe(200);
      const body = await res.json() as { users: Record<string, { id: string }[]> };
      expect(body.users.alice?.map(s => s.id)).toContain('alice_custom');
      expect(body.users.alice?.map(s => s.id)).not.toContain('old_system');
    });

    it('组织 admin (wain) DELETE /custom/alice/:id (跨组织) → 404 隐藏', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/custom/alice/alice_custom', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });

    it('组织 admin (wain) DELETE /custom/wain_user/:id (本组织) → 200', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/custom/wain_user/wain_user_custom', { method: 'DELETE' });
      expect(res.status).toBe(200);
    });
  });

  // ============================================================
  // /users/:username/... 跨组织防御
  // ============================================================
  describe('/users/:username/... 跨组织访问防御', () => {
    it('组织 admin (wain) GET /users/alice → 404 隐藏', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/users/alice');
      expect(res.status).toBe(404);
    });

    it('组织 admin (wain) PUT /users/alice/selections → 404 隐藏', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/users/alice/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['shared_skill'] }),
      });
      expect(res.status).toBe(404);
    });

    it('组织 admin (wain) GET /users/wain_user (本组织) → 200', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/users/wain_user');
      expect(res.status).toBe(200);
      const body = await res.json() as { customSkills: { id: string }[] };
      // 路径修复验证：tenant/userId 路径正确解析 → 能扫到 wain_user_custom
      expect(body.customSkills.map(s => s.id)).toContain('wain_user_custom');
    });

    it('platform admin GET /users/wain_user (跨组织) → 200', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/users/wain_user');
      expect(res.status).toBe(200);
    });
  });

  // ============================================================
  // /sync ?username= 单用户 跨组织防御 + 路径修复
  // ============================================================
  describe('POST /sync', () => {
    it('组织 admin (wain) POST /sync?username=alice → 404 隐藏', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/sync?username=alice', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('组织 admin (wain) 全量 POST /sync → 仅 sync 本组织', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/sync', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { synced: string[] };
      expect(body.synced).toContain('wain_user');
      expect(body.synced).not.toContain('alice');
    });

    it('platform admin 全量 POST /sync → 同步所有有 .ky-agent 的用户', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/sync', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { synced: string[] };
      expect(body.synced.sort()).toEqual(['alice', 'wain_user']);
    });

    it('platform admin 全量 POST /sync → 先删除旧系统副本，再 prune stale 配置', async () => {
      await h.skillConfigStore.setPoolVisibility({ old_system: true });
      const staleDir = join(h.agentCwd, 'kaiyan', 'u-ku', '.ky-agent', 'skills', 'old_system');
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, 'SKILL.md'), '---\nname: old_system\ndescription: stale\n---\nx');

      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/sync', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json() as { pruned: number };
      expect(body.pruned).toBeGreaterThan(0);
      expect(existsSync(staleDir)).toBe(false);
      expect(h.skillConfigStore.getPoolVisibility()).not.toHaveProperty('old_system');
    });
  });

  // ============================================================
  // /me 路径修复验证
  // ============================================================
  describe('GET /me - 路径按 user.tenantId 解析', () => {
    it('wain_user GET /me → 看到自己的 custom skill (wain_user_custom)', async () => {
      h.setCaller(WAIN_USER);
      const res = await h.request('/api/skills/me');
      expect(res.status).toBe(200);
      const body = await res.json() as { customSkills: { id: string }[] };
      expect(body.customSkills.map(s => s.id)).toContain('wain_user_custom');
    });

    it('kaiyan alice GET /me → 看到自己的 custom skill (alice_custom)', async () => {
      h.setCaller(KAIYAN_USER);
      const res = await h.request('/api/skills/me');
      expect(res.status).toBe(200);
      const body = await res.json() as { customSkills: { id: string }[] };
      expect(body.customSkills.map(s => s.id)).toContain('alice_custom');
    });
  });

  // ============================================================
  // 租户自有 skill：三级上传 / 治理 / promote
  // ============================================================
  describe('租户自有 skill（tenants/<id>/skills）', () => {
    function skillUploadBody(skillName: string): FormData {
      const fd = new FormData();
      fd.append('files', new Blob([`---\nname: ${skillName}\ndescription: d\n---\nbody`], { type: 'text/markdown' }), 'SKILL.md');
      return fd;
    }
    const tenantSkillDir = (tenantId: string, skillId: string) => join(h.tenantSkillsRootDir, tenantId, 'skills', skillId);

    it('组织 admin POST /tenants/:own/import → 200，目录落 tenants/<id>/skills', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('wain-shared') });
      expect(res.status).toBe(200);
      expect(existsSync(tenantSkillDir('wain', 'wain-shared'))).toBe(true);
    });

    it('组织 admin POST /tenants/:other/import → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/tenants/kaiyan/import', { method: 'POST', body: skillUploadBody('sneaky') });
      expect(res.status).toBe(403);
      expect(existsSync(tenantSkillDir('kaiyan', 'sneaky'))).toBe(false);
    });

    it('普通用户 POST /tenants/:own/import → 403', async () => {
      h.setCaller(WAIN_USER);
      const res = await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('nope') });
      expect(res.status).toBe(403);
    });

    it('POST /pool/import：组织 admin → 403；平台 admin → 200 且注册 visibility', async () => {
      h.setCaller(WAIN_ADMIN);
      const denied = await h.request('/api/skills/pool/import', { method: 'POST', body: skillUploadBody('pool-new') });
      expect(denied.status).toBe(403);

      h.setCaller(PLATFORM_ADMIN);
      const ok = await h.request('/api/skills/pool/import', { method: 'POST', body: skillUploadBody('pool-new') });
      expect(ok.status).toBe(200);
      expect(existsSync(join(h.poolDir, 'pool-new'))).toBe(true);
      expect(h.skillConfigStore.getPoolVisibility()).toHaveProperty('pool-new', true);
    });

    it('租户上传与 pool 同名 → 409', async () => {
      // SKILL.md name 规则只允许小写/数字/连字符，先经 pool/import 造一个合法名 pool skill
      h.setCaller(PLATFORM_ADMIN);
      await h.request('/api/skills/pool/import', { method: 'POST', body: skillUploadBody('pool-owned') });

      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('pool-owned') });
      expect(res.status).toBe(409);
    });

    it('租户上传与本组织成员自建同名 → 409', async () => {
      h.setCaller(WAIN_USER);
      await h.request('/api/skills/me/import', { method: 'POST', body: skillUploadBody('user-owned') });

      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('user-owned') });
      expect(res.status).toBe(409);
    });

    it('用户上传与组织 skill 同名 → 409', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('taken-by-tenant') });

      h.setCaller(WAIN_USER);
      const res = await h.request('/api/skills/me/import', { method: 'POST', body: skillUploadBody('taken-by-tenant') });
      expect(res.status).toBe(409);
    });

    it('GET /me 返回 tenantSkills 且按成员范围过滤', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('team-tool') });

      h.setCaller(WAIN_USER);
      let res = await h.request('/api/skills/me');
      let body = await res.json() as { tenantSkills: { id: string }[] };
      expect(body.tenantSkills.map(s => s.id)).toContain('team-tool');

      // kaiyan 用户看不到 wain 的组织 skill
      h.setCaller(KAIYAN_USER);
      res = await h.request('/api/skills/me');
      body = await res.json() as { tenantSkills: { id: string }[] };
      expect(body.tenantSkills.map(s => s.id)).not.toContain('team-tool');

      // 收紧成员范围：仅 wain_admin 可用 → wain_user 不再看到
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/skills/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'team-tool': { enabled: true, exposure: 'allow_users', usernames: ['wain_admin'] } }),
      });
      h.setCaller(WAIN_USER);
      res = await h.request('/api/skills/me');
      body = await res.json() as { tenantSkills: { id: string }[] };
      expect(body.tenantSkills.map(s => s.id)).not.toContain('team-tool');
    });

    it('PUT /me/selections 接受组织 skill id、拒绝他租户 skill id', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('selectable') });

      h.setCaller(WAIN_USER);
      const res = await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['selectable', 'shared_skill'] }),
      });
      expect(res.status).toBe(200);
      expect(h.skillConfigStore.getUserSelectedSkills('wain_user')).toContain('selectable');

      // kaiyan 用户提交 wain 的组织 skill → 被过滤
      h.setCaller(KAIYAN_USER);
      await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['selectable'] }),
      });
      expect(h.skillConfigStore.getUserSelectedSkills('alice')).not.toContain('selectable');
    });

    it('GET /tenants/:id/skills 列表含治理规则；跨组织 → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('listed') });
      const res = await h.request('/api/skills/tenants/wain/skills');
      expect(res.status).toBe(200);
      const body = await res.json() as { skills: { id: string; enabled: boolean; exposure: string }[] };
      const listed = body.skills.find(s => s.id === 'listed');
      expect(listed).toBeDefined();
      expect(listed!.enabled).toBe(true);
      expect(listed!.exposure).toBe('all');

      const denied = await h.request('/api/skills/tenants/kaiyan/skills');
      expect(denied.status).toBe(403);
    });

    it('POST /tenants/:id/promote：本组织成员 skill → 组织；跨组织源用户 → 400', async () => {
      h.setCaller(WAIN_ADMIN);
      const ok = await h.request('/api/skills/tenants/wain/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: 'wain_user_custom', sourceUser: 'wain_user' }),
      });
      expect(ok.status).toBe(200);
      expect(existsSync(tenantSkillDir('wain', 'wain_user_custom'))).toBe(true);
      // 源用户自动勾选，promote 后 skill 不消失
      expect(h.skillConfigStore.getUserSelectedSkills('wain_user')).toContain('wain_user_custom');

      const crossTenant = await h.request('/api/skills/tenants/wain/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: 'alice_custom', sourceUser: 'alice' }),
      });
      expect(crossTenant.status).toBe(400);
    });

    it('POST /tenants/:id/skills/:skillId/promote → pool：组织 admin 403；平台 admin 200', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('to-pool') });
      const denied = await h.request('/api/skills/tenants/wain/skills/to-pool/promote', { method: 'POST' });
      expect(denied.status).toBe(403);

      h.setCaller(PLATFORM_ADMIN);
      const ok = await h.request('/api/skills/tenants/wain/skills/to-pool/promote', { method: 'POST' });
      expect(ok.status).toBe(200);
      expect(existsSync(join(h.poolDir, 'to-pool'))).toBe(true);
      expect(h.skillConfigStore.getPoolVisibility()).toHaveProperty('to-pool', true);
    });

    it('DELETE /tenants/:id/skills/:skillId → 目录删除；跨组织 → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('doomed') });
      expect(existsSync(tenantSkillDir('wain', 'doomed'))).toBe(true);

      h.setCaller(KAIYAN_USER);
      const denied = await h.request('/api/skills/tenants/wain/skills/doomed', { method: 'DELETE' });
      expect(denied.status).toBe(403);

      h.setCaller(WAIN_ADMIN);
      const ok = await h.request('/api/skills/tenants/wain/skills/doomed', { method: 'DELETE' });
      expect(ok.status).toBe(200);
      expect(existsSync(tenantSkillDir('wain', 'doomed'))).toBe(false);
    });

    it('组织 skill 文档读写：GET/PUT /tenants/:id/skills/:skillId/document', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('docable') });

      const got = await h.request('/api/skills/tenants/wain/skills/docable/document');
      expect(got.status).toBe(200);
      const doc = await got.json() as { source: string; content: string };
      expect(doc.source).toBe('tenant');
      expect(doc.content).toContain('name: docable');

      const put = await h.request('/api/skills/tenants/wain/skills/docable/document', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '---\nname: docable\ndescription: updated\n---\nnew body' }),
      });
      expect(put.status).toBe(200);

      const mismatched = await h.request('/api/skills/tenants/wain/skills/docable/document', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '---\nname: other-name\ndescription: x\n---\nbody' }),
      });
      expect(mismatched.status).toBe(400);
    });
  });
});
