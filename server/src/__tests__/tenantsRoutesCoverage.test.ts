/**
 * /api/tenants 路由残余分支覆盖（routes/tenants.ts）——第三批补测
 *
 * 与现有测试的分工（侦察清单 5 项已全部被 07-19 凌晨 7240c54 批次覆盖，本文件只补缺口）：
 * - tenantsRouterGovernance.test.ts（7240c54 批次）：settings 平台专属字段守卫
 *   （imageGenEnabled / allowContextTokenDetails / quotas 403+不落库）、features/models
 *   merge 保留、merge 基底回归、跨租户 403、权限矩阵（GET 列表/GET :id/POST/改名/status
 *   的 403）、POST 主路径（201+company.md+seed / 409 / 400 slug）、PATCH name、
 *   PATCH status（disable 回调 / 409 默认租户 / 404 / 400）。
 * - tenantsCompanyInfoRouter.test.ts：company-info 读写主路径与隔离、POST 自动生成。
 * - tenantContextTokenPolicy.test.ts：两个平台专属字段守卫（与 governance 部分重合）。
 * - tenantDeletion.test.ts：deleteTenantResources 清理器函数层（不经 HTTP）。
 *
 * 本文件专补（现场读源码核对，均为上述文件未触达的分支）：
 * 1. DELETE /:id 路由层全分支——此前完全无路由级测试：
 *    403（组织 admin）/400（缺 confirm、confirm 不一致）/404/501（未注入清理器）/
 *    200 成功（清理成功后再回调 + report 透传 + store 落盘删除）/
 *    409（清理器抛 Cannot delete）/404 与 500（清理器抛错映射）。
 * 2. GET /api/tenants 列表 200 主路径（含 disabled 租户 + settings 补全默认）。
 * 3. PATCH settings 的「幽灵租户 admin」404 分支（canAccess 放行但 current 缺失，
 *    对应 token 存活期内组织被删的现实场景）。
 * 4. settings 嵌套 section 的 zod 必填线（mcp/security 缺必填布尔 → 400 不落库）
 *    与 mcp/security/personalization 三个此前未经路由写过的 section 落库主路径。
 * 5. 第三批补测发现的 3 个缺陷回归：平台专属字段不可间接清写、POST 空白名称
 *    返回 400、DELETE 清理失败不触发断连回调。
 * 6. POST 降级路径：company.md 初始化失败只 warn 仍 201；orgAgent seed 持久化失败
 *    只 warn 仍 201（回滚后不留内存脏记录）。
 * 7. company-info 500 分支：company.md 路径被目录占据 → GET/PUT 500。
 *
 * 不测（B/C 纪律）：auditLog 落库内容（login-logs 自有测试）、updateSettings persist
 * 的 fs 故障注入（需 chmod/rename 打桩，收益低）、seed 模板内容本身（orgAgentTemplates
 * 自有测试）。
 *
 * 模式照抄 tenantsRouterGovernance.test.ts 的 rig：真 express + listen(0) + 真 fetch，
 * 中间件注入 req.user，setCaller 切换身份，mkdtempSync 临时目录承载 file-backed store，
 * afterEach server.close + rmSync。
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { TenantRecord } from '../data/tenants/types.js';
import { TenantStore } from '../data/tenants/store.js';
import type { TenantDeletionReport } from '../data/tenants/cleanup.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import { createTenantsRouter } from '../routes/tenants.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'platform_admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
/** 幽灵租户 admin：token 声称的 tenantId 在 store 中不存在（组织已删但 token 未过期） */
const GHOST_ADMIN: JwtPayload = { sub: 'u-ghost', username: 'ghost_admin', role: 'admin', tenantId: 'ghost' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** tenantSettingsSchema 中 features 的 5 个必填布尔（PATCH 带 features 时必须带全） */
const BASE_FEATURES = {
  filesEnabled: true,
  cronEnabled: true,
  mcpEnabled: true,
  customSkillsEnabled: true,
  debugModeAllowed: false,
};

/** 构造一份字段齐全、数值可辨识的清理报告（透传断言用） */
function buildReport(tenant: TenantRecord): TenantDeletionReport {
  return {
    tenantId: tenant.id,
    tenant,
    usersDeleted: 2,
    agentProfilesDeleted: 1,
    groupsDeleted: 0,
    cronJobsDeleted: 0,
    skills: { usersRemoved: 0, tenantConfigRemoved: true, platformRefsRemoved: 0 },
    mcp: { serversRemoved: 0, usersRemoved: 0 },
    tokenUsageRowsDeleted: 0,
    billing: { usageEvents: 0, creditLedger: 0, creditAccounts: 0, tenantPolicies: 0 },
    runtime: {
      sessionIds: 0,
      eventsDeleted: 0,
      eventCursorsDeleted: 0,
      runsDeleted: 0,
      sessionsDeleted: 0,
      toolInvocationsDeleted: 0,
      handsDeleted: 0,
      artifactsDeleted: 0,
    },
    files: {
      workspaceDirDeleted: true,
      transcriptsDirDeleted: false,
      sharedTenantDirDeleted: true,
      tenantSkillsDirDeleted: false,
      avatarsDeleted: 0,
    },
  };
}

interface RigOptions {
  /** false 时不注入 deleteTenantResources（验证 501 分支） */
  withDeleter?: boolean;
  /** true 时 orgAgentStore 的落盘路径被目录占据 → persist 必失败（验证 seed 降级） */
  brokenOrgAgentStore?: boolean;
}

interface TestRig {
  sharedDir: string;
  tenantStore: TenantStore;
  orgAgentStore: OrgAgentStore;
  /** onTenantDisabled 与清理器的调用顺序记录（`disabled:<id>` / `deleter:<id>`） */
  callOrder: string[];
  setCaller(caller: JwtPayload): void;
  /** 覆写清理器实现（默认实现：真删 store 记录并返回 buildReport） */
  setDeleter(fn: (tenantId: string) => Promise<TenantDeletionReport>): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(opts: RigOptions = {}): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tenants-routes-cov-'));
  const sharedDir = join(tmpRoot, 'shared');
  const tenantStore = new TenantStore(join(tmpRoot, 'tenants.json'));
  await tenantStore.create({ id: DEFAULT_TENANT_ID, name: '万神殿', createdBy: 'system' });
  await tenantStore.create({ id: 'wain', name: '唯恩电气', createdBy: 'system' });
  await tenantStore.create({ id: 'acme', name: '阿康', createdBy: 'system' });

  const orgAgentPath = join(tmpRoot, 'org-agents.json');
  if (opts.brokenOrgAgentStore) {
    // 让 org-agents.json 位置被目录占据：load 容错为空表，persist 的 rename 必失败
    mkdirSync(orgAgentPath, { recursive: true });
  }
  const orgAgentStore = new OrgAgentStore(orgAgentPath);

  const callOrder: string[] = [];
  let deleterImpl = async (tenantId: string): Promise<TenantDeletionReport> => {
    const deleted = await tenantStore.delete(tenantId); // 不存在/默认租户由 store 抛错
    return buildReport(deleted);
  };

  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/tenants', createTenantsRouter({
    tenantStore,
    sharedDir,
    orgAgentStore,
    onTenantDisabled: id => { callOrder.push(`disabled:${id}`); },
    ...(opts.withDeleter === false ? {} : {
      deleteTenantResources: async (tenantId: string) => {
        callOrder.push(`deleter:${tenantId}`);
        return deleterImpl(tenantId);
      },
    }),
  }));

  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    sharedDir,
    tenantStore,
    orgAgentStore,
    callOrder,
    setCaller(c) { currentCaller = c; },
    setDeleter(fn) { deleterImpl = fn; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

describe('tenants 路由残余分支（DELETE 全分支 + 列表 + settings/POST 边界）', () => {
  let h: TestRig;
  afterEach(async () => { await h.close(); });

  // -------------------------------------------------------------------------
  // DELETE /api/tenants/:id —— 此前无任何路由级测试
  // -------------------------------------------------------------------------
  describe('DELETE /:id', () => {
    it('组织 admin 删除自己组织 → 403（平台专属接口）且组织仍在、清理器未触发', async () => {
      h = await makeTestRig();
      h.setCaller(WAIN_ADMIN);
      const res = await h.request('/api/tenants/wain', jsonInit('DELETE', { confirm: 'wain' }));
      expect(res.status).toBe(403);
      expect(h.tenantStore.findById('wain')).toBeTruthy();
      expect(h.callOrder).toEqual([]);
    });

    it('缺 confirm → 400；confirm 与 slug 不一致 → 400 明确文案；均无副作用', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);

      // 无 body（express.json 不解析 → req.body undefined → 路由 `?? {}` 兜底）
      const noBody = await h.request('/api/tenants/acme', { method: 'DELETE' });
      expect(noBody.status).toBe(400);
      const noBodyJson = await noBody.json() as { error: string };
      expect(typeof noBodyJson.error).toBe('string');

      const mismatch = await h.request('/api/tenants/acme', jsonInit('DELETE', { confirm: 'acme-typo' }));
      expect(mismatch.status).toBe(400);
      await expect(mismatch.json()).resolves.toMatchObject({ error: '请填写完全一致的组织 slug 以确认删除' });

      expect(h.tenantStore.findById('acme')).toBeTruthy();
      expect(h.callOrder).toEqual([]); // 回调与清理器都未触发
    });

    it('confirm 一致但组织不存在 → 404，不触发回调与清理器', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants/ghost', jsonInit('DELETE', { confirm: 'ghost' }));
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ error: '组织不存在' });
      expect(h.callOrder).toEqual([]);
    });

    it('未注入 deleteTenantResources → 501，且不触发 onTenantDisabled', async () => {
      h = await makeTestRig({ withDeleter: false });
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants/acme', jsonInit('DELETE', { confirm: 'acme' }));
      expect(res.status).toBe(501);
      await expect(res.json()).resolves.toMatchObject({ error: '当前服务未启用组织删除清理器' });
      expect(h.tenantStore.findById('acme')).toBeTruthy();
      expect(h.callOrder).toEqual([]); // 501 短路在回调之前
    });

    it('成功：200 {ok, report} 透传清理报告，清理成功后回调，store 落盘删除', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants/acme', jsonInit('DELETE', { confirm: 'acme' }));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; report: TenantDeletionReport };
      expect(body.ok).toBe(true);
      // report 原样透传（取可辨识字段抽查）
      expect(body.report.tenantId).toBe('acme');
      expect(body.report.tenant.name).toBe('阿康');
      expect(body.report.usersDeleted).toBe(2);
      expect(body.report.skills.tenantConfigRemoved).toBe(true);
      // 清理成功后才断连；store 中记录已删，其余租户不受影响
      expect(h.callOrder).toEqual(['deleter:acme', 'disabled:acme']);
      expect(h.tenantStore.findById('acme')).toBeUndefined();
      expect(h.tenantStore.count()).toBe(2);
    });

    it('删默认租户被 store 拒绝 → 409，且不触发 onTenantDisabled', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request(
        `/api/tenants/${DEFAULT_TENANT_ID}`,
        jsonInit('DELETE', { confirm: DEFAULT_TENANT_ID }),
      );
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Cannot delete');
      expect(h.tenantStore.findById(DEFAULT_TENANT_ID)).toBeTruthy(); // 未删成
      expect(h.callOrder).toEqual([`deleter:${DEFAULT_TENANT_ID}`]);
    });

    it('清理器抛 "Tenant not found" → 404；抛普通错误 → 500 且组织仍在', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);

      // 竞态场景：路由 findById 通过后、清理器执行时组织已被并发删除
      h.setDeleter(async () => { throw new Error('Tenant not found'); });
      const raced = await h.request('/api/tenants/acme', jsonInit('DELETE', { confirm: 'acme' }));
      expect(raced.status).toBe(404);
      await expect(raced.json()).resolves.toMatchObject({ error: '组织不存在' });
      expect(h.callOrder).toEqual(['deleter:acme']);

      h.setDeleter(async () => { throw new Error('磁盘清理失败'); });
      const failed = await h.request('/api/tenants/acme', jsonInit('DELETE', { confirm: 'acme' }));
      expect(failed.status).toBe(500);
      await expect(failed.json()).resolves.toMatchObject({ error: '磁盘清理失败' });
      expect(h.tenantStore.findById('acme')).toBeTruthy(); // 默认清理器未跑，记录仍在
      expect(h.callOrder).toEqual(['deleter:acme', 'deleter:acme']);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/tenants 列表 200 主路径（governance 只测了 403）
  // -------------------------------------------------------------------------
  describe('GET / 列表', () => {
    it('平台 admin → 200 返回全部组织（含 disabled），settings 已补全默认', async () => {
      h = await makeTestRig();
      await h.tenantStore.setDisabled('acme', true, PLATFORM_ADMIN.sub);

      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants');
      expect(res.status).toBe(200);
      const body = await res.json() as { tenants: TenantRecord[] };
      expect(body.tenants.map(t => t.id).sort()).toEqual(['acme', DEFAULT_TENANT_ID, 'wain'].sort());

      const acme = body.tenants.find(t => t.id === 'acme')!;
      expect(acme.disabled).toBe(true); // disabled 租户不被列表过滤
      expect(acme.disabledBy).toBe(PLATFORM_ADMIN.sub);
      // 稀疏存储经 mergeSettings 补全默认后返回
      const wain = body.tenants.find(t => t.id === 'wain')!;
      expect(wain.settings!.features.filesEnabled).toBe(true);
      expect(Array.isArray(wain.settings!.models.allowedModels)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /:id/settings 残余分支
  // -------------------------------------------------------------------------
  describe('settings 残余分支', () => {
    it('幽灵租户 admin PATCH 自己 tenantId → 404（canAccess 放行但组织不存在的分支）', async () => {
      // 覆盖 tenants.ts L244-247：非平台 admin 且 getSettings 返回 undefined。
      // 现实场景：组织已被删除但该组织 admin 的 JWT 尚未过期。
      h = await makeTestRig();
      h.setCaller(GHOST_ADMIN);
      const res = await h.request('/api/tenants/ghost/settings', jsonInit('PATCH', {
        features: { ...BASE_FEATURES },
      }));
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ error: '组织不存在' });
    });

    it('嵌套 section 缺必填布尔（mcp/security）→ 400 且不落库', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);
      const before = h.tenantStore.getSettings('wain')!;

      // mcp 缺 allowGlobalServers（schema 必填）
      const badMcp = await h.request('/api/tenants/wain/settings', jsonInit('PATCH', {
        mcp: { allowTenantServers: true },
      }));
      expect(badMcp.status).toBe(400);

      // security 缺 requireDingtalkBinding（schema 必填）
      const badSecurity = await h.request('/api/tenants/wain/settings', jsonInit('PATCH', {
        security: { passwordMinLength: 10 },
      }));
      expect(badSecurity.status).toBe(400);

      expect(h.tenantStore.getSettings('wain')).toEqual(before); // 全程未写入
    });

    it('平台 admin 更新 mcp/security/personalization section → 200 落库且响应与 store 一致', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants/wain/settings', jsonInit('PATCH', {
        mcp: { allowTenantServers: false, allowGlobalServers: true, defaultEnabledServerIds: ['srv-a'] },
        security: { passwordMinLength: 10, sessionTtlHours: 12, requireDingtalkBinding: true },
        personalization: { firstDayGuideBarEnabled: false },
      }));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        tenantId: string;
        settings: { mcp: unknown; security: unknown; personalization: unknown };
      };
      expect(body.tenantId).toBe('wain');

      const stored = h.tenantStore.getSettings('wain')!;
      expect(stored.mcp).toEqual({
        allowTenantServers: false,
        allowGlobalServers: true,
        defaultEnabledServerIds: ['srv-a'],
      });
      expect(stored.security).toEqual({
        passwordMinLength: 10,
        sessionTtlHours: 12,
        requireDingtalkBinding: true,
      });
      expect(stored.personalization.firstDayGuideBarEnabled).toBe(false);
      // 响应体 settings 与落盘一致
      expect(body.settings.mcp).toEqual(stored.mcp);
      expect(body.settings.security).toEqual(stored.security);
    });

    it('组织 admin 经 showContextTokens=false 间接翻转平台专属字段 → 403 且不落库', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);
      const setup = await h.request('/api/tenants/wain/settings', jsonInit('PATCH', {
        models: { allowUserModelSwitch: true, showContextTokens: true, allowContextTokenDetails: true },
      }));
      expect(setup.status).toBe(200);
      expect(h.tenantStore.getSettings('wain')!.models.allowContextTokenDetails).toBe(true);

      h.setCaller(WAIN_ADMIN);
      // 即便请求不带 allowContextTokenDetails，也按 merge 后终值检查平台专属字段。
      const indirect = await h.request('/api/tenants/wain/settings', jsonInit('PATCH', {
        models: { allowUserModelSwitch: true, showContextTokens: false },
      }));
      expect(indirect.status).toBe(403);
      await expect(indirect.json()).resolves.toMatchObject({ error: '上下文 Token 明细仅平台管理员可配置' });
      const after = h.tenantStore.getSettings('wain')!;
      expect(after.models.showContextTokens).toBe(true);
      expect(after.models.allowContextTokenDetails).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/tenants 边界与降级路径
  // -------------------------------------------------------------------------
  describe('POST 边界与降级', () => {
    it('name 纯空白 → 400，未创建', async () => {
      h = await makeTestRig();
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants', jsonInit('POST', { id: 'blanky', name: '   ' }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: 'name 不能为空' });
      expect(h.tenantStore.findById('blanky')).toBeUndefined();
      expect(h.tenantStore.count()).toBe(3);
    });

    it('company.md 初始化失败只 warn 不阻断：sharedDir 被文件占据仍 201，租户与 seed 均完成', async () => {
      // writeTenantCompanyInfo 需 mkdir sharedDir/tenants/<id>，sharedDir 是文件时
      // 抛 ENOTDIR → 路由 catch 内只 warn（tenants.ts L313-317），继续走 seed 并 201。
      h = await makeTestRig();
      writeFileSync(h.sharedDir, 'not-a-dir'); // 占位：sharedDir 变成普通文件
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants', jsonInit('POST', { id: 'ruiying', name: '瑞鹰卫浴' }));
      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; name: string };
      expect(body).toMatchObject({ id: 'ruiying', name: '瑞鹰卫浴' });
      // 租户记录已建、专家模板照常 seed，仅 company.md 缺失
      expect(h.tenantStore.findById('ruiying')).toBeTruthy();
      expect(h.orgAgentStore.listByTenant('ruiying').length).toBe(3);
      expect(readFileSync(h.sharedDir, 'utf-8')).toBe('not-a-dir'); // 占位文件未被破坏
    });

    it('专家模板 seed 持久化失败只 warn 不阻断：仍 201 且 company.md 正常生成、无内存脏记录', async () => {
      // brokenOrgAgentStore：org-agents.json 被目录占据 → persist rename 必失败 →
      // seed 逐条收集 errors（路由 L335-339 只 warn）；OrgAgentStore.create 失败时
      // 回滚内存记录，故 listByTenant 应为空。
      h = await makeTestRig({ brokenOrgAgentStore: true });
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants', jsonInit('POST', { id: 'ruiying', name: '瑞鹰卫浴' }));
      expect(res.status).toBe(201);
      expect(h.tenantStore.findById('ruiying')).toBeTruthy();
      // company.md 主路径不受 seed 失败影响
      const md = readFileSync(join(h.sharedDir, 'tenants', 'ruiying', 'company.md'), 'utf-8');
      expect(md).toContain('# 组织名称：瑞鹰卫浴');
      // seed 全部失败且已回滚——不留「内存有、磁盘无」的分叉记录
      expect(h.orgAgentStore.listByTenant('ruiying')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // company-info 500 分支（主路径与 400/404 在 companyInfoRouter/governance 已覆盖）
  // -------------------------------------------------------------------------
  describe('company-info 异常路径', () => {
    it('company.md 路径被目录占据 → GET/PUT 均 500（非 ENOENT 错误不吞）', async () => {
      h = await makeTestRig();
      // 目录占据 company.md 的位置：readFile → EISDIR（≠ENOENT，readTenantCompanyInfo 上抛）
      mkdirSync(join(h.sharedDir, 'tenants', 'wain', 'company.md'), { recursive: true });
      h.setCaller(PLATFORM_ADMIN);

      const get = await h.request('/api/tenants/wain/company-info');
      expect(get.status).toBe(500);
      const getBody = await get.json() as { error: string };
      expect(typeof getBody.error).toBe('string');
      expect(getBody.error.length).toBeGreaterThan(0);

      const put = await h.request('/api/tenants/wain/company-info', jsonInit('PUT', { content: '新内容' }));
      expect(put.status).toBe(500);
      // 目录占位仍在，未被 PUT 破坏成文件
      expect(existsSync(join(h.sharedDir, 'tenants', 'wain', 'company.md'))).toBe(true);
    });
  });
});
