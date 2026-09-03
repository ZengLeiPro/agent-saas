import { describe, expect, it } from 'vitest';
import {
  buildPendingInteractionsFromEvents,
  resolvedInteractionIdsFromEvents,
} from '../runtime/interactionProjection.js';
import type { PlatformEvent } from '../runtime/types.js';

describe('interactionProjection', () => {
  it('durable request 保留 InteractionStore 分配的 canonical revision', () => {
    const events: PlatformEvent[] = [
      {
        id: 'q1',
        timestamp: '2026-09-03T04:00:00.000Z',
        type: 'interaction_requested',
        sessionId: 's',
        interactionId: 'ask',
        interactionType: 'ask_user',
        version: 42,
        order: 41,
        questions: [],
      },
    ];
    expect(buildPendingInteractionsFromEvents(events, 's')).toEqual([
      expect.objectContaining({ interactionId: 'ask', version: 42, order: 41 }),
    ]);
  });

  it('durable terminal IDs 同时覆盖 AskUser 与 approval', () => {
    const events: PlatformEvent[] = [
      {
        id: 'r1',
        timestamp: '2026-09-03T04:00:00.000Z',
        type: 'interaction_resolved',
        sessionId: 's',
        interactionId: 'ask',
        interactionType: 'ask_user',
        response: { answers: {} },
      },
      {
        id: 'r2',
        timestamp: '2026-09-03T04:00:01.000Z',
        type: 'approval_resolved',
        sessionId: 's',
        runId: 'run',
        approvalId: 'approval',
        decision: 'approved',
      },
    ];
    expect(resolvedInteractionIdsFromEvents(events)).toEqual(new Set(['ask', 'approval']));
  });

  it('同一 interaction 的重复 request/resolution 最终不再投影 pending', () => {
    const events: PlatformEvent[] = [
      {
        id: 'q1',
        timestamp: '2026-09-03T04:00:00.000Z',
        type: 'interaction_requested',
        sessionId: 's',
        interactionId: 'ask',
        interactionType: 'ask_user',
        version: 42,
        order: 42,
        questions: [],
      },
      {
        id: 'q2',
        timestamp: '2026-09-03T04:00:00.000Z',
        type: 'interaction_requested',
        sessionId: 's',
        interactionId: 'ask',
        interactionType: 'ask_user',
        version: 42,
        order: 42,
        questions: [],
      },
      {
        id: 'r1',
        timestamp: '2026-09-03T04:01:00.000Z',
        type: 'interaction_resolved',
        sessionId: 's',
        interactionId: 'ask',
        interactionType: 'ask_user',
        response: { answers: {} },
      },
      {
        id: 'r2',
        timestamp: '2026-09-03T04:01:00.000Z',
        type: 'interaction_resolved',
        sessionId: 's',
        interactionId: 'ask',
        interactionType: 'ask_user',
        response: { answers: {} },
      },
    ];
    expect(buildPendingInteractionsFromEvents(events, 's')).toEqual([]);
  });
});
