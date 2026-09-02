import { describe, expect, it } from 'vitest';
import type { WsEvent } from '../types/ws';
import { chatQueueReducerEventsFromWsEvent } from './chatQueueWs';

describe('M20-02 WS compatibility projector', () => {
  it('preserves queuePosition=0 on legacy message_queued', () => {
    const [event] = chatQueueReducerEventsFromWsEvent({
      type: 'message_queued',
      sessionId: 'session-1',
      runId: 'run-1',
      clientMsgId: 'client-1',
      deliveryMode: 'queue',
      content: 'hello',
      timestamp: 1,
      queuePosition: 0,
    });
    expect(event).toMatchObject({
      type: 'server_upsert',
      item: { queuePosition: 0 },
    });
  });

  it('expresses a runId-only session status update for alias lookup', () => {
    const [event] = chatQueueReducerEventsFromWsEvent({
      type: 'session_status',
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'running',
    });
    expect(event).toEqual({
      type: 'server_upsert',
      item: {
        sessionId: 'session-1',
        runId: 'run-1',
        sourceRunId: 'run-1',
        status: 'running',
      },
    });
  });

  it('prefers structured cancel item and snapshot over N-1 inference', () => {
    const item = {
      sessionId: 'session-1', clientMsgId: 'client-1', runId: 'run-1', sourceRunId: 'run-1',
      deliveryMode: 'queue' as const, status: 'cancelled' as const,
    };
    const event: WsEvent = { type: 'cancel_queued_result', ok: true, sourceRunId: 'run-1', item };
    expect(chatQueueReducerEventsFromWsEvent(event)).toEqual([{ type: 'server_upsert', item }]);
  });
});
