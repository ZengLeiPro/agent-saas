import { describe, expect, it } from 'vitest';
import {
  normalizeRunLiveness,
  type ApiSessionDetail,
  type ChatQueueSnapshot,
  type RunLiveness,
  type WsEvent,
} from '@agent/shared';
import { buildChatQueueSnapshot } from '../channels/web/chatQueueSnapshot.js';
import type { SyncRuntimeSnapshot } from '../channels/web/syncProtocol.js';
import type { WsDownstreamEvent } from '../channels/web/wsTypes.js';
import { projectRunLiveness } from '../runtime/runLiveness.js';
import type { RunRecord } from '../runtime/runStoreTypes.js';

const persisted: RunRecord = {
  runId: 'run-boundary', sessionId: 'session-boundary', status: 'running',
  requestedAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:01.000Z',
  idempotencyKey: 'client-boundary',
  metadata: { clientMsgId: 'client-boundary' },
  liveness: {
    state: 'busy', lastHeartbeatAt: '2026-08-30T00:00:01.000Z',
    leaseExpiresAt: '2026-08-30T00:01:01.000Z', ownerId: 'worker-boundary',
    recoveryActions: ['cancel'], detectedAt: '2026-08-30T00:00:00.000Z', version: 1,
  },
};

describe('M40-02 server/shared schema boundary', () => {
  it('serializes the exact shared DTO keys and values', () => {
    const projected = projectRunLiveness(persisted) satisfies RunLiveness;
    expect(normalizeRunLiveness(projected)).toEqual(projected);
    expect(Object.keys(projected).sort()).toEqual([
      'detectedAt', 'lastHeartbeatAt', 'leaseExpiresAt', 'ownerId',
      'recoveryActions', 'state', 'version',
    ]);
  });

  it('aligns queue, WS runtime/status and session-detail fields with shared contracts', () => {
    const queueSnapshot = buildChatQueueSnapshot('session-boundary', [persisted]) satisfies ChatQueueSnapshot;
    const liveness = queueSnapshot.items[0].liveness!;
    const runtime = { active: true, runId: persisted.runId, status: persisted.status, liveness } satisfies SyncRuntimeSnapshot;
    const activeFrame = { type: 'active_stream', sessionId: persisted.sessionId, active: true, runId: persisted.runId, status: persisted.status, liveness } satisfies WsDownstreamEvent;
    const sharedFrame: WsEvent = activeFrame;
    const statusFrame = { type: 'session_status', sessionId: persisted.sessionId, status: 'running', runId: persisted.runId, liveness } satisfies WsDownstreamEvent;
    const detail = {
      sessionId: persisted.sessionId,
      stats: { lines: 0, parsedLines: 0, parseErrors: 0 }, blocks: [],
      queueSnapshot,
      lastRunState: { runId: persisted.runId, status: persisted.status, liveness },
    } satisfies ApiSessionDetail;
    expect(runtime.liveness).toEqual(liveness);
    expect(sharedFrame.liveness).toEqual(liveness);
    expect(statusFrame.liveness).toEqual(liveness);
    expect(detail.lastRunState.liveness).toEqual(liveness);
  });

  it('keeps N-1 missing fields unknown and uncertain external outcomes cancel-only', () => {
    expect(normalizeRunLiveness(undefined).state).toBe('unknown');
    expect(projectRunLiveness({
      ...persisted,
      status: 'orphaned', statusReason: 'external_tool_outcome_unknown',
      liveness: { ...persisted.liveness!, state: 'orphaned', reasonCode: 'external_tool_outcome_unknown' },
    })).toMatchObject({ state: 'orphaned', recoveryActions: ['cancel'] });
  });
});
