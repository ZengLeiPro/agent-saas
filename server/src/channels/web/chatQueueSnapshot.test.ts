import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../runtime/runStoreTypes.js';
import { buildChatQueueSnapshot, projectChatQueueItem } from './chatQueueSnapshot.js';

function run(index: number, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `run-${index}`,
    sessionId: 'session-queue',
    status: 'pending',
    requestedAt: `2026-08-30T00:00:0${index}.000Z`,
    updatedAt: `2026-08-30T00:01:0${index}.000Z`,
    idempotencyKey: `client-${index}`,
    channel: 'web',
    metadata: {
      clientMsgId: `client-${index}`,
      deliveryMode: 'queue',
      acceptedAt: `2026-08-30T00:00:0${index}.000Z`,
      chatSubmission: {
        version: 1,
        text: `message ${index}`,
        clientMsgId: `client-${index}`,
        target: { sessionId: 'session-queue' },
        deliveryMode: 'queue',
        attachments: [],
      },
    },
    ...patch,
  };
}

describe('M20-02 durable chat queue projection with M40-02 server liveness', () => {
  it('projects three submissions in durable order and preserves queuePosition=0', () => {
    const snapshot = buildChatQueueSnapshot('session-queue', [run(1), run(2), run(3)]);
    expect(snapshot.items.map((item) => [item.clientMsgId, item.queuePosition])).toEqual([
      ['client-1', 0], ['client-2', 1], ['client-3', 2],
    ]);
  });

  it('projects running, steered and server terminal outcomes without client guesses', () => {
    const snapshot = buildChatQueueSnapshot('session-queue', [
      run(1, { status: 'running' }),
      run(2, { metadata: { ...run(2).metadata, deliveryMode: 'steer', steeringState: 'applied' } }),
      run(3, { status: 'cancelled', statusReason: 'user_withdrew' }),
      run(4, { status: 'failed', statusReason: 'model_error' }),
    ]);
    expect(snapshot.items.map((item) => item.status)).toEqual([
      'running', 'steered', 'cancelled', 'failed',
    ]);
  });

  it('keeps canonical M20-01 attachmentId and display metadata', () => {
    const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const record = run(1);
    record.metadata.chatSubmission = {
      ...(record.metadata.chatSubmission as object),
      attachments: [{
        attachmentId,
        display: { originalName: 'contract.pdf', mimeType: 'application/pdf', size: 42 },
      }],
    };
    expect(projectChatQueueItem(record)?.attachments).toEqual([{
      attachmentId,
      name: 'contract.pdf',
      mimeType: 'application/pdf',
      size: 42,
    }]);
  });

  it('projects server-only structured liveness while legacy rows remain unknown', () => {
    const legacy = projectChatQueueItem(run(1));
    const live = projectChatQueueItem(run(2, {
      status: 'running',
      workerId: 'worker-2',
      leaseExpiresAt: '2026-08-30T00:02:00.000Z',
      liveness: {
        state: 'busy', ownerId: 'worker-2', lastHeartbeatAt: '2026-08-30T00:01:30.000Z',
        leaseExpiresAt: '2026-08-30T00:02:00.000Z', recoveryActions: ['cancel'],
        detectedAt: '2026-08-30T00:01:00.000Z', version: 2,
      },
    }));
    expect(legacy?.liveness).toEqual({ state: 'unknown', recoveryActions: [], version: 0 });
    expect(live?.liveness).toMatchObject({ state: 'busy', ownerId: 'worker-2', version: 2 });
  });

  it('omits legacy runs with no stable clientMsgId', () => {
    expect(projectChatQueueItem(run(1, { idempotencyKey: undefined, metadata: {} }))).toBeUndefined();
  });
});
