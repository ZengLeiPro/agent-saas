import { describe, expect, it } from 'vitest';
import type { MessageItem, MessageItemInput } from '../types/message';
import {
  processWsEvent,
  type MessagesController,
  type WsProcessingContext,
} from './wsEventProcessor';

function makeController(initial: MessageItem[]): MessagesController & { messages: MessageItem[] } {
  const messages = [...initial];
  return {
    messages,
    messagesRef: { current: messages },
    addMessage(message: MessageItemInput) {
      messages.push({ ...message, id: message.id ?? `m${messages.length}` } as MessageItem);
      return messages.length - 1;
    },
    updateMessageAt(index, updater) {
      messages[index] = updater(messages[index]);
    },
    setMessages(next) {
      messages.splice(0, messages.length, ...next.map((message, index) => (
        { ...message, id: message.id ?? `m${index}` } as MessageItem
      )));
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
