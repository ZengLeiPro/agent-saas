import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCallbacks } from './useSession';

const authFetchMock = vi.hoisted(() => vi.fn());
const listCacheSave = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authFetch', () => ({ authFetch: authFetchMock }));
vi.mock('@/lib/preload', () => ({ sessionsPreload: Promise.resolve(null) }));
vi.mock('@/lib/sessionListCache', () => ({
  loadSessionListCache: () => null,
  saveSessionListCache: listCacheSave,
}));
vi.mock('@/lib/messageCache', () => ({
  saveSessionMessages: vi.fn(),
  clearSessionMessages: vi.fn(async () => undefined),
  loadSessionMessageSnapshot: vi.fn(async () => null),
}));

import { useSession } from './useSession';

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'boom',
    json: async () => body,
  } as unknown as Response;
}

function makeCallbacks(): SessionCallbacks {
  return {
    resetMessages: vi.fn(),
    setMessages: vi.fn(),
    getMessages: () => [],
    triggerScroll: vi.fn(),
    cancelActiveStream: vi.fn(),
  };
}

const listBody = {
  sessions: [
    { sessionId: 's1', title: '旧', updatedAtMs: 1, source: { type: 'web', label: 'WEB' } },
  ],
  hasMore: false,
};

describe('web useSession 消费 shared 内核', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    listCacheSave.mockReset();
  });
  afterEach(() => cleanup());

  it('重命名成功后乐观更新标题，空标题写回 undefined；失败不改本地', async () => {
    authFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/sessions?')) return Promise.resolve(jsonResponse(listBody));
      if (url === '/api/sessions/s1' && init?.method === 'PATCH')
        return Promise.resolve(jsonResponse({}));
      if (url === '/api/sessions/s2' && init?.method === 'PATCH')
        return Promise.resolve(jsonResponse({}, false));
      return Promise.resolve(jsonResponse({}));
    });
    const { result } = renderHook(() => useSession(makeCallbacks()));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.sessions[0]?.title).toBe('旧');

    await act(async () => {
      expect(await result.current.renameSession('s1', '新')).toBe(true);
    });
    expect(result.current.sessions[0]?.title).toBe('新');
    expect(authFetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: '新' }),
      }),
    );

    await act(async () => {
      expect(await result.current.renameSession('s1', '')).toBe(true);
    });
    expect(result.current.sessions[0]?.title).toBeUndefined();
    expect('title' in result.current.sessions[0]!).toBe(true);

    await act(async () => {
      expect(await result.current.renameSession('s2', '失败')).toBe(false);
    });
    expect(result.current.sessions[0]?.title).toBeUndefined();
  });

  it('自动命名只在服务端返回 title 时更新本地', async () => {
    let titled = false;
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions?')) return Promise.resolve(jsonResponse(listBody));
      if (url === '/api/sessions/s1/auto-title') {
        return Promise.resolve(jsonResponse(titled ? { title: '自动' } : {}));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const { result } = renderHook(() => useSession(makeCallbacks()));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      expect(await result.current.autoTitleSession('s1')).toBe(true);
    });
    expect(result.current.sessions[0]?.title).toBe('旧');
    titled = true;
    await act(async () => {
      expect(await result.current.autoTitleSession('s1')).toBe(true);
    });
    expect(result.current.sessions[0]?.title).toBe('自动');
  });

  it('stats 落地 tokenUsage（附 totalCostUsd）与 contextUsage，refreshTokenUsage 只在有会话时拉取', async () => {
    let statsCalls = 0;
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/sessions?'))
        return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
      if (url.endsWith('/stats')) {
        statsCalls += 1;
        return Promise.resolve(
          jsonResponse({
            tokenUsage: { inputTokens: 10, outputTokens: 5 },
            totalCostUsd: 0.25,
            contextUsage: { used: 100, limit: 1000 },
          }),
        );
      }
      if (url.startsWith('/api/sessions/session-a?')) {
        return Promise.resolve(jsonResponse({ mode: 'full', blocks: [], historyComplete: true }));
      }
      if (url.startsWith('/api/chat/interactions/pending'))
        return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });
    const { result } = renderHook(() => useSession(makeCallbacks()));
    await act(async () => {
      await result.current.refreshTokenUsage();
    });
    expect(statsCalls).toBe(0);

    await act(async () => {
      await result.current.loadSessionDetail('session-a');
    });
    expect(statsCalls).toBe(1);
    expect(result.current.tokenUsage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 0.25,
    });
    expect(result.current.contextUsage).toMatchObject({ used: 100 });

    await act(async () => {
      await result.current.refreshTokenUsage();
    });
    expect(statsCalls).toBe(2);
  });

  it('会话列表 5s 内无新变化才落盘；首次挂载的空列表不落盘', async () => {
    vi.useFakeTimers();
    try {
      authFetchMock.mockImplementation((url: string) => {
        if (url.startsWith('/api/sessions?')) return Promise.resolve(jsonResponse(listBody));
        return Promise.resolve(jsonResponse({}));
      });
      const { result } = renderHook(() => useSession(makeCallbacks()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.sessions).toHaveLength(1);
      expect(listCacheSave).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      act(() => {
        result.current.updateSessionMeta('s1', { preview: '改' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(listCacheSave).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(listCacheSave).toHaveBeenCalledTimes(1);
      expect(listCacheSave.mock.calls[0]?.[0]).toMatchObject([{ sessionId: 's1', preview: '改' }]);
      expect(listCacheSave.mock.calls[0]?.[1]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
