import { describe, expect, it } from 'vitest';
import type { MessageItem, MessageItemInput } from '../types/message';
import type { WsProcessingContext } from './wsEventProcessorHelpers';
import { processWsEvent } from './wsEventProcessor';
import {
  projectInteractionRequest,
  projectInteractionResolution,
  projectPendingInteractionSnapshot,
  rememberResolvedInteraction,
} from './wsInteractionProjection';

const questions = [{ question: 'q', header: 'h', options: [], multiSelect: false }];

function createContext(messages: MessageItem[]): WsProcessingContext {
  return {
    msg: {
      messagesRef: { current: messages },
      addMessage: (message: MessageItemInput) =>
        messages.push({ ...message, id: message.id ?? `m-${messages.length}` } as MessageItem) - 1,
      updateMessageAt: (index: number, update: (message: MessageItem) => MessageItem) => {
        messages[index] = update(messages[index]);
      },
      setMessages: (next: MessageItemInput[]) => {
        messages.splice(0, messages.length, ...(next as MessageItem[]));
      },
      triggerScroll: () => undefined,
    },
    resolvedInteractionIdsRef: { current: new Set<string>() },
    handledTerminalKeysRef: { current: new Set<string>() },
  } as unknown as WsProcessingContext;
}

describe('interaction projection', () => {
  it('把外部系统确认卡片原样投影，并且不为普通审批制造 undefined 字段', () => {
    const confirmation = {
      systemName: '演示 ERP',
      capabilityName: '新建订单',
      params: [{ label: '客户', value: '张三' }],
      irreversible: true,
    };
    const projected = projectInteractionRequest([], {
      type: 'permission_request',
      interactionId: 'app-write',
      toolName: 'app__demo_erp__order_create',
      toolInput: { customer: '张三' },
      confirmation,
    });
    expect(projected.find((message) => message.type === 'permission_request')).toMatchObject({
      confirmation,
    });

    const ordinary = projectInteractionRequest([], {
      type: 'permission_request',
      interactionId: 'shell-write',
      toolName: 'Shell',
      toolInput: { command: 'echo ok' },
    });
    expect(ordinary.find((message) => message.type === 'permission_request')).not.toHaveProperty(
      'confirmation',
    );
  });

  it.each([
    [true, 'allowed'],
    [false, 'denied'],
  ] as const)('projects permission allow=%s as %s', (allow, status) => {
    const messages: MessageItem[] = [
      {
        id: 'p',
        type: 'permission_request',
        interactionId: 'x1',
        toolName: 'T',
        toolInput: '',
        status: 'pending',
      },
    ];
    expect(projectInteractionResolution(messages, 'x1', { allow })[0]).toMatchObject({ status });
  });

  it('projects AskUser answers', () => {
    const ask: MessageItem[] = [
      { id: 'a', type: 'ask_user', interactionId: 'x2', questions: [], status: 'pending' },
    ];
    expect(projectInteractionResolution(ask, 'x2', { answers: { q: '否' } })[0]).toMatchObject({
      status: 'answered',
      answers: { q: '否' },
    });
  });

  it('never invents a legacy approval outcome', () => {
    const approval: MessageItem[] = [
      {
        id: 'p',
        type: 'permission_request',
        interactionId: 'legacy',
        toolName: 'T',
        toolInput: '',
        status: 'pending',
      },
    ];
    processWsEvent(
      { type: 'interaction_resolved', sessionId: 's', interactionId: 'legacy' },
      createContext(approval),
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 's' },
      's',
    );
    expect(approval[0]).toMatchObject({ status: 'pending' });
  });

  it('hydrates a versionless card without duplication and rejects a stale version zero', () => {
    const live = projectInteractionRequest([], {
      type: 'ask_user',
      interactionId: 'hydrate',
      questions,
    });
    const hydrated = projectPendingInteractionSnapshot(
      live,
      [{ interactionId: 'hydrate', type: 'ask_user', version: 9, order: 9, questions }],
      's',
    );
    expect(hydrated.filter((message) => message.type === 'ask_user')).toEqual([
      expect.objectContaining({ interactionVersion: 9, interactionOrder: 9 }),
    ]);
    const stale = projectPendingInteractionSnapshot(
      hydrated,
      [{ interactionId: 'hydrate', type: 'ask_user', version: 0, order: 0, questions }],
      's',
    );
    expect(stale.find((message) => message.type === 'ask_user')).toMatchObject({
      interactionVersion: 9,
      interactionOrder: 9,
    });
  });

  it('terminal state and tombstone suppress stale snapshots and clear waiting state', () => {
    const live = projectInteractionRequest([], {
      type: 'ask_user',
      interactionId: 'resolved',
      version: 1,
      order: 1,
      questions,
    });
    const terminal = projectInteractionResolution(live, 'resolved', { answers: { q: 'yes' } });
    const keys = new Set<string>();
    rememberResolvedInteraction(keys, 's', 'resolved');
    const projected = projectPendingInteractionSnapshot(
      terminal,
      [{ interactionId: 'resolved', type: 'ask_user', version: 1, order: 1, questions }],
      's',
      keys,
    );
    expect(projected.filter((message) => message.type === 'ask_user')).toEqual([
      expect.objectContaining({ status: 'answered', answers: { q: 'yes' } }),
    ]);
    expect(
      projected.some(
        (message) => message.type === 'runtime_status' && message.status === 'waiting_user',
      ),
    ).toBe(false);
  });

  it('collapses a historical Answered plus pending duplicate when a stale request arrives', () => {
    const messages: MessageItem[] = [
      { id: 'answered', type: 'ask_user', interactionId: 'duplicate', questions, status: 'answered', answers: { q: 'yes' } },
      { id: 'pending', type: 'ask_user', interactionId: 'duplicate', questions, status: 'pending' },
      { id: 'waiting', type: 'runtime_status', status: 'waiting_user', content: '待补充', streaming: true },
    ];
    const projected = projectInteractionRequest(messages, {
      type: 'ask_user', interactionId: 'duplicate', version: 1, order: 1, questions,
    });
    expect(projected.filter((message) => message.type === 'ask_user')).toEqual([
      expect.objectContaining({ id: 'answered', status: 'answered' }),
    ]);
    expect(projected.some((message) => message.type === 'runtime_status' && message.status === 'waiting_user')).toBe(false);
  });

  it('treats a pending snapshot as an authoritative replacement', () => {
    const messages: MessageItem[] = [];
    const context = createContext(messages);
    processWsEvent(
      { type: 'ask_user', interactionId: 'new-live', version: 2, order: 2, questions },
      context,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 's' },
      's',
    );
    processWsEvent(
      { type: 'pending_interactions', sessionId: 's', interactions: [
        { type: 'ask_user', interactionId: 'old-snapshot', version: 1, order: 1, questions },
      ] },
      context,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 's' },
      's',
    );
    expect(messages.filter((message) => message.type === 'ask_user').map((message) => message.interactionId))
      .toEqual(['old-snapshot']);
  });

  it('lets an authoritative empty WS snapshot clear a stale pending interaction', () => {
    const messages: MessageItem[] = [];
    const context = createContext(messages);
    processWsEvent(
      { type: 'ask_user', interactionId: 'stale', version: 1, order: 1, questions },
      context,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 's' },
      's',
    );
    processWsEvent(
      { type: 'pending_interactions', sessionId: 's', interactions: [] },
      context,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 's' },
      's',
    );
    expect(messages.some((message) => message.type === 'ask_user')).toBe(false);
    expect(messages.some((message) => message.type === 'runtime_status' && message.status === 'waiting_user')).toBe(false);
  });

  it('applies a repeated failed terminal once without deleting adjacent messages', () => {
    const messages: MessageItem[] = [
      {
        id: 'wait',
        type: 'runtime_status',
        status: 'waiting_user',
        content: '待补充',
        streaming: true,
      },
      { id: 'ask-1', type: 'ask_user', interactionId: 'failed', questions, status: 'pending' },
      { id: 'neighbor', type: 'text', content: '不能误删' },
      { id: 'ask-2', type: 'ask_user', interactionId: 'failed', questions, status: 'pending' },
    ];
    const context = createContext(messages);
    const terminal = {
      type: 'interaction_resolved',
      sessionId: 's',
      interactionId: 'failed',
      status: 'failed',
      reason: '已失败',
    } as const;
    processWsEvent(
      terminal,
      context,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 's' },
      's',
    );
    processWsEvent(
      terminal,
      context,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 's' },
      's',
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ id: 'neighbor', content: '不能误删' }),
    );
    expect(
      messages.some(
        (message) =>
          (message.type === 'ask_user' || message.type === 'permission_request') &&
          message.interactionId === 'failed',
      ),
    ).toBe(false);
    expect(messages.filter((message) => message.type === 'system-error')).toHaveLength(1);
  });
});
