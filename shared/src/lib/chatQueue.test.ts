import { describe, expect, it } from 'vitest';

import {
  CHAT_QUEUE_SNAPSHOT_VERSION,
  chatQueueStatusToMessageStatus,
  createChatQueueState,
  reduceChatQueueEvent,
  selectCancellableChatQueueItems,
  selectChatQueueItem,
  selectChatQueueItems,
  selectChatQueueLocalIntents,
  selectPendingChatQueueItems,
  type ChatQueueItem,
  type ChatQueueSnapshot,
  type ChatQueueState,
  type ChatQueueStatus,
} from './chatQueue';

const SESSION_ID = 'session-m20-02';

function item(index: number, patch: Partial<ChatQueueItem> = {}): ChatQueueItem {
  return {
    sessionId: SESSION_ID,
    clientMsgId: `client-${index}`,
    runId: `run-${index}`,
    sourceRunId: `run-${index}`,
    deliveryMode: 'queue',
    status: 'queued',
    queuePosition: index,
    content: `message ${index}`,
    acceptedAt: `2026-08-30T00:00:0${index}.000Z`,
    ...patch,
  };
}

function snapshot(items: ChatQueueItem[]): ChatQueueSnapshot {
  return {
    version: CHAT_QUEUE_SNAPSHOT_VERSION,
    sessionId: SESSION_ID,
    items,
    generatedAt: '2026-08-30T00:01:00.000Z',
  };
}

function hydrate(items: ChatQueueItem[]): ChatQueueState {
  return reduceChatQueueEvent(createChatQueueState(), { type: 'snapshot', snapshot: snapshot(items) });
}

describe('chat queue reducer', () => {
  it('hydrates three queued messages in authoritative server order after a cold start', () => {
    const state = hydrate([item(1), item(2), item(3)]);

    expect(state.hydrated).toBe(true);
    expect(selectPendingChatQueueItems(state).map((entry) => entry.clientMsgId)).toEqual([
      'client-1',
      'client-2',
      'client-3',
    ]);
  });

  it('produces the same state for multiple devices hydrating the same snapshot', () => {
    const authoritative = snapshot([
      item(1, { status: 'running', queuePosition: undefined }),
      item(2),
      item(3),
    ]);
    const deviceA = reduceChatQueueEvent(createChatQueueState(), { type: 'snapshot', snapshot: authoritative });
    const deviceB = reduceChatQueueEvent(createChatQueueState(), { type: 'snapshot', snapshot: authoritative });

    expect(deviceA).toEqual(deviceB);
    expect(selectChatQueueItems(deviceA).map(({ runId, status }) => ({ runId, status }))).toEqual([
      { runId: 'run-2', status: 'queued' },
      { runId: 'run-3', status: 'queued' },
      { runId: 'run-1', status: 'running' },
    ]);
  });

  it('reconciles an ACK-loss retry with the same clientMsgId into one run', () => {
    let state = createChatQueueState(SESSION_ID);
    state = reduceChatQueueEvent(state, {
      type: 'intent_added',
      intent: {
        sessionId: SESSION_ID,
        clientMsgId: 'client-1',
        deliveryMode: 'queue',
        content: 'message 1',
        state: 'verifying',
        createdAt: 1,
      },
    });
    state = reduceChatQueueEvent(state, { type: 'server_upsert', item: item(1) });
    state = reduceChatQueueEvent(state, {
      type: 'server_upsert',
      item: item(1, { status: 'queued', queuePosition: 1 }),
    });

    expect(selectChatQueueItems(state)).toHaveLength(1);
    expect(selectChatQueueLocalIntents(state)).toHaveLength(0);
    expect(selectChatQueueItem(state, { clientMsgId: 'client-1' })?.runId).toBe('run-1');
  });

  it.each([
    ['queued', 'running', 'running'],
    ['running', 'queued', 'running'],
    ['queued', 'completed', 'completed'],
    ['completed', 'queued', 'completed'],
    ['failed', 'running', 'failed'],
    ['cancelled', 'queued', 'cancelled'],
    ['steered', 'queued', 'steered'],
    ['steered', 'completed', 'completed'],
  ] satisfies Array<[ChatQueueStatus, ChatQueueStatus, ChatQueueStatus]>) (
    'folds duplicate/out-of-order %s → %s as %s',
    (initial, incoming, expected) => {
      let state = hydrate([item(1, { status: initial })]);
      state = reduceChatQueueEvent(state, {
        type: 'server_upsert',
        item: item(1, { status: incoming }),
      });
      expect(selectChatQueueItem(state, { runId: 'run-1' })?.status).toBe(expected);
    },
  );

  it('lets a server running/terminal state settle a queue → cancel race', () => {
    let state = hydrate([item(1)]);
    state = reduceChatQueueEvent(state, {
      type: 'cancel_requested',
      sessionId: SESSION_ID,
      sourceRunId: 'run-1',
    });
    expect(selectChatQueueItem(state, { runId: 'run-1' })?.status).toBe('cancel_pending');

    state = reduceChatQueueEvent(state, {
      type: 'server_upsert',
      item: item(1, { status: 'running' }),
    });
    expect(selectChatQueueItem(state, { runId: 'run-1' })?.status).toBe('running');

    state = reduceChatQueueEvent(state, {
      type: 'server_terminal',
      sessionId: SESSION_ID,
      runId: 'run-1',
      status: 'completed',
    });
    expect(selectChatQueueItem(state, { runId: 'run-1' })?.status).toBe('completed');
    expect(selectCancellableChatQueueItems(state)).toEqual([]);
  });

  it('folds steer → terminal and never revives the source from a late queued frame', () => {
    let state = hydrate([item(1, { deliveryMode: 'steer', targetRunId: 'target-1' })]);
    state = reduceChatQueueEvent(state, {
      type: 'steered',
      sessionId: SESSION_ID,
      clientMsgIds: ['client-1'],
      sourceRunIds: ['run-1'],
      targetRunId: 'target-1',
    });
    state = reduceChatQueueEvent(state, {
      type: 'server_terminal',
      sessionId: SESSION_ID,
      sourceRunId: 'run-1',
      status: 'completed',
    });
    state = reduceChatQueueEvent(state, {
      type: 'server_upsert',
      item: item(1, { deliveryMode: 'steer', status: 'queued' }),
    });

    expect(selectChatQueueItem(state, { sourceRunId: 'run-1' })?.status).toBe('completed');
  });

  it('keeps canonical attachmentId unchanged through queue hydration', () => {
    const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const state = hydrate([item(1, {
      attachments: [{
        attachmentId,
        name: 'contract.pdf',
        mimeType: 'application/pdf',
        size: 100,
      }],
    })]);

    expect(selectChatQueueItem(state, { clientMsgId: 'client-1' })?.attachments).toEqual([{
      attachmentId,
      name: 'contract.pdf',
      mimeType: 'application/pdf',
      size: 100,
    }]);
  });

  it('replaces live guesses with a later authoritative snapshot while retaining unmatched local intents', () => {
    let state = hydrate([item(1), item(2)]);
    state = reduceChatQueueEvent(state, {
      type: 'server_upsert',
      item: item(1, { status: 'running' }),
    });
    state = reduceChatQueueEvent(state, {
      type: 'intent_added',
      intent: {
        sessionId: SESSION_ID,
        clientMsgId: 'client-local',
        deliveryMode: 'queue',
        state: 'sending',
        createdAt: 3,
      },
    });

    state = reduceChatQueueEvent(state, {
      type: 'snapshot',
      snapshot: snapshot([item(2, { status: 'running', queuePosition: undefined })]),
    });

    expect(selectChatQueueItems(state).map((entry) => entry.clientMsgId)).toEqual(['client-2']);
    expect(selectChatQueueLocalIntents(state).map((entry) => entry.clientMsgId)).toEqual(['client-local']);
  });

  it('ignores cross-session events and malformed/duplicate snapshot aliases', () => {
    let state = hydrate([
      item(1),
      item(1, { clientMsgId: 'client-duplicate' }),
      item(2, { sessionId: 'other-session' }),
    ]);
    state = reduceChatQueueEvent(state, {
      type: 'server_terminal',
      sessionId: 'other-session',
      runId: 'run-1',
      status: 'failed',
    });

    expect(selectChatQueueItems(state)).toHaveLength(1);
    expect(selectChatQueueItem(state, { runId: 'run-1' })?.status).toBe('queued');
  });
});

describe('chat queue selectors', () => {
  it.each([
    ['queued', 'queued'],
    ['cancel_pending', 'queued'],
    ['running', 'sent'],
    ['steered', 'sent'],
    ['completed', 'sent'],
    ['cancelled', 'sent'],
    ['failed', 'failed'],
  ] satisfies Array<[ChatQueueStatus, 'queued' | 'sent' | 'failed']>)(
    'projects %s to message status %s',
    (status, expected) => expect(chatQueueStatusToMessageStatus(status)).toBe(expected),
  );
});
