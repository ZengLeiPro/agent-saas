/**
 * sessionSlice 测试 —— 会话列表 + 活跃会话状态
 *
 * 重点覆盖有真实逻辑的方法：updateSessionMeta（按 updatedAtMs 降序排序 + 字段合并）、
 * upsertSession（新增/更新分支 + 排序）、removeSession（跨 slice 清理活跃会话）。
 * 简单 setter 抽样验证即可。
 *
 * removeSession 依赖 messagesSlice.resetMessages，故用完整 store + 初始化 platform。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { initPlatform } from '../../platform/context';
import type { PlatformDeps } from '../../platform/types';
import { createChatStore } from '../createStore';
import type { ApiSessionListItem } from '../../types/session';

/** 最小可用 platform 桩：仅需 scheduleFlush/cancelFlush 让 messagesSlice 不报错 */
function makePlatform(): PlatformDeps {
  return {
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    messageCache: { save: () => {}, load: async () => null, clear: async () => {} },
    platformConfig: { getBaseUrl: () => '', getWsUrl: () => '', platform: 'web' },
    scheduleFlush: (cb) => { cb(); return 0; },
    cancelFlush: () => {},
  };
}

function session(id: string, updatedAtMs: number, extra: Partial<ApiSessionListItem> = {}): ApiSessionListItem {
  return { sessionId: id, updatedAtMs, source: { type: 'web', label: 'WEB' }, ...extra };
}

beforeEach(() => {
  initPlatform(makePlatform());
});

describe('sessionSlice — 简单 setter', () => {
  it('setActiveSessionId / setSessions / 布尔与对象 setter 写入 state', () => {
    const store = createChatStore();
    store.getState().setActiveSessionId('s1');
    store.getState().setSessions([session('s1', 100)]);
    store.getState().setIsLoadingSessions(true);
    store.getState().setIsNewSession(true);
    store.getState().setTokenUsage({ totalTokens: 5 } as never);
    store.getState().setHasMore(false);
    store.getState().setIsLoadingMore(true);
    store.getState().setDeleteSessionId('s1');
    store.getState().setSessionOwner('alice');

    const s = store.getState();
    expect(s.activeSessionId).toBe('s1');
    expect(s.sessions).toHaveLength(1);
    expect(s.isLoadingSessions).toBe(true);
    expect(s.isNewSession).toBe(true);
    expect(s.tokenUsage).toEqual({ totalTokens: 5 });
    expect(s.hasMore).toBe(false);
    expect(s.isLoadingMore).toBe(true);
    expect(s.deleteSessionId).toBe('s1');
    expect(s.sessionOwner).toBe('alice');
  });
});

describe('sessionSlice — updateSessionTitle', () => {
  it('仅更新匹配会话的 title，其它不变', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 200, { title: '旧A' }), session('b', 100, { title: '旧B' })]);
    store.getState().updateSessionTitle('a', '新A');
    const s = store.getState().sessions;
    expect(s.find(x => x.sessionId === 'a')!.title).toBe('新A');
    expect(s.find(x => x.sessionId === 'b')!.title).toBe('旧B');
  });
});

describe('sessionSlice — updateSessionMeta', () => {
  it('合并 preview/title/updatedAtMs 并按 updatedAtMs 降序重排', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 100), session('b', 200)]);
    // 把 a 的 updatedAtMs 提升到最大 → a 应排到最前
    store.getState().updateSessionMeta('a', { preview: '预览A', updatedAtMs: 300, title: '标题A' });
    const s = store.getState().sessions;
    expect(s[0].sessionId).toBe('a');
    expect(s[0].preview).toBe('预览A');
    expect(s[0].title).toBe('标题A');
    expect(s[0].updatedAtMs).toBe(300);
    // undefined 字段不覆盖
    expect(s[1].sessionId).toBe('b');
  });

  it('patch 中 undefined 字段不写入', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 100, { preview: '原始', title: '原标题' })]);
    store.getState().updateSessionMeta('a', { updatedAtMs: 150 });
    const a = store.getState().sessions[0];
    expect(a.preview).toBe('原始');
    expect(a.title).toBe('原标题');
    expect(a.updatedAtMs).toBe(150);
  });
});

describe('sessionSlice — upsertSession', () => {
  it('sessionId 不存在时前插新条目并排序', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 100)]);
    store.getState().upsertSession({ sessionId: 'b', updatedAtMs: 200, title: '新会话' });
    const s = store.getState().sessions;
    expect(s).toHaveLength(2);
    expect(s[0].sessionId).toBe('b'); // 更新时间更大排最前
    expect(s[0].title).toBe('新会话');
    expect(s[0].source).toEqual({ type: 'web', label: 'WEB' });
  });

  it('sessionId 已存在时就地合并字段', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 100, { title: '旧' })]);
    store.getState().upsertSession({ sessionId: 'a', updatedAtMs: 300, preview: 'P' });
    const s = store.getState().sessions;
    expect(s).toHaveLength(1);
    expect(s[0].title).toBe('旧'); // 未提供不覆盖
    expect(s[0].preview).toBe('P');
    expect(s[0].updatedAtMs).toBe(300);
  });
});

describe('sessionSlice — removeSession', () => {
  it('删除非活跃会话仅从列表移除，不动 activeSessionId', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 100), session('b', 200)]);
    store.getState().setActiveSessionId('a');
    store.getState().removeSession('b');
    expect(store.getState().sessions.map(s => s.sessionId)).toEqual(['a']);
    expect(store.getState().activeSessionId).toBe('a');
  });

  it('删除当前活跃会话时清空 activeSessionId/tokenUsage 并重置消息', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 100)]);
    store.getState().setActiveSessionId('a');
    store.getState().setTokenUsage({ totalTokens: 9 } as never);
    store.getState().addMessage({ type: 'text', content: 'hi' });
    store.getState().flushMessages();
    expect(store.getState().messages.length).toBe(1);

    store.getState().removeSession('a');
    expect(store.getState().sessions).toHaveLength(0);
    expect(store.getState().activeSessionId).toBeNull();
    expect(store.getState().tokenUsage).toBeNull();
    expect(store.getState().messages).toHaveLength(0);
  });
});

describe('sessionSlice — updateSessionStatus', () => {
  it('当前为 no-op，不抛错也不改动 sessions', () => {
    const store = createChatStore();
    store.getState().setSessions([session('a', 100)]);
    const before = store.getState().sessions;
    store.getState().updateSessionStatus('a', 'busy');
    expect(store.getState().sessions).toBe(before);
  });
});
