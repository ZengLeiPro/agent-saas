import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import { fetchTenantCompanyInfo, updateTenantCompanyInfo } from './tenantsApi';

const mockAuthFetch = vi.mocked(authFetch);

function ok(jsonBody: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

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

describe('tenantsApi', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  describe('fetchTenantCompanyInfo', () => {
    it('GET company-info（tenantId encode）返回 data.content', async () => {
      mockAuthFetch.mockResolvedValue(ok({ content: 'company md' }));
      await expect(fetchTenantCompanyInfo('t/1')).resolves.toBe('company md');
      expect(lastCall().url).toBe('/api/tenants/t%2F1/company-info');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(403));
      await expect(fetchTenantCompanyInfo('t1')).rejects.toThrow('Failed to fetch company info: 403');
    });
  });

  describe('updateTenantCompanyInfo', () => {
    it('PUT，body 带 content', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateTenantCompanyInfo('t1', 'new md');

      const { url, init } = lastCall();
      expect(url).toBe('/api/tenants/t1/company-info');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ content: 'new md' }));
    });

    it('失败时优先抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(400, { error: '内容超长' }));
      await expect(updateTenantCompanyInfo('t1', 'x')).rejects.toThrow('内容超长');
    });

    it('失败但 body 解析失败时抛默认信息', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(updateTenantCompanyInfo('t1', 'x')).rejects.toThrow('更新失败 (500)');
    });
  });
});
