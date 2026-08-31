import { describe, expect, it, vi } from 'vitest';
import { passesGoalHardGates, SessionAutomationEvaluator } from './sessionAutomationEvaluator.js';
import {
  creditsToMicrocredits,
  extractRunProgressEvidence,
  reduceNoProgress,
  resolveAutomationBudgetReason,
} from './sessionAutomationBudgetProgress.js';
import type { PlatformEvent } from './types.js';

describe('automation evaluator reducers', () => {
  it('requires frozen evidence and every hard gate', () => {
    const evidence = {
      summary: 'done',
      evidenceRefs: ['event:test'],
      hardGates: { runTerminal: true, noPendingInteraction: true, noActiveResources: true, budgetValid: true },
    };
    expect(passesGoalHardGates(evidence)).toBe(true);
    expect(passesGoalHardGates({ ...evidence, evidenceRefs: [] })).toBe(false);
    for (const gate of Object.keys(evidence.hardGates) as Array<keyof typeof evidence.hardGates>) {
      expect(passesGoalHardGates({ ...evidence, hardGates: { ...evidence.hardGates, [gate]: false } })).toBe(false);
    }
  });

  it('compares credits as integer microcredits and fails closed on excess precision', () => {
    expect(creditsToMicrocredits('12.345678')).toBe(12_345_678n);
    expect(creditsToMicrocredits(0.000001)).toBe(1n);
    expect(creditsToMicrocredits('0.0000001')).toBeUndefined();
  });

  it('treats every returned budget reason as a hard-gate failure', async () => {
    const rows = [
      [{ run_count: '1', spec: { budget: { maxCredits: 1 } } }],
      [{ turns: '0', tokens: '0', credits: '1000000' }],
      [{ turns: '0', tokens: '0', credits: '0' }],
      [{ ledger: null, events: null }],
    ];
    const client = { query: async () => ({ rows: rows.shift() ?? [] }) } as never;
    const reason = await resolveAutomationBudgetReason({
      client,
      tables: { automations: 'a', specs: 's', usage: 'u', budgetReservations: 'r' },
      tablePrefix: 'runtime',
      runsTable: 'runs',
      tenantId: 'tenant', sessionId: 'session', automationId: 'automation',
    });
    expect(reason).toBe('max_credits');
    const evidence = {
      summary: 'done', evidenceRefs: ['event:1'],
      hardGates: { runTerminal: true, noPendingInteraction: true, noActiveResources: true, budgetValid: reason === undefined },
    };
    expect(passesGoalHardGates(evidence)).toBe(false);
  });

  it('derives progress from frozen event contents without hashing run ids', () => {
    const events = (runId: string, content: string): PlatformEvent[] => [{
      id: `event-${runId}`,
      timestamp: '2026-08-30T00:00:00.000Z',
      type: 'assistant_message',
      runId,
      sessionId: 'session',
      content,
    }];
    const first = extractRunProgressEvidence(events('run-1', 'completed artifact A'), 'completed');
    const replay = extractRunProgressEvidence(events('run-2', 'completed artifact A'), 'completed');
    const progress = extractRunProgressEvidence(events('run-3', 'completed artifact B'), 'completed');
    expect(first.fingerprint).toBe(replay.fingerprint);
    expect(progress.fingerprint).not.toBe(first.fingerprint);
    expect(first.evidenceRefs).toEqual(['event:event-run-1']);
  });

  it('fails closed when a success has no auditable progress content', () => {
    const first = extractRunProgressEvidence([], 'completed');
    const second = extractRunProgressEvidence([], 'completed');
    expect(first).toEqual({ summary: '', evidenceRefs: [], fingerprint: second.fingerprint });
  });

  it('pauses only at no-progress threshold and resets on progress', () => {
    expect(reduceNoProgress('x', 'x', 1, 3)).toEqual({ count: 2, pause: false });
    expect(reduceNoProgress('x', 'x', 2, 3)).toEqual({ count: 3, pause: true });
    expect(reduceNoProgress('x', 'y', 8, 3)).toEqual({ count: 0, pause: false });
  });
});


describe('SessionAutomationEvaluator execution gating', () => {
  it('does not claim work or invoke the model while execution is disabled', async () => {
    const store = {
      tablePrefix: 'runtime',
      tx: vi.fn(),
      pool: { query: vi.fn() },
      tables: {},
      runsTable: 'runs',
    };
    const model = { evaluate: vi.fn() };
    const evaluator = new SessionAutomationEvaluator(store as never, model as never, () => false);
    vi.spyOn(evaluator, 'reconcileUnknown').mockResolvedValue(0);
    vi.spyOn(evaluator as any, 'checkInBlocked').mockResolvedValue(0);

    await expect(evaluator.evaluatePending()).resolves.toBe(0);
    expect(store.tx).not.toHaveBeenCalled();
    expect(model.evaluate).not.toHaveBeenCalled();
  });
});
