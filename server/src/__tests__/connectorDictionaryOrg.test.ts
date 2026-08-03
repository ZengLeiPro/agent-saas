/**
 * 租户级连接器词典（2026-08-04 任务 E）：组织 API + 运行时租户合并。
 *
 * 守的核心不变量：
 * 1. 「保存了就对该租户生效」——覆盖保存后，带该 tenantId 的摘要产出立刻按
 *    租户词典走；不带 tenantId（其他租户/平台）仍按平台词典。
 * 2. 整条覆盖语义：租户条目完整替换平台条目，不做字段级 merge。
 * 3. 权限边界：组织 admin 只能动自己的租户；平台 admin 可 ?tenantId= 跨组织。
 */
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createConnectorDictionaryOrgRouter } from '../routes/connectorDictionaryOrg.js';
import { InMemoryConnectorDictionaryStore } from '../data/connectorDictionaryStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import {
  buildToolPresentation,
  parseConnectorCommand,
  resolveConnectorDictionary,
  setConnectorDictionary,
  setTenantConnectorDictionaries,
} from '../agent/toolPresentationBuilder.js';

const servers: Array<{ close: () => void }> = [];

interface TestUser {
  sub: string;
  username: string;
  role: string;
  tenantId: string;
}

const ORG_ADMIN: TestUser = { sub: 'zenglei', username: 'zenglei', role: 'admin', tenantId: 'kaiyan' };
const PLATFORM_ADMIN: TestUser = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };

async function withApp<T>(
  user: TestUser,
  fn: (args: { baseUrl: string; store: InMemoryConnectorDictionaryStore }) => Promise<T>,
): Promise<T> {
  const store = new InMemoryConnectorDictionaryStore();
  await store.init();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = user;
    next();
  });
  // 真接 setter：租户热更新是本批验收点，mock 掉等于没测
  app.use('/api/org/connector-dictionary', createConnectorDictionaryOrgRouter({ store }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({ baseUrl: `http://127.0.0.1:${address.port}`, store });
}

const API = '/api/org/connector-dictionary';

const KAIYAN_OVERRIDE = {
  systemName: '钉钉',
  enabled: true,
  modules: { todo: '客户任务' },
  actionVerbs: { create: { name: '登记', write: true } },
  excludePatterns: ['--help'],
  urlWhitelist: [],
};

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  setConnectorDictionary(null);
  setTenantConnectorDictionaries(null);
});

describe('组织连接器词典 API', () => {
  it('GET 返回平台基线与本租户覆盖两层', async () => {
    await withApp(ORG_ADMIN, async ({ baseUrl, store }) => {
      await store.upsertTenant('kaiyan', {
        binary: 'dws', ...KAIYAN_OVERRIDE,
      }, 'zenglei');
      const response = await fetch(`${baseUrl}${API}`);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        tenantId: string;
        platform: Array<{ binary: string }>;
        overrides: Array<{ binary: string; modules: Record<string, string> }>;
      };
      expect(body.tenantId).toBe('kaiyan');
      expect(body.platform.map((entry) => entry.binary)).toContain('dws');
      expect(body.overrides).toHaveLength(1);
      expect(body.overrides[0]?.modules.todo).toBe('客户任务');
    });
  });

  it('PUT 保存覆盖后：该租户摘要立刻按租户词典产出，其他租户与平台不受影响', async () => {
    await withApp(ORG_ADMIN, async ({ baseUrl }) => {
      // 覆盖前：kaiyan 与平台同词典
      expect(buildToolPresentation('Shell', { command: 'dws todo create' }, undefined, undefined, undefined, 'kaiyan')?.title)
        .toBe('钉钉 · 创建待办');

      const response = await fetch(`${baseUrl}${API}/dws`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(KAIYAN_OVERRIDE),
      });
      expect(response.status).toBe(200);

      // kaiyan 走租户覆盖（整条覆盖：动词也换）
      expect(buildToolPresentation('Shell', { command: 'dws todo create' }, undefined, undefined, undefined, 'kaiyan')?.title)
        .toBe('钉钉 · 登记客户任务');
      // 不带 tenantId（平台视角）与其他租户仍按平台词典
      expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title)
        .toBe('钉钉 · 创建待办');
      expect(buildToolPresentation('Shell', { command: 'dws todo create' }, undefined, undefined, undefined, 'wain')?.title)
        .toBe('钉钉 · 创建待办');
    });
  });

  it('整条覆盖语义：覆盖条目缺失的模块不回落平台条目（不做字段级 merge）', async () => {
    await withApp(ORG_ADMIN, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${API}/dws`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(KAIYAN_OVERRIDE), // modules 只有 todo，没有 calendar
      });
      expect(response.status).toBe(200);
      // 平台词典 calendar=日程、create=创建；覆盖条目两者都没带 calendar → 该租户
      // 产不出平台版「钉钉 · 创建日程」标题（覆盖不从平台条目借字段）
      const title = buildToolPresentation(
        'Shell', { command: 'dws calendar event create' }, undefined, undefined, undefined, 'kaiyan',
      )?.title;
      expect(title).not.toBe('钉钉 · 创建日程');
    });
  });

  it('DELETE 移除覆盖：回落平台词典；重复删除 404', async () => {
    await withApp(ORG_ADMIN, async ({ baseUrl }) => {
      await fetch(`${baseUrl}${API}/dws`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(KAIYAN_OVERRIDE),
      });
      expect(resolveConnectorDictionary('kaiyan').find((entry) => entry.binary === 'dws')?.actionVerbs.create?.name)
        .toBe('登记');

      const removed = await fetch(`${baseUrl}${API}/dws`, { method: 'DELETE' });
      expect(removed.status).toBe(200);
      expect(buildToolPresentation('Shell', { command: 'dws todo create' }, undefined, undefined, undefined, 'kaiyan')?.title)
        .toBe('钉钉 · 创建待办');

      const again = await fetch(`${baseUrl}${API}/dws`, { method: 'DELETE' });
      expect(again.status).toBe(404);
    });
  });

  it('组织 admin 带 ?tenantId= 指定其他租户 → 403', async () => {
    await withApp(ORG_ADMIN, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${API}?tenantId=wain`);
      expect(response.status).toBe(403);
    });
  });

  it('平台 admin 可 ?tenantId= 跨组织管理', async () => {
    await withApp(PLATFORM_ADMIN, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${API}?tenantId=kaiyan`, {
        method: 'GET',
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { tenantId: string };
      expect(body.tenantId).toBe('kaiyan');

      const put = await fetch(`${baseUrl}${API}/dws?tenantId=kaiyan`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(KAIYAN_OVERRIDE),
      });
      expect(put.status).toBe(200);
      const putBody = await put.json() as { tenantId: string; overrides: Array<{ binary: string }> };
      expect(putBody.tenantId).toBe('kaiyan');
      expect(putBody.overrides.some((entry) => entry.binary === 'dws')).toBe(true);
    });
  });

  it('非法条目（write 缺省）被 400 拒绝——防造假事实的校验层对租户同样生效', async () => {
    await withApp(ORG_ADMIN, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${API}/dws`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...KAIYAN_OVERRIDE,
          actionVerbs: { create: { name: '登记' } }, // 缺 write
        }),
      });
      expect(response.status).toBe(400);
    });
  });
});

describe('运行时租户合并视图（builder 侧）', () => {
  afterEach(() => {
    setConnectorDictionary(null);
    setTenantConnectorDictionaries(null);
  });

  it('租户新增 binary 追加进合并视图；无覆盖租户走平台词典', () => {
    setTenantConnectorDictionaries({
      kaiyan: [{
        binary: 'customcli',
        systemName: '自装系统',
        enabled: true,
        modules: { job: '工单' },
        actionVerbs: { create: { name: '创建', write: true } },
        excludePatterns: [],
        urlWhitelist: [],
      }],
    });
    expect(parseConnectorCommand('customcli job create', 'kaiyan')?.system).toBe('自装系统');
    expect(parseConnectorCommand('customcli job create', 'kaiyan')?.isWrite).toBe(true);
    // 其他租户与平台看不到该 binary
    expect(parseConnectorCommand('customcli job create', 'wain')).toBeNull();
    expect(parseConnectorCommand('customcli job create')).toBeNull();
  });

  it('平台词典更新后（setConnectorDictionary）合并视图跟随重算', () => {
    setTenantConnectorDictionaries({
      kaiyan: [{
        binary: 'dws',
        systemName: '钉钉K',
        enabled: true,
        modules: { todo: '待办' },
        actionVerbs: { create: { name: '创建', write: true } },
        excludePatterns: [],
        urlWhitelist: [],
      }],
    });
    // 平台词典整体替换后，kaiyan 的 dws 覆盖仍生效、平台其余条目（feishu 等）仍在合并视图
    setConnectorDictionary(null); // 回落内置
    const merged = resolveConnectorDictionary('kaiyan');
    expect(merged.find((entry) => entry.binary === 'dws')?.systemName).toBe('钉钉K');
    expect(merged.some((entry) => entry.binary === 'feishu')).toBe(true);
    expect(parseConnectorCommand('dws todo create', 'kaiyan')?.system).toBe('钉钉K');
  });
});
