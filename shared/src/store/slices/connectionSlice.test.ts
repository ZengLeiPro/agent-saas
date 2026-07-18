/**
 * connectionSlice 测试 —— WS 连接状态机
 *
 * 覆盖状态机所有动作分支、非法动作保持原状、以及“状态不变则不触发 set”的优化。
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createConnectionSlice } from './connectionSlice';
import type { ChatStore } from '../types';

/** 只挂载 connection slice 的最小 store（其它 slice 方法在本组用例中不被触碰） */
function makeStore() {
  return createStore<ChatStore>()((...a) => ({
    ...createConnectionSlice(...a),
  }) as ChatStore);
}

describe('connectionSlice — dispatchConnection 状态机', () => {
  it('初始状态为 idle', () => {
    const store = makeStore();
    expect(store.getState().connectionState).toBe('idle');
  });

  it('各动作按 reducer 映射到目标状态', () => {
    // connect → connected
    const s1 = makeStore();
    s1.getState().dispatchConnection('connect');
    expect(s1.getState().connectionState).toBe('connected');

    // drop → reconnecting（先 connect 建立基线）
    const s2 = makeStore();
    s2.getState().dispatchConnection('connect');
    s2.getState().dispatchConnection('drop');
    expect(s2.getState().connectionState).toBe('reconnecting');

    // reconnect_ok → connected
    const s3 = makeStore();
    s3.getState().dispatchConnection('drop');
    s3.getState().dispatchConnection('reconnect_ok');
    expect(s3.getState().connectionState).toBe('connected');

    // reconnect_fail → disconnected
    const s4 = makeStore();
    s4.getState().dispatchConnection('reconnect_fail');
    expect(s4.getState().connectionState).toBe('disconnected');

    // complete → idle
    const s5 = makeStore();
    s5.getState().dispatchConnection('connect');
    s5.getState().dispatchConnection('complete');
    expect(s5.getState().connectionState).toBe('idle');

    // reset → idle
    const s6 = makeStore();
    s6.getState().dispatchConnection('connect');
    s6.getState().dispatchConnection('reset');
    expect(s6.getState().connectionState).toBe('idle');
  });

  it('非法动作保持当前状态不变', () => {
    const store = makeStore();
    store.getState().dispatchConnection('connect');
    // @ts-expect-error 故意传入未知动作，验证 default 分支
    store.getState().dispatchConnection('unknown-action');
    expect(store.getState().connectionState).toBe('connected');
  });

  it('目标状态与当前一致时不触发 setState（对象引用不变）', () => {
    const store = makeStore();
    store.getState().dispatchConnection('connect');
    let notified = 0;
    const unsub = store.subscribe(() => { notified++; });
    // 已是 connected，再次 connect 不应引发订阅回调
    store.getState().dispatchConnection('connect');
    unsub();
    expect(notified).toBe(0);
  });

  it('drop→reconnect_ok 完整重连闭环', () => {
    const store = makeStore();
    store.getState().dispatchConnection('connect');
    store.getState().dispatchConnection('drop');
    expect(store.getState().connectionState).toBe('reconnecting');
    store.getState().dispatchConnection('reconnect_ok');
    expect(store.getState().connectionState).toBe('connected');
  });
});
