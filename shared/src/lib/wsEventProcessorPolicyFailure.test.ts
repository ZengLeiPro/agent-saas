import { describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '../types/message';
import type { WsEvent } from '../types/ws';
import {
  processWsEvent,
  type MessagesController,
  type WsProcessingContext,
} from './wsEventProcessor';

const POLICY_TEXT = '当前模型受策略限制，请切换其他模型继续。';
const POLICY_DONE: WsEvent = {
  type: 'done',
  runId: 'run-policy',
  client_msg_id: 'c-policy',
  error: POLICY_TEXT,
  failureKind: 'policy_rejection',
  recoveryAction: 'switch_model',
};

function makeHarness(messages: MessageItem[]) {
  const msg: MessagesController = {
    messagesRef: { current: messages },
    addMessage: (message) => {
      messages.push({ ...message, id: `m${messages.length}` } as MessageItem);
      return messages.length - 1;
    },
    updateMessageAt: (index, updater) => {
      if (messages[index]) messages[index] = updater(messages[index]);
    },
    triggerScroll: vi.fn(),
  };
  const ctx: WsProcessingContext = {
    msg,
    session: {
      setIsNewSession: vi.fn(), setSessionId: vi.fn(),
      loadSessions: vi.fn().mockResolvedValue(undefined), updateSessionTitle: vi.fn(),
      updateSessionMeta: vi.fn(), removeSession: vi.fn(),
    },
    selectedModelRef: { current: null }, voiceCallbackRef: { current: undefined },
    streamIdRef: { current: null }, runIdRef: { current: null },
    handledTerminalKeysRef: { current: new Set() }, lastEventIdRef: { current: null },
    userMsgIndex: 0, onChatDone: vi.fn(),
  };
  return {
    ctx,
    block: { currentBlockIndex: -1, currentBlockType: null },
    latestSessionId: { value: null },
  };
}

function expectSinglePolicyPrompt(messages: MessageItem[]) {
  expect(messages.filter((message) =>
    (message.type === 'text' || message.type === 'system-error')
    && message.content === POLICY_TEXT)).toHaveLength(1);
  expect(messages.some((message) =>
    'content' in message && message.content === '回复已中断')).toBe(false);
}

describe('processWsEvent - policy failure', () => {
  it('同步 live done 携带策略协议时只保留一条固定文案，不退化为通用中断提示', () => {
    const messages: MessageItem[] = [
      { id: 'u', type: 'user', content: 'hi', status: 'sent', clientMsgId: 'c-policy' },
    ];
    const { ctx, block, latestSessionId } = makeHarness(messages);

    processWsEvent(POLICY_DONE, ctx, block, latestSessionId, null);
    processWsEvent(POLICY_DONE, ctx, block, latestSessionId, null);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: 'u', status: 'sent' });
    expect(messages[1]).toMatchObject({ type: 'text', content: POLICY_TEXT, runId: 'run-policy' });
    expectSinglePolicyPrompt(messages);
  });

  it('durable 策略提示后收到同 run live done 时不追加重复或通用中断提示', () => {
    const messages: MessageItem[] = [
      { id: 'u', type: 'user', content: 'hi', status: 'sent', clientMsgId: 'c-policy' },
      {
        id: 'durable-policy', type: 'system-error', content: POLICY_TEXT, runId: 'run-policy',
        failureKind: 'policy_rejection', recoveryAction: 'switch_model',
      },
    ];
    const { ctx, block, latestSessionId } = makeHarness(messages);

    processWsEvent(POLICY_DONE, ctx, block, latestSessionId, null);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: 'durable-policy', type: 'system-error', content: POLICY_TEXT, runId: 'run-policy',
      failureKind: 'policy_rejection', recoveryAction: 'switch_model',
    });
    expectSinglePolicyPrompt(messages);
  });
});
