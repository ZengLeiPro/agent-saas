/**
 * Skill 平台池、组织池与个人所有权边界测试。
 * 个人 Skill 内容和选择 self-only；直接提升到组织或平台在提交审批链建成前 fail closed。
 * 组织管理员仍可治理组织 Skill 与成员可用范围，但不能代读、代改成员个人 Skill。
 */

import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
import { computeSkillPackageFingerprint } from '../workspace/materialization/fingerprint.js';
import { tenantSkillResourceId } from '../services/tenantSkillGovernanceUpload.js';
import { SkillMaterializationService } from '../workspace/materialization/service.js';
import { InMemorySkillMaterializationStore } from '../workspace/materialization/store.js';

export const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
export const KAIYAN_USER: JwtPayload = { sub: 'u-ku', username: 'alice', role: 'user', tenantId: 'kaiyan' };
export const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
export const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };

/** 复现旧 skillPackageUpload：故意不排除 node_modules 等目录。 */
export function legacyPackageFingerprint(root: string): string {
  const files: string[] = [];
  const visit = (current: string, prefix = ''): void => {
    for (const name of readdirSync(current).sort((a, b) => a.localeCompare(b))) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const path = join(current, name);
      if (statSync(path).isDirectory()) visit(path, relativePath);
      else files.push(relativePath);
    }
  };
  visit(root);
  const hash = createHash('sha256');
  for (const relativePath of files) {
    const path = join(root, relativePath);
    const size = statSync(path).size;
    hash.update(relativePath).update('\\0').update(String(size)).update('\\0').update(readFileSync(path));
  }
  return hash.digest('hex');
}

export interface TestRig {
  baseUrl: string;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir: string;
  poolDir: string;
  skillConfigStore: SkillConfigStore;
  userSkillsDir(username: string): string;
  setTenantSkillHistoricalDigests(tenantId: string, skillId: string, digests: string[]): void;
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

export async function makeTestRig(): Promise<TestRig> {
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
  const tenantSkillHistory = new Map<string, { tenantId: string; skillId: string; digests: string[] }>();
  const skillGovernanceStore = {
    getResource: async (resourceId: string) => {
      const entry = tenantSkillHistory.get(resourceId);
      if (!entry) return null;
      return {
        skillId: resourceId,
        tenantId: entry.tenantId,
        scope: 'tenant' as const,
        status: 'published' as const,
        revision: 1,
        createdAt: '2026-08-19T00:00:00.000Z',
        createdBy: 'test',
        updatedAt: '2026-08-19T00:00:00.000Z',
        updatedBy: 'test',
      };
    },
    getVersion: async (versionId: string) => versionId === 'test-personal'
      ? {
          versionId: 'test-personal',
          skillId: 'known-personal',
          versionNumber: 1,
          definition: { legacySkillId: 'known-personal' },
          digest: 'test-personal-digest',
          publishedAt: '2026-08-19T00:00:00.000Z',
          publishedBy: 'test',
        }
      : null,
    listPersonalByOwner: async () => [{
      skillId: 'known-personal',
      tenantId: 'kaiyan',
      scope: 'personal' as const,
      ownerUserId: 'u-ku',
      status: 'published' as const,
      currentVersionId: 'test-personal',
      revision: 1,
      createdAt: '2026-08-19T00:00:00.000Z',
      createdBy: 'test',
      updatedAt: '2026-08-19T00:00:00.000Z',
      updatedBy: 'test',
    }],
    listTenantSkillHistoricalProvenance: async (tenantId: string) => new Map(
      [...tenantSkillHistory.values()]
        .filter((entry) => entry.tenantId === tenantId)
        .map((entry) => [entry.skillId, { digests: [], legacyDigests: entry.digests }] as const),
    ),
  };
  const resolveTenantSkillHistoricalProvenance = async (tenantId: string) => new Map(
    [...tenantSkillHistory.values()]
      .filter((entry) => entry.tenantId === tenantId)
      .map((entry) => [entry.skillId, { digests: [], legacyDigests: entry.digests }] as const),
  );
  const materializer = new SkillWorkspaceMaterializer({
    sharedDir,
    sourceRevision: 'test-release',
    tenantSkillsRootDir,
    skillConfigStore,
    resolveTenantSkillHistoricalProvenance,
    resolveUserPersonalSkillIds: async () => new Set(['known-personal']),
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
      skillGovernanceStore,
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
    setTenantSkillHistoricalDigests(tenantId, skillId, digests) {
      tenantSkillHistory.set(tenantSkillResourceId(tenantId, skillId), { tenantId, skillId, digests });
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
