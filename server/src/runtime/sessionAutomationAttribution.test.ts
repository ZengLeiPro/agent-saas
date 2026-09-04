import { describe, expect, it, vi } from 'vitest';
import { PgSessionAutomationAttributionStore } from './sessionAutomationAttribution.js';

describe('session automation reconciliation receipt lineage', () => {
  it('rejects a duplicate receipt key owned by another session lineage', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 }) // tenant receipt_key conflict
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // no exact full-lineage duplicate
      .mockResolvedValueOnce({}); // ROLLBACK
    const client = { query, release: vi.fn() };
    const store = new PgSessionAutomationAttributionStore({ connect: vi.fn().mockResolvedValue(client) } as never);
    const item = {
      providerAttemptId: 'provider-attempt', preparedDispatchAttemptId: 'prepared-dispatch',
      tenantId: 'tenant', sessionId: 'session-b', automationId: 'automation', incarnationId: 'incarnation',
      generation: 2, executionId: 'execution', runId: 'run', provider: 'provider', operation: 'operation',
      idempotencyKey: 'attempt-key', state: 'reconcile' as const, version: 3, leaseToken: 'lease', requestPayload: {},
    };

    await expect(store.reconcileProviderAttempt(item, {
      receiptKey: 'shared-receipt', observedState: 'completed', receiptPayload: {}, nextState: 'completed',
    })).rejects.toMatchObject({ code: 'stale_claim', message: 'receipt key lineage conflict' });

    expect(query.mock.calls[2]?.[0]).toContain('session_id=$3');
    expect(query.mock.calls[2]?.[0]).toContain('provider_attempt_id=$7');
    expect(query.mock.calls[2]?.[0]).toContain('observed_state=$10');
    expect(query.mock.calls[2]?.[0]).toContain('receipt_payload=$11::jsonb');
    expect(query.mock.calls[2]?.[1]).toEqual([
      'tenant', 'shared-receipt', 'session-b', 'automation', 'incarnation', 2, 'provider-attempt', 'execution', 'run',
      'completed', '{}',
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('rejects inconsistent observed and target states before writing a receipt', async () => {
    const connect = vi.fn();
    const store = new PgSessionAutomationAttributionStore({ connect } as never);
    const item = {
      providerAttemptId: 'provider-attempt', preparedDispatchAttemptId: 'prepared-dispatch',
      tenantId: 'tenant', sessionId: 'session', automationId: 'automation', incarnationId: 'incarnation',
      generation: 2, executionId: 'execution', runId: 'run', provider: 'provider', operation: 'operation',
      idempotencyKey: 'attempt-key', state: 'reconcile' as const, version: 3, leaseToken: 'lease', requestPayload: {},
    };

    await expect(store.reconcileProviderAttempt(item, {
      receiptKey: 'receipt', observedState: 'ambiguous', receiptPayload: {}, nextState: 'completed',
    })).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(connect).not.toHaveBeenCalled();
  });

});
