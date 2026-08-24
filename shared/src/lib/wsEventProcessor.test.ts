/**
 * wsEventProcessor.ts 测试
 *
 * 纯逻辑：输入单条 WS 事件 → 通过 MessagesController 输出状态变更 / 消息更新。
 * 逐类事件类型构造输入并断言输出的消息数组 / 回调触发正确。
 *
 * 关键做法：用一个基于内存数组的 fakeController 复刻 addMessage / updateMessageAt /
 * setMessages 的真实语义（addMessage 返回下标、updateMessageAt 就地替换），
 * 这样断言的就是真实的 messages 终态，而非 mock 调用次数。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { MessageItem, MessageItemInput } from '../types/message';
import type { WsEvent } from '../types/ws';
import {
  processWsEvent,
  type MessagesController,
  type WsProcessingContext,
  type WsBlockState,
} from './wsEventProcessor';

// ── 内存版 MessagesController：复刻真实语义，便于对终态数组断言 ──────────────
interface FakeController extends MessagesController {
  messages: MessageItem[];
  scrollCount: number;
}

let idSeq = 0;
function makeController(initial: MessageItem[] = []): FakeController {
  const messages: MessageItem[] = [...initial];
  const ctrl: FakeController = {
    messages,
    scrollCount: 0,
    messagesRef: { current: messages },
    addMessage: (m: MessageItemInput) => {
      const withId = { ...m, id: m.id ?? `m${idSeq++}` } as MessageItem;
      messages.push(withId);
      return messages.length - 1;
    },
    updateMessageAt: (index: number, updater: (msg: MessageItem) => MessageItem) => {
      if (index < 0 || index >= messages.length) return;
      messages[index] = updater(messages[index]);
    },
    setMessages: (next: MessageItemInput[]) => {
      messages.length = 0;
      for (const m of next) messages.push({ ...m, id: (m as MessageItem).id ?? `m${idSeq++}` } as MessageItem);
    },
    triggerScroll: () => {
      ctrl.scrollCount++;
    },
  };
  return ctrl;
}

// ── 构造一个最小可用的 WsProcessingContext ──────────────────────────────
interface CtxHooks {
  onChatAck: Mock<(clientMsgId: string, event?: WsEvent) => void>;
  onInterjectionApplied: Mock<(sourceRunIds: string[], clientMsgIds: string[]) => void>;
  onUserMessageProjected: Mock<(clientMsgId: string | undefined, sourceRunId: string | undefined) => void>;
  onActiveUserMsgIndexChange: Mock<(index: number) => void>;
  onStreamAttached: Mock<(streamId: string, runId: string | null) => void>;
  onChatRejected: Mock<(clientMsgId: string, reasonCode: string, reason: string) => void>;
  onChatDone: Mock<(clientMsgId: string | undefined, error: string | undefined) => void>;
  onModelPersist: Mock<(sessionId: string, model: string) => void>;
  setIsNewSession: Mock<(v: boolean) => void>;
  setSessionId: Mock<(id: string | null) => void>;
  loadSessions: Mock<() => Promise<void>>;
  updateSessionTitle: Mock<(sessionId: string, title: string) => void>;
  updateSessionMeta: Mock<
    (sessionId: string, patch: { preview?: string; updatedAtMs?: number; title?: string }) => void
  >;
  removeSession: Mock<(sessionId: string) => void>;
  upsertSession: Mock<
    (session: {
      sessionId: string;
      title?: string;
      preview?: string;
      updatedAtMs: number;
      model?: string;
      username?: string;
    }) => void
  >;
  voiceCallback: Mock<(key: string, text: string, voice?: string, speed?: number) => void>;
}

function makeCtx(
  ctrl: MessagesController,
  overrides: Partial<WsProcessingContext> = {},
): { ctx: WsProcessingContext; hooks: CtxHooks } {
  const hooks: CtxHooks = {
    onChatAck: vi.fn<(clientMsgId: string, event?: WsEvent) => void>(),
    onInterjectionApplied: vi.fn<(sourceRunIds: string[], clientMsgIds: string[]) => void>(),
    onUserMessageProjected: vi.fn<(clientMsgId: string | undefined, sourceRunId: string | undefined) => void>(),
    onActiveUserMsgIndexChange: vi.fn<(index: number) => void>(),
    onStreamAttached: vi.fn<(streamId: string, runId: string | null) => void>(),
    onChatRejected: vi.fn<(clientMsgId: string, reasonCode: string, reason: string) => void>(),
    onChatDone: vi.fn<(clientMsgId: string | undefined, error: string | undefined) => void>(),
    onModelPersist: vi.fn<(sessionId: string, model: string) => void>(),
    setIsNewSession: vi.fn<(v: boolean) => void>(),
    setSessionId: vi.fn<(id: string | null) => void>(),
    loadSessions: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateSessionTitle: vi.fn<(sessionId: string, title: string) => void>(),
    updateSessionMeta: vi.fn<
      (sessionId: string, patch: { preview?: string; updatedAtMs?: number; title?: string }) => void
    >(),
    removeSession: vi.fn<(sessionId: string) => void>(),
    upsertSession: vi.fn<
      (session: {
        sessionId: string;
        title?: string;
        preview?: string;
        updatedAtMs: number;
        model?: string;
        username?: string;
      }) => void
    >(),
    voiceCallback: vi.fn<(key: string, text: string, voice?: string, speed?: number) => void>(),
  };
  const ctx: WsProcessingContext = {
    msg: ctrl,
    session: {
      setIsNewSession: hooks.setIsNewSession,
      setSessionId: hooks.setSessionId,
      loadSessions: hooks.loadSessions,
      updateSessionTitle: hooks.updateSessionTitle,
      updateSessionMeta: hooks.updateSessionMeta,
      removeSession: hooks.removeSession,
      upsertSession: hooks.upsertSession,
    },
    selectedModelRef: { current: null },
    voiceCallbackRef: { current: hooks.voiceCallback },
    streamIdRef: { current: null },
    runIdRef: { current: null },
    lastEventIdRef: { current: null },
    userMsgIndex: -1,
    onChatAck: hooks.onChatAck,
    onInterjectionApplied: hooks.onInterjectionApplied,
    onUserMessageProjected: hooks.onUserMessageProjected,
    onActiveUserMsgIndexChange: hooks.onActiveUserMsgIndexChange,
    onStreamAttached: hooks.onStreamAttached,
    onChatRejected: hooks.onChatRejected,
    onChatDone: hooks.onChatDone,
    onModelPersist: hooks.onModelPersist,
    ...overrides,
  };
  return { ctx, hooks };
}

function freshBlock(): WsBlockState { return { currentBlockIndex: -1, currentBlockType: null }; }
/** 便捷：以默认 block/latestSessionId/activeSessionId 派发一条事件 */
function dispatch(
  data: WsEvent,
  ctx: WsProcessingContext,
  block: WsBlockState = freshBlock(),
  latest: { value: string | null } = { value: null },
  activeSessionId: string | null = null,
): 'done' | 'buffer_overflow' | void {
  return processWsEvent(data, ctx, block, latest, activeSessionId);
}

beforeEach(() => {
  idSeq = 0;
});

// ── 独立导出的辅助函数 ────────────────────────────────────────────────

describe('processWsEvent - 连接与消息生命周期', () => {
  it('stream_id：写入 streamIdRef/runIdRef、新增 queued 状态、按 client_msg_id 把 pending user 翻 sent', () => {
    const ctrl = makeController([
      { id: 'u', type: 'user', content: 'hi', status: 'pending', clientMsgId: 'c1' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'stream_id', streamId: 's1', runId: 'r1', client_msg_id: 'c1' }, ctx);

    expect(ctx.streamIdRef.current).toBe('s1');
    expect(ctx.runIdRef!.current).toBe('r1');
    // user 气泡翻 sent
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'user' }>).status).toBe('sent');
    // 新增了 queued 状态条
    const status = ctrl.messages.find((m) => m.type === 'runtime_status');
    expect(status).toMatchObject({ status: 'queued', streamId: 's1', runId: 'r1' });
  });

  it('stream_id queued：只把对应气泡标为已排队，不覆盖当前 stream/run 引用', () => {
    const ctrl = makeController([
      { id: 'u1', type: 'user', content: '当前问题', status: 'sent', clientMsgId: 'c1' },
      { id: 'u2', type: 'user', content: '插话', status: 'pending', clientMsgId: 'c2' },
    ]);
    const { ctx } = makeCtx(ctrl);
    ctx.streamIdRef.current = 'active-stream';
    ctx.runIdRef!.current = 'active-run';

    dispatch({
      type: 'stream_id',
      streamId: 'queued-stream',
      runId: 'queued-run',
      client_msg_id: 'c2',
      queued: true,
      targetRunId: 'active-run',
    }, ctx);

    expect(ctx.streamIdRef.current).toBe('active-stream');
    expect(ctx.runIdRef!.current).toBe('active-run');
    expect((ctrl.messages[1] as Extract<MessageItem, { type: 'user' }>).status).toBe('queued');
    expect(ctrl.messages.some((message) => message.type === 'runtime_status')).toBe(false);
  });

  it('stream_id 接管（插话回退为独立 run）：切换 userMsgIndex 归属，后续 done 不被防串校验丢弃', () => {
    const ctrl = makeController([
      { id: 'u1', type: 'user', content: '当前问题', status: 'sent', clientMsgId: 'c1' },
      { id: 'u2', type: 'user', content: '插话', status: 'queued', clientMsgId: 'c2' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);
    ctx.streamIdRef.current = 'stream-a';
    ctx.runIdRef!.current = 'run-a';
    // 目标 run（c1）尚未结束时，userMsgIndex 仍指向它的气泡
    ctx.userMsgIndex = 0;

    // 目标 run 在边界前结束 → 服务端为回退 run 补发非 queued 的 stream_id
    dispatch({
      type: 'stream_id',
      streamId: 'stream-b',
      runId: 'run-b',
      client_msg_id: 'c2',
    }, ctx);

    expect(ctx.streamIdRef.current).toBe('stream-b');
    expect(ctx.runIdRef!.current).toBe('run-b');
    expect(hooks.onStreamAttached).toHaveBeenCalledWith('stream-b', 'run-b');
    expect(hooks.onActiveUserMsgIndexChange).toHaveBeenCalledWith(1);
    expect((ctrl.messages[1] as Extract<MessageItem, { type: 'user' }>).status).toBe('sent');

    // 上层按回调完成切换后重建 ctx（web/mobile 均为每事件重建）
    ctx.userMsgIndex = 1;
    const result = dispatch({
      type: 'done',
      sessionId: 's1',
      streamId: 'stream-b',
      runId: 'run-b',
      client_msg_id: 'c2',
    }, ctx, freshBlock(), { value: 's1' }, 's1');

    expect(result).toBe('done');
    expect(hooks.onChatDone).toHaveBeenCalledWith('c2', undefined);
  });

  it('stream_id 接管：sessionId 不属于当前会话时不接管', () => {
    const ctrl = makeController([
      { id: 'u1', type: 'user', content: '当前会话', status: 'sent', clientMsgId: 'c1' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);
    ctx.streamIdRef.current = 'stream-current';
    ctx.runIdRef!.current = 'run-current';

    dispatch({
      type: 'stream_id',
      streamId: 'stream-other',
      sessionId: 'other-session',
      runId: 'run-other',
      client_msg_id: 'c1',
    }, ctx, freshBlock(), { value: 's1' }, 's1');

    expect(ctx.streamIdRef.current).toBe('stream-current');
    expect(ctx.runIdRef!.current).toBe('run-current');
    expect(hooks.onStreamAttached).not.toHaveBeenCalled();
  });

  it('stream_id 接管：queued 的 stream_id 不触发 userMsgIndex 切换', () => {
    const ctrl = makeController([
      { id: 'u1', type: 'user', content: '当前问题', status: 'sent', clientMsgId: 'c1' },
      { id: 'u2', type: 'user', content: '插话', status: 'pending', clientMsgId: 'c2' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);
    ctx.streamIdRef.current = 'stream-a';
    ctx.runIdRef!.current = 'run-a';
    ctx.userMsgIndex = 0;

    dispatch({
      type: 'stream_id',
      streamId: 'queued-stream',
      runId: 'queued-run',
      client_msg_id: 'c2',
      queued: true,
      targetRunId: 'run-a',
    }, ctx);

    expect(hooks.onActiveUserMsgIndexChange).not.toHaveBeenCalled();
    expect(hooks.onChatAck).toHaveBeenCalledWith('c2');
    expect(ctx.streamIdRef.current).toBe('stream-a');
  });

  it('interjection_applied：把已排队气泡翻为 sent 并回调清理 outbox', () => {
    const ctrl = makeController([
      { id: 'u', type: 'user', content: '插话', status: 'queued', clientMsgId: 'c2' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);

    dispatch({
      type: 'interjection_applied',
      sourceRunIds: ['source-run'],
      clientMsgIds: ['c2'],
    }, ctx);

    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'user' }>).status).toBe('sent');
    expect(hooks.onInterjectionApplied).toHaveBeenCalledWith(['source-run'], ['c2']);
  });

  it('stream_id：无 client_msg_id 时回退到 userMsgIndex 定位 pending user', () => {
    const ctrl = makeController([
      { id: 'u', type: 'user', content: 'hi', status: 'pending' },
    ]);
    const { ctx } = makeCtx(ctrl, { userMsgIndex: 0 });
    dispatch({ type: 'stream_id', streamId: 's1' }, ctx);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'user' }>).status).toBe('sent');
    expect(ctx.runIdRef!.current).toBe(null);
  });

  it('chat_ack：转发 onChatAck 回调', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    const event = { type: 'chat_ack', client_msg_id: 'c9', server_recv_ts: 1 } as const;
    dispatch(event, ctx);
    expect(hooks.onChatAck).toHaveBeenCalledWith('c9', event);
  });

  it('chat_rejected：把 user 翻 failed 并写 failedReason，同时清状态条与回调', () => {
    const ctrl = makeController([
      { id: 'r', type: 'runtime_status', status: 'queued' },
      { id: 'u', type: 'user', content: 'hi', status: 'pending', clientMsgId: 'c1' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch(
      { type: 'chat_rejected', client_msg_id: 'c1', reason_code: 'session_locked', reason: '会话锁定' },
      ctx,
    );
    const user = ctrl.messages.find((m) => m.type === 'user') as Extract<MessageItem, { type: 'user' }>;
    expect(user.status).toBe('failed');
    expect(user.failedReason).toBe('会话锁定');
    // runtime_status 被清掉
    expect(ctrl.messages.some((m) => m.type === 'runtime_status')).toBe(false);
    expect(hooks.onChatRejected).toHaveBeenCalledWith('c1', 'session_locked', '会话锁定');
  });

  it('user_message：正常新增并透传消费身份；client_msg_id 相同则去重', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({
      type: 'user_message',
      content: 'hello',
      timestamp: 100,
      client_msg_id: 'c1',
      sourceRunId: 'source-1',
    }, ctx);
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ type: 'user', content: 'hello', clientMsgId: 'c1' });
    expect(hooks.onUserMessageProjected).toHaveBeenCalledWith('c1', 'source-1');

    // 相同 client_msg_id → 去重，不新增
    dispatch({ type: 'user_message', content: 'hello-again', timestamp: 200, client_msg_id: 'c1' }, ctx);
    expect(ctrl.messages).toHaveLength(1);
  });

  it('user_message：无 client_msg_id 时按 content 去重', () => {
    const ctrl = makeController([{ id: 'u', type: 'user', content: 'dup' }]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'user_message', content: 'dup', timestamp: 1 }, ctx);
    expect(ctrl.messages).toHaveLength(1);
  });

  it('session：更新 latestSessionId、setIsNewSession(false)、setSessionId、activeSessionId 为空时 loadSessions', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    ctx.selectedModelRef.current = 'gpt';
    const latest = { value: null as string | null };
    dispatch({ type: 'session', sessionId: 'sess-1' }, ctx, freshBlock(), latest, null);

    expect(latest.value).toBe('sess-1');
    expect(hooks.setIsNewSession).toHaveBeenCalledWith(false);
    expect(hooks.setSessionId).toHaveBeenCalledWith('sess-1');
    // 有选中模型 → onModelPersist + upsertSession 带 model
    expect(hooks.onModelPersist).toHaveBeenCalledWith('sess-1', 'gpt');
    expect(hooks.upsertSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', model: 'gpt' }));
    // activeSessionId 为 null → loadSessions
    expect(hooks.loadSessions).toHaveBeenCalledTimes(1);
  });

  it('session：activeSessionId 非空且归属一致时不 loadSessions', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'session', sessionId: 'sess-1' }, ctx, freshBlock(), { value: null }, 'sess-1');
    expect(hooks.setSessionId).toHaveBeenCalledWith('sess-1');
    expect(hooks.loadSessions).not.toHaveBeenCalled();
  });

  it('session：其他会话迟到事件不得改写当前会话', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    const latest = { value: 'sess-current' as string | null };

    dispatch({ type: 'session', sessionId: 'sess-old', client_msg_id: 'client-old' }, ctx, freshBlock(), latest, 'sess-current');

    expect(latest.value).toBe('sess-current');
    expect(hooks.setSessionId).not.toHaveBeenCalled();
    expect(hooks.upsertSession).not.toHaveBeenCalled();
  });
});

describe('processWsEvent - 流式块（block/thinking/text/tool_input）', () => {
  it('block_start(thinking) → thinking → block_end：累积内容并收尾计时', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const block = freshBlock();

    dispatch({ type: 'block_start', blockType: 'thinking' }, ctx, block);
    expect(block.currentBlockType).toBe('thinking');
    expect(block.currentBlockIndex).toBe(0);
    expect(ctrl.messages[0]).toMatchObject({ type: 'thinking', streaming: true });

    dispatch({ type: 'thinking', content: '思考A' }, ctx, block);
    dispatch({ type: 'thinking', content: '思考B' }, ctx, block);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'thinking' }>).content).toBe('思考A思考B');

    dispatch({ type: 'block_end', blockType: 'thinking' }, ctx, block);
    const think = ctrl.messages[0] as Extract<MessageItem, { type: 'thinking' }>;
    expect(think.streaming).toBe(false);
    expect(typeof think.durationMs).toBe('number');
    // block 复位
    expect(block.currentBlockIndex).toBe(-1);
    expect(block.currentBlockType).toBe(null);
  });

  it('block_start(text) → text：累积文本；无匹配 block 时 text 事件被忽略', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const block = freshBlock();

    dispatch({ type: 'block_start', blockType: 'text' }, ctx, block);
    dispatch({ type: 'text', content: 'Hello ' }, ctx, block);
    dispatch({ type: 'text', content: 'World' }, ctx, block);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'text' }>).content).toBe('Hello World');

    // block 复位后，孤立的 text 事件不改任何东西
    const blank = freshBlock();
    dispatch({ type: 'text', content: 'ignored' }, ctx, blank);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'text' }>).content).toBe('Hello World');
  });

  it('draft_reset：按 draftId 撤回思考与正文，替换成功后 commit 固化且不误删旧回答', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const block = freshBlock();

    dispatch({ type: 'block_start', blockType: 'thinking', draftId: 'draft-1' }, ctx, block);
    dispatch({ type: 'thinking', content: '失败轮思考' }, ctx, block);
    dispatch({ type: 'block_end', blockType: 'thinking' }, ctx, block);
    dispatch({ type: 'block_start', blockType: 'text', draftId: 'draft-1' }, ctx, block);
    dispatch({ type: 'text', content: '失败轮正文' }, ctx, block);

    dispatch({ type: 'draft_reset', draftId: 'draft-1', attempt: 1 }, ctx, block);
    expect(ctrl.messages).toEqual([
      expect.objectContaining({
        type: 'runtime_status',
        status: 'reconnecting',
        content: '连接波动，正在恢复',
      }),
    ]);
    expect(block).toEqual({ currentBlockIndex: -1, currentBlockType: null });

    dispatch({ type: 'block_start', blockType: 'text', draftId: 'draft-1' }, ctx, block);
    dispatch({ type: 'text', content: '最终答案' }, ctx, block);
    dispatch({ type: 'block_end', blockType: 'text' }, ctx, block);
    dispatch({ type: 'draft_commit', draftId: 'draft-1' }, ctx, block);

    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({
      type: 'text',
      content: '最终答案',
      streaming: false,
      draftId: undefined,
    });

    dispatch({ type: 'block_start', blockType: 'text', draftId: 'draft-2' }, ctx, block);
    dispatch({ type: 'text', content: '另一轮失败草稿' }, ctx, block);
    dispatch({ type: 'draft_reset', draftId: 'draft-2' }, ctx, block);
    expect(ctrl.messages.some((message) => message.type === 'text' && message.content === '最终答案')).toBe(true);
    expect(ctrl.messages.some((message) => message.type === 'text' && message.content === '另一轮失败草稿')).toBe(false);
  });

  it('block_start(tool_use) → tool_input → block_end：创建骨架、累积输入、收尾', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const block = freshBlock();

    dispatch({ type: 'block_start', blockType: 'tool_use', toolName: 'Bash', toolId: 'i1', runId: 'run-1' }, ctx, block);
    expect(ctrl.messages[0]).toMatchObject({ type: 'tool_use', toolName: 'Bash', toolId: 'i1', runId: 'run-1', streaming: true });

    dispatch({ type: 'tool_input', content: '{"cmd":' }, ctx, block);
    dispatch({ type: 'tool_input', content: '"ls"}' }, ctx, block);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>).toolInput).toBe('{"cmd":"ls"}');

    dispatch({ type: 'block_end', blockType: 'tool_use', toolName: 'Bash' }, ctx, block);
    const tool = ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>;
    expect(tool.streaming).toBe(false);
    expect(tool.executionStatus).toBe('pending');
  });

  it('block_start(tool_use) 独立卡片工具（Agent）：不产生通用骨架，currentBlockIndex 保持 -1', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const block = freshBlock();
    dispatch({ type: 'block_start', blockType: 'tool_use', toolName: 'Agent', toolId: 'a1' }, ctx, block);
    expect(ctrl.messages).toHaveLength(0);
    expect(block.currentBlockIndex).toBe(-1);
  });

  it('block_end(tool_use) 带新 toolName 时纠正骨架名', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const block = freshBlock();
    dispatch({ type: 'block_start', blockType: 'tool_use', toolName: 'unknown', toolId: 'i1' }, ctx, block);
    dispatch({ type: 'block_end', blockType: 'tool_use', toolName: 'Read' }, ctx, block);
    const tool = ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>;
    expect(tool.toolName).toBe('Read');
    expect(tool.streaming).toBe(false);
  });
});

describe('processWsEvent - 工具执行与结果', () => {
  it('tool_execution(started)：无骨架时新增 running 工具', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'tool_execution', phase: 'started', toolName: 'Bash', toolId: 'i1' }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'tool_use', toolName: 'Bash', executionStatus: 'running' });
  });

  it('tool_execution(completed, error)：更新既有骨架为 failed 并带 error/durationMs', () => {
    const ctrl = makeController([
      { id: 't', type: 'tool_use', toolName: 'Bash', toolInput: '', toolId: 'i1', executionStatus: 'running' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'tool_execution', phase: 'completed', status: 'error', toolName: 'Bash', toolId: 'i1', error: '炸了', durationMs: 42 },
      ctx,
    );
    const tool = ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>;
    expect(tool.executionStatus).toBe('failed');
    expect(tool.error).toBe('炸了');
    expect(tool.durationMs).toBe(42);
  });

  it('tool_execution(completed, cancelled)：映射到 cancelled', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'tool_execution', phase: 'completed', status: 'cancelled', toolName: 'Bash', toolId: 'i1' },
      ctx,
    );
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>).executionStatus).toBe('cancelled');
  });

  it('tool_execution 独立卡片工具（Agent）：兜底跳过，不新增消息', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'tool_execution', phase: 'started', toolName: 'Agent', toolId: 'a1' }, ctx);
    expect(ctrl.messages).toHaveLength(0);
  });

  it('tool_result：命中 toolId 的 tool_use 时写 result/resultReady 并置 completed', () => {
    const ctrl = makeController([
      { id: 't', type: 'tool_use', toolName: 'Read', toolInput: '', toolId: 'i1', executionStatus: 'running' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'tool_result', toolId: 'i1', result: '文件内容' }, ctx);
    const tool = ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>;
    expect(tool.result).toBe('文件内容');
    expect(tool.resultReady).toBe(true);
    expect(tool.executionStatus).toBe('completed');
  });

  it('tool_result(isError)：置 failed', () => {
    const ctrl = makeController([
      { id: 't', type: 'tool_use', toolName: 'Read', toolInput: '', toolId: 'i1', executionStatus: 'running' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'tool_result', toolId: 'i1', result: 'boom', isError: true }, ctx);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>).executionStatus).toBe('failed');
  });

  it('tool_result：找不到对应 tool_use 时新增 tool_result 消息', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'tool_result', toolId: 'nope', toolName: 'Read', result: 'orphan' }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'tool_result', toolName: 'Read', result: 'orphan' });
  });

  it('tool_result 带 presentation/metadata：normalize 后合并进 tool_use——实时观看与刷新后渲染一致', () => {
    const ctrl = makeController([
      { id: 't', type: 'tool_use', toolName: 'Shell', toolInput: '', toolId: 'i1', executionStatus: 'running' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({
      type: 'tool_result',
      toolId: 'i1',
      result: 'stdout...',
      presentation: {
        title: '钉钉 · 创建待办',
        detail: [{ k: '系统', v: '钉钉' }],
        status: 'ok',
        receipt: { id: '55820993744', system: '钉钉' },
      },
      metadata: { exitCode: 0, durationMs: 1393 },
    }, ctx);
    const tool = ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>;
    expect(tool.presentation?.title).toBe('钉钉 · 创建待办');
    expect(tool.presentation?.receipt).toEqual({ id: '55820993744', system: '钉钉' });
    expect(tool.toolMetadata).toMatchObject({ exitCode: 0, durationMs: 1393 });
  });

  it('tool_result 的 presentation 非法时被 normalize 拦下，不污染消息', () => {
    const ctrl = makeController([
      { id: 't', type: 'tool_use', toolName: 'Shell', toolInput: '', toolId: 'i1', executionStatus: 'running' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'tool_result', toolId: 'i1', result: 'x', presentation: 'not-an-object', metadata: 42 }, ctx);
    const tool = ctrl.messages[0] as Extract<MessageItem, { type: 'tool_use' }>;
    expect(tool.presentation).toBeUndefined();
    expect(tool.toolMetadata).toBeUndefined();
    expect(tool.resultReady).toBe(true);
  });
});

describe('processWsEvent - 交互事件', () => {
  it('permission_request：新增 pending 卡片；EnterPlanMode 走中文映射', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'permission_request', interactionId: 'x1', toolName: 'EnterPlanMode', toolInput: {} },
      ctx,
    );
    expect(ctrl.messages[0]).toMatchObject({ type: 'runtime_status', status: 'waiting_approval', content: '待处理' });
    expect(ctrl.messages[1]).toMatchObject({
      type: 'permission_request',
      interactionId: 'x1',
      toolName: '进入规划模式',
      status: 'pending',
    });
  });

  it('ask_user：新增 pending 提问卡片', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const questions = [{ question: 'q', header: 'h', options: [], multiSelect: false }];
    dispatch({ type: 'ask_user', interactionId: 'x2', questions }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'runtime_status', status: 'waiting_user', content: '待补充' });
    expect(ctrl.messages[1]).toMatchObject({ type: 'ask_user', interactionId: 'x2', status: 'pending' });
  });

  it('interaction_resolved：pending permission → allowed', () => {
    const ctrl = makeController([
      { id: 'p', type: 'permission_request', interactionId: 'x1', toolName: 'T', toolInput: '', status: 'pending' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'interaction_resolved', sessionId: 's', interactionId: 'x1' }, ctx);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'permission_request' }>).status).toBe('allowed');
  });

  it('interaction_resolved：pending ask_user → answered', () => {
    const ctrl = makeController([
      { id: 'a', type: 'ask_user', interactionId: 'x2', questions: [], status: 'pending' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'interaction_resolved', sessionId: 's', interactionId: 'x2' }, ctx);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'ask_user' }>).status).toBe('answered');
  });

  it('pending_interactions：批量补齐未存在的卡片，已存在的跳过', () => {
    const ctrl = makeController([
      { id: 'p', type: 'permission_request', interactionId: 'exist', toolName: 'T', toolInput: '', status: 'pending' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch(
      {
        type: 'pending_interactions',
        interactions: [
          { interactionId: 'exist', type: 'permission_request', toolName: 'T' }, // 已存在 → 跳过
          { interactionId: 'new-p', type: 'permission_request', toolName: 'Bash', toolInput: { cmd: 'ls' } },
          { interactionId: 'new-a', type: 'ask_user', questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }] },
        ],
      },
      ctx,
    );
    // 原 1 条 + 等待状态 + 新增 2 条
    expect(ctrl.messages).toHaveLength(4);
    expect(ctrl.messages[1]).toMatchObject({ type: 'runtime_status', status: 'waiting_user', content: '待补充' });
    expect(ctrl.messages[2]).toMatchObject({ type: 'permission_request', interactionId: 'new-p' });
    expect(ctrl.messages[3]).toMatchObject({ type: 'ask_user', interactionId: 'new-a' });
  });
});

describe('processWsEvent - subagent', () => {
  it('subagent_start：无既有骨架时新增 running subagent', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'subagent_start', toolId: 't1', agentType: 'coder', model: 'gpt' }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'subagent', toolId: 't1', agentType: 'coder', status: 'running', model: 'gpt' });
  });

  it('subagent_start：把同 toolId 的 tool_use 骨架原地升级为 subagent', () => {
    const ctrl = makeController([
      { id: 'u', type: 'tool_use', toolName: 'Agent', toolInput: '', toolId: 't1' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'subagent_start', toolId: 't1', agentType: 'coder' }, ctx);
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ type: 'subagent', toolId: 't1', agentType: 'coder', status: 'running' });
  });

  it('subagent_end：live 链路保留策略拒绝恢复字段，与刷新结构一致', () => {
    const ctrl = makeController([
      { id: 's', type: 'subagent', toolId: 't1', agentType: 'coder', status: 'running' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'subagent_end', toolId: 't1', status: 'failed', durationMs: 500, totalTokens: 1200, toolUseCount: 3, failureKind: 'policy_rejection', recoveryAction: 'switch_model' },
      ctx,
    );
    const sub = ctrl.messages[0] as Extract<MessageItem, { type: 'subagent' }>;
    expect(sub.status).toBe('failed');
    expect(sub.durationMs).toBe(500);
    expect(sub.totalTokens).toBe(1200);
    expect(sub.toolUseCount).toBe(3); expect(sub).toMatchObject({ failureKind: 'policy_rejection', recoveryAction: 'switch_model' });
  });

  it('subagent_end：无既有 subagent 但带 agentType 时补一条终态', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'subagent_end', toolId: 't9', agentType: 'coder', status: 'failed', errorMessage: 'oops' }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'subagent', toolId: 't9', status: 'failed', errorMessage: 'oops' });
  });
});

describe('processWsEvent - done 终态', () => {
  it('A 会话失败终态不得污染当前打开的 B/C/D 会话', () => {
    for (const activeSessionId of ['session-b', 'session-c', 'session-d']) {
      const ctrl = makeController([
        { id: `user-${activeSessionId}`, type: 'user', content: 'current', status: 'sent', clientMsgId: `client-${activeSessionId}` },
        { id: `text-${activeSessionId}`, type: 'text', content: 'still streaming', streaming: true },
      ]);
      const { ctx, hooks } = makeCtx(ctrl, {
        userMsgIndex: 0,
        streamIdRef: { current: `stream-${activeSessionId}` },
        runIdRef: { current: `run-${activeSessionId}` },
      });
      const before = ctrl.messages.map((message) => ({ ...message }));

      const ret = dispatch({
        type: 'done',
        sessionId: 'session-a',
        streamId: 'stream-session-a',
        runId: 'run-session-a',
        client_msg_id: 'client-session-a',
        error: 'boom',
      }, ctx, freshBlock(), { value: activeSessionId }, activeSessionId);

      expect(ret).toBeUndefined();
      expect(ctrl.messages).toEqual(before);
      expect(hooks.onChatDone).not.toHaveBeenCalled();
    }
  });

  it('草稿态（新建会话尚未定型）丢弃其他会话晚到的失败终态', () => {
    const ctrl = makeController([]);
    const { ctx, hooks } = makeCtx(ctrl, {
      userMsgIndex: -1,
      streamIdRef: { current: null },
      runIdRef: { current: null },
    });

    const ret = dispatch({
      type: 'done',
      sessionId: 'session-a',
      streamId: 'stream-session-a',
      runId: 'run-session-a',
      client_msg_id: 'client-session-a',
      error: 'boom',
    }, ctx, freshBlock(), { value: null }, null);

    expect(ret).toBeUndefined();
    expect(ctrl.messages).toEqual([]);
    expect(hooks.onChatDone).not.toHaveBeenCalled();
  });

  it('草稿态首条消息自身的失败终态仍按 client_msg_id 放行', () => {
    const ctrl = makeController([
      { id: 'u1', type: 'user', content: 'hi', status: 'sent', clientMsgId: 'client-draft' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl, {
      userMsgIndex: 0,
      streamIdRef: { current: null },
      runIdRef: { current: null },
    });

    const ret = dispatch({
      type: 'done',
      sessionId: 'session-new',
      client_msg_id: 'client-draft',
      error: 'boom',
    }, ctx, freshBlock(), { value: null }, null);

    expect(ret).toBe('done');
    expect(hooks.onChatDone).toHaveBeenCalledWith('client-draft', 'boom');
    expect(ctrl.messages[0]).toMatchObject({ status: 'sent' });
    expect(ctrl.messages[1]).toMatchObject({ type: 'text', content: '回复已中断' });
  });

  it('fallback source 接管后，按精确 client_msg_id 接受终态，不受旧 userMsgIndex 影响', () => {
    const ctrl = makeController([
      { id: 'target', type: 'user', content: '原始消息', status: 'sent', clientMsgId: 'target-client' },
      { id: 'source', type: 'user', content: '插话消息', status: 'sent', clientMsgId: 'source-client' },
      { id: 'status', type: 'runtime_status', status: 'running', streamId: 'source-stream', runId: 'source-run' },
      { id: 'text', type: 'text', content: 'fallback reply', streaming: true },
    ]);
    const { ctx, hooks } = makeCtx(ctrl, {
      // 目标 run 结束后，session_status 已把 stream/run 切到 source，
      // 但旧索引仍指向目标消息，这是 fallback 接管的真实时序。
      userMsgIndex: 0,
      streamIdRef: { current: 'source-stream' },
      runIdRef: { current: 'source-run' },
    });

    const ret = dispatch({
      type: 'done',
      sessionId: 'session-1',
      streamId: 'source-stream',
      runId: 'source-run',
      client_msg_id: 'source-client',
    }, ctx, freshBlock(), { value: 'session-1' }, 'session-1');

    expect(ret).toBe('done');
    expect(hooks.onChatDone).toHaveBeenCalledWith('source-client', undefined);
    expect(ctrl.messages.some((message) => message.type === 'runtime_status')).toBe(false);
    expect((ctrl.messages.find((message) => message.id === 'text') as Extract<MessageItem, { type: 'text' }>).streaming).toBe(false);
  });

  it('done 无 error：清状态条、收尾 streaming、返回 done、触发 onChatDone', () => {
    const ctrl = makeController([
      { id: 'r', type: 'runtime_status', status: 'running' },
      { id: 't', type: 'text', content: 'x', streaming: true },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);
    const block: WsBlockState = { currentBlockIndex: 1, currentBlockType: 'text' };
    const ret = dispatch({ type: 'done', client_msg_id: 'c1' }, ctx, block);

    expect(ret).toBe('done');
    expect(ctrl.messages.some((m) => m.type === 'runtime_status')).toBe(false);
    expect((ctrl.messages.find((m) => m.type === 'text') as Extract<MessageItem, { type: 'text' }>).streaming).toBe(false);
    expect(block.currentBlockIndex).toBe(-1);
    expect(hooks.onChatDone).toHaveBeenCalledWith('c1', undefined);
  });

  it('done 带普通 error：用户消息保持 sent，只追加一条简短中断提示', () => {
    const ctrl = makeController([
      { id: 'u', type: 'user', content: 'hi', status: 'sent', clientMsgId: 'c1' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);
    const ret = dispatch({ type: 'done', client_msg_id: 'c1', error: 'boom' }, ctx);
    expect(ret).toBe('done');
    const user = ctrl.messages[0] as Extract<MessageItem, { type: 'user' }>;
    expect(user.status).toBe('sent');
    expect(user.failedReason).toBeUndefined();
    expect(ctrl.messages[1]).toMatchObject({ type: 'text', content: '回复已中断' });
    expect(hooks.onChatDone).toHaveBeenCalledWith('c1', 'boom');
  });

  it('done 带积分不足 error：user 保持 sent（不染失败），并追加通俗文本兜底', () => {
    const ctrl = makeController([
      { id: 'u', type: 'user', content: 'hi', status: 'sent', clientMsgId: 'c1' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'done', client_msg_id: 'c1', error: '组织积分余额不足' }, ctx);
    const user = ctrl.messages[0] as Extract<MessageItem, { type: 'user' }>;
    expect(user.status).toBe('sent');
    expect(user.failedReason).toBeUndefined();
    // 末尾追加一条积分提示文本
    const last = ctrl.messages[ctrl.messages.length - 1];
    expect(last).toMatchObject({ type: 'text' });
    expect((last as Extract<MessageItem, { type: 'text' }>).content).toContain('积分余额不足');
  });

  it('done 带 error 且找不到 user：追加一条 text 兜底提示', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'done', error: 'boom' }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'text', content: '回复已中断' });
  });

  it('同一 run 的失败终态重复到达时只处理一次，不污染更早的 user', () => {
    const ctrl = makeController([
      { id: 'old', type: 'user', content: 'old', status: 'sent' },
      { id: 'current', type: 'user', content: 'current', status: 'sent', clientMsgId: 'c1' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl, {
      userMsgIndex: 1,
      handledTerminalKeysRef: { current: new Set<string>() },
    });

    dispatch({ type: 'done', runId: 'run-1', error: 'boom' }, ctx);
    dispatch({ type: 'done', runId: 'run-1', client_msg_id: 'c1', error: 'boom' }, ctx);

    expect(ctrl.messages).toHaveLength(3);
    expect(ctrl.messages[0]).toMatchObject({ id: 'old', status: 'sent' });
    expect(ctrl.messages[1]).toMatchObject({ id: 'current', status: 'sent' });
    expect(ctrl.messages[2]).toMatchObject({ type: 'text', content: '回复已中断' });
    expect(hooks.onChatDone).toHaveBeenCalledTimes(2);
    expect(hooks.onChatDone).toHaveBeenLastCalledWith('c1', 'boom');
  });

  it('无 client_msg_id 且无当前发送索引时不回扫历史 user，重复提示保持单条', () => {
    const ctrl = makeController([
      { id: 'old-1', type: 'user', content: 'old 1', status: 'sent' },
      { id: 'old-2', type: 'user', content: 'old 2', status: 'sent' },
    ]);
    const { ctx } = makeCtx(ctrl, { userMsgIndex: -1 });

    dispatch({ type: 'done', error: 'boom' }, ctx);
    dispatch({ type: 'done', error: 'boom' }, ctx);

    expect(ctrl.messages).toHaveLength(3);
    expect(ctrl.messages[0]).toMatchObject({ id: 'old-1', status: 'sent' });
    expect(ctrl.messages[1]).toMatchObject({ id: 'old-2', status: 'sent' });
    expect(ctrl.messages[2]).toMatchObject({ type: 'text', content: '回复已中断' });
  });
});

describe('processWsEvent - 会话元数据事件', () => {
  it('title_updated：调用 updateSessionTitle', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'title_updated', sessionId: 's1', title: '新标题' }, ctx);
    expect(hooks.updateSessionTitle).toHaveBeenCalledWith('s1', '新标题');
  });

  it('session_deleted：调用 removeSession', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'session_deleted', sessionId: 's1' }, ctx);
    expect(hooks.removeSession).toHaveBeenCalledWith('s1');
  });

  it('session_read_state_changed：同步未读状态', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({
      type: 'session_read_state_changed',
      sessionId: 's1',
      hasUnreadAiReply: true,
    }, ctx);
    expect(hooks.updateSessionMeta).toHaveBeenCalledWith('s1', {
      hasUnreadAiReply: true,
    });
  });

  it('session_updated(isNew 且有可展示内容)：upsertSession 直插本地列表', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch(
      { type: 'session_updated', sessionId: 's1', title: 'T', preview: 'P', updatedAtMs: 123, isNew: true },
      ctx,
    );
    expect(hooks.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', title: 'T', preview: 'P', updatedAtMs: 123 }),
    );
    expect(hooks.loadSessions).not.toHaveBeenCalled();
  });

  it('session_updated(isNew 但无可展示内容)：回退 loadSessions', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'session_updated', sessionId: 's1', updatedAtMs: 1, isNew: true }, ctx);
    expect(hooks.upsertSession).not.toHaveBeenCalled();
    expect(hooks.loadSessions).toHaveBeenCalledTimes(1);
  });

  it('session_updated(已有会话)：本地 patch updateSessionMeta', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'session_updated', sessionId: 's1', preview: 'P2', updatedAtMs: 9, title: 'T2' }, ctx);
    expect(hooks.updateSessionMeta).toHaveBeenCalledWith('s1', { preview: 'P2', updatedAtMs: 9, title: 'T2' });
  });
});

describe('processWsEvent - 语音 / 文件 / 错误 / 溢出', () => {
  it('error：清状态条并追加 Error 文本', () => {
    const ctrl = makeController([{ id: 'r', type: 'runtime_status', status: 'running' }]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'error', message: '出错了' }, ctx);
    expect(ctrl.messages.some((m) => m.type === 'runtime_status')).toBe(false);
    const text = ctrl.messages.find((m) => m.type === 'text') as Extract<MessageItem, { type: 'text' }>;
    expect(text.content).toBe('Error: 出错了');
  });

  it('buffer_overflow：返回 buffer_overflow', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(dispatch({ type: 'buffer_overflow' }, ctx)).toBe('buffer_overflow');
    warn.mockRestore();
  });

  it('file_download：新增 file_download 消息', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'file_download', fileName: 'a.pdf', fileType: 'pdf', filePath: 'x/a.pdf', fileSize: 10 },
      ctx,
    );
    expect(ctrl.messages[0]).toMatchObject({ type: 'file_download', fileName: 'a.pdf', filePath: 'x/a.pdf', fileSize: 10 });
  });

  it('artifact_created：映射到 file_download 并保留 artifactId/kind', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'artifact_created', artifactId: 'art1', fileName: 'r.png', kind: 'screenshot', mimeType: 'image/png', sizeBytes: 99 },
      ctx,
    );
    expect(ctrl.messages[0]).toMatchObject({
      type: 'file_download',
      fileName: 'r.png',
      artifactId: 'art1',
      artifactKind: 'screenshot',
      fileSize: 99,
    });
  });

  it('voice(standalone)：新增 voice 消息并触发 voiceCallback', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'voice', text: '你好', voice: 'v1', speed: 1, standalone: true }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'voice' });
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'voice' }>).voiceMarkers[0]).toMatchObject({ text: '你好' });
    expect(hooks.voiceCallback).toHaveBeenCalledWith('voice-0-0', '你好', 'v1', 1);
  });

  it('voice(standalone) 已有 voice 消息时追加 marker', () => {
    const ctrl = makeController([{ id: 'v', type: 'voice', voiceMarkers: [{ text: '第一句' }] }]);
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'voice', text: '第二句', standalone: true }, ctx);
    expect(ctrl.messages).toHaveLength(1);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'voice' }>).voiceMarkers).toHaveLength(2);
    expect(hooks.voiceCallback).toHaveBeenCalledWith('voice-0-1', '第二句', undefined, undefined);
  });

  it('voice(非 standalone)：挂到最近一条 text 的 voiceMarkers', () => {
    const ctrl = makeController([{ id: 't', type: 'text', content: '正文' }]);
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'voice', text: '朗读', standalone: false }, ctx);
    const text = ctrl.messages[0] as Extract<MessageItem, { type: 'text' }>;
    expect(text.voiceMarkers).toHaveLength(1);
    expect(text.voiceMarkers![0]).toMatchObject({ text: '朗读' });
    expect(hooks.voiceCallback).toHaveBeenCalledWith('voice-0-0', '朗读', undefined, undefined);
  });

  it('voice_transcribed：把转写中的 user-voice 落成 sent 并写文本', () => {
    const ctrl = makeController([{ id: 'v', type: 'user-voice', audioUrl: 'u', duration: 2, status: 'transcribing' }]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'voice_transcribed', text: '识别结果' }, ctx);
    const v = ctrl.messages[0] as Extract<MessageItem, { type: 'user-voice' }>;
    expect(v.status).toBe('sent');
    expect(v.transcribedText).toBe('识别结果');
  });

  it('voice_transcribed(error)：状态落 failed', () => {
    const ctrl = makeController([{ id: 'v', type: 'user-voice', audioUrl: 'u', duration: 2, status: 'uploading' }]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'voice_transcribed', text: '', error: true }, ctx);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'user-voice' }>).status).toBe('failed');
  });
});
describe('最终输出追认', () => {
  it('block_start 把 runId 绑定到实时 text 消息', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'block_start', blockType: 'text', runId: 'run-1' }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'text', runId: 'run-1', streaming: true });
  });

  it('成功 done 只追认同 Run 最后一条文本', () => {
    const ctrl = makeController([
      { id: 'u', type: 'user', content: '开始', status: 'sent' },
      { id: 'commentary', type: 'text', content: '我先检查', runId: 'run-1' },
      { id: 'other', type: 'text', content: '别的 Run', runId: 'run-2' },
      { id: 'final', type: 'text', content: '最终回答', runId: 'run-1', streaming: true },
    ]);
    const { ctx } = makeCtx(ctrl, { userMsgIndex: 0 });

    dispatch({ type: 'done', runId: 'run-1', finalOutput: true }, ctx);

    expect(ctrl.messages[1]).not.toHaveProperty('finalOutput');
    expect(ctrl.messages[2]).not.toHaveProperty('finalOutput');
    expect(ctrl.messages[3]).toMatchObject({ finalOutput: true, streaming: false });
  });

  it('失败 done 与无当前文本的成功 done 都不误标旧回答', () => {
    const failedCtrl = makeController([
      { id: 'old', type: 'text', content: '上一轮回答', finalOutput: false },
      { id: 'u', type: 'user', content: '新问题', status: 'sent' },
      { id: 'partial', type: 'text', content: '未完成', runId: 'run-2' },
    ]);
    const { ctx: failedCtx } = makeCtx(failedCtrl, { userMsgIndex: 1 });

    dispatch({ type: 'done', runId: 'run-2', finalOutput: true, error: 'boom' }, failedCtx);
    expect(failedCtrl.messages[2]).not.toHaveProperty('finalOutput');

    const emptyCtrl = makeController([
      { id: 'old', type: 'text', content: '上一轮回答', finalOutput: false },
      { id: 'u', type: 'user', content: '只执行工具', status: 'sent' },
    ]);
    const { ctx: emptyCtx } = makeCtx(emptyCtrl, { userMsgIndex: 1 });
    dispatch({ type: 'done', finalOutput: true }, emptyCtx);
    expect(emptyCtrl.messages[0]).toMatchObject({ finalOutput: false });
  });
});
