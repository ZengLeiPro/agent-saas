/**
 * 连接器映射词典：CRUD API + 热更新 + 内置回落。
 *
 * 本文件守的核心不变量是**「保存了就生效」**：词典改完必须直接影响下一次
 * 工具调用产出的摘要。少了这条断言，API 与运行时会各自「通过」，
 * 合起来仍然是断的（与 presentation 通道当年的失败模式一模一样）。
 */
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectorDictionaryAdminRouter } from '../routes/connectorDictionaryAdmin.js';
import {
  InMemoryConnectorDictionaryStore,
  normalizeConnectorEntry,
} from '../data/connectorDictionaryStore.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import {
  buildToolPresentation,
  getConnectorDictionary,
  setConnectorDictionary,
} from '../agent/toolPresentationBuilder.js';
import { BUILTIN_CONNECTOR_DICTIONARY } from '../agent/connectorDictionary.js';

const servers: Array<{ close: () => void }> = [];

async function withApp<T>(
  fn: (args: { baseUrl: string; store: InMemoryConnectorDictionaryStore }) => Promise<T>,
): Promise<T> {
  const store = new InMemoryConnectorDictionaryStore();
  await store.init();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID,
    };
    next();
  });
  // 真的接 setConnectorDictionary：热更新是本批次的验收点，mock 掉等于没测
  app.use('/api/admin/connector-dictionary', createConnectorDictionaryAdminRouter({ store }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({ baseUrl: `http://127.0.0.1:${address.port}`, store });
}

const API = '/api/admin/connector-dictionary';

beforeEach(() => {
  setConnectorDictionary(null);
});

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  setConnectorDictionary(null);
});

describe('连接器词典 CRUD API', () => {
  it('GET 返回平台级词典与内置种子', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${API}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { entries: Array<{ binary: string }>; builtin: unknown[] };
      expect(body.entries.map((entry) => entry.binary)).toEqual(['dws', 'feishu', 'gog', 'lark']);
      expect(body.builtin).toHaveLength(BUILTIN_CONNECTOR_DICTIONARY.length);
    });
  });

  it('PUT 保存后立刻热更新：下一次摘要就按新词典产出', async () => {
    await withApp(async ({ baseUrl }) => {
      expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title).toBe('钉钉 · 创建待办');

      const response = await fetch(`${baseUrl}${API}/dws`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemName: '钉钉（企业版）',
          enabled: true,
          modules: { todo: '任务中心' },
          actionVerbs: { create: { name: '新建', write: true } },
          excludePatterns: ['--help'],
          urlWhitelist: ['alidocs.dingtalk.com'],
        }),
      });
      expect(response.status).toBe(200);

      expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title)
        .toBe('钉钉（企业版） · 新建任务中心');
    });
  });

  it('停用某个连接器后，工具行退回「执行命令」，不再产出业务标题', async () => {
    await withApp(async ({ baseUrl }) => {
      await fetch(`${baseUrl}${API}/dws`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemName: '钉钉', enabled: false, modules: {}, actionVerbs: {} }),
      });
      expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title).toBe('执行命令');
    });
  });

  it('PUT 未知 binary 即新增连接器——CLI 上新的不必发版', async () => {
    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}${API}/wecom`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemName: '企业微信',
          enabled: true,
          modules: { approval: '审批' },
          actionVerbs: { submit: { name: '提交', write: true } },
          excludePatterns: [],
          urlWhitelist: [],
        }),
      });
      expect(response.status).toBe(200);
      expect(buildToolPresentation('Shell', { command: 'cd /w && wecom approval submit --id 1' })?.title)
        .toBe('企业微信 · 提交审批');
    });
  });

  it('DELETE 移除条目并热更新；不存在时 404', async () => {
    await withApp(async ({ baseUrl }) => {
      expect((await fetch(`${baseUrl}${API}/dws`, { method: 'DELETE' })).status).toBe(200);
      expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title).toBe('执行命令');
      expect((await fetch(`${baseUrl}${API}/nope`, { method: 'DELETE' })).status).toBe(404);
    });
  });

  it('reset 恢复内置词典并热更新', async () => {
    await withApp(async ({ baseUrl }) => {
      await fetch(`${baseUrl}${API}/dws`, { method: 'DELETE' });
      const response = await fetch(`${baseUrl}${API}/reset`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title).toBe('钉钉 · 创建待办');
    });
  });

  it('非法入参一律 400，不落库、不热更', async () => {
    await withApp(async ({ baseUrl }) => {
      const cases = [
        { systemName: '', enabled: true },
        { systemName: '钉钉', actionVerbs: { create: { name: '创建' } } },
        { systemName: '钉钉', urlWhitelist: ['*'] },
        { systemName: '钉钉', urlWhitelist: ['*.'] },
        { systemName: '钉钉', modules: [] },
      ];
      for (const body of cases) {
        const response = await fetch(`${baseUrl}${API}/dws`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      // 依然是内置行为，没有被半截数据污染
      expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title).toBe('钉钉 · 创建待办');
    });
  });
});

describe('入参归一化（防造假事实，不只是防手滑）', () => {
  it('actionVerbs.write 必须显式给——缺省会让读操作盖上回执章', () => {
    expect(() => normalizeConnectorEntry({
      binary: 'dws', systemName: '钉钉', actionVerbs: { list: { name: '查询' } },
    })).toThrow(/write/);
  });

  it('urlWhitelist 拒绝全通配——`*` 等于没有白名单', () => {
    expect(() => normalizeConnectorEntry({ binary: 'dws', systemName: '钉钉', urlWhitelist: ['*'] })).toThrow();
    expect(() => normalizeConnectorEntry({ binary: 'dws', systemName: '钉钉', urlWhitelist: ['*.evil*.com'] })).toThrow();
    expect(normalizeConnectorEntry({ binary: 'dws', systemName: '钉钉', urlWhitelist: ['*.feishu.cn'] }).urlWhitelist)
      .toEqual(['*.feishu.cn']);
  });

  it('binary 形状收死：路径分隔符与空白一律拒绝', () => {
    expect(() => normalizeConnectorEntry({ binary: '../../bin/sh', systemName: 'x' })).toThrow();
    expect(() => normalizeConnectorEntry({ binary: 'dws todo', systemName: 'x' })).toThrow();
  });
});

describe('内置词典回落', () => {
  it('未配置任何词典时用内置种子——配置表读不出来不该让摘要整体失灵', () => {
    setConnectorDictionary(null);
    expect(getConnectorDictionary()).toEqual(BUILTIN_CONNECTOR_DICTIONARY);
    expect(buildToolPresentation('Shell', { command: 'dws todo create' })?.title).toBe('钉钉 · 创建待办');
  });

  it('传入空数组同样回落内置——空表不等于「关掉所有连接器」', () => {
    setConnectorDictionary([]);
    expect(getConnectorDictionary()).toEqual(BUILTIN_CONNECTOR_DICTIONARY);
  });
});

describe('内存实现与 PG 实现同形态', () => {
  it('init 播种内置词典，upsert / remove / reset 行为一致', async () => {
    const store = new InMemoryConnectorDictionaryStore();
    await store.init();
    expect((await store.listPlatform()).map((entry) => entry.binary)).toEqual(['dws', 'feishu', 'gog', 'lark']);

    await store.upsert(normalizeConnectorEntry({ binary: 'dws', systemName: '改过的钉钉' }), 'tester');
    expect((await store.listPlatform()).find((entry) => entry.binary === 'dws')?.systemName).toBe('改过的钉钉');

    expect(await store.remove('dws', 'tester')).toBe(true);
    expect(await store.remove('dws', 'tester')).toBe(false);

    const reset = await store.resetToBuiltin('tester');
    expect(reset.find((entry) => entry.binary === 'dws')?.systemName).toBe('钉钉');
  });

  it('init 不覆盖已改过的条目——配置优先于代码', async () => {
    const store = new InMemoryConnectorDictionaryStore();
    await store.init();
    await store.upsert(normalizeConnectorEntry({ binary: 'dws', systemName: '改过的钉钉' }), 'tester');
    await store.init();
    expect((await store.listPlatform()).find((entry) => entry.binary === 'dws')?.systemName).toBe('改过的钉钉');
  });
});
