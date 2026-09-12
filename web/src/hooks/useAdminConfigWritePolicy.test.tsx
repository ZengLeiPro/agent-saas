import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authFetch } from '@/lib/authFetch';
import { useAdminConfigWritePolicy } from './useAdminConfigWritePolicy';

vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));

async function captureFailure(run: () => Promise<unknown>): Promise<Error> {
  let failure: unknown;
  await act(async () => {
    try {
      await run();
    } catch (error) {
      failure = error;
    }
  });
  expect(failure).toBeInstanceOf(Error);
  return failure as Error;
}

describe('useAdminConfigWritePolicy uncertain result handling', () => {
  beforeEach(() => vi.mocked(authFetch).mockReset());

  it('网络结果不确定时查询同一 operationId，已生效则阻止盲目重发', async () => {
    const { result } = renderHook(() => useAdminConfigWritePolicy(false));
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

    const failure = await captureFailure(() =>
      result.current.mutationFetch('/api/admin/example', {
        method: 'PUT',
        body: JSON.stringify(metadata),
      }),
    );
    expect(failure.message).toMatch(/已生效|applied|勿重复提交/u);

    expect(authFetch).toHaveBeenNthCalledWith(
      2,
      `/api/admin/config-operations/${encodeURIComponent(metadata.operationId)}`,
    );
    expect(result.current.uncertainOperationId).toBe(metadata.operationId);
    expect(() => result.current.bodyMetadata()).toThrow(metadata.operationId);
  });

  it.each([401, 500])('状态查询返回 HTTP %s 时保留 operationId 并阻止新操作', async (status) => {
    const { result } = renderHook(() => useAdminConfigWritePolicy(false));
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
      .mockResolvedValueOnce(new Response('{}', { status }));

    const failure = await captureFailure(() => result.current.mutationFetch('/api/admin/example'));
    expect(failure.message).toMatch(new RegExp(`${metadata.operationId}.*HTTP ${status}`, 'u'));
    expect(result.current.uncertainOperationId).toBe(metadata.operationId);
    expect(() => result.current.deleteHeaders()).toThrow(metadata.operationId);

    act(() => result.current.acceptMetadata({ revision: 'raw-revision-2' }));
    expect(result.current.uncertainOperationId).toBeNull();
    expect(result.current.bodyMetadata().operationId).not.toBe(metadata.operationId);
  });

  it('状态查询网络失败时展示并保留原 operationId', async () => {
    const { result } = renderHook(() => useAdminConfigWritePolicy(false));
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
      .mockRejectedValueOnce(new TypeError('write response lost'))
      .mockRejectedValueOnce(new TypeError('status unavailable'));

    const failure = await captureFailure(() => result.current.mutationFetch('/api/admin/example'));
    expect(failure.message).toMatch(new RegExp(`${metadata.operationId}.*结果不确定`, 'u'));
    expect(result.current.uncertainOperationId).toBe(metadata.operationId);
    expect(() => result.current.bodyMetadata()).toThrow(metadata.operationId);
  });

  it('只有明确未提交或已回滚才释放 operationId 允许重试', async () => {
    const { result } = renderHook(() => useAdminConfigWritePolicy(false));
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
      .mockRejectedValueOnce(new TypeError('write response lost'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'rolled_back' }), { status: 200 }),
      );

    const failure = await captureFailure(() => result.current.mutationFetch('/api/admin/example'));
    expect(failure.message).toContain('write response lost');
    expect(result.current.uncertainOperationId).toBeNull();
    expect(result.current.bodyMetadata().operationId).not.toBe(metadata.operationId);
  });

  it('普通 500 不建立不存在的操作台账查询，也不误报结果不确定', async () => {
    const { result } = renderHook(() => useAdminConfigWritePolicy(false));
    act(() =>
      result.current.acceptMetadata({
        revision: 'raw-revision-1',
        writePolicy: { environment: 'development', mode: 'online', canSave: true },
      }),
    );
    act(() => { result.current.bodyMetadata(); });
    vi.mocked(authFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: '未分类的服务端失败' }), { status: 500 }),
    );

    let response!: Response;
    await act(async () => {
      response = await result.current.mutationFetch('/api/admin/example');
    });

    expect(response.status).toBe(500);
    expect(authFetch).toHaveBeenCalledOnce();
    expect(result.current.uncertainOperationId).toBeNull();
  });

  it('只有明确的提交后不确定错误才查询 operationId', async () => {
    const { result } = renderHook(() => useAdminConfigWritePolicy(false));
    act(() =>
      result.current.acceptMetadata({
        revision: 'raw-revision-1',
        writePolicy: { environment: 'development', mode: 'online', canSave: true },
      }),
    );
    let metadata!: ReturnType<typeof result.current.bodyMetadata>;
    act(() => { metadata = result.current.bodyMetadata(); });
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'CONFIG_MUTATION_COMMITTED' }), { status: 500 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'not_committed' }), { status: 200 }));

    let response!: Response;
    await act(async () => {
      response = await result.current.mutationFetch('/api/admin/example');
    });
    expect(response.status).toBe(500);
    expect(authFetch).toHaveBeenNthCalledWith(
      2,
      `/api/admin/config-operations/${encodeURIComponent(metadata.operationId)}`,
    );
  });
});
