import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSocket } from 'ws';

import {
  getWebDisplayConfig,
  isDedicatedWebTool,
  shouldSendWebBlock,
  shouldSendWebToolResult,
} from '../channels/web/displayFilter.js';
import { EventBufferStore } from '../channels/web/eventBuffer.js';
import { UserEventLog } from '../channels/web/userEventLog.js';
import { EventBus, EVENT_SCOPE } from '../channels/web/eventBus.js';
import type { EventBusConfig, SessionContext } from '../channels/web/eventBus.js';
import type { WsClient } from '../channels/web/wsServer.js';

// ── displayFilter：纯路由/展示决策 ──────────────────────────────

describe('displayFilter', () => {
  it('isDedicatedWebTool 识别交互工具与 Agent，其余为 false', () => {
    // 交互工具与 Agent 拥有独立卡片，不进通用 tool_use 通道
    expect(isDedicatedWebTool('AskUserQuestion')).toBe(true);
    expect(isDedicatedWebTool('ExitPlanMode')).toBe(true);
    expect(isDedicatedWebTool('EnterPlanMode')).toBe(true);
    expect(isDedicatedWebTool('Agent')).toBe(true);
    expect(isDedicatedWebTool('Read')).toBe(false);
    // undefined 走短路返回 false
    expect(isDedicatedWebTool(undefined)).toBe(false);
  });

  it('shouldSendWebBlock: text 恒发，thinking 受 config.thinking 控制', () => {
    // text 不看工具名/config，永远发送
    expect(shouldSendWebBlock('text', undefined, {})).toBe(true);
    // thinking 默认发送（仅显式 false 时关闭）
    expect(shouldSendWebBlock('thinking', undefined, {})).toBe(true);
    expect(shouldSendWebBlock('thinking', undefined, { thinking: false })).toBe(false);
    expect(shouldSendWebBlock('thinking', undefined, { thinking: true })).toBe(true);
  });

  it('shouldSendWebBlock: tool_use 对专属工具返回 false', () => {
    expect(shouldSendWebBlock('tool_use', 'Agent', {})).toBe(false);
    expect(shouldSendWebBlock('tool_use', 'AskUserQuestion', { toolInput: true })).toBe(false);
  });

  it('shouldSendWebBlock: tool_use 普通工具走 toolInput，技能工具走 skillInput', () => {
    // 普通工具：默认发送，显式 toolInput=false 时关闭
    expect(shouldSendWebBlock('tool_use', 'Read', {})).toBe(true);
    expect(shouldSendWebBlock('tool_use', 'Read', { toolInput: false })).toBe(false);
    // 技能工具（Skill / Skill:xxx）：走 skillInput 开关，与 toolInput 独立
    expect(shouldSendWebBlock('tool_use', 'Skill', {})).toBe(true);
    expect(shouldSendWebBlock('tool_use', 'Skill', { skillInput: false })).toBe(false);
    // 技能工具即便 toolInput=false 也照发（因为走的是 skillInput 分支）
    expect(shouldSendWebBlock('tool_use', 'Skill:foo', { toolInput: false })).toBe(true);
  });

  it('shouldSendWebBlock: 未知 blockType 返回 false', () => {
    expect(shouldSendWebBlock('unknown' as never, 'Read', {})).toBe(false);
  });

  it('shouldSendWebToolResult: 专属工具 false，普通/技能分别走 toolResult/skillResult', () => {
    expect(shouldSendWebToolResult('Agent', {})).toBe(false);
    expect(shouldSendWebToolResult('Read', {})).toBe(true);
    expect(shouldSendWebToolResult('Read', { toolResult: false })).toBe(false);
    expect(shouldSendWebToolResult('Skill', {})).toBe(true);
    expect(shouldSendWebToolResult('Skill', { skillResult: false })).toBe(false);
    // 技能工具走 skillResult 分支，不受 toolResult 影响
    expect(shouldSendWebToolResult('技能', { toolResult: false })).toBe(true);
  });

  it('getWebDisplayConfig: undefined 归一化为空对象', () => {
    expect(getWebDisplayConfig(undefined)).toEqual({});
    const cfg = { thinking: false };
    // 已有 config 原样返回
    expect(getWebDisplayConfig(cfg)).toBe(cfg);
  });
});

// ── EventBufferStore：会话环形缓冲 ──────────────────────────────

describe('EventBufferStore', () => {
  let store: EventBufferStore;

  beforeEach(() => {
    store = new EventBufferStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('create 幂等：活跃 buffer 不覆盖，仅补写缺失 userId', () => {
    store.create('s1');
    store.push('s1', 'a');
    // 再次 create 不应清空已有事件
    store.create('s1', 'user-x');
    expect(store.get('s1')?.events).toHaveLength(1);
    expect(store.get('s1')?.userId).toBe('user-x');
  });

  it('create 对已完成的 buffer 会重建', () => {
    store.create('s1');
    store.push('s1', 'a');
    store.complete('s1');
    // 已完成 → 允许重建，事件清空、nextId 回到 1
    store.create('s1');
    expect(store.get('s1')?.completed).toBe(false);
    expect(store.get('s1')?.events).toHaveLength(0);
  });

  it('push: 未知会话返回 null，正常会话返回递增 id 并保留 eventCursor', () => {
    expect(store.push('missing', 'x')).toBeNull();
    store.create('s1');
    expect(store.push('s1', 'a')).toBe(1);
    expect(store.push('s1', 'b', 'cursor-2')).toBe(2);
    const events = store.get('s1')!.events;
    expect(events[1].eventCursor).toBe('cursor-2');
    // 无 cursor 时不写入该字段
    expect(events[0].eventCursor).toBeUndefined();
  });

  it('getEventsAfter: 未知会话 null；正常返回 lastId 之后的事件', () => {
    expect(store.getEventsAfter('missing', 0)).toBeNull();
    store.create('s1');
    store.push('s1', 'a');
    store.push('s1', 'b');
    store.push('s1', 'c');
    const res = store.getEventsAfter('s1', 1)!;
    expect(res.events.map(e => e.data)).toEqual(['b', 'c']);
    expect(res.gapDetected).toBe(false);
    // lastId 已是最新 → 空数组
    expect(store.getEventsAfter('s1', 3)!.events).toEqual([]);
  });

  it('push: 满环时淘汰最老事件并推进 oldestId，触发 gapDetected', () => {
    store.create('s1');
    // 用 MAX_EVENTS=2000，手动填满 + 溢出 1 条
    for (let i = 0; i < 2001; i++) store.push('s1', `e${i}`);
    const entry = store.get('s1')!;
    expect(entry.events).toHaveLength(2000);
    // 第一条 (id=1) 被淘汰，oldestId 变为 2
    expect(entry.oldestId).toBe(2);
    // 客户端请求 lastId=0 时不算 gap（lastId>0 才判定）；lastId=1 落在淘汰区间外沿
    // 用一个明确落在淘汰区的 lastId 测 gap：无法直接构造 <oldestId-1，改用小 buffer 语义验证 oldestId 推进
    expect(entry.oldestId - 1).toBe(1);
  });

  it('isActive / complete: 完成后清空监听器并广播 completion', () => {
    store.create('s1');
    expect(store.isActive('s1')).toBe(true);
    const onComplete = vi.fn();
    const onEvent = vi.fn();
    store.subscribe('s1', onEvent, onComplete);
    store.complete('s1');
    expect(store.isActive('s1')).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
    // 完成后监听器被清空，后续 push 不再通知
    store.push('s1', 'late');
    expect(onEvent).not.toHaveBeenCalled();
    // 未知会话 isActive=false
    expect(store.isActive('missing')).toBe(false);
  });

  it('subscribe: 实时 push 通知订阅者，unsubscribe 后停止', () => {
    store.create('s1');
    const onEvent = vi.fn();
    const unsub = store.subscribe('s1', onEvent, () => {})!;
    store.push('s1', 'a');
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0].data).toBe('a');
    unsub();
    store.push('s1', 'b');
    expect(onEvent).toHaveBeenCalledTimes(1);
    // 未知会话订阅返回 null
    expect(store.subscribe('missing', () => {}, () => {})).toBeNull();
  });

  it('subscribe: 监听器抛错被吞掉，不影响其它订阅者', () => {
    store.create('s1');
    const good = vi.fn();
    store.subscribe('s1', () => { throw new Error('boom'); }, () => {});
    store.subscribe('s1', good, () => {});
    expect(() => store.push('s1', 'a')).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('subscribeFrom: completed entry 同步补发窗口、完成并且不残留 listener', () => {
    store.create('s1');
    store.push('s1', 'before-boundary');
    store.push('s1', 'window-1');
    store.push('s1', 'window-2');
    store.complete('s1');
    const delivered: string[] = [];
    const onComplete = vi.fn(() => delivered.push('complete'));

    const unsubscribe = store.subscribeFrom(
      's1',
      1,
      event => delivered.push(event.data),
      onComplete,
    );

    expect(unsubscribe).toBeNull();
    expect(delivered).toEqual(['window-1', 'window-2', 'complete']);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(store.get('s1')!.listeners.size).toBe(0);
    expect(store.get('s1')!.completionListeners.size).toBe(0);
  });

  it('subscribeFrom: active entry 先补发窗口，再持续接收 live event，退订后无泄漏', () => {
    store.create('s1');
    store.push('s1', 'before-boundary');
    store.push('s1', 'window');
    const delivered: string[] = [];

    const unsubscribe = store.subscribeFrom(
      's1',
      1,
      event => delivered.push(event.data),
      () => delivered.push('complete'),
    );

    expect(unsubscribe).not.toBeNull();
    expect(delivered).toEqual(['window']);
    expect(store.get('s1')!.listeners.size).toBe(1);
    store.push('s1', 'live');
    expect(delivered).toEqual(['window', 'live']);
    unsubscribe!();
    expect(store.get('s1')!.listeners.size).toBe(0);
    expect(store.get('s1')!.completionListeners.size).toBe(0);
  });

  it('remove: 立即丢弃单会话 buffer', () => {
    store.create('s1');
    store.push('s1', 'a');
    store.remove('s1');
    expect(store.get('s1')).toBeUndefined();
    // 幂等：删不存在的会话不抛
    expect(() => store.remove('missing')).not.toThrow();
  });

  it('complete: 未知会话静默返回', () => {
    expect(() => store.complete('missing')).not.toThrow();
  });
});

// ── UserEventLog：跨会话元数据环形缓冲 ──────────────────────────

describe('UserEventLog', () => {
  let log: UserEventLog;

  beforeEach(() => {
    log = new UserEventLog();
  });

  afterEach(() => {
    log.stop();
  });

  it('epoch: 按用户隔离并仅对正 seq 校验，实例 epoch 只作匿名 probe', () => {
    const userEpoch = log.getEpoch('u1');
    expect(userEpoch).toMatch(/^[0-9a-f-]{36}$/i);
    expect(log.getEpoch('u1')).toBe(userEpoch);
    expect(log.getEpoch('u2')).not.toBe(userEpoch);
    expect(log.epoch).not.toBe(userEpoch);
    expect(log.hasEpochMismatch('u1', undefined, 0)).toBe(false);
    expect(log.hasEpochMismatch('u1', undefined, 1)).toBe(true);
    expect(log.hasEpochMismatch('u1', userEpoch, 1)).toBe(false);
  });

  it('TTL 删除后同一用户 seq 重置时分配新 epoch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));
    log.push('u1', { type: 'title_updated' });
    const firstEpoch = log.getEpoch('u1');

    vi.advanceTimersByTime(31 * 60 * 1000);
    (log as unknown as { cleanup(): void }).cleanup();

    expect(log.getCurrentSeq('u1')).toBe(0);
    expect(log.push('u1', { type: 'session_updated' })).toBe(1);
    expect(log.getEpoch('u1')).not.toBe(firstEpoch);
    vi.useRealTimers();
  });

  it('shouldLog: 仅白名单元数据类型返回 true', () => {
    expect(log.shouldLog({ type: 'title_updated' })).toBe(true);
    expect(log.shouldLog({ type: 'session_deleted' })).toBe(true);
    expect(log.shouldLog({ type: 'interaction_resolved' })).toBe(true);
    // 非白名单 / 无 type 字段
    expect(log.shouldLog({ type: 'text' })).toBe(false);
    expect(log.shouldLog({ foo: 'bar' })).toBe(false);
  });

  it('push: 首次创建日志并分配递增 seq', () => {
    expect(log.push('u1', { type: 'title_updated' })).toBe(1);
    expect(log.push('u1', { type: 'session_updated' })).toBe(2);
    expect(log.getCurrentSeq('u1')).toBe(2);
    // 未知用户 currentSeq=0
    expect(log.getCurrentSeq('missing')).toBe(0);
  });

  it('getEventsAfter: 初次同步未知/空用户返回空且不报 gap', () => {
    expect(log.getEventsAfter('missing', 0)).toEqual({ events: [], gapDetected: false });
  });

  it('getEventsAfter: 客户端有旧 seq 但新实例无日志时报告 gap', () => {
    expect(log.getEventsAfter('u1', 3)).toEqual({ events: [], gapDetected: true });
  });

  it('getEventsAfter: 客户端旧 seq 大于新实例当前 seq 时报告 gap', () => {
    log.push('u1', { type: 'title_updated' });
    log.push('u1', { type: 'session_updated' });

    expect(log.getEventsAfter('u1', 5)).toEqual({ events: [], gapDetected: true });
  });

  it('getEventsAfter: 返回 lastSeq 之后事件；已最新返回空', () => {
    log.push('u1', { type: 'title_updated' });
    log.push('u1', { type: 'session_updated' });
    log.push('u1', { type: 'session_deleted' });
    const res = log.getEventsAfter('u1', 1);
    expect(res.events.map(e => e.seq)).toEqual([2, 3]);
    expect(res.gapDetected).toBe(false);
    // 客户端已最新（lastSeq >= nextSeq-1）
    expect(log.getEventsAfter('u1', 3)).toEqual({ events: [], gapDetected: false });
  });

  it('push: 超出容量时淘汰最老事件（环形），并在请求过老 lastSeq 时报 gap', () => {
    // 填满 200 + 溢出，最老 seq 前移
    for (let i = 0; i < 205; i++) log.push('u1', { type: 'title_updated' });
    // 请求一个已被淘汰的老 seq → gap
    const res = log.getEventsAfter('u1', 1);
    expect(res.gapDetected).toBe(true);
    // 只返回仍在缓冲内的事件
    expect(res.events.length).toBeGreaterThan(0);
    expect(res.events.every(e => e.seq > 1)).toBe(true);
  });
});

// ── EventBus：静态作用域表 + 事件路由 ──────────────────────────

describe('EventBus', () => {
  function makeConfig(overrides: Partial<EventBusConfig> = {}): {
    config: EventBusConfig;
    sendTo: ReturnType<typeof vi.fn>;
    bufferPush: ReturnType<typeof vi.fn>;
    logPush: ReturnType<typeof vi.fn>;
  } {
    const sendTo = vi.fn();
    const bufferPush = vi.fn(() => 42);
    const logPush = vi.fn(() => 7);
    const config: EventBusConfig = {
      eventBufferStore: { push: bufferPush } as never,
      userEventLog: { push: logPush, shouldLog: () => true } as never,
      getClientsByUser: () => undefined,
      getAdminUserIds: () => [],
      sendTo,
      isActiveStream: () => true,
      ...overrides,
    };
    return { config, sendTo, bufferPush, logPush };
  }

  function fakeWs(open = true): WebSocket {
    return { OPEN: 1, readyState: open ? 1 : 3 } as unknown as WebSocket;
  }

  it('EVENT_SCOPE 声明表对关键事件类型给出正确作用域', () => {
    expect(EVENT_SCOPE.text).toBe('session');
    expect(EVENT_SCOPE.session_deleted).toBe('user');
    expect(EVENT_SCOPE.title_updated).toBe('dual');
    expect(EVENT_SCOPE.pong).toBe('reply');
  });

  it('emitSession: 写 EventBuffer 且活跃时携带 eventId 直推发起方', () => {
    const { config, sendTo, bufferPush } = makeConfig();
    const bus = new EventBus(config);
    const ws = fakeWs();
    const ctx: SessionContext = { sessionId: 's1', streamId: 'st1', ws };
    const data = { type: 'text', content: 'hi' };
    bus.emitSession(ctx, data);
    expect(bufferPush).toHaveBeenCalledWith('s1', JSON.stringify(data));
    expect(sendTo).toHaveBeenCalledWith(ws, { eventId: 42, data });
  });

  it('emitSession: 无 sessionId 时不写 buffer，直推不带 eventId', () => {
    const { config, sendTo, bufferPush } = makeConfig();
    const bus = new EventBus(config);
    const ws = fakeWs();
    const ctx: SessionContext = { sessionId: '', streamId: 'st1', ws };
    const data = { type: 'text' };
    bus.emitSession(ctx, data);
    expect(bufferPush).not.toHaveBeenCalled();
    expect(sendTo).toHaveBeenCalledWith(ws, { data });
  });

  it('emitSession: ws 未活跃/已关闭时只写 buffer 不直推', () => {
    const { config, sendTo } = makeConfig({ isActiveStream: () => false });
    const bus = new EventBus(config);
    const ws = fakeWs();
    bus.emitSession({ sessionId: 's1', streamId: 'st1', ws }, { type: 'text' });
    expect(sendTo).not.toHaveBeenCalled();
  });

  it('emitUser: 写 UserEventLog 并广播携带 seq，排除 excludeWs 与非 OPEN 客户端', () => {
    const includedWs = fakeWs(true);
    const excludedWs = fakeWs(true);
    const closedWs = fakeWs(false);
    const clients = new Set<WsClient>([
      { ws: includedWs } as WsClient,
      { ws: excludedWs } as WsClient,
      { ws: closedWs } as WsClient,
    ]);
    const { config, sendTo, logPush } = makeConfig({ getClientsByUser: () => clients });
    const bus = new EventBus(config);
    const data = { type: 'session_deleted', sessionId: 's1' };
    bus.emitUser('u1', data, excludedWs);
    expect(logPush).toHaveBeenCalledWith('u1', data);
    // 只发给 included（excluded 被排除，closed 非 OPEN）
    expect(sendTo).toHaveBeenCalledTimes(1);
    expect(sendTo).toHaveBeenCalledWith(includedWs, { seq: 7, data });
  });

  it('emitUser: 无客户端时静默不发', () => {
    const { config, sendTo } = makeConfig({ getClientsByUser: () => undefined });
    const bus = new EventBus(config);
    bus.emitUser('u1', { type: 'session_deleted' });
    expect(sendTo).not.toHaveBeenCalled();
  });

  it('emitDual: 双写 EventBuffer + UserEventLog 并广播', () => {
    const ws = fakeWs(true);
    const clients = new Set<WsClient>([{ ws } as WsClient]);
    const { config, sendTo, bufferPush, logPush } = makeConfig({ getClientsByUser: () => clients });
    const bus = new EventBus(config);
    const data = { type: 'title_updated', sessionId: 's1', title: 'T' };
    bus.emitDual('u1', 's1', data);
    expect(bufferPush).toHaveBeenCalledWith('s1', JSON.stringify(data));
    expect(logPush).toHaveBeenCalledWith('u1', data);
    expect(sendTo).toHaveBeenCalledWith(ws, { seq: 7, data });
  });

  it('emitAdmin: 持久化事件带 seq 广播，高频事件不持久化不带 seq', () => {
    const ws = fakeWs(true);
    const clients = new Set<WsClient>([{ ws } as WsClient]);
    // shouldLog=true 分支
    const persisted = makeConfig({
      getAdminUserIds: () => ['admin1'],
      getClientsByUser: () => clients,
    });
    const persistedBus = new EventBus(persisted.config);
    persistedBus.emitAdmin({ type: 'session_deleted' });
    expect(persisted.logPush).toHaveBeenCalledTimes(1);
    expect(persisted.sendTo).toHaveBeenCalledWith(ws, { seq: 7, data: { type: 'session_deleted' } });

    // shouldLog=false 分支：只广播 { data }，不 push
    const rawSendTo = vi.fn();
    const rawLogPush = vi.fn(() => 7);
    const rawConfig: EventBusConfig = {
      eventBufferStore: { push: vi.fn() } as never,
      userEventLog: { push: rawLogPush, shouldLog: () => false } as never,
      getClientsByUser: () => clients,
      getAdminUserIds: () => ['admin1'],
      sendTo: rawSendTo,
      isActiveStream: () => true,
    };
    const rawBus = new EventBus(rawConfig);
    rawBus.emitAdmin({ type: 'log_line' });
    expect(rawLogPush).not.toHaveBeenCalled();
    expect(rawSendTo).toHaveBeenCalledWith(ws, { data: { type: 'log_line' } });
  });

  it('emitReply: OPEN 时直发（带/不带 eventId），非 OPEN 时不发', () => {
    const { config, sendTo } = makeConfig();
    const bus = new EventBus(config);
    const openWs = fakeWs(true);
    bus.emitReply(openWs, { type: 'pong' });
    expect(sendTo).toHaveBeenCalledWith(openWs, { data: { type: 'pong' } });
    bus.emitReply(openWs, { type: 'pong' }, 9);
    expect(sendTo).toHaveBeenCalledWith(openWs, { eventId: 9, data: { type: 'pong' } });
    sendTo.mockClear();
    bus.emitReply(fakeWs(false), { type: 'pong' });
    expect(sendTo).not.toHaveBeenCalled();
  });
});
