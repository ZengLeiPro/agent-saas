/**
 * /api/tenants 路由治理与越权防线测试（routes/tenants.ts）
 *
 * 与现有测试的分工：
 * - tenantsCompanyInfoRouter.test.ts：company-info 读写主路径（组织 admin 自读写、
 *   平台 admin 任意组织、隔离、POST 后自动生成 company.md 的内容断言）。
 *   本文件只补其未覆盖的缺口：404（组织不存在）、400（非法 body/超长）、
 *   以及跨租户 PUT 403 时「未落盘」的双条件断言。
 * - tenantStore.test.ts：store 层单元（不经 HTTP）。
 * - authTenantIsolation.test.ts：auth.ts 用户路由的跨租户格局。本文件沿用其
 *   三租户格局（DEFAULT_TENANT_ID + wain + acme），构造真正的
 *   「A 租户组织 admin 攻击 B 租户 / 攻击平台专属字段」场景打 tenants.ts：
 *   - PATCH /:id/settings 组织 admin 翻转 imageGenEnabled /
 *     allowContextTokenDetails → 403 且不落库（双条件断言）
 *   - 组织 admin PATCH 时 features/models 与现值 merge、平台专属字段强制保留
 *   - GET /:id、GET/PATCH /:id/settings 的 403/404/400 权限矩阵
 *   - POST 创建（201 + company.md + 专家模板 seed / 409 重复 / 400 非法 slug）
 *   - PATCH /:id name、PATCH /:id/status（disable 触发 onTenantDisabled 回调）
 *
 * 模式对齐现有 rig：真 express + listen(0) + 真 fetch，中间件注入 req.user，
 * setCaller 切换调用方身份，mkdtempSync 临时目录承载 store 文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { MAX_COMPANY_INFO_CHARS } from '../data/tenants/companyInfo.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import { createTenantsRouter } from '../routes/tenants.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'platform_admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
/** A 租户组织 admin（非平台 admin）——本文件所有越权攻击的发起方 */
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** tenantSettingsSchema 中 features 的 5 个必填布尔（组织/平台 PATCH 都必须带全） */
const BASE_FEATURES = {
  filesEnabled: true,
  cronEnabled: true,
  mcpEnabled: true,
  customSkillsEnabled: true,
  debugModeAllowed: false,
};

interface TestRig {
  sharedDir: string;
  tenantStore: TenantStore;
  orgAgentStore: OrgAgentStore;
  disabledCalls: string[];
  setCaller(caller: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tenants-governance-'));
  const sharedDir = join(tmpRoot, 'shared');
  const tenantStore = new TenantStore(join(tmpRoot, 'tenants.json'));
  await tenantStore.create({ id: DEFAULT_TENANT_ID, name: '万神殿', createdBy: 'system' });
  await tenantStore.create({ id: 'wain', name: '唯恩电气', createdBy: 'system' });
  // 第三个租户：跨租户攻击的受害方（区别于攻击方自己的 wain）
  await tenantStore.create({ id: 'acme', name: '阿康', createdBy: 'system' });

  const orgAgentStore = new OrgAgentStore(join(tmpRoot, 'org-agents.json'));
  const disabledCalls: string[] = [];

  const app = express();
  // 1mb：默认 100kb 会让「company.md 超 MAX_COMPANY_INFO_CHARS」用例在 body parser
  // 层 413，永远打不到路由自己的 zod max 校验（生产 index.ts 也是默认 100kb，
  // 该 zod 上限经此路由实际不可达——见测试报告）。这里放大 limit 以单测路由本身。
  app.use(express.json({ limit: '1mb' }));
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/tenants', createTenantsRouter({
    tenantStore,
    sharedDir,
    orgAgentStore,
    onTenantDisabled: id => { disabledCalls.push(id); },
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
    disabledCalls,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function patchSettings(h: TestRig, tenantId: string, settings: unknown): Promise<Response> {
  return h.request(`/api/tenants/${tenantId}/settings`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(settings),
  });
}

describe('tenants 路由治理（settings 越权守卫 + CRUD 权限矩阵）', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeTestRig(); });
  afterEach(async () => { await h.close(); });

  // -------------------------------------------------------------------------
  // 组织 admin PATCH settings：平台专属字段越权守卫（403 + 不落库 双条件）
  // -------------------------------------------------------------------------
  describe('组织 admin PATCH /:id/settings 平台专属字段守卫', () => {
    it('翻转 features.imageGenEnabled（false→true）→ 403 且未落库', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, imageGenEnabled: true },
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: 'AI 生图能力仅平台管理员可配置' });
      // 双条件：再读一次确认未落库
      expect(h.tenantStore.getSettings('wain')!.features.imageGenEnabled).toBe(false);
      const get = await (await h.request('/api/tenants/wain/settings')).json() as {
        settings: { features: { imageGenEnabled?: boolean } };
      };
      expect(get.settings.features.imageGenEnabled).toBe(false);
    });

    it('平台已开 imageGenEnabled 后，组织 admin 试图关闭（true→false）→ 403 且仍为 true', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const setup = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, imageGenEnabled: true },
      });
      expect(setup.status).toBe(200);

      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, imageGenEnabled: false },
      });
      expect(res.status).toBe(403);
      expect(h.tenantStore.getSettings('wain')!.features.imageGenEnabled).toBe(true);
    });

    it('翻转 models.allowContextTokenDetails（false→true）→ 403 且未落库', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', {
        models: { allowUserModelSwitch: true, allowContextTokenDetails: true },
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: '上下文 Token 明细仅平台管理员可配置' });
      expect(h.tenantStore.getSettings('wain')!.models.allowContextTokenDetails).toBe(false);
    });

    it('组织 admin 提交与现值相同的平台专属字段 → 放行（非翻转不算越权）', async () => {
      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, debugModeAllowed: true, imageGenEnabled: false },
        models: { allowUserModelSwitch: true, allowContextTokenDetails: false },
      });
      expect(res.status).toBe(200);
      const after = h.tenantStore.getSettings('wain')!;
      expect(after.features.debugModeAllowed).toBe(true);
      expect(after.features.imageGenEnabled).toBe(false);
    });

    it('features merge：不带 imageGenEnabled/autoCompactEnabled 时保留现值（平台开的能力不被组织 admin 无意关掉）', async () => {
      // 平台 admin 先给 wain 开 imageGen + autoCompact
      h.setCaller(PLATFORM_ADMIN);
      await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, autoCompactEnabled: true, imageGenEnabled: true },
      });

      // 组织 admin 只改 filesEnabled，不带可选字段
      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, filesEnabled: false },
      });
      expect(res.status).toBe(200);
      const after = h.tenantStore.getSettings('wain')!;
      expect(after.features.filesEnabled).toBe(false); // 本次修改生效
      expect(after.features.imageGenEnabled).toBe(true); // 平台专属：强制保留
      expect(after.features.autoCompactEnabled).toBe(true); // 可选字段：与现值 merge 保留
    });

    it('models merge：组织 admin 只改 allowUserModelSwitch 时保留 defaultModel/allowedModels/allowContextTokenDetails', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await patchSettings(h, 'wain', {
        models: {
          defaultModel: 'model-a',
          allowedModels: ['model-a', 'model-b'],
          allowUserModelSwitch: true,
          allowContextTokenDetails: true,
        },
      });

      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', {
        models: { allowUserModelSwitch: false },
      });
      expect(res.status).toBe(200);
      const after = h.tenantStore.getSettings('wain')!;
      expect(after.models.allowUserModelSwitch).toBe(false); // 本次修改生效
      expect(after.models.defaultModel).toBe('model-a'); // 与现值 merge 保留
      expect(after.models.allowedModels).toEqual(['model-a', 'model-b']);
      expect(after.models.allowContextTokenDetails).toBe(true); // 平台专属：强制保留
    });

    it('平台 admin 可翻转两个平台专属字段（对照放行线），支持 {settings:{...}} 包裹形式', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await patchSettings(h, 'wain', {
        settings: {
          features: { ...BASE_FEATURES, imageGenEnabled: true },
          models: { allowUserModelSwitch: true, allowContextTokenDetails: true },
        },
      });
      expect(res.status).toBe(200);
      const after = h.tenantStore.getSettings('wain')!;
      expect(after.features.imageGenEnabled).toBe(true);
      expect(after.models.allowContextTokenDetails).toBe(true);
    });

    it('组织 admin 改 quotas.monthlyTokenLimit → 403 且未落库（不得自助提额，2026-07-19 治理修复）', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await patchSettings(h, 'wain', { quotas: { monthlyTokenLimit: 1_000_000 } });

      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', { quotas: { monthlyTokenLimit: 9_999_999 } });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: '组织配额仅平台管理员可配置' });
      expect(h.tenantStore.getSettings('wain')!.quotas.monthlyTokenLimit).toBe(1_000_000);
    });

    it('组织 admin 提交与现值相同的 quotas → 放行且配额保持', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await patchSettings(h, 'wain', { quotas: { maxUsers: 50 } });

      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES },
        quotas: { maxUsers: 50 },
      });
      expect(res.status).toBe(200);
      expect(h.tenantStore.getSettings('wain')!.quotas.maxUsers).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // settings merge 基底回归（2026-07-19 修复）：patch 缺省的 section 保留租户现值，
  // 而非被静默重置为平台默认（修复前 updateSettings 以 DEFAULT_TENANT_SETTINGS 为基底，
  // 一次普通 PATCH 即可清掉平台设置的 monthlyTokenLimit/maxUsers 等配额）
  // -------------------------------------------------------------------------
  describe('settings merge 基底：缺省 section 保留现值', () => {
    it('平台 admin 设 quotas 后，仅 PATCH features 不清掉配额', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await patchSettings(h, 'wain', { quotas: { monthlyTokenLimit: 5_000_000, maxUsers: 30 } });

      const res = await patchSettings(h, 'wain', { features: { ...BASE_FEATURES } });
      expect(res.status).toBe(200);
      const after = h.tenantStore.getSettings('wain')!;
      expect(after.quotas.monthlyTokenLimit).toBe(5_000_000);
      expect(after.quotas.maxUsers).toBe(30);
    });

    it('组织 admin 仅 PATCH features 时，平台设的 quotas/branding 保留现值', async () => {
      h.setCaller(PLATFORM_ADMIN);
      await patchSettings(h, 'wain', {
        quotas: { monthlyTokenLimit: 5_000_000 },
        branding: { displayName: '唯恩电气股份' },
      });

      h.setCaller(WAIN_ADMIN);
      const res = await patchSettings(h, 'wain', { features: { ...BASE_FEATURES, filesEnabled: false } });
      expect(res.status).toBe(200);
      const after = h.tenantStore.getSettings('wain')!;
      expect(after.features.filesEnabled).toBe(false);
      expect(after.quotas.monthlyTokenLimit).toBe(5_000_000); // 修复前被重置为默认
      expect(after.branding.displayName).toBe('唯恩电气股份'); // 修复前被重置为默认
    });
  });

  // -------------------------------------------------------------------------
  // 跨租户隔离：wain 组织 admin → acme
  // -------------------------------------------------------------------------
  describe('跨租户隔离（wain admin → acme）', () => {
    it('GET/PATCH 他租户 settings → 403 且未落库', async () => {
      h.setCaller(WAIN_ADMIN);
      const get = await h.request('/api/tenants/acme/settings');
      expect(get.status).toBe(403);
      await expect(get.json()).resolves.toMatchObject({ error: '跨组织访问被拒绝' });

      const patch = await patchSettings(h, 'acme', {
        features: { ...BASE_FEATURES, filesEnabled: false },
      });
      expect(patch.status).toBe(403);
      // 双条件：acme settings 未被写入
      expect(h.tenantStore.getSettings('acme')!.features.filesEnabled).toBe(true);
    });

    it('PUT 他租户 company-info → 403 且未落盘', async () => {
      h.setCaller(WAIN_ADMIN);
      const put = await h.request('/api/tenants/acme/company-info', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 'hijacked' }),
      });
      expect(put.status).toBe(403);
      // 双条件：磁盘上没有生成 acme 的 company.md
      expect(existsSync(join(h.sharedDir, 'tenants', 'acme', 'company.md'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 权限矩阵：requireAdmin / requirePlatformAdmin 边界
  // -------------------------------------------------------------------------
  describe('权限矩阵', () => {
    it('普通用户访问本组织 settings（GET/PATCH）→ 403', async () => {
      h.setCaller(WAIN_USER);
      expect((await h.request('/api/tenants/wain/settings')).status).toBe(403);
      const patch = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, debugModeAllowed: true },
      });
      expect(patch.status).toBe(403);
      expect(h.tenantStore.getSettings('wain')!.features.debugModeAllowed).toBe(false);
    });

    it('组织 admin 访问平台专属接口（列表/GET :id/POST/改名/status）→ 403 且无副作用', async () => {
      h.setCaller(WAIN_ADMIN);
      expect((await h.request('/api/tenants')).status).toBe(403);
      expect((await h.request('/api/tenants/wain')).status).toBe(403);

      const post = await h.request('/api/tenants', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'evil', name: '偷建组织' }),
      });
      expect(post.status).toBe(403);
      expect(h.tenantStore.findById('evil')).toBeUndefined();

      const rename = await h.request('/api/tenants/wain', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: '改名攻击' }),
      });
      expect(rename.status).toBe(403);
      expect(h.tenantStore.findById('wain')!.name).toBe('唯恩电气');

      const status = await h.request('/api/tenants/acme/status', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled: true }),
      });
      expect(status.status).toBe(403);
      expect(h.tenantStore.findById('acme')!.disabled).toBeFalsy();
      expect(h.disabledCalls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // GET /:id 与 settings/company-info 的 404/400
  // -------------------------------------------------------------------------
  describe('GET /:id 与 404/400 边界（平台 admin）', () => {
    it('GET /:id → 200 返回组织记录；不存在 → 404', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const ok = await h.request('/api/tenants/wain');
      expect(ok.status).toBe(200);
      const body = await ok.json() as { id: string; name: string; settings?: unknown };
      expect(body.id).toBe('wain');
      expect(body.name).toBe('唯恩电气');
      expect(body.settings).toBeTruthy();

      expect((await h.request('/api/tenants/ghost')).status).toBe(404);
    });

    it('settings：GET 不存在组织 → 404；PATCH 不存在组织 → 404；非法 body → 400', async () => {
      h.setCaller(PLATFORM_ADMIN);
      expect((await h.request('/api/tenants/ghost/settings')).status).toBe(404);

      const patch404 = await patchSettings(h, 'ghost', {
        features: { ...BASE_FEATURES },
      });
      expect(patch404.status).toBe(404);
      await expect(patch404.json()).resolves.toMatchObject({ error: '组织不存在' });

      const bad = await patchSettings(h, 'wain', {
        features: { ...BASE_FEATURES, filesEnabled: 'yes' },
      });
      expect(bad.status).toBe(400);
    });

    it('company-info：不存在组织 GET/PUT → 404；非法/超长 content → 400 且不落盘', async () => {
      h.setCaller(PLATFORM_ADMIN);
      expect((await h.request('/api/tenants/ghost/company-info')).status).toBe(404);
      const put404 = await h.request('/api/tenants/ghost/company-info', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 'x' }),
      });
      expect(put404.status).toBe(404);

      const badType = await h.request('/api/tenants/wain/company-info', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 123 }),
      });
      expect(badType.status).toBe(400);

      const tooLong = await h.request('/api/tenants/wain/company-info', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: 'a'.repeat(MAX_COMPANY_INFO_CHARS + 1) }),
      });
      expect(tooLong.status).toBe(400);
      expect(existsSync(join(h.sharedDir, 'tenants', 'wain', 'company.md'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/tenants 创建
  // -------------------------------------------------------------------------
  describe('POST 创建组织', () => {
    it('成功：201 + 生成含组织名的 company.md + seed 企业专家模板', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'ruiying', name: '瑞鹰卫浴' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; name: string; createdBy: string };
      expect(body.id).toBe('ruiying');
      expect(body.name).toBe('瑞鹰卫浴');
      expect(body.createdBy).toBe(PLATFORM_ADMIN.sub);

      // buildInitialCompanyInfo 落盘：含组织名 + 防编造指令
      const md = readFileSync(join(h.sharedDir, 'tenants', 'ruiying', 'company.md'), 'utf-8');
      expect(md).toContain('# 组织名称：瑞鹰卫浴');
      expect(md).toContain('不要编造');

      // 新租户自动 seed 3 个种子专家模板，且只属于新租户
      const seeded = h.orgAgentStore.listByTenant('ruiying');
      expect(seeded.length).toBe(3);
      expect(seeded.every(r => r.tenantId === 'ruiying')).toBe(true);
      expect(h.orgAgentStore.listByTenant('wain').length).toBe(0);
    });

    it('重复 id → 409，且已有组织未被覆盖', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const res = await h.request('/api/tenants', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: 'wain', name: '冒名顶替' }),
      });
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: 'tenant id 已存在' });
      expect(h.tenantStore.findById('wain')!.name).toBe('唯恩电气');
    });

    it('非法 slug（大写/过短/缺 name）→ 400 且不创建', async () => {
      h.setCaller(PLATFORM_ADMIN);
      for (const payload of [
        { id: 'Upper', name: '大写开头' },
        { id: 'x', name: '过短' },
        { id: 'ok-slug' }, // 缺 name
      ]) {
        const res = await h.request('/api/tenants', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
      }
      expect(h.tenantStore.count()).toBe(3); // 仍只有初始三个租户
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /:id（改名）与 PATCH /:id/status（禁用/启用）
  // -------------------------------------------------------------------------
  describe('PATCH name 与 status', () => {
    it('改名：200 生效；不存在 → 404；空 name → 400；纯空白 name → 400（store 校验线）', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const ok = await h.request('/api/tenants/wain', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: '唯恩电气（新）' }),
      });
      expect(ok.status).toBe(200);
      await expect(ok.json()).resolves.toMatchObject({ id: 'wain', name: '唯恩电气（新）' });
      expect(h.tenantStore.findById('wain')!.name).toBe('唯恩电气（新）');

      const notFound = await h.request('/api/tenants/ghost', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: '不存在' }),
      });
      expect(notFound.status).toBe(404);

      const empty = await h.request('/api/tenants/wain', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: '' }),
      });
      expect(empty.status).toBe(400); // zod min(1)

      const blank = await h.request('/api/tenants/wain', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: '   ' }),
      });
      expect(blank.status).toBe(400); // 过 zod，store trim 后拒绝
      expect(h.tenantStore.findById('wain')!.name).toBe('唯恩电气（新）');
    });

    it('disable=true 触发 onTenantDisabled 回调并记录 disabledBy；re-enable 不再触发', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const disable = await h.request('/api/tenants/wain/status', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled: true }),
      });
      expect(disable.status).toBe(200);
      const disabled = await disable.json() as { id: string; disabled?: boolean; disabledBy?: string };
      expect(disabled.disabled).toBe(true);
      expect(disabled.disabledBy).toBe(PLATFORM_ADMIN.sub);
      expect(h.disabledCalls).toEqual(['wain']); // 回调触发，且只带被禁租户

      const enable = await h.request('/api/tenants/wain/status', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled: false }),
      });
      expect(enable.status).toBe(200);
      expect(h.tenantStore.findById('wain')!.disabled).toBeFalsy();
      expect(h.disabledCalls).toEqual(['wain']); // enable 不再触发回调
    });

    it('status：禁用默认租户 → 409；不存在 → 404；非法 body → 400；均不触发回调', async () => {
      h.setCaller(PLATFORM_ADMIN);
      const root = await h.request(`/api/tenants/${DEFAULT_TENANT_ID}/status`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled: true }),
      });
      expect(root.status).toBe(409);
      expect(h.tenantStore.findById(DEFAULT_TENANT_ID)!.disabled).toBeFalsy();

      const notFound = await h.request('/api/tenants/ghost/status', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled: true }),
      });
      expect(notFound.status).toBe(404);

      const bad = await h.request('/api/tenants/wain/status', {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled: 'yes' }),
      });
      expect(bad.status).toBe(400);
      expect(h.disabledCalls).toEqual([]);
    });
  });
});
