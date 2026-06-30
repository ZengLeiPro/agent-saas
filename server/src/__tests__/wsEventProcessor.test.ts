import { describe, expect, it, vi } from 'vitest';

import {
  processWsEvent,
  type MessagesController,
  type WsProcessingContext,
} from '../../../shared/src/lib/wsEventProcessor.js';
import type { MessageItem, MessageItemInput } from '../../../shared/src/types/message.js';
import type { WsEvent } from '../../../shared/src/types/ws.js';

function createTestRig(initial: MessageItem[] = []) {
  const messages: MessageItem[] = [...initial];
  let id = 0;
  const msg: MessagesController = {
    messagesRef: { current: messages },
    addMessage(message: MessageItemInput): number {
      messages.push({ id: `m-${++id}`, ...message } as MessageItem);
      return messages.length - 1;
    },
    updateMessageAt(index: number, updater: (msg: MessageItem) => MessageItem): void {
      messages[index] = updater(messages[index]);
    },
    triggerScroll: vi.fn(),
  };
  const ctx: WsProcessingContext = {
    msg,
    session: {
      setIsNewSession: vi.fn(),
      setSessionId: vi.fn(),
      loadSessions: vi.fn(async () => {}),
      updateSessionTitle: vi.fn(),
      updateSessionMeta: vi.fn(),
      removeSession: vi.fn(),
      upsertSession: vi.fn(),
    },
    selectedModelRef: { current: null },
    voiceCallbackRef: { current: undefined },
    streamIdRef: { current: null },
    lastEventIdRef: { current: null },
    userMsgIndex: -1,
  };
  return { messages, ctx };
}

function process(event: WsEvent, ctx: WsProcessingContext): void {
  processWsEvent(
    event,
    ctx,
    { currentBlockIndex: -1, currentBlockType: null },
    { value: 'session-1' },
    'session-1',
  );
}

describe('wsEventProcessor session events', () => {
  it('upserts a local placeholder when a session id is assigned', () => {
    const { ctx } = createTestRig();
    ctx.selectedModelRef.current = 'opus-test';

    processWsEvent(
      { type: 'session', sessionId: 'new-session-1' },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: null },
      null,
    );

    expect(ctx.session.setIsNewSession).toHaveBeenCalledWith(false);
    expect(ctx.session.setSessionId).toHaveBeenCalledWith('new-session-1');
    expect(ctx.session.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'new-session-1',
      model: 'opus-test',
    }));
  });
});

describe('wsEventProcessor terminal errors', () => {
  it('finalizes a half-open streaming text block when done arrives without block_end', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'assistant-1',
        type: 'text',
        content: 'partial answer',
        streaming: true,
      },
    ]);
    const block = { currentBlockIndex: 0, currentBlockType: 'text' };

    const result = processWsEvent(
      { type: 'done' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );

    expect(result).toBe('done');
    expect(messages[0]).toMatchObject({
      type: 'text',
      streaming: false,
    });
    expect(block).toEqual({ currentBlockIndex: -1, currentBlockType: null });
  });

  it('finalizes the previous streaming block before starting a new block', () => {
    const { messages, ctx } = createTestRig();
    const block = { currentBlockIndex: -1, currentBlockType: null };

    processWsEvent(
      { type: 'block_start', blockType: 'text' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'text', content: 'hello' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'block_start', blockType: 'thinking' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );

    expect(messages[0]).toMatchObject({
      type: 'text',
      content: 'hello',
      streaming: false,
    });
    expect(messages[1]).toMatchObject({
      type: 'thinking',
      streaming: true,
    });
  });

  it('marks the current user message failed when done carries an error without client_msg_id', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'user-1',
        type: 'user',
        content: 'please run',
        status: 'sent',
      },
    ]);
    ctx.userMsgIndex = 0;

    const result = processWsEvent(
      { type: 'done', error: 'model returned empty turn' },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 'session-1' },
      'session-1',
    );

    expect(result).toBe('done');
    expect(messages[0]).toMatchObject({
      type: 'user',
      status: 'failed',
      // 用户侧通俗文案;原始 model error 留 server.log + PG runtime_events
      failedReason: '异常中断，请继续对话',
    });
  });

  it('uses the model request message only for model HTTP 5xx failures', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'user-1',
        type: 'user',
        content: 'continue',
        status: 'sent',
      },
    ]);
    ctx.userMsgIndex = 0;

    processWsEvent(
      {
        type: 'done',
        error: 'Responses API HTTP 500: {"error":{"message":"Post \\"https://chatgpt.com/backend-api/codex/responses\\": EOF","type":"server_error"}}',
      },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 'session-1' },
      'session-1',
    );

    expect(messages[0]).toMatchObject({
      type: 'user',
      status: 'failed',
      failedReason: '模型请求错误，请稍后重试',
    });
  });

  it('does not mask non-model runtime errors as model request errors', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'user-1',
        type: 'user',
        content: 'continue',
        status: 'sent',
      },
    ]);
    ctx.userMsgIndex = 0;

    processWsEvent(
      {
        type: 'done',
        error: 'approval not found: approval-1',
      },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 'session-1' },
      'session-1',
    );

    expect(messages[0]).toMatchObject({
      type: 'user',
      status: 'failed',
      failedReason: '异常中断，请继续对话',
    });
  });
});

describe('wsEventProcessor pending interaction replay', () => {
  it('adds pending ask_user and plan approval messages without duplicating existing interactionIds', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'existing',
        type: 'permission_request',
        interactionId: 'plan-1',
        toolName: '规划方案审批',
        toolInput: '旧计划',
        status: 'pending',
      },
    ]);

    process({
      type: 'pending_interactions',
      interactions: [
        {
          interactionId: 'plan-1',
          type: 'permission_request',
          toolName: 'ExitPlanMode',
          planContent: '不应重复加入',
        },
        {
          interactionId: 'plan-2',
          type: 'permission_request',
          toolName: 'ExitPlanMode',
          planContent: '新计划正文',
        },
        {
          interactionId: 'ask-1',
          type: 'ask_user',
          questions: [
            {
              question: '继续吗？',
              header: '确认',
              options: [{ label: '继续', description: '继续执行' }],
              multiSelect: false,
            },
          ],
        },
      ],
    }, ctx);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      type: 'permission_request',
      interactionId: 'plan-2',
      toolName: '规划方案审批',
      toolInput: '新计划正文',
      status: 'pending',
    });
    expect(messages[2]).toMatchObject({
      type: 'ask_user',
      interactionId: 'ask-1',
      status: 'pending',
    });
  });

  it('marks replayed pending interactions as resolved', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'pending',
        type: 'ask_user',
        interactionId: 'ask-2',
        questions: [],
        status: 'pending',
      },
    ]);

    process({ type: 'interaction_resolved', sessionId: 'session-1', interactionId: 'ask-2' }, ctx);

    expect(messages[0]).toMatchObject({
      type: 'ask_user',
      interactionId: 'ask-2',
      status: 'answered',
    });
  });
});
