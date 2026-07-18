import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import {
  fetchToolControlsConfig,
  updateToolControlsConfig,
  type ToolControlsAdminResponse,
  type UpdateToolControlsRequest,
} from './toolControlsApi';

const mockAuthFetch = vi.mocked(authFetch);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

function htmlResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'text/html' }),
    json: vi.fn(),
    text: vi.fn().mockResolvedValue('<html>502</html>'),
  } as unknown as Response;
}

function lastCall() {
  const [url, init] = mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1];
  return { url, init: (init ?? {}) as RequestInit };
}

const resp: ToolControlsAdminResponse = {
  toolControls: null,
  tools: [],
  webTools: null,
  effectiveWebTools: [],
};

describe('toolControlsApi', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  describe('fetchToolControlsConfig', () => {
    it('GET /api/admin/tool-controls 返回解析后的 body', async () => {
      mockAuthFetch.mockResolvedValue(jsonResponse(200, resp));
      await expect(fetchToolControlsConfig()).resolves.toEqual(resp);
      expect(lastCall().url).toBe('/api/admin/tool-controls');
    });

    it('非 JSON 响应时抛带业务名的错误', async () => {
      mockAuthFetch.mockResolvedValue(htmlResponse(502));
      await expect(fetchToolControlsConfig()).rejects.toThrow('工具开关');
    });
  });

  describe('updateToolControlsConfig', () => {
    it('PUT，body 为 payload', async () => {
      const payload: UpdateToolControlsRequest = {
        toolControls: { enabled: true, tools: { web: { enabled: false } } },
        webTools: { enabled: true },
      };
      mockAuthFetch.mockResolvedValue(jsonResponse(200, resp));
      await expect(updateToolControlsConfig(payload)).resolves.toEqual(resp);

      const { url, init } = lastCall();
      expect(url).toBe('/api/admin/tool-controls');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify(payload));
    });

    it('非 2xx JSON body.error 时抛该 error', async () => {
      mockAuthFetch.mockResolvedValue(jsonResponse(400, { error: '工具配置非法' }));
      await expect(
        updateToolControlsConfig({ toolControls: null, webTools: null }),
      ).rejects.toThrow('工具配置非法');
    });
  });
});
