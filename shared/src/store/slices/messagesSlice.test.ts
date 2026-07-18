/**
 * messagesSlice 测试 —— 消息列表 + 流式批量更新
 *
 * 核心是内部可变数组 _messages 与 React state messages 的分离：
 * - addMessage/updateMessageAt 立即改可变数组，通过 scheduleFlush 合并到 state
 * - flushMessages 立即同步；resetMessages/setMessages 取消 pending flush
 * - shouldScroll 由 isNearBottom / 已有 shouldScroll 决定
 *
 * 用可控 scheduler 精确断言批处理（不真跑 rAF/setTimeout）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createMessagesSlice } from './messagesSlice';
import { initPlatform } from '../../platform/context';
import type { PlatformDeps } from '../../platform/types';
import type { ChatStore } from '../types';

/** 手动控制的 flush 调度：收集回调，测试里显式 runFlush() 触发 */
let flushQueue: Array<() => void>;
let cancelledIds: number[];
let flushIdSeq: number;

function makePlatform(): PlatformDeps {
  return {
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    messageCache: { save: () => {}, load: async () => null, clear: async () => {} },
    platformConfig: { getBaseUrl: () => '', getWsUrl: () => '', platform: 'web' },
    scheduleFlush: (cb) => {
      const id = ++flushIdSeq;
      flushQueue.push(cb);
      return id;
    },
    cancelFlush: (id) => { cancelledIds.push(id); },
  };
}

/** 执行所有排队的 flush 回调 */
function runFlush() {
  const q = flushQueue;
  flushQueue = [];
  for (const cb of q) cb();
}

function makeStore() {
  return createStore<ChatStore>()((...a) => ({
    ...createMessagesSlice(...a),
  }) as ChatStore);
}

beforeEach(() => {
  flushQueue = [];
  cancelledIds = [];
  flushIdSeq = 0;
  initPlatform(makePlatform());
});

describe('messagesSlice — 初始值与 ref', () => {
  it('初始 messages 空、shouldScroll false、isNearBottom true', () => {
    const s = makeStore().getState();
    expect(s.messages).toEqual([]);
    expect(s.shouldScroll).toBe(false);
    expect(s.isNearBottom).toBe(true);
    expect(s.getMessagesRef()).toEqual([]);
  });
});

describe('messagesSlice — addMessage 与批量 flush', () => {
  it('addMessage 立即进 ref 并返回索引，但 state.messages 要等 flush', () => {
    const store = makeStore();
    const idx = store.getState().addMessage({ type: 'text', content: 'a' });
    expect(idx).toBe(0);
    // ref 已更新
    expect(store.getState().getMessagesRef()).toHaveLength(1);
    // React state 尚未 flush
    expect(store.getState().messages).toHaveLength(0);
    // flush 后同步
    runFlush();
    expect(store.getState().messages).toHaveLength(1);
    expect((store.getState().messages[0] as { content: string }).content).toBe('a');
  });

  it('连续多次 addMessage 只调度一次 flush（合并写入）', () => {
    const store = makeStore();
    store.getState().addMessage({ type: 'text', content: '1' });
    store.getState().addMessage({ type: 'text', content: '2' });
    store.getState().addMessage({ type: 'text', content: '3' });
    // 只排了一个 flush 回调
    expect(flushQueue).toHaveLength(1);
    runFlush();
    expect(store.getState().messages).toHaveLength(3);
  });

  it('自动生成 id；已带 id 时保留', () => {
    const store = makeStore();
    store.getState().addMessage({ type: 'text', content: 'x' });
    store.getState().addMessage({ id: 'fixed-id', type: 'text', content: 'y' });
    const ref = store.getState().getMessagesRef();
    expect(ref[0].id).toMatch(/^msg-/);
    expect(ref[1].id).toBe('fixed-id');
  });

  it('isNearBottom 为 true 时 addMessage 置 shouldScroll', () => {
    const store = makeStore();
    expect(store.getState().isNearBottom).toBe(true);
    store.getState().addMessage({ type: 'text', content: 'a' });
    expect(store.getState().shouldScroll).toBe(true);
  });

  it('isNearBottom false 且未预置 shouldScroll 时不置 shouldScroll', () => {
    const store = makeStore();
    store.getState().setIsNearBottom(false);
    store.getState().addMessage({ type: 'text', content: 'a' });
    expect(store.getState().shouldScroll).toBe(false);
  });
});

describe('messagesSlice — updateMessageAt', () => {
  it('更新指定 index 的消息内容', () => {
    const store = makeStore();
    store.getState().addMessage({ type: 'text', content: '原始' });
    runFlush();
    store.getState().updateMessageAt(0, (m) => ({ ...m, content: '更新后' } as typeof m));
    runFlush();
    expect((store.getState().messages[0] as { content: string }).content).toBe('更新后');
  });

  it('越界 index 直接返回，不改动、不调度 flush', () => {
    const store = makeStore();
    store.getState().addMessage({ type: 'text', content: 'a' });
    runFlush();
    flushQueue = [];
    store.getState().updateMessageAt(99, (m) => m);
    store.getState().updateMessageAt(-1, (m) => m);
    expect(flushQueue).toHaveLength(0);
    expect((store.getState().getMessagesRef()[0] as { content: string }).content).toBe('a');
  });
});

describe('messagesSlice — flushMessages / resetMessages / setMessages', () => {
  it('flushMessages 立即同步 ref 到 state 并取消 pending flush', () => {
    const store = makeStore();
    store.getState().addMessage({ type: 'text', content: 'a' });
    // 有 pending flush（id=1）
    expect(store.getState().messages).toHaveLength(0);
    store.getState().flushMessages();
    expect(store.getState().messages).toHaveLength(1);
    // pending flush 已被取消
    expect(cancelledIds).toContain(1);
  });

  it('resetMessages 清空 ref 与 state 并取消 pending flush', () => {
    const store = makeStore();
    store.getState().addMessage({ type: 'text', content: 'a' });
    store.getState().resetMessages();
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().getMessagesRef()).toEqual([]);
    expect(cancelledIds).toContain(1);
  });

  it('setMessages 补齐缺失 id 并直接写入 state', () => {
    const store = makeStore();
    store.getState().setMessages([
      { type: 'text', content: 'a' },
      { id: 'keep', type: 'text', content: 'b' },
    ]);
    const msgs = store.getState().messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toMatch(/^msg-/);
    expect(msgs[1].id).toBe('keep');
    // ref 与 state 一致
    expect(store.getState().getMessagesRef()).toEqual(msgs);
  });
});

describe('messagesSlice — 滚动标志 setter', () => {
  it('triggerScroll / setShouldScroll / setIsNearBottom', () => {
    const store = makeStore();
    store.getState().triggerScroll();
    expect(store.getState().shouldScroll).toBe(true);
    store.getState().setShouldScroll(false);
    expect(store.getState().shouldScroll).toBe(false);
    store.getState().setIsNearBottom(false);
    expect(store.getState().isNearBottom).toBe(false);
  });
});
