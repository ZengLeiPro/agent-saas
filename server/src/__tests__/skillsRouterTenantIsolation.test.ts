/**
 * Skill 平台池、组织池与个人所有权边界测试。
 * 个人 Skill 内容和选择 self-only；直接提升到组织或平台在提交审批链建成前 fail closed。
 * 组织管理员仍可治理组织 Skill 与成员可用范围，但不能代读、代改成员个人 Skill。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSkillsRouter } from '../routes/skills.js';
import { requireAdmin } from '../auth/middleware.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { SkillWorkspaceMaterializer } from '../workspace/materialization/materializer.js';
import { SkillMaterializationService } from '../workspace/materialization/service.js';
import { InMemorySkillMaterializationStore } from '../workspace/materialization/store.js';

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
  userSkillsDir(username: string): string;
  waitSync(res: Response): Promise<{
    total: number;
    tenantIds: string[];
    pruned?: number;
  }>;
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
    userRecord('u-platform', 'admin', 'admin', DEFAULT_TENANT_ID),
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
    getAllUserConfigs: () => Object.fromEntries([...userSelections.entries()].map(([username, selectedSkills]) => [username, { selectedSkills }])),
    getAllTenantConfigs: () => Object.fromEntries([...tenantSelections.entries()].map(([tenantId, enabledSkills]) => [tenantId, { enabledSkills }])),
    setUserSelectedSkills: async (u: string, skills: string[]) => { userSelections.set(u, skills); configVersion++; },
    removeSkillReferences: async (skillId: string) => {
      let usersUpdated = 0;
      let tenantsUpdated = 0;
      delete visibility[skillId];
      platformConfig.delete(skillId);
      for (const [username, skills] of userSelections) {
        const next = skills.filter(id => id !== skillId);
        if (next.length !== skills.length) { userSelections.set(username, next); usersUpdated++; }
      }
      for (const [tenantId, skills] of tenantSelections) {
        const next = skills.filter(id => id !== skillId);
        if (next.length !== skills.length) { tenantSelections.set(tenantId, next); tenantsUpdated++; }
      }
      configVersion++;
      return { usersUpdated, tenantsUpdated };
    },
    touchConfigVersion: async () => { configVersion++; },
    // syncSkills() 调到的方法：返回该 username 实际应同步的 pool skill ids
    getUserEffectivePoolSkills: (u: string, tenantId?: string) => {
      return (userSelections.get(u) ?? []).filter(id => isTenantSkillAvailableToUser(id, tenantId, u));
    },
    getOrgAgentEffectivePoolSkills: () => [],
    getOrgAgentEffectiveTenantOwnSkills: () => [],
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
  const userStore = fakeUserStore();
  const materializer = new SkillWorkspaceMaterializer({
    sharedDir,
    sourceRevision: 'test-release',
    tenantSkillsRootDir,
    skillConfigStore,
  });
  const materializationStore = new InMemorySkillMaterializationStore();
  await materializationStore.init();
  const skillMaterialization = new SkillMaterializationService({
    store: materializationStore,
    materializer,
    skillConfigStore,
    sourceRevision: 'test-release',
    pollIntervalMs: 10,
    resolveTargetByUsername: (username) => {
      const user = userStore.findByUsername(username);
      if (!user) return undefined;
      const workspaceUser = {
        id: user.id,
        username: user.username,
        role: user.role as 'admin' | 'user',
        tenantId: user.tenantId,
      };
      return {
        user: workspaceUser,
        userCwd: join(agentCwd, user.tenantId, user.id),
      };
    },
  });
  skillMaterialization.start();
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/skills', createSkillsRouter({
      skillConfigStore,
      userStore,
      agentCwd,
      sharedDir,
      tenantSkillsRootDir,
      skillMaterialization,
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
    userSkillsDir(username) {
      const user = userStore.findByUsername(username)!;
      return join(agentCwd, user.tenantId, user.id, '.ky-agent', 'skills');
    },
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    waitSync: async (res) => {
      expect(res.status).toBe(202);
      const started = await res.json() as {
        id: string;
        total: number;
        tenantIds: string[];
        pruned?: number;
      };
      for (;;) {
        const progress = await fetch(`${baseUrl}/api/skills/sync-jobs/${started.id}`);
        expect(progress.status).toBe(200);
        const body = await progress.json() as {
          status: string;
          total: number;
          tenantIds: string[];
          error?: string;
        };
        if (body.status === 'succeeded') return { ...body, pruned: started.pruned };
        if (body.status === 'partial' || body.status === 'failed') {
          throw new Error(body.error || 'sync failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: async () => {
      await skillMaterialization.stop();
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

    it('组织 admin 可关闭本租户 skill，成员列表与本人保存选择都会被租户开关过滤', async () => {
      h.setCaller(WAIN_USER);
      let res = await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['shared_skill'] }),
      });
      expect(res.status).toBe(200);

      h.setCaller(WAIN_ADMIN);
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

      h.setCaller(WAIN_USER);
      res = await h.request('/api/skills/me');
      expect(res.status).toBe(200);
      expect((await res.json() as { poolSkills: { id: string }[] }).poolSkills.map(s => s.id)).not.toContain('shared_skill');

      res = await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['shared_skill'] }),
      });
      expect(res.status).toBe(200);
      expect(h.skillConfigStore.getUserSelectedSkills('wain_user')).not.toContain('shared_skill');
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
  // /custom 个人所有权
  // ============================================================
  describe('Custom 列表与删除 self-only', () => {
    it('管理员 GET /custom 不枚举本组织或全平台其他用户', async () => {
      for (const caller of [WAIN_ADMIN, PLATFORM_ADMIN]) {
        h.setCaller(caller);
        const res = await h.request('/api/skills/custom');
        expect(res.status).toBe(200);
        expect((await res.json() as { users: Record<string, unknown[]> }).users).toEqual({});
      }
    });

    it('管理员不能删除同组织或跨组织成员的个人 Skill', async () => {
      h.setCaller(WAIN_ADMIN);
      expect((await h.request('/api/skills/custom/wain_user/wain_user_custom', { method: 'DELETE' })).status).toBe(403);
      expect((await h.request('/api/skills/custom/alice/alice_custom', { method: 'DELETE' })).status).toBe(404);
      expect(existsSync(join(h.userSkillsDir('wain_user'), 'wain_user_custom'))).toBe(true);
    });

    it('管理员可通过兼容路径删除自己的个人 Skill', async () => {
      const ownDir = join(h.userSkillsDir('wain_admin'), 'own-custom');
      mkdirSync(ownDir, { recursive: true });
      writeFileSync(join(ownDir, 'SKILL.md'), '---\nname: own-custom\ndescription: own\n---\nx');
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/custom/wain_admin/own-custom', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(existsSync(ownDir)).toBe(false);
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

    it('组织 admin GET 本组织成员仍按个人所有权拒绝', async () => {
      h.setCaller(WAIN_ADMIN);
      expect((await h.request('/api/skills/users/wain_user')).status).toBe(403);
    });

    it('platform admin GET 跨组织成员仍按个人所有权拒绝', async () => {
      h.setCaller(PLATFORM_ADMIN);
      expect((await h.request('/api/skills/users/wain_user')).status).toBe(403);
    });

    it('管理员可通过兼容路径查看自己的 Skill 状态', async () => {
      h.setCaller(WAIN_ADMIN);
      expect((await h.request('/api/skills/users/wain_admin')).status).toBe(200);
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
      const body = await h.waitSync(res);
      expect(body.total).toBe(1);
      expect(body.tenantIds).toEqual(['wain']);
    });

    it('platform admin 全量 POST /sync → 同步所有有 .ky-agent 的用户', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/sync', { method: 'POST' });
      const body = await h.waitSync(res);
      expect(body.total).toBe(2);
      expect(body.tenantIds.sort()).toEqual(['kaiyan', 'wain']);
    });

    it('platform admin 全量 POST /sync → 旧系统副本移出热目录，prune 留给全员 warmup', async () => {
      await h.skillConfigStore.setPoolVisibility({ old_system: true });
      const staleDir = join(h.agentCwd, 'kaiyan', 'u-ku', '.ky-agent', 'skills', 'old_system');
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, 'SKILL.md'), '---\nname: old_system\ndescription: stale\n---\nx');

      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/sync', { method: 'POST' });
      const body = await h.waitSync(res);
      expect(body.pruned).toBe(0);
      expect(existsSync(staleDir)).toBe(false);
      expect(h.skillConfigStore.getPoolVisibility()).toHaveProperty('old_system');
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

    it('其他组织的物化残留不进入个人列表、选择和文档接口', async () => {
      const form = new FormData();
      form.append('files', new Blob(['---\nname: wy-invoice\ndescription: 唯恩电气 T100 Vendor Portal\n---\nbody'], { type: 'text/markdown' }), 'SKILL.md');
      h.setCaller(WAIN_ADMIN);
      const uploaded = await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: form });
      expect(uploaded.status).toBe(200);
      h.setCaller(WAIN_USER);
      const ownerView = await h.request('/api/skills/me');
      expect((await ownerView.json() as { tenantSkills: { id: string }[] }).tenantSkills.map(s => s.id)).toContain('wy-invoice');

      // 模拟历史错误物化：wain 组织技能残留在 kaiyan 用户 workspace。
      const leakedDir = join(h.userSkillsDir('alice'), 'wy-invoice');
      mkdirSync(leakedDir, { recursive: true });
      writeFileSync(join(leakedDir, 'SKILL.md'), '---\nname: wy-invoice\ndescription: leaked\n---\nbody');
      writeFileSync(join(h.userSkillsDir('alice'), '..', 'skills-state.json'), JSON.stringify({
        version: 1,
        desiredHash: 'previous',
        configVersion: h.skillConfigStore.getConfigVersion(),
        generatedAt: '2026-08-19T00:00:00.000Z',
        skills: { 'wy-invoice': { digest: 'foreign', source: 'tenant', tenantId: 'wain' } },
      }));

      h.setCaller(KAIYAN_USER);
      const listed = await h.request('/api/skills/me');
      expect(listed.status).toBe(200);
      const body = await listed.json() as { customSkills: { id: string }[]; tenantSkills: { id: string }[] };
      expect(body.customSkills.map(s => s.id)).not.toContain('wy-invoice');
      expect(body.tenantSkills.map(s => s.id)).not.toContain('wy-invoice');

      const bulkSelection = await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['wy-invoice'] }),
      });
      expect(bulkSelection.status).toBe(200);
      expect(h.skillConfigStore.getUserSelectedSkills('alice')).not.toContain('wy-invoice');

      const singleSelection = await h.request('/api/skills/me/skills/wy-invoice/selection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, expectedVersion: 0 }),
      });
      expect(singleSelection.status).toBe(403);

      const document = await h.request('/api/skills/me/skills/wy-invoice/document');
      expect(document.status).toBe(400);
    });

    it('无 manifest 的旧 .skills-version 状态仍隔离可证明的外租户残留', async () => {
      const sourceDir = join(h.tenantSkillsRootDir, 'wain', 'skills', 'legacy-foreign');
      mkdirSync(sourceDir, { recursive: true });
      const content = '---\nname: legacy-foreign\ndescription: foreign\n---\nforeign';
      writeFileSync(join(sourceDir, 'SKILL.md'), content);

      const leakedDir = join(h.userSkillsDir('alice'), 'legacy-foreign');
      mkdirSync(leakedDir, { recursive: true });
      writeFileSync(join(leakedDir, 'SKILL.md'), content);
      writeFileSync(join(h.userSkillsDir('alice'), '..', '.skills-version'), '1');

      h.setCaller(KAIYAN_USER);
      const listed = await h.request('/api/skills/me');
      expect(listed.status).toBe(200);
      expect((await listed.json() as { customSkills: { id: string }[] }).customSkills.map(s => s.id))
        .not.toContain('legacy-foreign');

      const selected = await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['legacy-foreign'] }),
      });
      expect(selected.status).toBe(200);
      expect(h.skillConfigStore.getUserSelectedSkills('alice')).not.toContain('legacy-foreign');
    });

    it('外租户后来创建同名组织 Skill 不影响既有个人 Skill', async () => {
      h.setCaller(KAIYAN_USER);
      const personalDir = join(h.userSkillsDir('alice'), 'same-name');
      mkdirSync(personalDir, { recursive: true });
      writeFileSync(join(personalDir, 'SKILL.md'), '---\nname: same-name\ndescription: personal\n---\npersonal');

      h.setCaller(WAIN_ADMIN);
      const form = new FormData();
      form.append('files', new Blob(['---\nname: same-name\ndescription: d\n---\nbody'], { type: 'text/markdown' }), 'SKILL.md');
      const uploaded = await h.request('/api/skills/tenants/wain/import', {
        method: 'POST',
        body: form,
      });
      expect(uploaded.status).toBe(200);

      h.setCaller(PLATFORM_ADMIN);
      const synced = await h.request('/api/skills/sync', { method: 'POST' });
      expect(synced.status).toBe(202);
      await h.waitSync(synced);

      h.setCaller(KAIYAN_USER);
      const listed = await h.request('/api/skills/me');
      const body = await listed.json() as { customSkills: { id: string }[] };
      expect(body.customSkills.map(s => s.id)).toContain('same-name');
      expect(readFileSync(join(personalDir, 'SKILL.md'), 'utf8')).toContain('personal');

      const selected = await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['same-name'] }),
      });
      expect(selected.status).toBe(200);
      expect(h.skillConfigStore.getUserSelectedSkills('alice')).toContain('same-name');
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

    it('平台上传与任一用户自建同名 → 409，避免物化覆盖下层目录', async () => {
      h.setCaller(WAIN_USER);
      const created = await h.request('/api/skills/me/import', { method: 'POST', body: skillUploadBody('user-collision') });
      expect(created.status).toBe(200);

      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/skills/pool/import', { method: 'POST', body: skillUploadBody('user-collision') });
      expect(res.status).toBe(409);
      expect(existsSync(join(h.userSkillsDir('wain_user'), 'user-collision', 'SKILL.md'))).toBe(true);
    });

    it('平台技能必须先退役且显式确认，删除后清理选择并进入异步物化', async () => {
      h.setCaller(PLATFORM_ADMIN);
      let res = await h.request('/api/skills/pool/shared_skill?confirm=true', { method: 'DELETE' });
      expect(res.status).toBe(409);

      await h.request('/api/skills/pool/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared_skill: { enabled: false, exposure: 'all', tenantIds: [] } }),
      });
      res = await h.request('/api/skills/pool/shared_skill', { method: 'DELETE' });
      expect(res.status).toBe(400);

      await h.skillConfigStore.setUserSelectedSkills('wain_user', ['shared_skill']);
      res = await h.request('/api/skills/pool/shared_skill?confirm=true', { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(h.skillConfigStore.getUserSelectedSkills('wain_user')).not.toContain('shared_skill');
      expect(existsSync(join(h.poolDir, 'shared_skill'))).toBe(false);
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

    it('管理员不能代改成员个人 Skill 选择', async () => {
      h.setCaller(WAIN_USER);
      await h.request('/api/skills/me/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: ['shared_skill'] }),
      });

      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/users/wain_user/selections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedSkills: [] }),
      });
      expect(res.status).toBe(403);
      expect(h.skillConfigStore.getUserSelectedSkills('wain_user')).toContain('shared_skill');
    });

    it('用户本人可读写自己的 SKILL.md，不能借接口编辑组织 skill', async () => {
      h.setCaller(WAIN_USER);
      await h.request('/api/skills/me/import', { method: 'POST', body: skillUploadBody('self-editable') });
      let res = await h.request('/api/skills/me/skills/self-editable/document');
      expect(res.status).toBe(200);

      res = await h.request('/api/skills/me/skills/self-editable/document', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '---\nname: self-editable\ndescription: updated\n---\nnew body' }),
      });
      expect(res.status).toBe(200);

      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('team-protected') });
      h.setCaller(WAIN_USER);
      res = await h.request('/api/skills/me/skills/team-protected/document', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '---\nname: team-protected\ndescription: bad\n---\nbody' }),
      });
      expect(res.status).toBe(400);
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

    it('POST /tenants/:id/promote：候选副本与审批链未建成前 fail closed', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/skills/tenants/wain/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: 'wain_user_custom', sourceUser: 'wain_user' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'PERSONAL_SKILL_SUBMISSION_REQUIRED' });
      expect(existsSync(tenantSkillDir('wain', 'wain_user_custom'))).toBe(false);
    });

    it('POST /tenants/:id/skills/:skillId/promote → pool：组织 admin 403；平台 admin 200', async () => {
      h.setCaller(WAIN_ADMIN);
      await h.request('/api/skills/tenants/wain/import', { method: 'POST', body: skillUploadBody('to-pool') });
      const denied = await h.request('/api/skills/tenants/wain/skills/to-pool/promote', { method: 'POST' });
      expect(denied.status).toBe(403);

      // 模拟组织 skill 已被异步物化到成员目录；该系统副本不能被误判为个人自建冲突。
      const materialized = join(h.userSkillsDir('wain_user'), 'to-pool');
      mkdirSync(materialized, { recursive: true });
      writeFileSync(join(materialized, 'SKILL.md'), `---\nname: to-pool\ndescription: materialized copy\n---\nbody`);

      h.setCaller(PLATFORM_ADMIN);
      const ok = await h.request('/api/skills/tenants/wain/skills/to-pool/promote', { method: 'POST' });
      expect(ok.status, await ok.clone().text()).toBe(200);
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
