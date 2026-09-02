import { describe, expect, it } from 'vitest';
import { createInteractionReducerState, reduceInteraction } from './interactionProtocol';
import {
  isCanonicalPendingInteractionTimelineItem,
  selectCanonicalInteractionFinalStatus,
  selectCanonicalInteractionZone,
  redactInteractionCredentials,
  validateAskUserAnswers,
  type ActiveInteractionSummary,
} from './activeInteraction';

const interactions: ActiveInteractionSummary[] = [
  { sessionId: 's1', interactionId: 'later', kind: 'permission', version: 3, order: 30 },
  { sessionId: 's1', interactionId: 'first', kind: 'ask_user', version: 2, order: 10 },
  { sessionId: 's1', interactionId: 'approval', kind: 'approval', version: 4, order: 20, risk: { level: 'high', summary: 'external write' } },
  { sessionId: 's2', interactionId: 'other-session', kind: 'permission', version: 1, order: 1 },
];

describe('M40-03 canonical fixed interaction zone', () => {
  it('selects exactly one current card and queues the rest in server order per session', () => {
    const s1 = selectCanonicalInteractionZone({ selectedSessionId: 's1', interactions });
    expect(s1.current?.interactionId).toBe('first');
    expect(s1.queue.map((item) => item.interactionId)).toEqual(['approval', 'later']);
    expect(s1.queue.every((item) => !item.current)).toBe(true);
    const s2 = selectCanonicalInteractionZone({ selectedSessionId: 's2', interactions });
    expect(s2.current?.interactionId).toBe('other-session');
    expect(s2.queue).toEqual([]);
  });

  it.each([
    [{ revoked: true }, 'revoked'],
    [{ readOnly: true }, 'read_only'],
    [{ terminalSession: true }, 'terminal_session'],
  ] as const)('keeps the card readable but disables actions for %s', (boundary, reason) => {
    const zone = selectCanonicalInteractionZone({ selectedSessionId: 's1', interactions, ...boundary });
    expect(zone.current).toMatchObject({ interactionId: 'first', disabled: true, disabledReason: reason });
  });

  it('keeps timeout/offline locally recoverable and accepts only canonical terminal outcomes', () => {
    const identity = { sessionId: 's1', interactionId: 'first', generation: 1, authEpoch: 2, version: 2 };
    let lifecycle = reduceInteraction(createInteractionReducerState(1), { type: 'server_pending', ...identity });
    lifecycle = reduceInteraction(lifecycle, { type: 'submit', ...identity, requestId: 'r', response: { answers: { q: 'a' } } });
    lifecycle = reduceInteraction(lifecycle, { type: 'transport_failed', ...identity, requestId: 'r', reason: 'timeout' });
    let zone = selectCanonicalInteractionZone({ selectedSessionId: 's1', interactions, lifecycle });
    expect(zone.current?.state).toMatchObject({ phase: 'pending', serverAuthoritative: false, retryable: true });
    expect(selectCanonicalInteractionFinalStatus(zone.current!, zone.current?.state)).toBeNull();
    lifecycle = reduceInteraction(lifecycle, { type: 'outcome', ...identity, status: 'resolved', response: { answers: { q: 'a' } } });
    zone = selectCanonicalInteractionZone({ selectedSessionId: 's1', interactions, lifecycle });
    expect(selectCanonicalInteractionFinalStatus(zone.current!, zone.current?.state)).toBe('answered');
  });

  it('validates single/multi/text AskUser shapes and redacts approval credentials', () => {
    const questions = [
      { id: 'single', question: 'single', header: 'Single', options: [{ label: 'A' }], multiSelect: false, required: true },
      { id: 'multi', question: 'multi', header: 'Multi', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true, minSelections: 2, maxSelections: 2 },
      { id: 'text', question: 'text', header: 'Text', options: [], multiSelect: false, allowText: true, minLength: 3, maxLength: 5 },
    ];
    expect(validateAskUserAnswers(questions, { single: 'A', multi: ['A', 'B'], text: 'abcd' }).valid).toBe(true);
    expect(validateAskUserAnswers(questions, { single: ['A', 'B'], multi: ['A'], text: 'x' }).errors).toEqual({
      single: '只能选择一个答案', multi: '至少选择 2 项', text: '回答至少 3 个字符',
    });
    expect(redactInteractionCredentials({ command: 'deploy', token: 'secret', nested: { password: 'pw', safe: 'ok' } })).toEqual({
      command: 'deploy', token: '[REDACTED]', nested: { password: '[REDACTED]', safe: 'ok' },
    });
  });

  it('excludes pending interaction cards from history while allowing terminal receipts', () => {
    expect(isCanonicalPendingInteractionTimelineItem({ type: 'ask_user', status: 'pending' })).toBe(true);
    expect(isCanonicalPendingInteractionTimelineItem({ type: 'permission_request', status: 'allowed' })).toBe(false);
    expect(isCanonicalPendingInteractionTimelineItem({ type: 'text', status: 'pending' })).toBe(false);
  });
});
