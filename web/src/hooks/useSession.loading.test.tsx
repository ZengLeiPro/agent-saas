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

function detailResponse(content: string): Response {
  return jsonResponse({
    mode: 'full',
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
