/**
 * sessionLoader 测试 —— 会话列表/详情加载
 *
 * mock 外部边界：authFetch（网络）、platform.messageCache（缓存）。
 * 测状态机流转：isLoadingSessions loading→loaded、分页 append、
 * 详情 cache 命中、404/403 清空、token usage 拉取。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const authFetchMock = vi.fn();
vi.mock('../../lib/authFetch', () => ({
  authFetch: (...a: unknown[]) => authFetchMock(...a),
}));

import {
  loadSessions,
  loadMoreSessions,
  loadSessionDetail,
  fetchTokenUsage,
} from './sessionLoader';
import { getChatStore, resetChatStore } from '../index';
import { initPlatform } from '../../platform/context';
import type { PlatformDeps } from '../../platform/types';
import type { ApiSessionListItem } from '../../types/session';

let cacheStore: Record<string, unknown>;
let cacheSaveSpy: ReturnType<typeof vi.fn>;

function makePlatform(): PlatformDeps {
  cacheSaveSpy = vi.fn();
  return {
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    messageCache: {
      save: (id, msgs) => { cacheSaveSpy(id, msgs); },
      load: async (id) => (cacheStore[id] as never) ?? null,
      clear: async () => {},
    },
    platformConfig: { getBaseUrl: () => '', getWsUrl: () => '', platform: 'web' },
    scheduleFlush: (cb) => { cb(); return 0; },
    cancelFlush: () => {},
  };
}

function jsonRes(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body };
}

function session(id: string, updatedAtMs: number): ApiSessionListItem {
  return { sessionId: id, updatedAtMs, source: { type: 'web', label: 'WEB' } };
}

beforeEach(() => {
  resetChatStore();
  cacheStore = {};
  initPlatform(makePlatform());
  authFetchMock.mockReset();
});

describe('loadSessions', () => {
  it('成功：置 isLoadingSessions true→false，写入 sessions 与 hasMore', async () => {
    authFetchMock.mockResolvedValue(jsonRes({ sessions: [session('a', 1)], hasMore: true }));
    const store = getChatStore();

    const p = loadSessions();
    expect(store.getState().isLoadingSessions).toBe(true); // 加载中
    await p;

    expect(store.getState().isLoadingSessions).toBe(false);
    expect(store.getState().sessions).toHaveLength(1);
    expect(store.getState().hasMore).toBe(true);
  });

  it('silent 模式不切换 isLoadingSessions 标志', async () => {
    authFetchMock.mockResolvedValue(jsonRes({ sessions: [], hasMore: false }));
    const store = getChatStore();
    store.setState({ isLoadingSessions: false });
    await loadSessions({ silent: true });
    expect(store.getState().isLoadingSessions).toBe(false);
  });

  it('fresh 参数拼接到 URL', async () => {
    authFetchMock.mockResolvedValue(jsonRes({ sessions: [], hasMore: false }));
    await loadSessions({ fresh: true });
    expect(authFetchMock).toHaveBeenCalledWith(expect.stringContaining('fresh=1'));
  });

  it('网络异常：吞掉错误，finally 仍复位 isLoadingSessions', async () => {
    authFetchMock.mockRejectedValue(new Error('boom'));
    const store = getChatStore();
    await loadSessions();
    expect(store.getState().isLoadingSessions).toBe(false);
  });

  it('响应 !ok：不改动 sessions', async () => {
    authFetchMock.mockResolvedValue(jsonRes({}, { ok: false, status: 500 }));
    const store = getChatStore();
    store.getState().setSessions([session('x', 1)]);
    await loadSessions();
    expect(store.getState().sessions).toEqual([session('x', 1)]);
  });
});

describe('loadMoreSessions', () => {
  it('hasMore=false 时直接返回，不发请求', async () => {
    const store = getChatStore();
    store.setState({ hasMore: false, sessions: [session('a', 1)] });
    await loadMoreSessions();
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('已在 isLoadingMore 时直接返回', async () => {
    const store = getChatStore();
    store.setState({ hasMore: true, isLoadingMore: true, sessions: [session('a', 1)] });
    await loadMoreSessions();
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('列表为空时返回（无 lastSession）', async () => {
    const store = getChatStore();
    store.setState({ hasMore: true, sessions: [] });
    await loadMoreSessions();
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('成功：追加新会话到列表尾部，更新 hasMore', async () => {
    const store = getChatStore();
    store.setState({ hasMore: true, sessions: [session('a', 100)] });
    authFetchMock.mockResolvedValue(jsonRes({ sessions: [session('b', 50)], hasMore: false }));

    await loadMoreSessions();

    expect(store.getState().sessions.map(s => s.sessionId)).toEqual(['a', 'b']);
    expect(store.getState().hasMore).toBe(false);
    expect(store.getState().isLoadingMore).toBe(false);
    // before 游标 = 最后一条的 updatedAtMs
    expect(authFetchMock).toHaveBeenCalledWith(expect.stringContaining('before=100'));
  });
});

describe('loadSessionDetail', () => {
  it('命中本地缓存：先渲染缓存消息并置 activeSessionId', async () => {
    cacheStore['s1'] = [{ id: 'c1', type: 'text', content: '缓存' }];
    // detail 请求返回 200 空 blocks，避免 404 分支
    authFetchMock.mockImplementation((url: string) => {
      if (url.includes('/stats')) return Promise.resolve(jsonRes({ tokenUsage: null }));
      if (url.includes('/interactions/pending')) return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ sessionId: 's1', stats: {}, blocks: [] }));
    });

    const store = getChatStore();
    await loadSessionDetail('s1');

    expect(store.getState().activeSessionId).toBe('s1');
    // detail 加载后消息被 setMessages 覆盖（缓存先渲染已经过一遍）
    expect(cacheSaveSpy).toHaveBeenCalledWith('s1', expect.any(Array));
  });

  it('详情 200：写入 activeSessionId、拉 pending、保存缓存', async () => {
    authFetchMock.mockImplementation((url: string) => {
      if (url.includes('/stats')) return Promise.resolve(jsonRes({ tokenUsage: { totalTokens: 3 }, totalCostUsd: 0.1 }));
      if (url.includes('/interactions/pending')) return Promise.resolve(jsonRes([]));
      return Promise.resolve(jsonRes({ sessionId: 's2', stats: {}, blocks: [] }));
    });

    const store = getChatStore();
    await loadSessionDetail('s2');

    expect(store.getState().activeSessionId).toBe('s2');
    expect(cacheSaveSpy).toHaveBeenCalledWith('s2', expect.any(Array));
  });

  it('404：清空 activeSessionId 并重置消息', async () => {
    authFetchMock.mockResolvedValue(jsonRes({}, { ok: false, status: 404 }));
    const store = getChatStore();
    store.setState({ activeSessionId: 'old' });
    store.getState().addMessage({ type: 'text', content: 'x' });
    store.getState().flushMessages();

    await loadSessionDetail('s3');

    expect(store.getState().activeSessionId).toBeNull();
    expect(store.getState().messages).toHaveLength(0);
  });

  it('403：同样清空 activeSessionId', async () => {
    authFetchMock.mockResolvedValue(jsonRes({}, { ok: false, status: 403 }));
    const store = getChatStore();
    store.setState({ activeSessionId: 'old' });
    await loadSessionDetail('s4');
    expect(store.getState().activeSessionId).toBeNull();
  });

  it('网络异常：吞错，不抛出', async () => {
    authFetchMock.mockRejectedValue(new Error('net'));
    const store = getChatStore();
    await expect(loadSessionDetail('s5')).resolves.toBeUndefined();
  });
});

describe('fetchTokenUsage', () => {
  it('activeSessionId 匹配时写入 tokenUsage（含 totalCostUsd 合并）', async () => {
    authFetchMock.mockResolvedValue(jsonRes({ tokenUsage: { totalTokens: 100 }, totalCostUsd: 0.5 }));
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });

    await fetchTokenUsage('s1');

    expect(store.getState().tokenUsage).toEqual({ totalTokens: 100, totalCostUsd: 0.5 });
  });

  it('activeSessionId 不匹配（用户已切走）时不写入', async () => {
    authFetchMock.mockResolvedValue(jsonRes({ tokenUsage: { totalTokens: 100 } }));
    const store = getChatStore();
    store.setState({ activeSessionId: 'other', tokenUsage: null });

    await fetchTokenUsage('s1');

    expect(store.getState().tokenUsage).toBeNull();
  });

  it('tokenUsage 为 null 时写入 null', async () => {
    authFetchMock.mockResolvedValue(jsonRes({ tokenUsage: null }));
    const store = getChatStore();
    store.setState({ activeSessionId: 's1', tokenUsage: { totalTokens: 1 } as never });
    await fetchTokenUsage('s1');
    expect(store.getState().tokenUsage).toBeNull();
  });

  it('网络异常静默吞掉', async () => {
    authFetchMock.mockRejectedValue(new Error('x'));
    const store = getChatStore();
    store.setState({ activeSessionId: 's1' });
    await expect(fetchTokenUsage('s1')).resolves.toBeUndefined();
  });
});
