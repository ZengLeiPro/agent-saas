import { describe, expect, it } from 'vitest';
import { UserEventLog } from '../channels/web/userEventLog.js';
import { buildChatQueueSnapshot } from '../channels/web/chatQueueSnapshot.js';
import { buildSyncOverflowFrame } from '../channels/web/syncProtocol.js';
import type { RunRecord } from '../runtime/runStoreTypes.js';

function run(input: Partial<RunRecord> & Pick<RunRecord, 'runId' | 'sessionId' | 'status'>): RunRecord {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    model: 'model-1',
    channel: 'web',
    requestedAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:01.000Z',
    attempt: 0,
    metadata: {},
    ...input,
  } as RunRecord;
}

describe('M20-03 server authoritative sync protocol', () => {
  it('keeps one epoch stable for the process and changes it on restart', () => {
    const firstProcess = new UserEventLog('boot-a');
    expect(firstProcess.getEpoch('user-a')).toBe('boot-a');
    expect(firstProcess.getEpoch('user-b')).toBe('boot-a');
    firstProcess.push('user-a', { type: 'session_updated' });
    firstProcess.stop();
    expect(firstProcess.getEpoch('user-a')).toBe('boot-a');

    const restartedProcess = new UserEventLog('boot-b');
    expect(restartedProcess.getEpoch('user-a')).toBe('boot-b');
    expect(restartedProcess.getEpoch('user-a')).not.toBe(firstProcess.getEpoch('user-a'));
  });

  it('returns only a continuous gap replay ending at the authoritative current seq', () => {
    const log = new UserEventLog('boot-a');
    log.push('user-a', { type: 'session_updated', sessionId: 's1' });
    log.push('user-a', { type: 'session_status', sessionId: 's1', status: 'running' });
    log.push('user-a', { type: 'interaction_resolved', sessionId: 's1', interactionId: 'i1' });

    const replay = log.getEventsAfter('user-a', 1);
    expect(replay.gapDetected).toBe(false);
    expect(replay.events.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(replay.events.map((entry) => (entry.event as { type: string }).type)).toEqual([
      'session_status',
      'interaction_resolved',
    ]);
  });

  it('reports overflow without returning a misleading retained suffix', () => {
    const log = new UserEventLog('boot-a');
    for (let index = 0; index < 205; index += 1) {
      log.push('user-a', { type: 'session_updated', index });
    }
    expect(log.getCurrentSeq('user-a')).toBe(205);
    expect(log.getEventsAfter('user-a', 0)).toEqual({ events: [], gapDetected: true });
    expect(log.getEventsAfter('user-a', 1)).toEqual({ events: [], gapDetected: true });
  });

  it('answers duplicate sync cursors idempotently without advancing seq or creating a loop', () => {
    const log = new UserEventLog('boot-a');
    log.push('user-a', { type: 'session_deleted', sessionId: 's1' });
    expect(log.getEventsAfter('user-a', 1)).toEqual({ events: [], gapDetected: false });
    expect(log.getEventsAfter('user-a', 1)).toEqual({ events: [], gapDetected: false });
    expect(log.getCurrentSeq('user-a')).toBe(1);
  });

  it('carries reducer-compatible queue/runtime/interaction/session recovery data on overflow', () => {
    const queueSnapshot = buildChatQueueSnapshot('s1', [
      run({ runId: 'queued-run', sessionId: 's1', status: 'pending', idempotencyKey: 'msg-queued' }),
      run({ runId: 'done-run', sessionId: 's1', status: 'completed', idempotencyKey: 'msg-done' }),
    ]);
    const frame = buildSyncOverflowFrame(205, 'boot-a', {
      sessionId: 's1',
      queueSnapshot,
      runtime: { active: true, runId: 'queued-run', status: 'waiting_user' },
      pendingInteractions: [{ interactionId: 'i-pending', type: 'ask_user', runId: 'queued-run' }],
    });

    expect(frame).toMatchObject({
      type: 'sync_overflow',
      seq: 205,
      epoch: 'boot-a',
      recovery: {
        version: 1,
        authoritative: true,
        refresh: {
          sessions: { method: 'GET', path: '/api/sessions' },
          sessionDetail: { pathTemplate: '/api/sessions/{sessionId}' },
          runtime: { pathTemplate: '/api/sessions/{sessionId}/stream-status' },
          pendingInteractions: { action: 'resume' },
        },
        session: {
          sessionId: 's1',
          runtime: { active: true, runId: 'queued-run', status: 'waiting_user' },
          pendingInteractions: [{ interactionId: 'i-pending', type: 'ask_user' }],
        },
      },
    });
    expect(frame.recovery.session?.queueSnapshot?.items.map((item) => item.status)).toEqual([
      'queued',
      'completed',
    ]);
  });

  it('does not let a stale client epoch become authoritative', () => {
    const log = new UserEventLog('server-boot');
    log.push('user-a', { type: 'session_updated' });
    expect(log.hasEpochMismatch('user-a', 'client-boot', 1)).toBe(true);
    expect(log.hasEpochMismatch('user-a', 'server-boot', 1)).toBe(false);
    expect(log.hasEpochMismatch('user-a', undefined, 0)).toBe(false);
  });
});
