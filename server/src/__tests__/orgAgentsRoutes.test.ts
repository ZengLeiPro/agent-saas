/**
 * /api/org-agents 路由权限测试（公司级专职 Agent；2026-07 唯恩批次）
 *
 * 覆盖（计划测试 2-4）：
 *   - 组织 admin 创建时 body.tenantId 强制覆写为自身租户（防伪造）
 *   - 组织 admin 跨租户读/改 403；普通用户未被指派 GET /:id 404（防枚举）
 *   - 普通用户 list 只见裁剪字段（无 instructions/guardrail/audience 泄漏）
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOrgAgentsRouter } from '../routes/orgAgents.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };
const KAIYAN_ADMIN: JwtPayload = { sub: 'u-ka', username: 'kaiyan_admin', role: 'admin', tenantId: 'kaiyan' };

interface TestRig {
  store: OrgAgentStore;
  setCaller(caller: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'org-agents-routes-'));
  const store = new OrgAgentStore(join(tmpRoot, 'org-agents.json'));
  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/org-agents', createOrgAgentsRouter({ orgAgentStore: store }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    store,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function postBody(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '产品选型助手',
      description: '帮助成员完成产品选型与参数查询。',
      starterPrompts: ['帮我推荐一个型号'],
      instructions: '只回答唯恩产品选型问题',
      allowedSkills: ['wain-kb'],
      audience: { exposure: 'all', usernames: [] },
      guardrail: {
        enabled: true,
        scopeDescription: '唯恩产品选型',
        rejectionMessage: '超出职责范围。',
        strictness: 'strict',
      },
      enabled: true,
      ...overrides,
    }),
  };
}

describe('org-agents 路由权限', () => {
  let h: TestRig;

  beforeEach(async () => { h = await makeTestRig(); });
  afterEach(async () => { await h.close(); });

  it('组织 admin 创建时 body.tenantId 被强制覆写为自身租户（伪造无效）', async () => {
    h.setCaller(WAIN_ADMIN);
    const res = await h.request('/api/org-agents', postBody({ tenantId: 'kaiyan' }));
    expect(res.status).toBe(201);
    const record = await res.json() as OrgAgentRecord;
    expect(record.tenantId).toBe('wain');
    expect(record.createdBy).toBe('wain_admin');
    // 平台 admin 可显式指定 tenantId
    h.setCaller(PLATFORM_ADMIN);
    const res2 = await h.request('/api/org-agents', postBody({ tenantId: 'kaiyan', name: '跨租户配置' }));
    expect(res2.status).toBe(201);
    expect((await res2.json() as OrgAgentRecord).tenantId).toBe('kaiyan');
  });

  it('组织 admin 跨租户读/改/删 403；普通用户未被指派 GET /:id 一律 404 防枚举', async () => {
    h.setCaller(WAIN_ADMIN);
    const created = await (await h.request('/api/org-agents', postBody({
      audience: { exposure: 'allow_users', usernames: ['someone_else'] },
    }))).json() as OrgAgentRecord;

    // 跨租户 admin：读 / 改 / 删 全部 403
    h.setCaller(KAIYAN_ADMIN);
    expect((await h.request(`/api/org-agents/${created.id}`)).status).toBe(403);
    expect((await h.request(`/api/org-agents/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hijacked' }),
    })).status).toBe(403);
    expect((await h.request(`/api/org-agents/${created.id}`, { method: 'DELETE' })).status).toBe(403);

    // 本租户普通用户但未被指派：404（与「不存在」不可区分，防枚举）
    h.setCaller(WAIN_USER);
    expect((await h.request(`/api/org-agents/${created.id}`)).status).toBe(404);
    // 完全不存在的 id 同样 404
    expect((await h.request('/api/org-agents/oa-not-exist')).status).toBe(404);

    // 本租户 admin 不受 audience 限制，读到全字段
    h.setCaller(WAIN_ADMIN);
    const adminRes = await h.request(`/api/org-agents/${created.id}`);
    expect(adminRes.status).toBe(200);
    expect((await adminRes.json() as OrgAgentRecord).instructions).toBe('只回答唯恩产品选型问题');
  });

  it('普通用户 list 只见裁剪字段，不泄漏 instructions/guardrail/audience', async () => {
    h.setCaller(WAIN_ADMIN);
    const created = await (await h.request('/api/org-agents', postBody())).json() as OrgAgentRecord;
    // 未被指派 / 停用的不出现在普通用户列表
    await h.request('/api/org-agents', postBody({
      name: '别人的助手',
      audience: { exposure: 'allow_users', usernames: ['someone_else'] },
    }));
    await h.request('/api/org-agents', postBody({ name: '停用的助手', enabled: false }));

    h.setCaller(WAIN_USER);
    for (const path of ['/api/org-agents', '/api/org-agents/mine']) {
      const res = await h.request(path);
      expect(res.status).toBe(200);
      const list = await res.json() as Array<Record<string, unknown>>;
      expect(list).toHaveLength(1);
      expect(Object.keys(list[0]).sort()).toEqual(['description', 'id', 'name', 'skillCount', 'starterPrompts']);
      expect(list[0].id).toBe(created.id);
      expect(list[0].description).toBe('帮助成员完成产品选型与参数查询。');
      expect(list[0].starterPrompts).toEqual(['帮我推荐一个型号']);
      expect(list[0].skillCount).toBe(1);
    }
    // 被指派用户 GET /:id 也只拿到裁剪视图
    const detail = await (await h.request(`/api/org-agents/${created.id}`)).json() as Record<string, unknown>;
    expect(detail.instructions).toBeUndefined();
    expect(detail.guardrail).toBeUndefined();
    expect(detail.audience).toBeUndefined();
  });

  it('公开资料边界：trim 输入、拒绝空白/超长/重复，并允许 PATCH 清空示例问题', async () => {
    h.setCaller(WAIN_ADMIN);
    const createdRes = await h.request('/api/org-agents', postBody({
      name: '  产品选型助手  ',
      description: '  公开说明  ',
      starterPrompts: ['  问题一  ', '问题二'],
    }));
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json() as OrgAgentRecord;
    expect(created.name).toBe('产品选型助手');
    expect(created.description).toBe('公开说明');
    expect(created.starterPrompts).toEqual(['问题一', '问题二']);

    for (const starterPrompts of [
      ['   '],
      Array.from({ length: 7 }, (_, index) => `问题${index}`),
      ['x'.repeat(201)],
      ['重复', '重复'],
    ]) {
      const res = await h.request('/api/org-agents', postBody({ starterPrompts }));
      expect(res.status).toBe(400);
    }

    const clearRes = await h.request(`/api/org-agents/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starterPrompts: [] }),
    });
    expect(clearRes.status).toBe(200);
    expect((await clearRes.json() as OrgAgentRecord).starterPrompts).toEqual([]);
  });
});
