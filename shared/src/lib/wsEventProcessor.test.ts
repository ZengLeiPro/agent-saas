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
  upsertRuntimeStatusMessage,
  removeRuntimeStatusMessages,
  finalizeRunningSubagents,
  finalizeStreamingMessages,
  findUserMsgIndexByClientId,
  resolvePlanModeDisplay,
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
  onChatAck: Mock<(clientMsgId: string) => void>;
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
    onChatAck: vi.fn<(clientMsgId: string) => void>(),
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
    onChatRejected: hooks.onChatRejected,
    onChatDone: hooks.onChatDone,
    onModelPersist: hooks.onModelPersist,
    ...overrides,
  };
  return { ctx, hooks };
}

function freshBlock(): WsBlockState {
  return { currentBlockIndex: -1, currentBlockType: null };
}

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

// ══════════════════════════════════════════════════════════════════════
// 独立导出的辅助函数
// ══════════════════════════════════════════════════════════════════════

describe('辅助函数', () => {
  it('resolvePlanModeDisplay：EnterPlanMode 返回中文名与固定描述', () => {
    expect(resolvePlanModeDisplay('EnterPlanMode', 'fallback')).toEqual({
      name: '进入规划模式',
      description: 'Agent 请求进入规划模式，将在只读模式下探索代码库并设计实现方案。',
    });
  });

  it('resolvePlanModeDisplay：ExitPlanMode 带 planContent 时用 planContent 作描述', () => {
    expect(resolvePlanModeDisplay('ExitPlanMode', 'fb', '方案正文')).toEqual({
      name: '规划方案审批',
      description: '方案正文',
    });
    // 无 planContent 时回退到固定描述
    expect(resolvePlanModeDisplay('ExitPlanMode', 'fb').description).toContain('已完成方案规划');
  });

  it('resolvePlanModeDisplay：未映射工具回退到 displayName / toolName + fallbackInput', () => {
    expect(resolvePlanModeDisplay('Bash', '{"cmd":"ls"}', undefined, '运行命令')).toEqual({
      name: '运行命令',
      description: '{"cmd":"ls"}',
    });
    // 无 displayName 时用 toolName
    expect(resolvePlanModeDisplay('Bash', 'input').name).toBe('Bash');
  });

  it('findUserMsgIndexByClientId：命中最后一条匹配的 user/user-voice', () => {
    const msgs: MessageItem[] = [
      { id: 'a', type: 'user', content: 'hi', clientMsgId: 'c1' },
      { id: 'b', type: 'text', content: 'x' },
      { id: 'c', type: 'user-voice', audioUrl: 'u', duration: 1, status: 'sent', clientMsgId: 'c2' },
    ];
    expect(findUserMsgIndexByClientId(msgs, 'c1')).toBe(0);
    expect(findUserMsgIndexByClientId(msgs, 'c2')).toBe(2);
    expect(findUserMsgIndexByClientId(msgs, 'missing')).toBe(-1);
  });

  it('upsertRuntimeStatusMessage：无既有状态则新增，再次调用则原地更新', () => {
    const ctrl = makeController();
    upsertRuntimeStatusMessage(ctrl, 'queued', { streamId: 's1' });
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ type: 'runtime_status', status: 'queued', streamId: 's1' });

    upsertRuntimeStatusMessage(ctrl, 'running');
    // 仍然只有一条，状态被更新
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ type: 'runtime_status', status: 'running', content: '正在思考' });
  });

  it('removeRuntimeStatusMessages：有 setMessages 时过滤掉 runtime_status', () => {
    const ctrl = makeController([
      { id: 'r', type: 'runtime_status', status: 'queued' },
      { id: 't', type: 'text', content: 'hi' },
    ]);
    removeRuntimeStatusMessages(ctrl);
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0].type).toBe('text');
  });

  it('finalizeStreamingMessages：把半开的 streaming 文本与 running 工具收尾', () => {
    const ctrl = makeController([
      { id: 't', type: 'text', content: 'x', streaming: true },
      { id: 'k', type: 'thinking', content: 'y', streaming: true, startedAt: Date.now() - 100 },
      { id: 'u', type: 'tool_use', toolName: 'Bash', toolInput: '', toolId: 'i1', executionStatus: 'running' },
    ]);
    finalizeStreamingMessages(ctrl);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'text' }>).streaming).toBe(false);
    const think = ctrl.messages[1] as Extract<MessageItem, { type: 'thinking' }>;
    expect(think.streaming).toBe(false);
    expect(typeof think.durationMs).toBe('number');
    // 无 resultReady 的 running 工具落到 pending
    expect((ctrl.messages[2] as Extract<MessageItem, { type: 'tool_use' }>).executionStatus).toBe('pending');
  });

  it('finalizeRunningSubagents：running 子 agent 翻成 completed', () => {
    const ctrl = makeController([
      { id: 's', type: 'subagent', toolId: 't1', agentType: 'coder', status: 'running' },
      { id: 's2', type: 'subagent', toolId: 't2', agentType: 'coder', status: 'failed' },
    ]);
    finalizeRunningSubagents(ctrl);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'subagent' }>).status).toBe('completed');
    // 非 running 的不动
    expect((ctrl.messages[1] as Extract<MessageItem, { type: 'subagent' }>).status).toBe('failed');
  });
});

// ══════════════════════════════════════════════════════════════════════
// processWsEvent 逐事件类型
// ══════════════════════════════════════════════════════════════════════

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
    dispatch({ type: 'chat_ack', client_msg_id: 'c9', server_recv_ts: 1 }, ctx);
    expect(hooks.onChatAck).toHaveBeenCalledWith('c9');
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

  it('user_message：正常新增；client_msg_id 相同则去重', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'user_message', content: 'hello', timestamp: 100, client_msg_id: 'c1' }, ctx);
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ type: 'user', content: 'hello', clientMsgId: 'c1' });

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

  it('session：activeSessionId 非空时不 loadSessions', () => {
    const ctrl = makeController();
    const { ctx, hooks } = makeCtx(ctrl);
    dispatch({ type: 'session', sessionId: 'sess-1' }, ctx, freshBlock(), { value: null }, 'active');
    expect(hooks.loadSessions).not.toHaveBeenCalled();
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

  it('block_start(tool_use) → tool_input → block_end：创建骨架、累积输入、收尾', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    const block = freshBlock();

    dispatch({ type: 'block_start', blockType: 'tool_use', toolName: 'Bash', toolId: 'i1' }, ctx, block);
    expect(ctrl.messages[0]).toMatchObject({ type: 'tool_use', toolName: 'Bash', toolId: 'i1', streaming: true });

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
});

describe('processWsEvent - 交互事件', () => {
  it('permission_request：新增 pending 卡片；EnterPlanMode 走中文映射', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'permission_request', interactionId: 'x1', toolName: 'EnterPlanMode', toolInput: {} },
      ctx,
    );
    expect(ctrl.messages[0]).toMatchObject({
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
    expect(ctrl.messages[0]).toMatchObject({ type: 'ask_user', interactionId: 'x2', status: 'pending' });
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
    // 原 1 条 + 新增 2 条
    expect(ctrl.messages).toHaveLength(3);
    expect(ctrl.messages[1]).toMatchObject({ type: 'permission_request', interactionId: 'new-p' });
    expect(ctrl.messages[2]).toMatchObject({ type: 'ask_user', interactionId: 'new-a' });
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

  it('subagent_end：命中既有 subagent 时写终态与统计字段', () => {
    const ctrl = makeController([
      { id: 's', type: 'subagent', toolId: 't1', agentType: 'coder', status: 'running' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch(
      { type: 'subagent_end', toolId: 't1', status: 'completed', durationMs: 500, totalTokens: 1200, toolUseCount: 3 },
      ctx,
    );
    const sub = ctrl.messages[0] as Extract<MessageItem, { type: 'subagent' }>;
    expect(sub.status).toBe('completed');
    expect(sub.durationMs).toBe(500);
    expect(sub.totalTokens).toBe(1200);
    expect(sub.toolUseCount).toBe(3);
  });

  it('subagent_end：无既有 subagent 但带 agentType 时补一条终态', () => {
    const ctrl = makeController();
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'subagent_end', toolId: 't9', agentType: 'coder', status: 'failed', errorMessage: 'oops' }, ctx);
    expect(ctrl.messages[0]).toMatchObject({ type: 'subagent', toolId: 't9', status: 'failed', errorMessage: 'oops' });
  });
});

describe('processWsEvent - done 终态', () => {
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

  it('done 带普通 error：按 client_msg_id 把 user 翻 failed，failedReason 用通俗文案', () => {
    const ctrl = makeController([
      { id: 'u', type: 'user', content: 'hi', status: 'sent', clientMsgId: 'c1' },
    ]);
    const { ctx, hooks } = makeCtx(ctrl);
    const ret = dispatch({ type: 'done', client_msg_id: 'c1', error: 'boom' }, ctx);
    expect(ret).toBe('done');
    const user = ctrl.messages[0] as Extract<MessageItem, { type: 'user' }>;
    expect(user.status).toBe('failed');
    expect(user.failedReason).toBe('异常中断，请继续对话');
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
    expect(ctrl.messages[0]).toMatchObject({ type: 'text', content: '异常中断，请继续对话' });
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
    const ctrl = makeController([
      { id: 'v', type: 'voice', voiceMarkers: [{ text: '第一句' }] },
    ]);
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
    const ctrl = makeController([
      { id: 'v', type: 'user-voice', audioUrl: 'u', duration: 2, status: 'transcribing' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'voice_transcribed', text: '识别结果' }, ctx);
    const v = ctrl.messages[0] as Extract<MessageItem, { type: 'user-voice' }>;
    expect(v.status).toBe('sent');
    expect(v.transcribedText).toBe('识别结果');
  });

  it('voice_transcribed(error)：状态落 failed', () => {
    const ctrl = makeController([
      { id: 'v', type: 'user-voice', audioUrl: 'u', duration: 2, status: 'uploading' },
    ]);
    const { ctx } = makeCtx(ctrl);
    dispatch({ type: 'voice_transcribed', text: '', error: true }, ctx);
    expect((ctrl.messages[0] as Extract<MessageItem, { type: 'user-voice' }>).status).toBe('failed');
  });
});
