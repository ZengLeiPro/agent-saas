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
  return {
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

    it('组织 admin (wain) DELETE /custom/alice/:id (跨组织) → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/custom/alice/alice_custom', { method: 'DELETE' });
      expect(res.status).toBe(403);
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
    it('组织 admin (wain) GET /users/alice → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/users/alice');
      expect(res.status).toBe(403);
    });

    it('组织 admin (wain) PUT /users/alice/selections → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/users/alice/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['shared_skill'] }),
      });
      expect(res.status).toBe(403);
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
    it('组织 admin (wain) POST /sync?username=alice → 403', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/sync?username=alice', { method: 'POST' });
      expect(res.status).toBe(403);
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
});
