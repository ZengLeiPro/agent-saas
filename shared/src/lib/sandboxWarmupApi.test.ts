import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({ authFetch: vi.fn() }));

import { authFetch } from './authFetch';
import { warmupSessionSandbox } from './sandboxWarmupApi';

const mockAuthFetch = vi.mocked(authFetch);

describe('warmupSessionSandbox', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  it('POST /api/sessions/:id/warmup 且会话 id 做 URL 转义', async () => {
    mockAuthFetch.mockResolvedValue({ ok: true, status: 200 } as unknown as Response);
    await warmupSessionSandbox('a/b c');
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/sessions/a%2Fb%20c/warmup', {
      method: 'POST',
    });
  });

  it('非 2xx 抛错，交由调用方吞掉（预热失败不能影响发送）', async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 503 } as unknown as Response);
    await expect(warmupSessionSandbox('s-1')).rejects.toThrow('Sandbox warmup failed: HTTP 503');
  });
});
