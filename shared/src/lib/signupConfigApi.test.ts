import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import {
  fetchSignupConfig,
  updateSignupConfig,
  type SignupConfigAdminView,
  type UpdateSignupConfigRequest,
} from './signupConfigApi';

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

function lastCall() {
  const [url, init] = mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1];
  return { url, init: (init ?? {}) as RequestInit };
}

const view: SignupConfigAdminView = {
  config: { enabled: true, grantCredits: 100 },
  publicEnabled: true,
  smsError: null,
  smsSecretConfigured: false,
  smsSecretSource: null,
  effectiveAllowedModels: ['g/m'],
  updatedAt: null,
  updatedBy: null,
};

describe('signupConfigApi', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  describe('fetchSignupConfig', () => {
    it('GET /api/admin/signup-config 返回解析后的 view', async () => {
      mockAuthFetch.mockResolvedValue(jsonResponse(200, view));
      await expect(fetchSignupConfig()).resolves.toEqual(view);
      expect(lastCall().url).toBe('/api/admin/signup-config');
    });

    it('非 2xx JSON body.error 时抛该 error', async () => {
      mockAuthFetch.mockResolvedValue(jsonResponse(403, { error: '仅平台管理员可访问' }));
      await expect(fetchSignupConfig()).rejects.toThrow('仅平台管理员可访问');
    });
  });

  describe('updateSignupConfig', () => {
    it('PUT，body 为整个 payload', async () => {
      const payload: UpdateSignupConfigRequest = {
        config: { enabled: false, grantCredits: 0 },
        smsAccessKeySecret: null,
      };
      mockAuthFetch.mockResolvedValue(jsonResponse(200, view));
      await expect(updateSignupConfig(payload)).resolves.toEqual(view);

      const { url, init } = lastCall();
      expect(url).toBe('/api/admin/signup-config');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify(payload));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(jsonResponse(400, { error: '配置非法' }));
      await expect(
        updateSignupConfig({ config: { enabled: true, grantCredits: 0 } }),
      ).rejects.toThrow('配置非法');
    });
  });
});
