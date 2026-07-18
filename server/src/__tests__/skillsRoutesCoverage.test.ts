/**
 * skills 路由覆盖测试（routes/skills.ts）
 *
 * 现有 skillsRouterTenantIsolation.test.ts 覆盖跨组织 403 与主要 happy path；
 * 本文件只补未覆盖的分支（真 express + 真文件系统 pool + 真 fetch）：
 *   - requireAdmin 403（普通用户访问 admin 端点）
 *   - 输入校验 400（非法 skillId / username / tenantId 格式）
 *   - 自服务：GET /me 401 未登录、happy 200；PUT /me/selections 400 校验；
 *     DELETE /me/skills 自删 happy + 404 不存在 + 拒删系统 skill 400
 *   - pool 文档读：GET /pool/:id/document 200 / 未注册 404
 *   - /me/import happy path（zip 之外的多文件上传）
 *   - POST /sync 空池 409
 *   - /custom/:u/:id/document 拒改系统 skill 400
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSkillsRouter } from '../routes/skills.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const KAIYAN_USER: JwtPayload = { sub: 'u-ku', username: 'alice', role: 'user', tenantId: 'kaiyan' };

function userRecord(id: string, username: string, role: 'admin' | 'user', tenantId: string): UserRecord {
  return {
    id, username, passwordHash: 'x', role, tenantId, realName: username,
    createdAt: '2026-06-23T00:00:00Z', createdBy: 'system', updatedAt: '2026-06-23T00:00:00Z',
  };
}

function fakeUserStore(): UserStore {
  const users: UserRecord[] = [
    userRecord('u-platform', 'admin', 'admin', DEFAULT_TENANT_ID),
    userRecord('u-ku', 'alice', 'user', 'kaiyan'),
  ];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    findById: (id: string) => users.find(u => u.id === id),
    listAll: () => users.map(({ passwordHash: _p, ...rest }) => rest as never),
  } as unknown as UserStore;
}

/** 极简 in-memory SkillConfigStore：仅覆盖本测试触达的方法 */
function fakeSkillConfigStore(): SkillConfigStore {
  const visibility: Record<string, boolean> = {};
  const userSelections = new Map<string, string[]>();
  let configVersion = 1;
  return {
    getPoolVisibility: () => ({ ...visibility }),
    getPlatformSkillConfig: (id: string) => ({ enabled: visibility[id] !== false, exposure: 'all' as const, tenantIds: [] }),
    isPoolSkillAvailableToTenant: (id: string) => visibility[id] !== false,
    setPoolVisibility: async (updates: Record<string, boolean>) => { Object.assign(visibility, updates); configVersion++; },
    isTenantSkillAvailableToUser: () => true,
    isTenantOwnSkillAvailableToUser: () => true,
    getTenantSkillRule: () => ({ enabled: true, exposure: 'all' as const, usernames: [] }),
    getTenantOwnSkillRule: () => ({ enabled: true, exposure: 'all' as const, usernames: [] }),
    getUserSelectedSkills: (u: string) => userSelections.get(u) ?? [],
    setUserSelectedSkills: async (u: string, skills: string[]) => { userSelections.set(u, skills); configVersion++; },
    getConfigVersion: () => configVersion,
    touchConfigVersion: async () => { configVersion++; },
    syncWithPool: () => 0,
    pruneStaleSkills: () => 0,
  } as unknown as SkillConfigStore;
}

interface Rig {
  baseUrl: string;
  agentCwd: string;
  poolDir: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  setCaller(c: JwtPayload | undefined): void;
  close(): Promise<void>;
}

async function makeRig(opts: { seedPool?: boolean } = {}): Promise<Rig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-routes-cov-'));
  const agentCwd = join(tmpRoot, 'workspace');
  const sharedDir = join(tmpRoot, 'shared');
  const tenantSkillsRootDir = join(tmpRoot, 'tenant-skills');
  const poolDir = join(sharedDir, '.ky-agent', 'skills-pool');
  mkdirSync(agentCwd, { recursive: true });
  mkdirSync(poolDir, { recursive: true });
  if (opts.seedPool !== false) {
    mkdirSync(join(poolDir, 'shared_skill'), { recursive: true });
    writeFileSync(join(poolDir, 'shared_skill', 'SKILL.md'), '---\nname: shared_skill\ndescription: shared\n---\nhi');
  }
  // kaiyan alice 自建 skill（供 /me、自删测试）
  const aliceSkillDir = join(agentCwd, 'kaiyan', 'u-ku', '.ky-agent', 'skills', 'alice_custom');
  mkdirSync(aliceSkillDir, { recursive: true });
  writeFileSync(join(aliceSkillDir, 'SKILL.md'), '---\nname: alice_custom\ndescription: c\n---\nx');

  const app = express();
  app.use(express.json());
  let caller: JwtPayload | undefined = PLATFORM_ADMIN;
  app.use((req, _res, next) => { if (caller) req.user = caller; next(); });
  app.use('/api/skills', createSkillsRouter({
    skillConfigStore: fakeSkillConfigStore(),
    userStore: fakeUserStore(),
    agentCwd, sharedDir, tenantSkillsRootDir,
  }));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl, agentCwd, poolDir,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    setCaller(c) { caller = c; },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('skills routes coverage', () => {
  let h: Rig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  it('requireAdmin 403：普通用户访问 admin 端点', async () => {
    h.setCaller(KAIYAN_USER);
    const res = await h.request('/api/skills/pool');
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('Admin access required');
  });

  it('requirePlatformAdmin 403：非平台 admin 访问全局写端点', async () => {
    const KAIYAN_ADMIN: JwtPayload = { sub: 'a', username: 'ka', role: 'admin', tenantId: 'kaiyan' };
    h.setCaller(KAIYAN_ADMIN);
    const res = await h.request('/api/skills/pool/visibility', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shared_skill: false }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('Platform admin access required');
  });

  it('输入校验 400：非法 skillId / username / tenantId 格式', async () => {
    h.setCaller(PLATFORM_ADMIN);
    // 非法 skillId（含 path traversal 字符）
    expect((await h.request('/api/skills/pool/..%2Fetc/document')).status).toBe(400);
    // 非法 username（点开头）
    expect((await h.request('/api/skills/users/.hidden')).status).toBe(400);
    // 非法 tenantId（含斜杠）→ resolveAdminTargetTenantId 400
    expect((await h.request('/api/skills/tenants/.bad/pool')).status).toBe(400);
  });

  it('GET /me：401 未登录 / 200 返回自建 skill', async () => {
    h.setCaller(undefined);
    expect((await h.request('/api/skills/me')).status).toBe(401);

    h.setCaller(KAIYAN_USER);
    const res = await h.request('/api/skills/me');
    expect(res.status).toBe(200);
    const body = await res.json() as { customSkills: { id: string }[] };
    expect(body.customSkills.map(s => s.id)).toContain('alice_custom');
  });

  it('PUT /me/selections：401 / 400 校验 / 200 过滤后落库', async () => {
    h.setCaller(undefined);
    expect((await h.request('/api/skills/me/selections', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedSkills: [] }),
    })).status).toBe(401);

    h.setCaller(KAIYAN_USER);
    const bad = await h.request('/api/skills/me/selections', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedSkills: 'nope' }),
    });
    expect(bad.status).toBe(400);

    // 合法：选自建 skill → 200；不存在的 id 被过滤掉不报错
    const ok = await h.request('/api/skills/me/selections', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedSkills: ['alice_custom', 'ghost_id'] }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ok: boolean }).ok).toBe(true);
  });

  it('DELETE /me/skills/:skillId：拒删系统 skill 400 / 不存在 404 / 自删 200', async () => {
    h.setCaller(KAIYAN_USER);
    // 系统 pool skill 不能经此接口删
    const sys = await h.request('/api/skills/me/skills/shared_skill', { method: 'DELETE' });
    expect(sys.status).toBe(400);

    // 不存在的自建 skill → 404
    expect((await h.request('/api/skills/me/skills/nonexistent', { method: 'DELETE' })).status).toBe(404);

    // 自删已存在的自建 skill → 200
    const ok = await h.request('/api/skills/me/skills/alice_custom', { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ok: boolean }).ok).toBe(true);
    // 再删 → 404（确认真删了）
    expect((await h.request('/api/skills/me/skills/alice_custom', { method: 'DELETE' })).status).toBe(404);
  });

  it('DELETE /me/skills/:skillId 401 未登录', async () => {
    h.setCaller(undefined);
    expect((await h.request('/api/skills/me/skills/x', { method: 'DELETE' })).status).toBe(401);
  });

  it('GET /pool/:skillId/document：200 已注册 / 404 未注册', async () => {
    h.setCaller(PLATFORM_ADMIN);
    const ok = await h.request('/api/skills/pool/shared_skill/document');
    expect(ok.status).toBe(200);
    const body = await ok.json() as { skillId: string; source: string; content: string };
    expect(body.skillId).toBe('shared_skill');
    expect(body.source).toBe('pool');
    expect(body.content).toContain('shared_skill');

    // 未在池中注册的 skillId → 404
    const notReg = await h.request('/api/skills/pool/unregistered/document');
    expect(notReg.status).toBe(404);
  });

  it('PUT /pool/:skillId/document：非法内容 400 / 未注册 404 / 成功 200', async () => {
    h.setCaller(PLATFORM_ADMIN);
    // content 类型错误（非字符串）→ Zod 400
    const badBody = await h.request('/api/skills/pool/shared_skill/document', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 123 }),
    });
    expect(badBody.status).toBe(400);
    expect((await badBody.json() as { error: string }).error).toBe('Invalid document');

    // 未注册 skill → 404
    const notReg = await h.request('/api/skills/pool/ghost/document', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }),
    });
    expect(notReg.status).toBe(404);

    // 成功写入
    const ok = await h.request('/api/skills/pool/shared_skill/document', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '---\nname: shared_skill\ndescription: updated\n---\nnew body' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ok: boolean }).ok).toBe(true);
  });

  it('POST /custom/:username/:skillId/promote：源用户不存在 404', async () => {
    h.setCaller(PLATFORM_ADMIN);
    const res = await h.request('/api/skills/custom/alice_custom/promote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceUser: 'ghostuser' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('Source user not found');
  });

  it('POST /sync：空技能池 → 409 拒绝同步', async () => {
    const empty = await makeRig({ seedPool: false });
    try {
      empty.setCaller(PLATFORM_ADMIN);
      const res = await empty.request('/api/skills/sync', { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain('技能池为空');
    } finally {
      await empty.close();
    }
  });

  it('POST /me/import：多文件上传自建 skill → 200 并即启用', async () => {
    h.setCaller(KAIYAN_USER);
    const form = new FormData();
    const skillMd = '---\nname: uploaded-skill\ndescription: an uploaded skill\n---\nbody text';
    form.append('files', new Blob([skillMd], { type: 'text/markdown' }), 'uploaded-skill/SKILL.md');
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skill: { id: string; name: string } };
    expect(body.ok).toBe(true);
    expect(body.skill.id).toBe('uploaded-skill');
    expect(body.skill.name).toBe('uploaded-skill');
  });

  it('POST /me/import：无文件 → 400', async () => {
    h.setCaller(KAIYAN_USER);
    const res = await h.request('/api/skills/me/import', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('No files uploaded');
  });
});
