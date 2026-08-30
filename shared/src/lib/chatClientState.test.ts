import { describe, expect, it } from 'vitest';
import type { BoundaryIdentity } from './identity';
import type { ChatQueueItem, ChatQueueSnapshot } from './chatQueue';
import {
  canSendChatIntent,
  captureChatClientFence,
  createChatClientState,
  isChatClientFenceCurrent,
  reduceChatClientState,
  selectChatClientQueue,
  selectChatClientQueueItems,
} from './chatClientState';

const identity = (generation = 1, userId = 'a'): BoundaryIdentity => ({ userId, tenantId: 't', generation });
const item = (n: number, status: ChatQueueItem['status'] = 'queued'): ChatQueueItem => ({
  sessionId: 's', clientMsgId: `c${n}`, runId: `r${n}`, sourceRunId: `r${n}`,
  deliveryMode: 'queue', status, queuePosition: n, content: `m${n}`,
  attachments: n === 3 ? [{ attachmentId: '00000000-0000-4000-8000-000000000003', name: 'a.txt' }] : undefined,
});
const snapshot = (items: ChatQueueItem[], generatedAt = '2026-08-30T00:00:00Z'): ChatQueueSnapshot => ({
  version: 1, sessionId: 's', generatedAt, items,
});

describe('M40-01 cross-platform authoritative chat projection', () => {
  it('hydrates three ordered queue items including attachmentId-only data', () => {
    let state = createChatClientState(identity());
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'snapshot', snapshot: snapshot([item(3), item(1), item(2)]) } });
    expect(selectChatClientQueueItems(state, 's').map((entry) => entry.clientMsgId)).toEqual(['c1', 'c2', 'c3']);
    expect(selectChatClientQueueItems(state, 's')[2].attachments).toEqual([{ attachmentId: '00000000-0000-4000-8000-000000000003', name: 'a.txt' }]);
  });

  it('keeps a lost-ACK intent until cold-start snapshot authority replaces it', () => {
    let state = createChatClientState(identity());
    state = reduceChatClientState(state, { type: 'select_session', sessionId: 's', generation: 1 });
    state = reduceChatClientState(state, { type: 'local_intent', generation: 1, intent: { sessionId: 's', clientMsgId: 'c1', deliveryMode: 'queue', state: 'verifying', createdAt: 1 } });
    expect(selectChatClientQueue(state, 's').localIntents.c1?.state).toBe('verifying');
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'snapshot', snapshot: snapshot([item(1)]) } });
    expect(selectChatClientQueue(state, 's').localIntents.c1).toBeUndefined();
    expect(selectChatClientQueueItems(state, 's')[0].runId).toBe('r1');
  });

  it('converges multi-device edit/cancel/steer races by snapshot and terminal stickiness', () => {
    let state = createChatClientState(identity());
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'snapshot', snapshot: snapshot([item(1)]) } });
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'cancel_requested', sessionId: 's', clientMsgId: 'c1' } });
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'server_upsert', item: { ...item(1, 'running'), content: 'edited-by-server' } } });
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'steered', sessionId: 's', clientMsgIds: ['c1'], sourceRunIds: ['r1'], targetRunId: 'target' } });
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'server_terminal', sessionId: 's', runId: 'r1', status: 'completed' } });
    const settled = selectChatClientQueueItems(state, 's')[0];
    expect(settled.content).toBe('edited-by-server');
    expect(settled.status).toBe('completed');
    state = reduceChatClientState(state, { type: 'ws', generation: 1, event: { type: 'done', sessionId: 's', runId: 'r1' } });
    expect(selectChatClientQueueItems(state, 's')[0].status).toBe('completed');
  });

  it('never dispatches on done: reducer only settles the matching authority item', () => {
    let state = createChatClientState(identity());
    state = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'snapshot', snapshot: snapshot([item(1, 'running'), item(2)]) } });
    state = reduceChatClientState(state, { type: 'ws', generation: 1, event: { type: 'done', sessionId: 's', runId: 'r1' } });
    expect(selectChatClientQueueItems(state, 's').map(({ clientMsgId, status }) => [clientMsgId, status])).toEqual([['c2', 'queued'], ['c1', 'completed']]);
  });

  it('fences A→B identity and late frames from a switched session', () => {
    let state = createChatClientState(identity(1, 'a'));
    state = reduceChatClientState(state, { type: 'select_session', sessionId: 's', generation: 1 });
    const fence = captureChatClientFence(state);
    state = reduceChatClientState(state, { type: 'identity_boundary', identity: identity(2, 'b') });
    expect(isChatClientFenceCurrent(state, fence)).toBe(false);
    const afterLateA = reduceChatClientState(state, { type: 'queue', sessionId: 's', generation: 1, event: { type: 'snapshot', snapshot: snapshot([item(1)]) } });
    expect(afterLateA.queues).toEqual({});
    state = reduceChatClientState(state, { type: 'select_session', sessionId: 'other', generation: 2 });
    const switchedFence = captureChatClientFence(state);
    state = reduceChatClientState(state, { type: 'select_session', sessionId: 's', generation: 2 });
    expect(isChatClientFenceCurrent(state, switchedFence, { requireSelectedSession: true })).toBe(false);
  });

  it('recovers interaction after kill/reopen and rejects stale generation outcomes', () => {
    let state = createChatClientState(identity());
    state = reduceChatClientState(state, { type: 'interaction', generation: 1, event: { type: 'server_pending', sessionId: 's', interactionId: 'i', generation: 1 } });
    state = reduceChatClientState(state, { type: 'interaction', generation: 1, event: { type: 'submit', sessionId: 's', interactionId: 'i', generation: 1, requestId: 'q', response: { ok: true } } });
    state = reduceChatClientState(state, { type: 'identity_boundary', identity: identity(2) });
    state = reduceChatClientState(state, { type: 'interaction', generation: 1, event: { type: 'outcome', sessionId: 's', interactionId: 'i', generation: 1, status: 'resolved' } });
    expect(Object.keys(state.interactions.byKey)).toHaveLength(0);
    state = reduceChatClientState(state, { type: 'interaction', generation: 2, event: { type: 'server_pending', sessionId: 's', interactionId: 'i', generation: 2 } });
    expect(Object.values(state.interactions.byKey)[0]?.phase).toBe('pending');
  });
  it('fails closed while offline, locally locked, or uploading', () => {
    expect(canSendChatIntent({ online: false, locallyUnlocked: true })).toBe(false);
    expect(canSendChatIntent({ online: true, locallyUnlocked: false })).toBe(false);
    expect(canSendChatIntent({ online: true, locallyUnlocked: true, uploading: true })).toBe(false);
    expect(canSendChatIntent({ online: true, locallyUnlocked: true })).toBe(true);
  });

});
