import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JwtPayload } from '../auth/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { createTenantsRouter } from '../routes/tenants.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const PLATFORM_ADMIN: JwtPayload = { sub: 'u-platform', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
const WAIN_ADMIN: JwtPayload = { sub: 'u-wa', username: 'wain_admin', role: 'admin', tenantId: 'wain' };
const WAIN_USER: JwtPayload = { sub: 'u-wu', username: 'wain_user', role: 'user', tenantId: 'wain' };

interface TestRig {
  sharedDir: string;
  setCaller(caller: JwtPayload): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

async function makeTestRig(): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tenant-company-info-'));
  const sharedDir = join(tmpRoot, 'shared');
  const tenantStore = new TenantStore(join(tmpRoot, 'tenants.json'));
  await tenantStore.create({ id: 'kaiyan', name: '开沿科技', createdBy: 'system' });
  await tenantStore.create({ id: 'wain', name: '唯恩电气', createdBy: 'system' });

  const app = express();
  app.use(express.json());
  let currentCaller: JwtPayload = PLATFORM_ADMIN;
  app.use((req, _res, next) => { req.user = currentCaller; next(); });
  app.use('/api/tenants', createTenantsRouter({ tenantStore, sharedDir }));

  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    sharedDir,
    setCaller(c) { currentCaller = c; },
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('tenant-scoped company-info routes', () => {
  let h: TestRig;
  beforeEach(async () => { h = await makeTestRig(); });
  afterEach(async () => { await h.close(); });

  it('组织 admin 可写入并读取自己组织的 company.md', async () => {
    h.setCaller(WAIN_ADMIN);
    const put = await h.request('/api/tenants/wain/company-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Wain\n组织信息' }),
    });
    expect(put.status).toBe(200);

    const get = await h.request('/api/tenants/wain/company-info');
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ tenantId: 'wain', content: '# Wain\n组织信息' });
    expect(readFileSync(join(h.sharedDir, 'tenants', 'wain', 'company.md'), 'utf-8')).toBe('# Wain\n组织信息');
  });

  it('组织 admin 跨组织读写被拒绝', async () => {
    h.setCaller(WAIN_ADMIN);
    const get = await h.request('/api/tenants/kaiyan/company-info');
    expect(get.status).toBe(403);

    const put = await h.request('/api/tenants/kaiyan/company-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hijack' }),
    });
    expect(put.status).toBe(403);
  });

  it('平台 admin 可管理任意组织，且不同组织 company.md 相互隔离', async () => {
    h.setCaller(PLATFORM_ADMIN);
    await h.request('/api/tenants/kaiyan/company-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'kaiyan info' }),
    });
    await h.request('/api/tenants/wain/company-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'wain info' }),
    });

    const kaiyan = await (await h.request('/api/tenants/kaiyan/company-info')).json() as { content: string };
    const wain = await (await h.request('/api/tenants/wain/company-info')).json() as { content: string };
    expect(kaiyan.content).toBe('kaiyan info');
    expect(wain.content).toBe('wain info');
  });

  it('旧全局接口废弃：不会读取 sharedDir/company.md', async () => {
    mkdirSync(h.sharedDir, { recursive: true });
    writeFileSync(join(h.sharedDir, 'company.md'), 'legacy global info');

    h.setCaller(WAIN_ADMIN);
    const tenantScoped = await h.request('/api/tenants/wain/company-info');
    expect(tenantScoped.status).toBe(200);
    await expect(tenantScoped.json()).resolves.toMatchObject({ tenantId: 'wain', content: '' });

    const old = await h.request('/api/tenants/company-info');
    expect(old.status).toBe(403);
  });

  it('普通用户不能访问 company-info 管理接口', async () => {
    h.setCaller(WAIN_USER);
    const res = await h.request('/api/tenants/wain/company-info');
    expect(res.status).toBe(403);
  });

  it('POST /api/tenants 创建组织时自动生成最小 company.md（组织名 + 引导 agent 提示补充）', async () => {
    h.setCaller(PLATFORM_ADMIN);
    const post = await h.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ruiying', name: '瑞鹰卫浴' }),
    });
    expect(post.status).toBe(201);

    const content = readFileSync(join(h.sharedDir, 'tenants', 'ruiying', 'company.md'), 'utf-8');
    expect(content).toContain('# 组织名称：瑞鹰卫浴');
    expect(content).toContain('尚未配置');
    expect(content).toContain('不要编造');
  });

  it('自动生成的 company.md 不覆盖管理员后续写入', async () => {
    h.setCaller(PLATFORM_ADMIN);
    await h.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ruiying', name: '瑞鹰卫浴' }),
    });
    await h.request('/api/tenants/ruiying/company-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# 瑞鹰卫浴\n正式版公司介绍' }),
    });
    const get = await (await h.request('/api/tenants/ruiying/company-info')).json() as { content: string };
    expect(get.content).toBe('# 瑞鹰卫浴\n正式版公司介绍');
  });
});
