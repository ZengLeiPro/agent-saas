import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import { saveUserPreferences } from './preferencesApi';

const mockAuthFetch = vi.mocked(authFetch);

function ok(jsonBody: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

function fail(status = 500): Response {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

function lastCall() {
  const [url, init] = mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1];
  return { url, init: (init ?? {}) as RequestInit };
}

describe('preferencesApi.saveUserPreferences', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  it('PATCH /api/auth/me/preferences，body 为 preferences，返回 data.preferences', async () => {
    const prefs = { theme: 'dark' } as never;
    mockAuthFetch.mockResolvedValue(ok({ preferences: prefs }));
    await expect(saveUserPreferences(prefs)).resolves.toEqual(prefs);

    const { url, init } = lastCall();
    expect(url).toBe('/api/auth/me/preferences');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify(prefs));
  });

  it('body 无 preferences 时返回空对象', async () => {
    mockAuthFetch.mockResolvedValue(ok({}));
    await expect(saveUserPreferences({} as never)).resolves.toEqual({});
  });

  it('非 2xx 返回 null（不抛错）', async () => {
    mockAuthFetch.mockResolvedValue(fail());
    await expect(saveUserPreferences({} as never)).resolves.toBeNull();
  });
});
