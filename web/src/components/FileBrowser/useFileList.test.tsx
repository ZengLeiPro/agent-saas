import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '@/lib/authFetch';
import { useFileList } from './useFileList';

vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));

function page(paths: string[], nextCursor: string | null): Response {
  return new Response(
    JSON.stringify({
      entries: paths.map((path) => ({
        name: path.split('/').at(-1),
        path,
        isDirectory: false,
        size: 1,
        modifiedAt: 1,
        extension: '.txt',
      })),
      currentPath: 'assets',
      parentPath: null,
      nextCursor,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('useFileList', () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it('递归列表首屏只取一页，按需携带游标加载下一页', async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(page(['assets/a.txt'], 'cursor-2'))
      .mockResolvedValueOnce(page(['assets/b.txt'], null));

    const { result } = renderHook(() => useFileList('assets', 'alice', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries.map((entry) => entry.path)).toEqual(['assets/a.txt']);
    expect(result.current.hasMore).toBe(true);
    expect(String(vi.mocked(authFetch).mock.calls[0]?.[0])).toContain('recursive=true');
    expect(String(vi.mocked(authFetch).mock.calls[0]?.[0])).toContain('limit=200');

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.entries.map((entry) => entry.path)).toEqual([
      'assets/a.txt',
      'assets/b.txt',
    ]);
    expect(String(vi.mocked(authFetch).mock.calls[1]?.[0])).toContain('cursor=cursor-2');
    expect(result.current.hasMore).toBe(false);
  });

  it('离开页面时取消在途请求，不再提交迟到结果', () => {
    let signal: AbortSignal | undefined;
    vi.mocked(authFetch).mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() => useFileList('assets', undefined, true));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
