import { describe, expect, it } from 'vitest';
import type { MessageItem, MessageItemInput } from '../types/message';
import type { WsEvent } from '../types/ws';
import {
  processWsEvent,
  type MessagesController,
  type WsProcessingContext,
  type WsBlockState,
} from './wsEventProcessor';

function makeController(initial: MessageItem[], copyOnWrite = false): MessagesController & { messages: MessageItem[] } {
  const messagesRef = { current: [...initial] };
  return {
    get messages() { return messagesRef.current; },
    messagesRef,
    addMessage(message: MessageItemInput) {
      const messages = messagesRef.current;
      messages.push({ ...message, id: message.id ?? `m${messages.length}` } as MessageItem);
      return messages.length - 1;
    },
    updateMessageAt(index, updater) {
      if (copyOnWrite) messagesRef.current = [...messagesRef.current];
      const messages = messagesRef.current;
      messages[index] = updater(messages[index]);
    },
    setMessages(next) {
      messagesRef.current = next.map((message, index) => (
        { ...message, id: message.id ?? `m${index}` } as MessageItem
      ));
    },
    triggerScroll() {},
  };
}

function makeContext(msg: MessagesController): WsProcessingContext {
  return {
    msg,
    session: {
      setIsNewSession() {},
      setSessionId() {},
      async loadSessions() {},
      updateSessionTitle() {},
      updateSessionMeta() {},
      removeSession() {},
    },
    selectedModelRef: { current: null },
    voiceCallbackRef: { current: undefined },
    streamIdRef: { current: null },
    lastEventIdRef: { current: null },
    userMsgIndex: -1,
  };
}

function toolFrame(eventId: string, frame: WsEvent, runId = 'run-1', toolId = 'call-1'): WsEvent {
  return {
    ...frame,
    projection: {
      eventId, domain: 'tool', runId, messageId: `assistant:${runId}`,
      blockId: `tool:${runId}:${toolId}`, toolCallId: toolId,
    },
  };
}

describe('工具参数与执行投影的调用身份', () => {
  it.each(['success', 'error', 'cancelled'] as const)('完整 %s 生命周期始终只有一行，保留参数与执行结果', (status) => {
    const ctrl = makeController([]);
    const context = makeContext(ctrl);
    const block: WsBlockState = { currentBlockIndex: -1, currentBlockType: null };
    const dispatch = (frame: WsEvent) => processWsEvent(frame, context, block, { value: null }, null);
    dispatch(toolFrame('args-start', { type: 'block_start', blockType: 'tool_use', toolId: 'call-1', toolName: 'WaitForWorkspaceReady', runId: 'run-1' }));
    dispatch(toolFrame('args-delta', { type: 'tool_input', toolId: 'call-1', content: '{"timeoutMs":30000}' }));
    dispatch(toolFrame('args-end', { type: 'block_end', blockType: 'tool_use', toolName: 'WaitForWorkspaceReady' }));
    expect(ctrl.messages).toHaveLength(1);

    const started = toolFrame('started', { type: 'tool_execution', phase: 'started', toolId: 'call-1', toolName: 'WaitForWorkspaceReady', invocationId: 'inv-1' });
    dispatch(started);
    expect(ctrl.messages).toEqual([expect.objectContaining({ toolInput: '{"timeoutMs":30000}', executionStatus: 'running', invocationId: 'inv-1' })]);
    dispatch(toolFrame('progress', { type: 'tool_execution', phase: 'progress', toolId: 'call-1' }));
    expect(ctrl.messages[0]).toMatchObject({ toolName: 'WaitForWorkspaceReady', toolInput: '{"timeoutMs":30000}' });
    dispatch(toolFrame('completed', { type: 'tool_execution', phase: 'completed', toolId: 'call-1', status, durationMs: 12 }));
    if (status !== 'cancelled') {
      dispatch(toolFrame('result', { type: 'tool_result', toolId: 'call-1', result: 'workspace result', isError: status === 'error' }));
    }
    const expected = status === 'error' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed';
    expect(ctrl.messages).toEqual([expect.objectContaining({ toolName: 'WaitForWorkspaceReady', toolInput: '{"timeoutMs":30000}', executionStatus: expected, streaming: false, durationMs: 12 })]);
    if (status !== 'cancelled') expect(ctrl.messages[0]).toMatchObject({ resultReady: true, result: 'workspace result' });
    dispatch(started);
    dispatch(toolFrame('late-started', { type: 'tool_execution', phase: 'started', toolId: 'call-1' }));
    expect(ctrl.messages).toHaveLength(1);
    expect(ctrl.messages[0]).toMatchObject({ executionStatus: expected, streaming: false });
  });

  it('重连从历史块接续，晚到的执行开始不覆盖已有终态与结果', () => {
    const ctrl = makeController([{
      id: 'history-block', type: 'tool_use', runId: 'run-1', toolId: 'call-1',
      toolName: 'Read', toolInput: '{"path":"example.txt"}', executionStatus: 'completed',
      result: 'file contents', resultReady: true, durationMs: 17,
    }]);
    const context = makeContext(ctrl);
    const block: WsBlockState = { currentBlockIndex: -1, currentBlockType: null };
    processWsEvent(toolFrame('replay-start', { type: 'tool_execution', phase: 'started', toolId: 'call-1', toolName: 'Read' }), context, block, { value: null }, null);
    expect(ctrl.messages).toEqual([expect.objectContaining({
      type: 'tool_use', executionStatus: 'completed', resultReady: true, result: 'file contents',
      toolInput: '{"path":"example.txt"}', durationMs: 17, streaming: false,
    })]);
  });

  it('旧协议无 runId 的参数骨架可被执行事件原位认领', () => {
    const ctrl = makeController([]);
    const context = makeContext(ctrl);
    const block: WsBlockState = { currentBlockIndex: -1, currentBlockType: null };
    processWsEvent({ type: 'block_start', blockType: 'tool_use', toolId: 'call-1', toolName: 'Read' }, context, block, { value: null }, null);
    processWsEvent({ type: 'tool_input', content: '{}' }, context, block, { value: null }, null);
    processWsEvent(toolFrame('start', { type: 'tool_execution', phase: 'started', toolId: 'call-1' }), context, block, { value: null }, null);
    expect(ctrl.messages).toEqual([expect.objectContaining({ runId: 'run-1', toolName: 'Read', toolInput: '{}', executionStatus: 'running' })]);
  });

  it.each([false, true])('收拢旧重复行并修正流式指针，不合并其他 run 或另一次同名调用（copyOnWrite=%s）', (copyOnWrite) => {
    const ctrl = makeController([
      { id: 'args', type: 'tool_use', runId: 'run-1', toolId: 'call-1', toolName: 'Read', toolInput: '{"path":"a"}', executionStatus: 'pending' },
      { id: 'tool:run-1:call-1', type: 'tool_use', runId: 'run-1', toolId: 'call-1', toolName: 'Read', toolInput: '', executionStatus: 'running' },
      { id: 'other-run', type: 'tool_use', runId: 'run-2', toolId: 'call-1', toolName: 'Read', toolInput: '{}', executionStatus: 'running' },
      { id: 'other-call', type: 'tool_use', runId: 'run-1', toolId: 'call-2', toolName: 'Read', toolInput: '{}', executionStatus: 'running' },
      { id: 'text', type: 'text', content: '', streaming: true },
    ], copyOnWrite);
    const context = makeContext(ctrl);
    const block: WsBlockState = { currentBlockIndex: 4, currentBlockType: 'text' };
    processWsEvent(toolFrame('result', { type: 'tool_result', toolId: 'call-1', result: 'done' }), context, block, { value: null }, null);
    expect(ctrl.messages).toHaveLength(4);
    expect(ctrl.messages[0]).toMatchObject({ toolInput: '{"path":"a"}', executionStatus: 'completed', result: 'done' });
    expect(ctrl.messages.slice(1, 3).map((message) => message.id)).toEqual(['other-run', 'other-call']);
    expect(block.currentBlockIndex).toBe(3);
    processWsEvent({ type: 'text', content: '继续' }, context, block, { value: null }, null);
    expect(ctrl.messages[3]).toMatchObject({ content: '继续' });
  });
});

describe('WS canonical event integration', () => {
  it('user_message：按 clientMsgId 原位接管 optimistic 气泡，重复投影仍保持单条', () => {
    const ctrl = makeController([{
      id: 'local-user',
      type: 'user',
      content: '本地乐观消息',
      status: 'pending',
      clientMsgId: 'client-1',
    }]);
    const context = makeContext(ctrl);
    const block = { currentBlockIndex: -1, currentBlockType: null };
    const event = {
      type: 'user_message',
      content: '服务端权威消息',
      timestamp: 100,
      client_msg_id: 'client-1',
      projection: {
        eventId: 'event-user-1',
        domain: 'message',
        runId: 'run-1',
        messageId: 'canonical-user-1',
      },
    } as const;

    processWsEvent(event, context, block, { value: null }, null);
    expect(ctrl.messages).toEqual([expect.objectContaining({
      id: 'canonical-user-1',
      type: 'user',
      content: '服务端权威消息',
      status: 'sent',
      clientMsgId: 'client-1',
    })]);

    processWsEvent(event, context, block, { value: null }, null);
    expect(ctrl.messages).toHaveLength(1);
  });

  it('user_message：相同正文但 clientMsgId 不同的 canonical 消息不得合并', () => {
    const ctrl = makeController([{
      id: 'local-user',
      type: 'user',
      content: '重复正文',
      status: 'pending',
      clientMsgId: 'client-local',
    }]);

    processWsEvent({
      type: 'user_message',
      content: '重复正文',
      timestamp: 100,
      client_msg_id: 'client-server',
      projection: {
        eventId: 'event-user-2',
        domain: 'message',
        runId: 'run-2',
        messageId: 'canonical-user-2',
      },
    }, makeContext(ctrl), { currentBlockIndex: -1, currentBlockType: null }, { value: null }, null);

    expect(ctrl.messages).toHaveLength(2);
    expect(ctrl.messages.map((message) => message.id)).toEqual(['local-user', 'canonical-user-2']);
  });

  it('user_message：接管语音 optimistic 气泡时保留本地音频能力', () => {
    const ctrl = makeController([{
      id: 'local-voice',
      type: 'user-voice',
      audioUrl: '/api/attachments/voice-1',
      attachmentId: 'voice-1',
      duration: 8,
      status: 'transcribing',
      clientMsgId: 'client-voice',
    }]);

    processWsEvent({
      type: 'user_message',
      content: '语音转写内容',
      timestamp: 200,
      client_msg_id: 'client-voice',
      projection: {
        eventId: 'event-voice',
        domain: 'message',
        runId: 'run-voice',
        messageId: 'canonical-voice',
      },
    }, makeContext(ctrl), { currentBlockIndex: -1, currentBlockType: null }, { value: null }, null);

    expect(ctrl.messages).toEqual([expect.objectContaining({
      id: 'canonical-voice',
      type: 'user-voice',
      audioUrl: '/api/attachments/voice-1',
      attachmentId: 'voice-1',
      status: 'sent',
      clientMsgId: 'client-voice',
    })]);
  });

  it('structured error：清状态条并追加 canonical 安全终态，不复制 raw message', () => {
    const ctrl = makeController([{ id: 'r', type: 'runtime_status', status: 'running' }]);
    processWsEvent({
      type: 'error',
      code: 'tls_untrusted',
      correlationId: 'corr-ws-123',
      message: 'token=WS_SECRET /workspace/private stack trace',
    }, makeContext(ctrl), { currentBlockIndex: -1, currentBlockType: null }, { value: null }, null);
    expect(ctrl.messages.some((message) => message.type === 'runtime_status')).toBe(false);
    const error = ctrl.messages.find((message) => message.type === 'system-error') as Extract<MessageItem, { type: 'system-error' }>;
    expect(error.canonicalFailure).toMatchObject({ kind: 'tls_untrusted', terminal: true, correlationId: 'corr-ws-123' });
    expect(JSON.stringify(error)).not.toMatch(/WS_SECRET|workspace|stack trace/);
  });

  it('interaction_resolved：仅在当前会话显示 denied/workflow failure/expired 原因', () => {
    const ctrl = makeController([
      { id: 'p', type: 'permission_request', interactionId: 'failed', toolName: 'T', toolInput: '', status: 'pending' },
    ]);
    processWsEvent({
      type: 'interaction_resolved',
      sessionId: 's',
      interactionId: 'failed',
      status: 'failed',
      response: { allow: false },
      reason: 'Workflow approval unavailable',
    }, makeContext(ctrl), { currentBlockIndex: -1, currentBlockType: null }, { value: 's' }, 's');
    expect(ctrl.messages).toContainEqual(expect.objectContaining({
      type: 'system-error',
      content: '交互未完成：Workflow approval unavailable',
    }));
  });
});
