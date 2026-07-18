/**
 * streamSlice 测试 —— 流式传输控制状态
 *
 * 均为纯 state setter，无外部依赖。覆盖初值、各 setter 写入、incrementNonce 递增语义。
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createStreamSlice } from './streamSlice';
import { INITIAL_BLOCK_STATE } from '../types';
import type { ChatStore } from '../types';

function makeStore() {
  return createStore<ChatStore>()((...a) => ({
    ...createStreamSlice(...a),
  }) as ChatStore);
}

describe('streamSlice — 初始值', () => {
  it('暴露正确的初始状态', () => {
    const s = makeStore().getState();
    expect(s.loading).toBe(false);
    expect(s.stopping).toBe(false);
    expect(s.streamId).toBeNull();
    expect(s.runId).toBeNull();
    expect(s.lastEventId).toBeNull();
    expect(s.lastEventCursor).toBeNull();
    expect(s.streamNonce).toBe(0);
    expect(s.isAttached).toBe(false);
    expect(s.latestStreamSessionId).toBeNull();
    expect(s.userMsgIndex).toBe(-1);
    expect(s.blockState).toEqual(INITIAL_BLOCK_STATE);
    expect(s.pendingMessage).toBeNull();
    expect(s.lastUserSeq).toBe(0);
  });
});

describe('streamSlice — setters', () => {
  it('各标量 setter 写入对应 state', () => {
    const store = makeStore();
    store.getState().setLoading(true);
    store.getState().setStopping(true);
    store.getState().setStreamId('stream-1');
    store.getState().setRunId('run-1');
    store.getState().setLastEventId(42);
    store.getState().setLastEventCursor('cursor-x');
    store.getState().setIsAttached(true);
    store.getState().setLatestStreamSessionId('sess-9');
    store.getState().setUserMsgIndex(3);
    store.getState().setLastUserSeq(7);

    const s = store.getState();
    expect(s.loading).toBe(true);
    expect(s.stopping).toBe(true);
    expect(s.streamId).toBe('stream-1');
    expect(s.runId).toBe('run-1');
    expect(s.lastEventId).toBe(42);
    expect(s.lastEventCursor).toBe('cursor-x');
    expect(s.isAttached).toBe(true);
    expect(s.latestStreamSessionId).toBe('sess-9');
    expect(s.userMsgIndex).toBe(3);
    expect(s.lastUserSeq).toBe(7);
  });

  it('setBlockState / setPendingMessage 写入对象值', () => {
    const store = makeStore();
    const block = { currentBlockIndex: 2, currentBlockType: 'text' as const };
    store.getState().setBlockState(block);
    expect(store.getState().blockState).toEqual(block);

    const pending = { input: '你好', attachments: [] };
    store.getState().setPendingMessage(pending);
    expect(store.getState().pendingMessage).toEqual(pending);

    store.getState().setPendingMessage(null);
    expect(store.getState().pendingMessage).toBeNull();
  });

  it('incrementNonce 每次 +1 并返回新值', () => {
    const store = makeStore();
    expect(store.getState().streamNonce).toBe(0);
    const first = store.getState().incrementNonce();
    expect(first).toBe(1);
    expect(store.getState().streamNonce).toBe(1);
    const second = store.getState().incrementNonce();
    expect(second).toBe(2);
    expect(store.getState().streamNonce).toBe(2);
  });

  it('setLastEventId(null) 可清空', () => {
    const store = makeStore();
    store.getState().setLastEventId(5);
    store.getState().setLastEventId(null);
    expect(store.getState().lastEventId).toBeNull();
  });
});
