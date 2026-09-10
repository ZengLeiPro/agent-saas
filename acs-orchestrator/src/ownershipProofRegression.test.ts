import { describe, expect, it, vi } from 'vitest';
import { OwnedOperations } from './ownedOperations.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import type { OwnershipRecord } from './ownershipState.js';

const scope = {
  storageId: 'fixture-storage', mountSubPath: 'workspaces/fixture', sandboxName: 'fixture-sandbox',
  workspaceId: 'fixture-workspace', sessionId: 'fixture-session', sandboxScopeId: 'fixture-scope',
};

function journalFixture() {
  const records = new Map<string, OwnershipRecord>();
  const journal = {
    reserve: vi.fn(async (record: OwnershipRecord) => { records.set(record.operationId, structuredClone(record)); return record; }),
    update: vi.fn(async (record: OwnershipRecord) => { records.set(record.operationId, structuredClone(record)); return record; }),
    snapshot: () => ({ available: true, records: [...records.values()] }),
  } as unknown as OwnershipJournal;
  return journal;
}

describe('actual ownership proof boundary', () => {
  it('R10 R26 rejects an unsigned terminal assertion after a remote dispatch', async () => {
    const operations = new OwnedOperations(journalFixture());
    const operation = await operations.begin({ kind: 'invocation', invocationId: 'logical-one', attemptId: 'attempt-one', scope });
    await operation.dispatch('sandbox-uid-one');
    await expect(operation.complete('success', {
      kind: 'remote_receipt', attemptId: 'attempt-one', sandboxUid: 'sandbox-uid-one',
    }, 'stopped')).rejects.toMatchObject({ code: 'ownership_unresolved' });
    expect(operation.record.resource).not.toBe('stopped');
    expect(operations.drainBlockers()).toBeGreaterThan(0);
  });

  it('R10 R26 does not accept a background timestamp as proof of a durable handoff', async () => {
    const operations = new OwnedOperations(journalFixture());
    const operation = await operations.begin({ kind: 'invocation', invocationId: 'logical-two', attemptId: 'attempt-two', scope });
    await operation.dispatch('sandbox-uid-two');
    await expect(operation.complete('success', {
      kind: 'background_inventory', attemptId: 'attempt-two', sandboxUid: 'sandbox-uid-two',
    }, 'background_owned')).rejects.toMatchObject({ code: 'ownership_unresolved' });
    expect(operation.record.resource).not.toBe('background_owned');
    expect(operations.drainBlockers()).toBeGreaterThan(0);
  });

  it('R06 preserves a proved never-dispatched terminal when a later diagnostic becomes unavailable', async () => {
    const operations = new OwnedOperations(journalFixture());
    const operation = await operations.begin({ kind: 'invocation', invocationId: 'logical-three', attemptId: 'attempt-three', scope });
    await operation.complete('cancelled', { kind: 'never_dispatched', attemptId: 'attempt-three' }, 'not_started');
    operation.markUncertain('late_transport_error');
    expect(operation.record.resource).toBe('not_started');
    expect(operation.record.outcome).toBe('cancelled');
    expect(operations.drainBlockers()).toBe(0);
  });
});
