// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundaryIdentity, MessageItem } from '@agent/shared';

const h = vi.hoisted(() => ({
  authFetch: vi.fn(),
  cacheSave: vi.fn(),
  listCacheSave: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    authFetch: h.authFetch,
    getPlatform: () => ({
      storage: {
        getItem: vi.fn(async () => null),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
      },
    }),
  };
});

vi.mock('../platform/mobileMessageCache', () => ({
  createMobileMessageCacheForIdentity: () => ({
    load: vi.fn(async () => null),
    save: h.cacheSave,
    clear: vi.fn(async () => undefined),
  }),
}));

vi.mock('../lib/sessionListCache', () => ({
  saveSessionListCache: h.listCacheSave,
  loadSessionListCache: vi.fn(async () => null),
}));

import { useSession, type SessionCallbacks } from './useSession';

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'boom',
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const identityA = { tenantId: 't1', userId: 'u1', generation: 1 } as unknown as BoundaryIdentity;
const identityB = { ...identityA, userId: 'u2' } as BoundaryIdentity;

function makeCallbacks(store: { messages: MessageItem[] }): SessionCallbacks {
  return {
    resetMessages: vi.fn(() => {
      store.messages = [];
    }),
    setMessages: vi.fn((msgs: MessageItem[]) => {
      store.messages = msgs;
    }),
    getMessages: () => store.messages,
    triggerScroll: vi.fn(),
    cancelActiveStream: vi.fn(),
    clearComposer: vi.fn(),
  };
}

const blocks = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => ({
    id: `line-${start + i}`,
    kind: (start + i) % 2 === 0 ? 'text' : 'prompt',
    content: `内容 ${start + i}`,
  }));

function routeDefault(url: string): Promise<Response> | null {
  if (url.startsWith('/api/sessions?'))
    return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
  if (url.startsWith('/api/chat/interactions/pending')) return Promise.resolve(jsonResponse([]));
  return null;
}

describe('mobile useSession 消费 shared 内核', () => {
  beforeEach(() => {
    h.authFetch.mockReset();
    h.cacheSave.mockReset();
    h.listCacheSave.mockClear();
  });
  afterEach(() => cleanup());

  it('向前翻页：mode=before 合并去重，mode=full 整窗替换，到头后不再请求', async () => {
    const store = { messages: [] as MessageItem[] };
    const callbacks = makeCallbacks(store);
    let beforeCalls = 0;
    h.authFetch.mockImplementation((url: string) => {
      if (url.includes('before=line-101')) {
        beforeCalls += 1;
        return Promise.resolve(
          jsonResponse({
            mode: 'before',
            blocks: blocks(1, 101),
            oldestCursor: 'line-1',
            cursor: 'line-200',
            historyComplete: true,
          }),
        );
      }
      if (url.startsWith('/api/sessions/session-a?')) {
        return Promise.resolve(
          jsonResponse({
            mode: 'full',
            blocks: blocks(101, 200),
            oldestCursor: 'line-101',
            cursor: 'line-200',
            historyComplete: false,
          }),
        );
      }
      if (url.endsWith('/stats')) return Promise.resolve(jsonResponse({}));
      return routeDefault(url) ?? Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks, { identity: identityA }));
    await act(async () => {
      await result.current.loadSessionDetail('session-a');
    });
    expect(store.messages).toHaveLength(100);
    expect(result.current.hasMoreHistory).toBe(true);

    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(store.messages).toHaveLength(200);
    expect(store.messages[0]?.id).toBe('line-1');
    expect(store.messages.filter((m) => m.id === 'line-101')).toHaveLength(1);
    expect(result.current.hasMoreHistory).toBe(false);
    expect(result.current.isLoadingEarlier).toBe(false);

    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(beforeCalls).toBe(1);
  });

  it('历史游标失效返回 full 时替换旧窗口（与 Web 对齐）', async () => {
    const store = { messages: [] as MessageItem[] };
    const callbacks = makeCallbacks(store);
    h.authFetch.mockImplementation((url: string) => {
      if (url.includes('before=')) {
        return Promise.resolve(
          jsonResponse({
            mode: 'full',
            blocks: [{ id: 'line-1', kind: 'text', content: '新尾页' }],
            oldestCursor: 'new-oldest',
            cursor: 'new-tail',
            historyComplete: true,
          }),
        );
      }
      if (url.startsWith('/api/sessions/session-a?')) {
        return Promise.resolve(
          jsonResponse({
            mode: 'full',
            blocks: [{ id: 'line-101', kind: 'text', content: '旧尾页' }],
            oldestCursor: 'old-oldest',
            cursor: 'old-tail',
            historyComplete: false,
          }),
        );
      }
      if (url.endsWith('/stats')) return Promise.resolve(jsonResponse({}));
      return routeDefault(url) ?? Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks, { identity: identityA }));
    await act(async () => {
      await result.current.loadSessionDetail('session-a');
    });
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(store.messages.map((m) => m.id)).toEqual(['line-1']);
    expect(result.current.hasMoreHistory).toBe(false);
  });

  it('historyRevision 变化时放弃旧页并静默重载最新一代', async () => {
    const store = { messages: [] as MessageItem[] };
    const callbacks = makeCallbacks(store);
    const detailCalls: string[] = [];
    h.authFetch.mockImplementation((url: string) => {
      if (url.includes('before=')) {
        return Promise.resolve(
          jsonResponse({
            mode: 'before',
            blocks: [{ id: 'stale', kind: 'text', content: '过期页' }],
            oldestCursor: 'x',
            historyComplete: true,
            historyRevision: 'rev-2',
          }),
        );
      }
      if (url.startsWith('/api/sessions/session-a?')) {
        detailCalls.push(url);
        return Promise.resolve(
          jsonResponse({
            mode: 'full',
            blocks: [{ id: 'tail', kind: 'text', content: '尾页' }],
            oldestCursor: 'tail',
            historyComplete: false,
            historyRevision: 'rev-1',
          }),
        );
      }
      if (url.endsWith('/stats')) return Promise.resolve(jsonResponse({}));
      return routeDefault(url) ?? Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks, { identity: identityA }));
    await act(async () => {
      await result.current.loadSessionDetail('session-a');
    });
    expect(detailCalls).toHaveLength(1);
    await act(async () => {
      await result.current.loadEarlierMessages();
    });
    expect(store.messages.some((m) => m.id === 'stale')).toBe(false);
    expect(detailCalls).toHaveLength(2);
    expect(detailCalls[1]).toContain('silent=1');
    expect(result.current.isLoadingEarlier).toBe(false);
  });

  it('身份切换后迟到的历史页与 stats 响应都不落地', async () => {
    const store = { messages: [] as MessageItem[] };
    const callbacks = makeCallbacks(store);
    const earlier = deferred<Response>();
    const stats = deferred<Response>();
    h.authFetch.mockImplementation((url: string) => {
      if (url.includes('before=')) return earlier.promise;
      if (url.endsWith('/stats')) return stats.promise;
      if (url.startsWith('/api/sessions/session-a?')) {
        return Promise.resolve(
          jsonResponse({
            mode: 'full',
            blocks: [{ id: 'tail', kind: 'text', content: '尾页' }],
            oldestCursor: 'tail',
            historyComplete: false,
          }),
        );
      }
      return routeDefault(url) ?? Promise.resolve(jsonResponse({}));
    });

    const { result, rerender } = renderHook(
      ({ identity }: { identity: BoundaryIdentity }) => useSession(callbacks, { identity }),
      { initialProps: { identity: identityA } },
    );
    await act(async () => {
      await result.current.loadSessionDetail('session-a');
    });
    let earlierPromise!: Promise<void>;
    act(() => {
      earlierPromise = result.current.loadEarlierMessages();
    });
    expect(result.current.isLoadingEarlier).toBe(true);

    rerender({ identity: identityB });
    await act(async () => {
      earlier.resolve(
        jsonResponse({
          mode: 'before',
          blocks: [{ id: 'old', kind: 'text', content: '旧' }],
          oldestCursor: 'old',
          historyComplete: true,
        }),
      );
      stats.resolve(
        jsonResponse({ tokenUsage: { inputTokens: 1, outputTokens: 1 }, totalCostUsd: 0.5 }),
      );
      await earlierPromise;
    });
    expect(store.messages.some((m) => m.id === 'old')).toBe(false);
    expect(result.current.tokenUsage).toBeNull();
  });

  it('stats 只在响应到达时仍是当前会话才落地（附 totalCostUsd 与 contextUsage）', async () => {
    const store = { messages: [] as MessageItem[] };
    const callbacks = makeCallbacks(store);
    // stats 与详情一样绑定当前会话：详情提交 sessionId 后再返回的 stats 才会落地，
    // 所以这里让 stats 晚于详情提交再返回（真实网络下的常态）。
    const stats = deferred<Response>();
    h.authFetch.mockImplementation((url: string) => {
      if (url.endsWith('/stats')) return stats.promise;
      if (url.startsWith('/api/sessions/session-a?')) {
        return Promise.resolve(jsonResponse({ mode: 'full', blocks: [], historyComplete: true }));
      }
      return routeDefault(url) ?? Promise.resolve(jsonResponse({}));
    });
    const { result } = renderHook(() => useSession(callbacks, { identity: identityA }));
    await act(async () => {
      await result.current.loadSessionDetail('session-a');
    });
    expect(result.current.sessionId).toBe('session-a');
    expect(result.current.tokenUsage).toBeNull();

    await act(async () => {
      stats.resolve(
        jsonResponse({
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          totalCostUsd: 0.25,
          contextUsage: { used: 100, limit: 1000 },
        }),
      );
      await stats.promise;
    });
    expect(result.current.tokenUsage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 0.25,
    });
    expect(result.current.contextUsage).toMatchObject({ used: 100 });
  });

  it('重命名与自动命名走服务端确认后再更新本地标题', async () => {
    const store = { messages: [] as MessageItem[] };
    const callbacks = makeCallbacks(store);
    h.authFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/sessions?')) {
        return Promise.resolve(
          jsonResponse({
            sessions: [
              {
                sessionId: 's1',
                title: '旧',
                updatedAtMs: 1,
                source: { type: 'web', label: 'WEB' },
              },
            ],
            hasMore: false,
          }),
        );
      }
      if (url === '/api/sessions/s1' && init?.method === 'PATCH')
        return Promise.resolve(jsonResponse({}));
      if (url === '/api/sessions/s1/auto-title')
        return Promise.resolve(jsonResponse({ title: '自动标题' }));
      if (url === '/api/sessions/s2' && init?.method === 'PATCH')
        return Promise.resolve(jsonResponse({}, false));
      return routeDefault(url) ?? Promise.resolve(jsonResponse({}));
    });
    const { result } = renderHook(() => useSession(callbacks, { identity: identityA }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.sessions.map((s) => s.title)).toEqual(['旧']);

    await act(async () => {
      expect(await result.current.renameSession('s1', '新')).toBe(true);
    });
    expect(result.current.sessions[0]?.title).toBe('新');
    await act(async () => {
      expect(await result.current.autoTitleSession('s1')).toBe(true);
    });
    expect(result.current.sessions[0]?.title).toBe('自动标题');
    await act(async () => {
      expect(await result.current.renameSession('s2', '失败')).toBe(false);
    });
    expect(result.current.sessions[0]?.title).toBe('自动标题');
  });

  it('会话列表变化 5s 内无新变化才落盘', async () => {
    vi.useFakeTimers();
    try {
      const store = { messages: [] as MessageItem[] };
      const callbacks = makeCallbacks(store);
      h.authFetch.mockImplementation((url: string) => {
        if (url.startsWith('/api/sessions?')) {
          return Promise.resolve(
            jsonResponse({
              sessions: [
                { sessionId: 's1', updatedAtMs: 1, source: { type: 'web', label: 'WEB' } },
              ],
              hasMore: false,
            }),
          );
        }
        return routeDefault(url) ?? Promise.resolve(jsonResponse({}));
      });
      const { result } = renderHook(() => useSession(callbacks, { identity: identityA }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.sessions).toHaveLength(1);
      expect(h.listCacheSave).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      act(() => {
        result.current.updateSessionMeta('s1', { preview: '改' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(h.listCacheSave).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(h.listCacheSave).toHaveBeenCalledTimes(1);
      expect(h.listCacheSave.mock.calls[0]?.[0]).toMatchObject([
        { sessionId: 's1', preview: '改' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
