import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import {
  fetchMcpTemplates,
  fetchMyMcp,
  updateMyMcpSelections,
  bindMyMcpSecret,
  bindAdminMcpSecret,
  diagnoseMyMcp,
  fetchMcpAdminServers,
  upsertMcpServer,
  deleteMcpServer,
  upsertMyMcpServer,
  deleteMyMcpServer,
  startMyMcpOAuth,
  disconnectMyMcpOAuth,
} from './mcpApi';

const mockAuthFetch = vi.mocked(authFetch);

function ok(jsonBody: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

// 失败响应：默认 json 抛错（模拟无 body），传 jsonBody 可返回 error/details
function fail(status: number, jsonBody?: unknown): Response {
  return {
    ok: false,
    status,
    json:
      jsonBody === undefined
        ? vi.fn().mockRejectedValue(new Error('no body'))
        : vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

function lastCall() {
  const [url, init] = mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1];
  return { url, init: (init ?? {}) as RequestInit };
}

describe('mcpApi', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  describe('fetchMcpTemplates', () => {
    it('GET templates 返回 body', async () => {
      const body = { templates: [] };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchMcpTemplates()).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/mcp/templates');
    });

    it('失败时 jsonOrError 抛出（带 fallback + status）', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(fetchMcpTemplates()).rejects.toThrow('Failed to fetch MCP templates: 500');
    });
  });

  describe('fetchMyMcp', () => {
    it('GET me 返回 body', async () => {
      mockAuthFetch.mockResolvedValue(ok({ servers: [] }));
      await expect(fetchMyMcp()).resolves.toEqual({ servers: [] });
      expect(lastCall().url).toBe('/api/mcp/me');
    });

    it('失败时优先抛 body.error（含 details）', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: '出错了', details: { field: 'x' } }));
      await expect(fetchMyMcp()).rejects.toThrow('出错了: {"field":"x"}');
    });
  });

  describe('updateMyMcpSelections', () => {
    it('PUT selections，body 带 enabledServers', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateMyMcpSelections(['a', 'b']);

      const { url, init } = lastCall();
      expect(url).toBe('/api/mcp/me/selections');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ enabledServers: ['a', 'b'] }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updateMyMcpSelections([])).rejects.toThrow('Failed to update MCP selections: 400');
    });
  });

  describe('bindMyMcpSecret', () => {
    it('PUT secrets，serverId/key 双 encode，body 带 value', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await bindMyMcpSecret('srv/1', 'API KEY', 'secret');

      const { url, init } = lastCall();
      expect(url).toBe('/api/mcp/me/servers/srv%2F1/secrets/API%20KEY');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ value: 'secret' }));
    });

    it('失败时抛 formatApiError 结果', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: 'key 非法' }));
      await expect(bindMyMcpSecret('s', 'k', 'v')).rejects.toThrow('key 非法');
    });
  });

  describe('bindAdminMcpSecret', () => {
    it('PUT admin secrets 路径', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await bindAdminMcpSecret('srv1', 'KEY', 'val');
      expect(lastCall().url).toBe('/api/mcp/admin/servers/srv1/secrets/KEY');
      expect(lastCall().init.method).toBe('PUT');
    });

    it('失败但无 body 时抛默认信息', async () => {
      mockAuthFetch.mockResolvedValue(fail(403));
      await expect(bindAdminMcpSecret('s', 'k', 'v')).rejects.toThrow('Failed to bind admin MCP secret: 403');
    });
  });

  describe('diagnoseMyMcp', () => {
    it('POST diagnose 返回 body', async () => {
      mockAuthFetch.mockResolvedValue(ok({ ok: true }));
      await expect(diagnoseMyMcp()).resolves.toEqual({ ok: true });

      const { url, init } = lastCall();
      expect(url).toBe('/api/mcp/diagnose');
      expect(init.method).toBe('POST');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(diagnoseMyMcp()).rejects.toThrow('Failed to diagnose MCP: 500');
    });
  });

  describe('fetchMcpAdminServers', () => {
    it('GET admin/servers 返回 body', async () => {
      mockAuthFetch.mockResolvedValue(ok({ servers: [] }));
      await expect(fetchMcpAdminServers()).resolves.toEqual({ servers: [] });
      expect(lastCall().url).toBe('/api/mcp/admin/servers');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(403));
      await expect(fetchMcpAdminServers()).rejects.toThrow('Failed to fetch MCP servers: 403');
    });
  });

  describe('upsertMcpServer', () => {
    it('PUT admin/servers/:id，body 为整个 server', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      const server = { id: 'srv 1', name: 'S' } as never;
      await upsertMcpServer(server);

      const { url, init } = lastCall();
      expect(url).toBe('/api/mcp/admin/servers/srv%201');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify(server));
    });

    it('失败时抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: '配置无效' }));
      await expect(upsertMcpServer({ id: 's' } as never)).rejects.toThrow('配置无效');
    });
  });

  describe('deleteMcpServer', () => {
    it('DELETE admin/servers/:id', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await deleteMcpServer('srv/1');
      expect(lastCall().url).toBe('/api/mcp/admin/servers/srv%2F1');
      expect(lastCall().init.method).toBe('DELETE');
    });

    it('非 2xx 抛错（无 body 提取）', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(deleteMcpServer('s')).rejects.toThrow('Failed to delete MCP server: 500');
    });
  });

  describe('upsertMyMcpServer', () => {
    it('PUT me/servers/:id', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await upsertMyMcpServer({ id: 'srv1' } as never);
      expect(lastCall().url).toBe('/api/mcp/me/servers/srv1');
      expect(lastCall().init.method).toBe('PUT');
    });

    it('失败时抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: '个人配置无效' }));
      await expect(upsertMyMcpServer({ id: 's' } as never)).rejects.toThrow('个人配置无效');
    });
  });

  describe('deleteMyMcpServer', () => {
    it('DELETE me/servers/:id', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await deleteMyMcpServer('srv1');
      expect(lastCall().url).toBe('/api/mcp/me/servers/srv1');
      expect(lastCall().init.method).toBe('DELETE');
    });

    it('失败时抛 formatApiError（无 body 时用 fallback）', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(deleteMyMcpServer('s')).rejects.toThrow('Failed to delete personal MCP server: 500');
    });
  });

  describe('startMyMcpOAuth', () => {
    it('POST oauth/start，body 带 returnTo，返回 body', async () => {
      mockAuthFetch.mockResolvedValue(ok({ authorizationUrl: 'https://x' }));
      await expect(startMyMcpOAuth('srv 1', '/back')).resolves.toEqual({ authorizationUrl: 'https://x' });

      const { url, init } = lastCall();
      expect(url).toBe('/api/mcp/me/servers/srv%201/oauth/start');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ returnTo: '/back' }));
    });

    it('非 2xx 抛「连接器授权启动失败」', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(startMyMcpOAuth('s', '/b')).rejects.toThrow('连接器授权启动失败: 500');
    });
  });

  describe('disconnectMyMcpOAuth', () => {
    it('DELETE oauth', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await disconnectMyMcpOAuth('srv1');
      expect(lastCall().url).toBe('/api/mcp/me/servers/srv1/oauth');
      expect(lastCall().init.method).toBe('DELETE');
    });

    it('失败时抛「断开连接器失败」', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(disconnectMyMcpOAuth('s')).rejects.toThrow('断开连接器失败: 500');
    });
  });
});
