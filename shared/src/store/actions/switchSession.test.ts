/**
 * switchSession / newSession 测试 —— 原子会话切换
 *
 * 验证一次性重置 session + stream + messages，并向服务端发 detach。
 * 外部边界只 mock wsClient.send；store 用真实单例（每例 reset）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── mock 外部边界：wsClient ──
const wsSend = vi.fn();
vi.mock('../../lib/wsClient', () => ({
  wsClient: { send: (...a: unknown[]) => wsSend(...a) },
}));

import { switchSession, newSession } from './switchSession';
import { getChatStore, resetChatStore } from '../index';
import { initPlatform } from '../../platform/context';
import type { PlatformDeps } from '../../platform/types';

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

beforeEach(() => {
  resetChatStore();
  initPlatform(makePlatform());
  wsSend.mockClear();
});

describe('switchSession', () => {
  it('切到新会话：重置所有 stream/loading 状态、清空消息、发 detach', () => {
    const store = getChatStore();
    // 造一个“正在流式中”的旧会话状态
    store.setState({
      activeSessionId: 'old',
      loading: true,
      stopping: true,
      isAttached: true,
      streamId: 's-old',
      runId: 'r-old',
      streamNonce: 5,
      tokenUsage: { totalTokens: 1 } as never,
      sessionOwner: 'bob',
      userMsgIndex: 2,
    });
    store.getState().addMessage({ type: 'text', content: '旧消息' });
    store.getState().flushMessages();

    switchSession('new');

    const s = store.getState();
    expect(s.activeSessionId).toBe('new');
    expect(s.isNewSession).toBe(false);
    expect(s.loading).toBe(false);
    expect(s.stopping).toBe(false);
    expect(s.isAttached).toBe(false);
    expect(s.streamId).toBeNull();
    expect(s.runId).toBeNull();
    expect(s.tokenUsage).toBeNull();
    expect(s.sessionOwner).toBeUndefined();
    expect(s.userMsgIndex).toBe(-1);
    expect(s.streamNonce).toBe(6); // 递增
    expect(s.messages).toHaveLength(0); // resetMessages
    expect(wsSend).toHaveBeenCalledWith({ action: 'detach' });
  });

  it('目标等于当前活跃会话时直接返回，不 detach', () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 'same' });
    switchSession('same');
    expect(wsSend).not.toHaveBeenCalled();
    expect(store.getState().activeSessionId).toBe('same');
  });
});

describe('newSession', () => {
  it('清空会话与消息、置 isNewSession，发 detach', () => {
    const store = getChatStore();
    store.setState({ activeSessionId: 'old', streamNonce: 2, tokenUsage: { totalTokens: 1 } as never });
    store.getState().addMessage({ type: 'text', content: 'x' });
    store.getState().flushMessages();

    newSession();

    const s = store.getState();
    expect(s.activeSessionId).toBeNull();
    expect(s.isNewSession).toBe(true);
    expect(s.tokenUsage).toBeNull();
    expect(s.messages).toHaveLength(0);
    expect(s.streamNonce).toBe(3);
    expect(wsSend).toHaveBeenCalledWith({ action: 'detach' });
  });
});
