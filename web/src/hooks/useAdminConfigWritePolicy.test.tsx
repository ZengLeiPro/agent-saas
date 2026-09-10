import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authFetch } from '@/lib/authFetch';
import { useAdminConfigWritePolicy } from './useAdminConfigWritePolicy';

vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));

describe('useAdminConfigWritePolicy uncertain result handling', () => {
  beforeEach(() => vi.mocked(authFetch).mockReset());

  it('网络结果不确定时查询同一 operationId，已生效则阻止盲目重发', async () => {
    const { result } = renderHook(() => useAdminConfigWritePolicy(false, '测试配置'));
    act(() =>
      result.current.acceptMetadata({
        revision: 'raw-revision-1',
        writePolicy: { environment: 'development', mode: 'online', canSave: true },
      }),
    );
    let metadata!: ReturnType<typeof result.current.bodyMetadata>;
    act(() => {
      metadata = result.current.bodyMetadata();
    });
    vi.mocked(authFetch)
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'applied' }), { status: 200 }));

    await expect(
      result.current.mutationFetch('/api/admin/example', {
        method: 'PUT',
        body: JSON.stringify(metadata),
      }),
    ).rejects.toThrow(/已生效|applied|勿重复提交/u);

    expect(authFetch).toHaveBeenNthCalledWith(
      2,
      `/api/admin/config-operations/${encodeURIComponent(metadata.operationId)}`,
    );
  });
});
