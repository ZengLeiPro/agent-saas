import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authFetchMock = vi.hoisted(() => vi.fn());
const loadSessionMessageSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/authFetch', () => ({ authFetch: authFetchMock }));
vi.mock('@/lib/preload', () => ({
  sessionsPreload: Promise.resolve({ sessions: [], hasMore: false }),
}));
vi.mock('@/lib/sessionListCache', () => ({
  loadSessionListCache: () => null,
  saveSessionListCache: vi.fn(),
}));
vi.mock('@/lib/messageCache', () => ({
  loadSessionMessageSnapshot: loadSessionMessageSnapshotMock,
  saveSessionMessages: vi.fn(),
  clearSessionMessages: vi.fn().mockResolvedValue(undefined),
}));

import { useSession, type SessionCallbacks } from './useSession';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function detailResponse(content: string, accessMode: 'owner' | 'read_only' = 'owner'): Response {
  return jsonResponse({
    mode: 'full',
    accessMode,
    blocks: [{ id: `line-${content}`, kind: 'text', content }],
    historyComplete: true,
  });
}

function callbacks(): SessionCallbacks {
  return {
    resetMessages: vi.fn(),
    setMessages: vi.fn(),
    triggerScroll: vi.fn(),
    cancelActiveStream: vi.fn(),
  };
}

function mockAncillaryRequests(): void {
  authFetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/chat/interactions/pending')) {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.startsWith('/api/sessions?') || url === '/api/sessions') {
      return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
    }
    if (url.includes('/stats')) return Promise.resolve(jsonResponse({}));
    return Promise.resolve(detailResponse('默认'));
  });
}

describe('useSession 会话详情加载韧性', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    authFetchMock.mockReset();
    loadSessionMessageSnapshotMock.mockReset();
    loadSessionMessageSnapshotMock.mockResolvedValue(null);
    mockAncillaryRequests();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('选择会话后立即锁定交互，并沿用详情返回的只读权限', async () => {
    let resolveDetail!: (response: Response) => void;
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions/taskboard-session?')) {
        return new Promise<Response>((resolve) => { resolveDetail = resolve; });
      }
      if (url.startsWith('/api/chat/interactions/pending')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/stats')) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
    });
    const { result } = renderHook(() => useSession(callbacks()));

    act(() => result.current.selectSession('taskboard-session'));
    expect(result.current.accessRef.current).toBe('unknown');
    expect(result.current.sessionAccessMode).toBe('unknown');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      resolveDetail(detailResponse('只读历史', 'read_only'));
      await result.current.loadDetailPromiseRef.current;
    });
    expect(result.current.accessRef.current).toBe('read_only');
    expect(result.current.sessionAccessMode).toBe('read_only');
  });

  it('自有会话详情返回 owner 后，渲染层访问模式回到 owner（回归：自有会话不得被锁成只读）', async () => {
    let resolveDetail!: (response: Response) => void;
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions/own-session?')) {
        return new Promise<Response>((resolve) => { resolveDetail = resolve; });
      }
      if (url.startsWith('/api/chat/interactions/pending')) return Promise.resolve(jsonResponse([]));
      if (url.includes('/stats')) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
    });
    const { result } = renderHook(() => useSession(callbacks()));
    expect(result.current.sessionAccessMode).toBe('owner');

    act(() => result.current.selectSession('own-session'));
    expect(result.current.sessionAccessMode).toBe('unknown');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      resolveDetail(detailResponse('自己的历史', 'owner'));
      await result.current.loadDetailPromiseRef.current;
    });
    expect(result.current.sessionAccessMode).toBe('owner');
    expect(result.current.accessRef.current).toBe('owner');
  });

  it('IndexedDB 永久挂起时在缓存预算后直接请求网络', async () => {
    loadSessionMessageSnapshotMock.mockReturnValue(new Promise(() => undefined));
    const cb = callbacks();
    const { result } = renderHook(() => useSession(cb));

    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadSessionDetail('session-a');
    });
    expect(result.current.isLoadingMessages).toBe(true);
    expect(
      authFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/sessions/session-a?')),
    ).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await loading;
    });

    expect(
      authFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/sessions/session-a?')),
    ).toBe(true);
    expect(result.current.isLoadingMessages).toBe(false);
    expect(result.current.sessionLoadError).toBeNull();
    expect(cb.setMessages).toHaveBeenCalled();
  });

  it('详情请求永久挂起时停止转圈并允许原位重试', async () => {
    let detailAttempts = 0;
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions/session-a?')) {
        detailAttempts += 1;
        return detailAttempts === 1
          ? new Promise(() => undefined)
          : Promise.resolve(detailResponse('重试成功'));
      }
      if (url.startsWith('/api/chat/interactions/pending'))
        return Promise.resolve(jsonResponse([]));
      if (url.includes('/stats')) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
    });

    const cb = callbacks();
    const { result } = renderHook(() => useSession(cb));
    let firstLoad!: Promise<void>;
    act(() => {
      result.current.selectSession('session-a');
      firstLoad = result.current.loadDetailPromiseRef.current as Promise<void>;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await firstLoad;
    });

    expect(result.current.isLoadingMessages).toBe(false);
    expect(result.current.sessionLoadError).toBe('会话加载超时，请重试');

    await act(async () => {
      result.current.retrySessionLoad();
      await result.current.loadDetailPromiseRef.current;
    });

    expect(detailAttempts).toBe(2);
    expect(result.current.sessionLoadError).toBeNull();
    expect(result.current.isLoadingMessages).toBe(false);
    expect(cb.setMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: '重试成功' })]),
      undefined,
    );
  });

  it('缓存永久挂起时快速切换不会产生未处理 AbortError', async () => {
    loadSessionMessageSnapshotMock
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue(null);
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions/session-b?')) {
        return Promise.resolve(detailResponse('会话 B'));
      }
      if (url.startsWith('/api/chat/interactions/pending')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/stats')) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
    });
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      const cb = callbacks();
      const { result } = renderHook(() => useSession(cb));
      act(() => result.current.selectSession('session-a'));
      const firstLoad = result.current.loadDetailPromiseRef.current as Promise<void>;
      await act(async () => {
        await Promise.resolve();
      });

      act(() => result.current.selectSession('session-b'));
      await act(async () => {
        await result.current.loadDetailPromiseRef.current;
        await vi.advanceTimersByTimeAsync(200);
        await firstLoad;
      });

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(result.current.sessionId).toBe('session-b');
      expect(result.current.isLoadingMessages).toBe(false);
      expect(cb.setMessages).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ content: '会话 B' })]),
        undefined,
      );
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  it('缓存永久挂起时新建会话不会产生未处理 AbortError', async () => {
    loadSessionMessageSnapshotMock.mockReturnValue(new Promise(() => undefined));
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      const { result } = renderHook(() => useSession(callbacks()));
      act(() => result.current.selectSession('session-a'));
      const loading = result.current.loadDetailPromiseRef.current as Promise<void>;
      await act(async () => {
        await Promise.resolve();
      });

      act(() => result.current.newSession());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
        await loading;
      });

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(result.current.sessionId).toBeNull();
      expect(result.current.isLoadingMessages).toBe(false);
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  it('缓存永久挂起时卸载不会产生未处理 AbortError', async () => {
    loadSessionMessageSnapshotMock.mockReturnValue(new Promise(() => undefined));
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      const { result, unmount } = renderHook(() => useSession(callbacks()));
      act(() => result.current.selectSession('session-a'));
      const loading = result.current.loadDetailPromiseRef.current as Promise<void>;
      await act(async () => {
        await Promise.resolve();
      });

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
        await loading;
      });

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  it('快速切换会真正取消旧详情请求且只提交新会话', async () => {
    let firstSignal: AbortSignal | undefined;
    authFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/sessions/session-a?')) {
        firstSignal = init?.signal as AbortSignal;
        return new Promise(() => undefined);
      }
      if (url.startsWith('/api/sessions/session-b?')) {
        return Promise.resolve(detailResponse('会话 B'));
      }
      if (url.startsWith('/api/chat/interactions/pending'))
        return Promise.resolve(jsonResponse([]));
      if (url.includes('/stats')) return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
    });

    const cb = callbacks();
    const { result } = renderHook(() => useSession(cb));
    act(() => result.current.selectSession('session-a'));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.selectSession('session-b'));
    await act(async () => {
      await result.current.loadDetailPromiseRef.current;
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.sessionId).toBe('session-b');
    expect(result.current.isLoadingMessages).toBe(false);
    expect(cb.setMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ content: '会话 B' })]),
      undefined,
    );
  });
});
