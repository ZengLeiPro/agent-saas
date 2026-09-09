import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('@/lib/authFetch', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

import { KyAppManagementError, kyAppPost, kyAppRequest } from './kyAppManagementApi';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('kyAppRequest response contract', () => {
  beforeEach(() => authFetch.mockReset());

  it('returns valid data and preserves the abort signal and no-store policy', async () => {
    const controller = new AbortController();
    authFetch.mockResolvedValueOnce(json({ overview: { balanceCredits: 20 } }));
    await expect(kyAppRequest('/usage', { signal: controller.signal })).resolves.toEqual({
      overview: { balanceCredits: 20 },
    });
    expect(authFetch).toHaveBeenCalledWith(
      '/api/app-contract/v1/usage',
      expect.objectContaining({ signal: controller.signal, cache: 'no-store' }),
    );
  });

  it.each([
    { name: 'SPA HTML', body: '<!doctype html><html><body>App</body></html>' },
    { name: 'empty body', body: '' },
    { name: 'malformed JSON', body: '{"overview":' },
    { name: 'JSON null', body: 'null' },
    { name: 'JSON array', body: '[]' },
    { name: 'JSON string', body: '"unexpected"' },
  ])('rejects HTTP 200 with $name instead of returning missing data', async ({ body }) => {
    authFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(kyAppRequest('/usage')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
      retryable: true,
      message: expect.stringContaining('未返回有效 JSON'),
    });
  });

  it('preserves structured server errors and diagnostic reports', async () => {
    const error = {
      code: 'forbidden',
      message: '无权查看该组织用量',
      requestId: 'request-1',
      retryable: false,
    };
    authFetch.mockResolvedValueOnce(json({ error, report: { passed: false } }, 403));
    const failure = await kyAppRequest('/usage').catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(KyAppManagementError);
    expect(failure).toMatchObject({ ...error, status: 403, diagnosticReport: { passed: false } });
  });

  it('reports HTTP failures even when a proxy returns HTML', async () => {
    authFetch.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(kyAppRequest('/usage')).rejects.toMatchObject({
      status: 502,
      code: 'unknown',
      message: '请求失败 (502)',
    });
  });

  it('使用鉴权请求并传递 abort 与 no-store', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ systems: [] })));
    const signal = new AbortController().signal;
    expect(await kyAppRequest('/systems', { signal })).toEqual({ systems: [] });
    expect(authFetch).toHaveBeenCalledWith(
      '/api/app-contract/v1/systems',
      expect.objectContaining({ signal, cache: 'no-store' }),
    );
  });

  it('保留 POST 冲突码和请求标识', async () => {
    authFetch.mockResolvedValueOnce(
      json({ error: { code: 'conflict', message: '基线变化', requestId: 'r1', retryable: false } }, 409),
    );
    await expect(kyAppPost('/systems/demo/status')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      requestId: 'r1',
      message: '基线变化',
    });
    expect(authFetch).toHaveBeenCalledWith(
      '/api/app-contract/v1/systems/demo/status',
      expect.objectContaining({ method: 'POST', body: '{}', cache: 'no-store' }),
    );
  });
});
