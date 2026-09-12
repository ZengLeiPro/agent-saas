import { describe, expect, it } from 'vitest';
import { handleOperationDiagnostics, type DiagnosticsOptions } from './operationDiagnostics.js';

function response() {
  const result: { status: number; value: Record<string, unknown> | undefined } = { status: 0, value: undefined };
  return {
    result,
    res: {
      writeHead(status: number) {
        result.status = status;
      },
      end(body: string) {
        result.value = JSON.parse(body) as Record<string, unknown>;
      },
    },
  };
}

function options(
  journalAvailable = true,
  extra?: {
    counts?: DiagnosticsOptions['counts'];
    drainBlockers?: number;
  },
): DiagnosticsOptions {
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
      drainBlockers: () => extra?.drainBlockers ?? 0,
      get: () => undefined,
    },
    journal: { snapshot: () => ({ available: journalAvailable, records: [record] }) },
    counts: extra?.counts ?? (() => ({ requests: 0, recovery: 0, unresolvedInvocations: 0, draining: false })),
  } as unknown as DiagnosticsOptions;
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

describe('operation diagnostics drain classification', () => {
  it('distinguishes request, recovery, unresolved, owned work and journal unavailability', () => {
    const cases = [
      { requests: 1, recovery: 0, unresolvedInvocations: 0, ownedWork: 0 },
      { requests: 0, recovery: 1, unresolvedInvocations: 0, ownedWork: 0 },
      { requests: 0, recovery: 0, unresolvedInvocations: 1, ownedWork: 0 },
      { requests: 0, recovery: 0, unresolvedInvocations: 0, ownedWork: 1 },
    ];
    for (const counts of cases) {
      const { res, result } = response();
      handleOperationDiagnostics(
        { method: 'GET', url: '/diagnostics/drain' } as never,
        res as never,
        options(true, {
          counts: () => ({ ...counts, draining: true }),
          drainBlockers: counts.ownedWork,
        }),
      );
      expect(result.status).toBe(200);
      expect(result.value).toMatchObject({
        protocolVersion: 1,
        ...counts,
        draining: true,
        journalAvailable: true,
        blockers: [expect.objectContaining({
          operationId: 'operation-one',
          invocationId: 'agent-dws-events-account-one',
        })],
      });
    }
  });

  it('keeps journal unavailability visible without dropping blockers', () => {
    const { res, result } = response();
    handleOperationDiagnostics(
      { method: 'GET', url: '/diagnostics/drain' } as never,
      res as never,
      options(false, {
        counts: () => ({ requests: 0, recovery: 0, unresolvedInvocations: 0, draining: true }),
        drainBlockers: 1,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({
      ownedWork: 1,
      journalAvailable: false,
      persistedUnresolved: 0,
    });
    expect(result.value).not.toHaveProperty('secret');
  });
});
