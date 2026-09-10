import { describe, expect, it } from 'vitest';
import { handleOperationDiagnostics } from './operationDiagnostics.js';

function response() {
  const result = { status: 0, value: undefined as unknown };
  return {
    result,
    res: {
      writeHead(status: number) {
        result.status = status;
      },
      end(body: string) {
        result.value = JSON.parse(body);
      },
    },
  };
}

function options(journalAvailable = true) {
  const record = {
    protocolVersion: 1,
    operationId: 'operation-one',
    attemptId: 'attempt-one',
    invocationId: 'agent-dws-events-account-one',
    ownerId: 'owner-one',
    revision: 2,
    kind: 'invoke',
    scope: { sandboxScopeId: 'scope-one', writableMounts: ['tenant/a'] },
    resource: 'stopped',
    outcome: 'succeeded',
    phase: 'stopped',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1).toISOString(),
  };
  return {
    authorize: () => true,
    operations: {
      snapshot: () => [{ ...record, resource: 'unknown' }],
      drainBlockers: () => [],
      get: () => undefined,
    },
    journal: { snapshot: () => ({ available: journalAvailable, records: [record] }) },
    counts: () => ({ requests: 0, recovery: 0, draining: false }),
  } as never;
}

describe('operation diagnostics exact invocation lookup', () => {
  it('returns the durable exact record rather than a conflicting local snapshot', () => {
    const { res, result } = response();
    expect(
      handleOperationDiagnostics(
        { method: 'GET', url: '/operations?invocationId=agent-dws-events-account-one' } as never,
        res as never,
        options(),
      ),
    ).toBe(true);
    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({
      provenance: 'journal',
      operations: [{ resource: 'stopped' }],
    });
  });

  it('fails closed when the journal is unavailable', () => {
    const { res, result } = response();
    handleOperationDiagnostics(
      { method: 'GET', url: '/operations?invocationId=agent-dws-events-account-one' } as never,
      res as never,
      options(false),
    );
    expect(result.status).toBe(503);
    expect(result.value).toEqual({ error: 'ownership_journal_unavailable' });
  });
});
