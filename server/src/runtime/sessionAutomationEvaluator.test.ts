import { describe, expect, it, vi } from 'vitest';
import { goalEvidenceManifestHash, ModelGoalEvaluator, passesGoalHardGates, SessionAutomationEvaluator } from './sessionAutomationEvaluator.js';
import {
  creditsToMicrocredits,
  extractRunProgressEvidence,
  reduceNoProgress,
  resolveAutomationBudgetReason,
} from './sessionAutomationBudgetProgress.js';
import type { PlatformEvent } from './types.js';

describe('automation evaluator reducers, hashes, and evidence gates', () => {
  it('requires frozen evidence and every hard gate', () => {
    const body = { version: 1 as const, fence: {
      tenantId: 'tenant', sessionId: 'session', rootAutomationId: 'automation', executionId: 'execution',
      incarnationId: 'incarnation', generation: 1, specVersion: 1, runId: 'run',
    }, entries: [{
      ref: 'event:test', kind: 'event' as const, tenantId: 'tenant', sessionId: 'session', rootAutomationId: 'automation',
      source: { eventId: 'test', runId: 'run' }, version: { globalSequence: 1, sha256: 'a'.repeat(64) },
      freshness: { capturedAt: '2026-08-31T00:00:00.000Z', freshThroughGlobalSequence: 1 },
    }] };
    const evidence = {
      summary: 'done', evidenceManifest: { ...body, canonicalHash: goalEvidenceManifestHash(body) },
      hardGates: { runTerminal: true, noPendingInteraction: true, noActiveResources: true, budgetValid: true },
    };
    expect(passesGoalHardGates(evidence)).toBe(true);
    expect(passesGoalHardGates({ ...evidence, evidenceManifest: { ...evidence.evidenceManifest, canonicalHash: 'tampered' } })).toBe(false);
    expect(goalEvidenceManifestHash(body)).toBe(goalEvidenceManifestHash({ entries: body.entries, fence: {
      runId: 'run', specVersion: 1, generation: 1, incarnationId: 'incarnation', executionId: 'execution',
      rootAutomationId: 'automation', sessionId: 'session', tenantId: 'tenant',
    }, version: 1 }));
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
      summary: 'done', evidenceManifest: undefined as never,
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


describe('SessionAutomationEvaluator execution and evidence gating', () => {
  it('does not promote model-authored shell substrings or compound commands to test attestations', () => {
    const evaluator = new SessionAutomationEvaluator({ tablePrefix: 'runtime' } as never, { evaluate: vi.fn() } as never);
    const classify = (command: string) => (evaluator as any).classifyEvidenceEvent(
      { type: 'tool_result', toolCallId: 'call', toolName: 'Shell', metadata: { exitCode: 0 } },
      new Map([['call', { name: 'Shell', command }]]),
    );
    expect(classify('echo test')).toBe('tool_result');
    expect(classify('pnpm test && sed -i s/a/b/ file')).toBe('tool_result');
    expect(classify('pnpm -F server exec vitest run src/example.test.ts')).toBe('test');
    expect((evaluator as any).classifyEvidenceEvent(
      { type: 'assistant_message', content: 'tests pass; task complete' }, new Map(),
    )).toBeUndefined();
  });

  it('releases a prepared model attempt when the switch flips before transport', async () => {
    const stream = vi.fn();
    const runtimeGuard = {
      beforeModel: vi.fn().mockResolvedValue({
        providerAttemptId: 'attempt', reservationIds: ['reservation'], sourceKey: 'source',
        model: 'model', purpose: 'goal_evaluation',
      }),
      beforeModelTransport: vi.fn().mockResolvedValue(undefined),
      releaseModel: vi.fn().mockResolvedValue(undefined),
      finishModel: vi.fn(),
    };
    const executionEnabled = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const evaluator = new ModelGoalEvaluator({
      resolveModel: () => ({ model: 'model' }),
      createAdapter: () => ({ stream } as never),
      billing: () => undefined,
      resolveIdentity: () => ({ username: 'owner' }),
      runtimeGuard: runtimeGuard as never,
      executionEnabled,
    });
    const body = { version: 1 as const, fence: {
      tenantId: 'tenant', sessionId: 'session', rootAutomationId: 'automation', executionId: 'execution',
      incarnationId: 'incarnation', generation: 1, specVersion: 1, runId: 'run',
    }, entries: [{
      ref: 'event:test', kind: 'test' as const, tenantId: 'tenant', sessionId: 'session', rootAutomationId: 'automation',
      source: { eventId: 'test', runId: 'run' }, version: { globalSequence: 1, sha256: 'a'.repeat(64) },
      freshness: { capturedAt: '2026-08-31T00:00:00.000Z', freshThroughGlobalSequence: 1 },
    }] };
    await expect(evaluator.evaluate({
      tenantId: 'tenant', sessionId: 'session', ownerUserId: 'owner', automationId: 'automation',
      executionId: 'execution', incarnationId: 'incarnation', generation: 1, specVersion: 1,
      condition: 'done', evidence: {
        summary: 'done', evidenceManifest: { ...body, canonicalHash: goalEvidenceManifestHash(body) },
        hardGates: { runTerminal: true, noPendingInteraction: true, noActiveResources: true, budgetValid: true },
      },
    })).rejects.toThrow('execution_disabled');
    expect(runtimeGuard.releaseModel).toHaveBeenCalledTimes(1);
    expect(runtimeGuard.beforeModelTransport).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('releases a claimed evaluation when execution is disabled before provider work', async () => {
    const claimed = {
      evaluation_id: 'evaluation', tenant_id: 'tenant', session_id: 'session',
      automation_id: 'automation', execution_id: 'execution', incarnation_id: 'incarnation',
      generation: 1, spec_version: 1, owner_user_id: 'owner', run_id: 'run', evidence: {},
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [claimed] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const store = {
      tablePrefix: 'runtime', runsTable: 'runs', pool,
      tables: { evaluations: 'evaluations', automations: 'automations', executions: 'executions' },
      tx: vi.fn(async (callback: (input: typeof client) => Promise<unknown>) => callback(client)),
    };
    const model = { evaluate: vi.fn() };
    const executionEnabled = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const evaluator = new SessionAutomationEvaluator(store as never, model as never, executionEnabled);
    vi.spyOn(evaluator, 'reconcileUnknown').mockResolvedValue(0);
    vi.spyOn(evaluator as any, 'checkInBlocked').mockResolvedValue(0);

    await expect(evaluator.evaluatePending()).resolves.toBe(1);
    expect(model.evaluate).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET state='pending'"), ['evaluation', expect.any(String)],
    );
  });

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
