import { describe, expect, it } from 'vitest';
import type { ChatQueueItem } from './chatQueue';
import {
  createSyncRecoveryState,
  reduceSyncRecovery,
  resetSyncRecovery,
  selectAppliedInteractionEvents,
  selectAppliedQueueEvents,
  selectAppliedRuntimeEvents,
  selectAppliedSessionUserEvents,
  selectFullRefreshRequired,
  selectRecoveredInteractions,
  selectRecoveredQueue,
  selectRecoveredRuntime,
  selectRecoveredSession,
  selectSyncRequest,
  type SyncRecoveryState,
} from './syncRecovery';
import type { WsEvent } from '../types/ws';

const SESSION = 'session-m20-03';

function queueItem(status: ChatQueueItem['status']): ChatQueueItem {
  return {
    sessionId: SESSION,
    clientMsgId: 'client-1',
    runId: 'run-1',
    sourceRunId: 'run-1',
    deliveryMode: 'queue',
    status,
  };
}

function live(
  state: SyncRecoveryState,
  seq: number,
  event: WsEvent,
  epoch = 'epoch-1',
): SyncRecoveryState {
  return reduceSyncRecovery(state, { type: 'event', envelope: { seq, epoch, event } });
}

function readyAtZero(epoch = 'epoch-1'): SyncRecoveryState {
  return reduceSyncRecovery(createSyncRecoveryState({ serverEpoch: epoch }), {
    type: 'sync_ok', seq: 0, epoch, events: [],
  });
}

describe('M20-03 pure sync recovery kernel', () => {
  it('clears all old projections and restarts from zero when the server epoch changes', () => {
    let state = readyAtZero();
    state = live(state, 1, { type: 'queue_item_updated', item: queueItem('running') });
    state = live(state, 2, { type: 'session_status', sessionId: SESSION, runId: 'run-1', status: 'running' });
    state = live(state, 3, {
      type: 'permission_request', interactionId: 'interaction-1', toolName: 'Shell', toolInput: {},
    });
    state = live(state, 4, { type: 'session_updated', sessionId: SESSION, title: 'old', updatedAtMs: 1 });

    state = reduceSyncRecovery(state, { type: 'pong', seq: 7, epoch: 'epoch-2' });

    expect(state).toMatchObject({ lastSeq: 0, serverEpoch: 'epoch-2', phase: 'syncing' });
    expect(Object.keys(state.queueBySession)).toHaveLength(0);
    expect(Object.keys(state.runtimeBySession)).toHaveLength(0);
    expect(selectRecoveredInteractions(state)).toEqual([]);
    expect(Object.keys(state.sessions)).toHaveLength(0);
    expect(selectSyncRequest(state)).toMatchObject({ lastSeq: 0, epoch: 'epoch-2', reason: 'epoch_change' });
  });

  it('does not advance over a gap and requests exactly one sync for repeated gap frames', () => {
    let state = createSyncRecoveryState({ lastSeq: 3, serverEpoch: 'epoch-1' });
    const gap = { type: 'title_updated', sessionId: SESSION, title: 'must wait' } as const;
    state = live(state, 5, gap);
    const request = selectSyncRequest(state);

    expect(state.lastSeq).toBe(3);
    expect(selectRecoveredSession(state, SESSION)).toBeUndefined();
    expect(request).toMatchObject({ id: 1, lastSeq: 3, reason: 'gap' });

    const duplicateGap = live(state, 5, gap);
    expect(selectSyncRequest(duplicateGap)).toBe(request);
    expect(duplicateGap.nextSyncRequestId).toBe(2);
  });

  it('marks overflow as an authoritative full refresh and discards partial projections', () => {
    let state = readyAtZero();
    state = live(state, 1, { type: 'queue_item_updated', item: queueItem('queued') });
    state = reduceSyncRecovery(state, { type: 'sync_overflow', seq: 99, epoch: 'epoch-1' });

    expect(state).toMatchObject({ lastSeq: 99, phase: 'full_refresh' });
    expect(selectFullRefreshRequired(state)).toEqual({
      reason: 'overflow', authoritativeSeq: 99, epoch: 'epoch-1',
    });
    expect(Object.keys(state.queueBySession)).toHaveLength(0);
    expect(selectSyncRequest(state)).toBeNull();
  });

  it('sorts a sync batch, applies only its continuous prefix, and drops duplicates/out-of-order live frames', () => {
    let state = createSyncRecoveryState({ serverEpoch: 'epoch-1' });
    state = reduceSyncRecovery(state, {
      type: 'sync_ok',
      seq: 3,
      epoch: 'epoch-1',
      events: [
        { seq: 3, event: { type: 'title_updated', sessionId: SESSION, title: 'third' } },
        { seq: 1, event: { type: 'title_updated', sessionId: SESSION, title: 'first' } },
        { seq: 2, event: { type: 'title_updated', sessionId: SESSION, title: 'second' } },
        { seq: 2, event: { type: 'title_updated', sessionId: SESSION, title: 'duplicate' } },
      ],
    });
    expect(state.lastSeq).toBe(3);
    expect(selectRecoveredSession(state, SESSION)?.title).toBe('third');

    state = live(state, 2, { type: 'title_updated', sessionId: SESSION, title: 'stale' });
    expect(state.lastSeq).toBe(3);
    expect(selectRecoveredSession(state, SESSION)?.title).toBe('third');
  });

  it('never revives terminal queue/runtime or resolved interaction projections from stale frames', () => {
    let state = readyAtZero();
    state = live(state, 1, { type: 'queue_item_updated', item: queueItem('completed') });
    state = live(state, 2, { type: 'session_status', sessionId: SESSION, runId: 'run-1', status: 'completed' });
    state = live(state, 3, { type: 'interaction_resolved', sessionId: SESSION, interactionId: 'interaction-1' });

    state = live(state, 1, { type: 'queue_item_updated', item: queueItem('queued') });
    state = live(state, 2, { type: 'session_status', sessionId: SESSION, runId: 'run-1', status: 'running' });
    state = live(state, 3, {
      type: 'permission_request', interactionId: 'interaction-1', toolName: 'Shell', toolInput: {},
    });

    expect(selectRecoveredQueue(state, SESSION).items['client-1']?.status).toBe('completed');
    expect(selectRecoveredRuntime(state, SESSION)).toMatchObject({ status: 'completed', terminal: true });
    expect(selectRecoveredInteractions(state)).toEqual([]);
  });

  it('keeps queue/runtime/interaction/session terminal projections sticky in later frames', () => {
    let state = readyAtZero();
    state = live(state, 1, { type: 'queue_item_updated', item: queueItem('completed') });
    state = live(state, 2, { type: 'session_status', sessionId: SESSION, runId: 'run-1', status: 'failed' });
    state = live(state, 3, { type: 'interaction_resolved', sessionId: SESSION, interactionId: 'interaction-1' });
    state = live(state, 4, { type: 'session_deleted', sessionId: SESSION });
    state = live(state, 5, { type: 'queue_item_updated', item: queueItem('queued') });
    state = live(state, 6, { type: 'session_status', sessionId: SESSION, runId: 'run-1', status: 'queued' });
    state = live(state, 7, {
      type: 'pending_interactions',
      interactions: [{ interactionId: 'interaction-1', type: 'permission_request', toolName: 'Shell' }],
    });
    state = live(state, 8, { type: 'session_updated', sessionId: SESSION, title: 'revived', updatedAtMs: 8 });

    expect(selectRecoveredQueue(state, SESSION).items['client-1']?.status).toBe('completed');
    expect(selectRecoveredRuntime(state, SESSION)?.status).toBe('failed');
    expect(selectRecoveredInteractions(state)).toEqual([]);
    expect(selectRecoveredSession(state, SESSION)).toEqual({ sessionId: SESSION, deleted: true });
  });

  it('ignores responses from a retired old server after adopting a restart epoch', () => {
    let state = readyAtZero('epoch-1');
    state = reduceSyncRecovery(state, { type: 'pong', seq: 2, epoch: 'epoch-2' });
    const afterRestart = state;

    state = reduceSyncRecovery(state, {
      type: 'sync_ok', seq: 8, epoch: 'epoch-1',
      events: [{ seq: 1, event: { type: 'title_updated', sessionId: SESSION, title: 'old server' } }],
    });

    expect(state).toBe(afterRestart);
    expect(state.serverEpoch).toBe('epoch-2');
    expect(state.lastSeq).toBe(0);
  });

  it('does not create a sync loop for duplicate pongs or an incomplete response without progress', () => {
    let state = createSyncRecoveryState({ lastSeq: 4, serverEpoch: 'epoch-1' });
    state = reduceSyncRecovery(state, { type: 'pong', seq: 7, epoch: 'epoch-1' });
    const request = selectSyncRequest(state);

    state = reduceSyncRecovery(state, { type: 'pong', seq: 7, epoch: 'epoch-1' });
    state = reduceSyncRecovery(state, { type: 'sync_ok', seq: 7, epoch: 'epoch-1', events: [] });

    expect(selectSyncRequest(state)).toBe(request);
    expect(state.nextSyncRequestId).toBe(2);
    expect(state.phase).toBe('syncing');
  });

  it('exposes categorized applied events for queue, runtime, interactions, and session-user adapters', () => {
    const cases: Array<[WsEvent, (state: SyncRecoveryState) => unknown[]]> = [
      [{ type: 'queue_item_updated', item: queueItem('queued') }, selectAppliedQueueEvents],
      [{ type: 'session_status', sessionId: SESSION, status: 'running' }, selectAppliedRuntimeEvents],
      [{ type: 'ask_user', interactionId: 'i-1', questions: [] }, selectAppliedInteractionEvents],
      [{ type: 'user_message', sessionId: SESSION, content: 'hello', timestamp: 1 }, selectAppliedSessionUserEvents],
    ];

    for (const [event, selector] of cases) {
      const state = live(readyAtZero(), 1, event);
      expect(selector(state)).toHaveLength(1);
    }
  });

  it('provides callable reset and full-refresh completion without retaining recovery state', () => {
    let state = createSyncRecoveryState({ lastSeq: 5, serverEpoch: 'epoch-1' });
    state = reduceSyncRecovery(state, { type: 'sync_overflow', seq: 9, epoch: 'epoch-1' });
    state = reduceSyncRecovery(state, { type: 'full_refresh_complete' });
    expect(state).toMatchObject({ lastSeq: 9, phase: 'ready', fullRefresh: null });

    expect(resetSyncRecovery({ serverEpoch: 'epoch-2' })).toMatchObject({
      lastSeq: 0, serverEpoch: 'epoch-2', phase: 'idle', fullRefresh: null,
    });
  });
});
