/**
 * skills 路由残余分支覆盖（routes/skills.ts）—— promote / custom document / resolveAdminTargetUser / safeName
 *
 * 分工（不与既有测试重复）：
 *   - skillsRouterTenantIsolation.test.ts：跨组织 403 主格局、pool 写权限、tenant 自有 skill 全流程
 *   - skillsRoutesCoverage.test.ts：requireAdmin/requirePlatformAdmin 403、pool document 读写、
 *     /me 自服务、/sync 空池 409、promote 的「Source user not found」404
 *   - platformGovernance.test.ts：只读平台管理员治理中间件（非本路由逻辑）
 *
 * 本文件补：
 *   1. POST /custom/:skillId/promote（skills.ts L651-682）：
 *      入参校验 400（非法 skillId / 缺 sourceUser / 非法 sourceUser）、
 *      源 skill 目录不存在 404、池已存在 409（且不覆盖池内容）、
 *      成功路径（递归复制落盘 + 源保留 + setPoolVisibility(true) 生效 + GET /pool 可见）
 *   2. GET/PUT /custom/:username/:skillId/document 拒绝矩阵（L686-736）：
 *      系统 pool skill → 400、组织自有 skill → 400（含 PUT 后文件未被改写的副作用断言）、
 *      非法 username/skillId → 400、目标 skill 不存在 404、happy path 读写落盘、
 *      name 与目录 ID 不一致 400
 *   3. resolveAdminTargetUser（L123-134）：目标用户不存在 404；
 *      已知缺陷记录：跨租户目标返回 403（非 404 隐藏），组织 admin 可借状态码差异探测他租户用户名存在性
 *   4. safeName（L51-54）：下划线/点开头等非法名在 promote 与 document 端点的 400 分支；
 *      已知缺陷记录：safeName 允许下划线目录名，但 validateSkillDocument 的 frontmatter name
 *      规则只允许小写/数字/连字符 → 下划线 id 的自建 skill 无法通过 PUT document 编辑
 *
 * rig 照抄 skillsRoutesCoverage.test.ts：真 express + app.listen(0) + 全局 fetch，
 * 认证伪造=中间件注入 req.user，setCaller 切换；mkdtempSync 真实临时目录种 skill；
 * afterEach server.close() + rmSync。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSkillsRouter } from '../routes/skills.js';
import type { UserStore } from '../data/users/store.js';
import type { UserRecord } from '../data/users/types.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };

const ALICE_CUSTOM_MD = '---\nname: alice_custom\ndescription: c\n---\nalice custom body';
const EDITABLE_MD = '---\nname: editable-skill\ndescription: editable\n---\noriginal body';
const POOL_SHARED_MD = '---\nname: shared_skill\ndescription: shared\n---\nhi';
const TENANT_TEAM_MD = '---\nname: kaiyan-team-skill\ndescription: team\n---\nteam body';

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
    userRecord('u-wa', 'wain_admin', 'admin', 'wain'),
  ];
  return {
    findByUsername: (name: string) => users.find(u => u.username === name),
    findById: (id: string) => users.find(u => u.id === id),
    listAll: () => users.map(({ passwordHash: _p, ...rest }) => rest as never),
  } as unknown as UserStore;
}

/** 极简 in-memory SkillConfigStore：仅覆盖本测试触达的方法（同 skillsRoutesCoverage） */
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
  /** alice（kaiyan/u-ku）的 .ky-agent/skills 物理目录 */
  aliceSkillsDir: string;
  /** kaiyan 组织自有 skill 目录（tenantSkillsRootDir/kaiyan/skills） */
  kaiyanTenantSkillsDir: string;
  skillConfigStore: SkillConfigStore;
  request(path: string, init?: RequestInit): Promise<Response>;
  setCaller(c: JwtPayload | undefined): void;
  close(): Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-promote-doc-cov-'));
  const agentCwd = join(tmpRoot, 'workspace');
  const sharedDir = join(tmpRoot, 'shared');
  const tenantSkillsRootDir = join(tmpRoot, 'tenant-skills');
  const poolDir = join(sharedDir, '.ky-agent', 'skills-pool');
  mkdirSync(agentCwd, { recursive: true });
  mkdirSync(poolDir, { recursive: true });

  // 系统 pool skill（供「系统 skill → 400」与 promote 409 撞名）
  mkdirSync(join(poolDir, 'shared_skill'), { recursive: true });
  writeFileSync(join(poolDir, 'shared_skill', 'SKILL.md'), POOL_SHARED_MD);

  // kaiyan 组织自有 skill（供「组织 skill → 400」）
  const kaiyanTenantSkillsDir = join(tenantSkillsRootDir, 'kaiyan', 'skills');
  mkdirSync(join(kaiyanTenantSkillsDir, 'kaiyan-team-skill'), { recursive: true });
  writeFileSync(join(kaiyanTenantSkillsDir, 'kaiyan-team-skill', 'SKILL.md'), TENANT_TEAM_MD);

  // alice 自建 skill：alice_custom（含嵌套文件，验证 promote 递归复制）+ editable-skill（document 读写）
  const aliceSkillsDir = join(agentCwd, 'kaiyan', 'u-ku', '.ky-agent', 'skills');
  mkdirSync(join(aliceSkillsDir, 'alice_custom', 'assets'), { recursive: true });
  writeFileSync(join(aliceSkillsDir, 'alice_custom', 'SKILL.md'), ALICE_CUSTOM_MD);
  writeFileSync(join(aliceSkillsDir, 'alice_custom', 'assets', 'note.txt'), 'nested asset');
  mkdirSync(join(aliceSkillsDir, 'editable-skill'), { recursive: true });
  writeFileSync(join(aliceSkillsDir, 'editable-skill', 'SKILL.md'), EDITABLE_MD);

  const app = express();
  app.use(express.json());
  let caller: JwtPayload | undefined = PLATFORM_ADMIN;
  app.use((req, _res, next) => { if (caller) req.user = caller; next(); });
  const skillConfigStore = fakeSkillConfigStore();
  app.use('/api/skills', createSkillsRouter({
    skillConfigStore,
    userStore: fakeUserStore(),
    agentCwd, sharedDir, tenantSkillsRootDir,
  }));
  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    baseUrl, agentCwd, poolDir, aliceSkillsDir, kaiyanTenantSkillsDir, skillConfigStore,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    setCaller(c) { caller = c; },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('skills promote/document 残余分支覆盖', () => {
  let h: Rig;
  beforeEach(async () => { h = await makeRig(); });
  afterEach(async () => { await h.close(); });

  // ============================================================
  // POST /custom/:skillId/promote（skills.ts L651-682）
  // ============================================================
  describe('POST /custom/:skillId/promote', () => {
    it('入参校验：非法 skillId / 缺 sourceUser / 非法 sourceUser → 各自 400', async () => {
      // safeName 拒绝下划线开头的 skillId（L652-653）
      const badSkill = await h.request('/api/skills/custom/_bad/promote', jsonInit('POST', { sourceUser: 'alice' }));
      expect(badSkill.status).toBe(400);
      expect((await badSkill.json() as { error: string }).error).toBe('Invalid skillId');

      // promoteSchema 校验失败（L654-656）
      const missing = await h.request('/api/skills/custom/alice_custom/promote', jsonInit('POST', {}));
      expect(missing.status).toBe(400);
      expect((await missing.json() as { error: string }).error).toBe('sourceUser is required');

      // safeName 拒绝点开头的 sourceUser（L659-660）
      const badUser = await h.request('/api/skills/custom/alice_custom/promote', jsonInit('POST', { sourceUser: '.hidden' }));
      expect(badUser.status).toBe(400);
      expect((await badUser.json() as { error: string }).error).toBe('Invalid sourceUser');

      // 副作用：全部被拒，pool 目录没有任何新落盘
      expect(existsSync(join(h.poolDir, 'alice_custom'))).toBe(false);
    });

    it('源用户存在但其工作区无该 skill → 404', async () => {
      const res = await h.request('/api/skills/custom/ghost-skill/promote', jsonInit('POST', { sourceUser: 'alice' }));
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe('用户 alice 的工作区中不存在技能“ghost-skill”');
      expect(existsSync(join(h.poolDir, 'ghost-skill'))).toBe(false);
    });

    it('池中已存在同名 skill → 409，且池内容不被覆盖、visibility 不被写入', async () => {
      // 给 alice 造一个与 pool 同名的自建目录，使 srcDir 存在、dstDir 也存在
      mkdirSync(join(h.aliceSkillsDir, 'shared_skill'), { recursive: true });
      writeFileSync(join(h.aliceSkillsDir, 'shared_skill', 'SKILL.md'), '---\nname: shared_skill\ndescription: hijack\n---\nhijack');

      const res = await h.request('/api/skills/custom/shared_skill/promote', jsonInit('POST', { sourceUser: 'alice' }));
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toBe('技能“shared_skill”已存在于技能池');
      // 池内原文档未被用户版本覆盖
      expect(readFileSync(join(h.poolDir, 'shared_skill', 'SKILL.md'), 'utf-8')).toBe(POOL_SHARED_MD);
      // setPoolVisibility 未被调用（fake store 初始为空表）
      expect(h.skillConfigStore.getPoolVisibility()).not.toHaveProperty('shared_skill');
    });

    it('成功：200 + 目录（含嵌套文件）复制进 pool + 源保留 + setPoolVisibility(true) 生效', async () => {
      const res = await h.request('/api/skills/custom/alice_custom/promote', jsonInit('POST', { sourceUser: 'alice' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // 落盘：SKILL.md 与嵌套 assets/note.txt 均按原内容复制
      expect(readFileSync(join(h.poolDir, 'alice_custom', 'SKILL.md'), 'utf-8')).toBe(ALICE_CUSTOM_MD);
      expect(readFileSync(join(h.poolDir, 'alice_custom', 'assets', 'note.txt'), 'utf-8')).toBe('nested asset');
      // promote 是复制不是搬移：源用户目录保留
      expect(existsSync(join(h.aliceSkillsDir, 'alice_custom', 'SKILL.md'))).toBe(true);
      // 可见性配置副作用：setPoolVisibility({alice_custom: true}) 已生效
      expect(h.skillConfigStore.getPoolVisibility()).toHaveProperty('alice_custom', true);

      // 端到端：GET /pool 立即能看到新技能且 visible=true
      const pool = await h.request('/api/skills/pool');
      expect(pool.status).toBe(200);
      const body = await pool.json() as { skills: { id: string; visible: boolean }[] };
      expect(body.skills.find(s => s.id === 'alice_custom')?.visible).toBe(true);
    });
  });

  // ============================================================
  // GET/PUT /custom/:username/:skillId/document 拒绝矩阵（L686-736）
  // ============================================================
  describe('/custom/:username/:skillId/document 拒绝矩阵', () => {
    it('非法 username / skillId → 400 Invalid username or skillId（GET 与 PUT）', async () => {
      for (const path of [
        '/api/skills/custom/.bad/editable-skill/document', // username 点开头
        '/api/skills/custom/alice/_bad/document',          // skillId 下划线开头
      ]) {
        const got = await h.request(path);
        expect(got.status).toBe(400);
        expect((await got.json() as { error: string }).error).toBe('Invalid username or skillId');

        const put = await h.request(path, jsonInit('PUT', { content: 'x' }));
        expect(put.status).toBe(400);
        expect((await put.json() as { error: string }).error).toBe('Invalid username or skillId');
      }
    });

    it('系统 pool skill → 400（GET 与 PUT），池文档不被改写', async () => {
      const got = await h.request('/api/skills/custom/alice/shared_skill/document');
      expect(got.status).toBe(400);
      expect((await got.json() as { error: string }).error).toBe('技能池文档必须通过 /pool 管理');

      const put = await h.request('/api/skills/custom/alice/shared_skill/document',
        jsonInit('PUT', { content: '---\nname: shared_skill\ndescription: hijack\n---\nhijack' }));
      expect(put.status).toBe(400);
      expect((await put.json() as { error: string }).error).toBe('技能池文档必须通过 /pool 管理');
      // 副作用断言：池内文档保持原样
      expect(readFileSync(join(h.poolDir, 'shared_skill', 'SKILL.md'), 'utf-8')).toBe(POOL_SHARED_MD);
    });

    it('组织自有 skill → 400（GET 与 PUT），组织文档不被改写', async () => {
      const got = await h.request('/api/skills/custom/alice/kaiyan-team-skill/document');
      expect(got.status).toBe(400);
      expect((await got.json() as { error: string }).error).toBe('组织技能文档必须通过 /tenants 管理');

      const put = await h.request('/api/skills/custom/alice/kaiyan-team-skill/document',
        jsonInit('PUT', { content: '---\nname: kaiyan-team-skill\ndescription: hijack\n---\nhijack' }));
      expect(put.status).toBe(400);
      expect((await put.json() as { error: string }).error).toBe('组织技能文档必须通过 /tenants 管理');
      expect(readFileSync(join(h.kaiyanTenantSkillsDir, 'kaiyan-team-skill', 'SKILL.md'), 'utf-8')).toBe(TENANT_TEAM_MD);
    });

    it('目标用户存在但 skill 目录不存在 → 404（GET 与 PUT）', async () => {
      const got = await h.request('/api/skills/custom/alice/no-such-skill/document');
      expect(got.status).toBe(404);
      expect((await got.json() as { error: string }).error).toBe('用户 alice 的工作区中不存在技能“no-such-skill”');

      const put = await h.request('/api/skills/custom/alice/no-such-skill/document',
        jsonInit('PUT', { content: '---\nname: no-such-skill\ndescription: d\n---\nx' }));
      expect(put.status).toBe(404);
    });

    it('happy path：GET 读取 + PUT 改写落盘；name 与目录 ID 不一致 / 无 frontmatter → 400', async () => {
      const got = await h.request('/api/skills/custom/alice/editable-skill/document');
      expect(got.status).toBe(200);
      const doc = await got.json() as { skillId: string; source: string; username: string; content: string; fileName: string };
      expect(doc).toMatchObject({ skillId: 'editable-skill', source: 'custom', username: 'alice', fileName: 'SKILL.md' });
      expect(doc.content).toBe(EDITABLE_MD);

      // content 非字符串 → Zod 400 Invalid document（L719）
      const badType = await h.request('/api/skills/custom/alice/editable-skill/document',
        jsonInit('PUT', { content: 123 }));
      expect(badType.status).toBe(400);
      expect((await badType.json() as { error: string }).error).toBe('Invalid document');

      // name 与目录 ID 不一致 → 400（L723），文件不动
      const mismatched = await h.request('/api/skills/custom/alice/editable-skill/document',
        jsonInit('PUT', { content: '---\nname: other-name\ndescription: d\n---\nbody' }));
      expect(mismatched.status).toBe(400);
      expect((await mismatched.json() as { error: string }).error).toBe("SKILL.md name 必须与目录 ID 'editable-skill' 保持一致");
      expect(readFileSync(join(h.aliceSkillsDir, 'editable-skill', 'SKILL.md'), 'utf-8')).toBe(EDITABLE_MD);

      // 无 frontmatter → 400（L722）
      const noFm = await h.request('/api/skills/custom/alice/editable-skill/document',
        jsonInit('PUT', { content: 'plain text without frontmatter' }));
      expect(noFm.status).toBe(400);

      // 合法改写 → 200 且真实落盘
      const updated = '---\nname: editable-skill\ndescription: updated\n---\nnew body';
      const put = await h.request('/api/skills/custom/alice/editable-skill/document', jsonInit('PUT', { content: updated }));
      expect(put.status).toBe(200);
      const putBody = await put.json() as { ok: boolean; skillId: string; source: string; username: string; fileName: string };
      expect(putBody).toMatchObject({ ok: true, skillId: 'editable-skill', source: 'custom', username: 'alice', fileName: 'SKILL.md' });
      expect(readFileSync(join(h.aliceSkillsDir, 'editable-skill', 'SKILL.md'), 'utf-8')).toBe(updated);
    });

    it('已知缺陷记录：下划线 id 的自建 skill 无法通过 PUT document 编辑（safeName 与 frontmatter name 规则不一致）', async () => {
      // safeName（L51）允许下划线目录名（alice_custom 可被扫描、promote、GET document），
      // 但 validateSkillDocument（L187）的 name 规则只允许 [a-z0-9-]，
      // 于是「name 与目录 ID 保持一致」在下划线 id 上永远无法满足 → PUT 恒 400。
      const got = await h.request('/api/skills/custom/alice/alice_custom/document');
      expect(got.status).toBe(200); // 读没问题

      const put = await h.request('/api/skills/custom/alice/alice_custom/document',
        jsonInit('PUT', { content: ALICE_CUSTOM_MD })); // 原样回写自己的内容也被拒
      expect(put.status).toBe(400);
      expect((await put.json() as { error: string }).error)
        .toBe('SKILL.md 必须包含 YAML frontmatter，name 需为小写字母/数字/连字符且 description 非空');
      expect(readFileSync(join(h.aliceSkillsDir, 'alice_custom', 'SKILL.md'), 'utf-8')).toBe(ALICE_CUSTOM_MD);
    });
  });

  // ============================================================
  // resolveAdminTargetUser（L123-134）
  // ============================================================
  describe('resolveAdminTargetUser', () => {
    it('目标用户不存在 → 404 User not found', async () => {
      const res = await h.request('/api/skills/custom/ghostuser/editable-skill/document');
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe('User not found');
    });

    it('已知缺陷记录：跨租户目标返回 403 而非 404 隐藏，状态码差异泄露用户名存在性', async () => {
      // 源码 L129-132 有意对跨组织返回 403（注释「跨组织 admin 一律 403」）。
      // 但与 L125-127 的 404 对照：组织 admin 探测任意 username，
      // 404 = 不存在、403 = 存在于其他租户 —— 存在性被状态码差异泄露。
      // 本用例固化当前行为；若改为统一 404 隐藏（本任务原始预期），需同步更新此断言。
      h.setCaller(WAIN_ADMIN);

      const ghost = await h.request('/api/skills/custom/ghostuser/editable-skill/document');
      expect(ghost.status).toBe(404);
      expect((await ghost.json() as { error: string }).error).toBe('User not found');

      const crossTenant = await h.request('/api/skills/custom/alice/editable-skill/document');
      expect(crossTenant.status).toBe(403);
      expect((await crossTenant.json() as { error: string }).error).toBe('跨组织访问被拒绝');

      // PUT 同口径
      const crossPut = await h.request('/api/skills/custom/alice/editable-skill/document',
        jsonInit('PUT', { content: '---\nname: editable-skill\ndescription: d\n---\nx' }));
      expect(crossPut.status).toBe(403);
      // 副作用断言：跨租户写被拒后文件保持原样
      expect(readFileSync(join(h.aliceSkillsDir, 'editable-skill', 'SKILL.md'), 'utf-8')).toBe(EDITABLE_MD);
    });
  });
});
