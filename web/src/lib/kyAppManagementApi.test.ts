import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '@/lib/authFetch';
import { kyAppRequest, kyAppPost } from './kyAppManagementApi';
vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe('业务系统 API', () => {
  it('使用鉴权请求并传递 abort 与 no-store', async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ systems: [] })));
    const signal = new AbortController().signal;
    expect(await kyAppRequest('/systems', { signal })).toEqual({ systems: [] });
    expect(authFetch).toHaveBeenCalledWith(
      '/api/app-contract/v1/systems',
      expect.objectContaining({ signal, cache: 'no-store' }),
    );
  });
  it('保留冲突码和请求标识', async () => {
    vi.mocked(authFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'conflict', message: '基线变化', requestId: 'r1', retryable: false },
        }),
        { status: 409 },
      ),
    );
    await expect(kyAppPost('/systems/demo/status')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      requestId: 'r1',
      message: '基线变化',
    });
  });
});
