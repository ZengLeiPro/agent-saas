import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMySystems } from './systemsApi';

const authFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authFetch', () => ({ authFetch: authFetchMock }));

function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: vi.fn().mockResolvedValue(body),
  };
}

afterEach(() => {
  authFetchMock.mockReset();
});

describe('systemsApi', () => {
  it('正常返回时按最小字段归一化', async () => {
    authFetchMock.mockResolvedValue(
      res(200, {
        installations: [
          {
            installationId: 'iid-1',
            systemId: 'orders',
            name: '订单系统',
            icon: 'box',
            origin: 'https://a.example.com',
            state: 'enabled',
          },
          { installationId: 'iid-2', systemId: 'wms', origin: 'https://b.example.com' },
        ],
      }),
    );
    const result = await fetchMySystems();
    expect(authFetchMock).toHaveBeenCalledWith('/api/systems/mine');
    expect(result.installations).toEqual([
      {
        installationId: 'iid-1',
        systemId: 'orders',
        name: '订单系统',
        icon: 'box',
        origin: 'https://a.example.com',
        state: 'enabled',
        externalLinkHosts: [],
      },
      {
        installationId: 'iid-2',
        systemId: 'wms',
        name: 'wms',
        icon: null,
        origin: 'https://b.example.com',
        state: 'enabled',
        externalLinkHosts: [],
      },
    ]);
  });

  it('externalLinkHosts 容错解析：缺失或非字符串项一律不进白名单（fail-closed）', async () => {
    authFetchMock.mockResolvedValue(
      res(200, {
        installations: [
          {
            installationId: 'iid-3',
            systemId: 'crm',
            origin: 'https://c.example.com',
            externalLinkHosts: ['docs.example.com', 7, null, 'help.example.com'],
          },
          { installationId: 'iid-4', systemId: 'crm', origin: 'https://d.example.com' },
          {
            installationId: 'iid-5',
            systemId: 'crm',
            origin: 'https://e.example.com',
            externalLinkHosts: 'docs.example.com',
          },
        ],
      }),
    );
    const result = await fetchMySystems();
    expect(result.installations.map((item) => item.externalLinkHosts)).toEqual([
      ['docs.example.com', 'help.example.com'],
      [],
      [],
    ]);
  });

  it('功能未启用（404）时按没有可见系统处理', async () => {
    authFetchMock.mockResolvedValue(res(404, null));
    await expect(fetchMySystems()).resolves.toEqual({ installations: [] });
  });

  it('缺关键字段的条目被丢弃', async () => {
    authFetchMock.mockResolvedValue(
      res(200, {
        installations: [
          { systemId: 'orders' },
          { installationId: '', systemId: 'x', origin: 'https://c.example.com' },
        ],
      }),
    );
    await expect(fetchMySystems()).resolves.toEqual({ installations: [] });
  });

  it('其他错误状态抛出带 code 的错误', async () => {
    authFetchMock.mockResolvedValue(
      res(503, { error: { code: 'unavailable', message: '分配事实源不可用' } }),
    );
    await expect(fetchMySystems()).rejects.toMatchObject({ message: '分配事实源不可用' });
  });
});
