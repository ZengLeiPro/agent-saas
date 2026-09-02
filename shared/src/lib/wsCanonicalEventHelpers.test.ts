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

  it('interaction_resolved：denied/workflow failure/expired 显示服务端原因', () => {
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
    }, makeContext(ctrl), { currentBlockIndex: -1, currentBlockType: null }, { value: null }, null);
    expect(ctrl.messages).toContainEqual(expect.objectContaining({
      type: 'system-error',
      content: '交互未完成：Workflow approval unavailable',
    }));
  });
});
