import { describe, expect, it, vi } from 'vitest';

import { DerivedContextStore } from './store.js';

const ref = {
  sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a', recordRevision: 3, evidenceId: 'evidence-a',
};

function rejectInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a', actorId: 'actor-a', entityId: 'entity-a', expectedRevision: 1,
    scope: { type: 'person' as const, personId: 'actor-a' }, action: 'reject' as const,
    targetItemId: 'item-a', rejectFingerprint: 'a'.repeat(64), evidence: [ref], authorize: async () => true, ...overrides,
  };
}

function rejectHarness(evidenceExists = true) {
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT en.generation')) return { rows: [{ generation: 9 }] };
    if (sql.includes('AS revision')) return { rows: [{ revision: 1 }] };
    if (sql.includes('SELECT i.item_id,i.generation')) return { rows: [{
      item_id: 'item-a', generation: 7, item_type: 'Status', semantic_key: 'status',
      value_fingerprint: 'a'.repeat(64), owner_principal: null,
    }] };
    if (sql.includes('SELECT source_id,collection_id,record_id,record_revision,evidence_id,revoked')) {
      return { rows: evidenceExists ? [{ source_id: ref.sourceId, collection_id: ref.collectionId,
        record_id: ref.recordId, record_revision: ref.recordRevision, evidence_id: ref.evidenceId, revoked: false }] : [] };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  const store = new DerivedContextStore({
    pool: { query: vi.fn(), connect: vi.fn(async () => client) } as never,
    tablePrefix: 'test', roleGate: { mayCorrectOrganization: vi.fn(async () => true) },
    now: () => new Date('2026-08-23T12:00:00.000Z'),
  });
  return { store, query };
}

function itemRow(itemId: string) {
  return {
    generation: 7, item_id: itemId, subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status',
    value_json: { value: itemId, valueFingerprint: 'a'.repeat(64), scope: { type: 'org' }, observedAt: '2026-08-23T10:00:00Z' },
    derivation: 'source', review_status: 'confirmed', authority: 'informational', valid_from: '2026-08-23T10:00:00Z',
    valid_to: null, lifecycle: 'active', owner_principal: null, evidence_json: [ref],
  };
}

describe('DerivedContextStore review target hardening', () => {
  it('binds reject lookup, fingerprint, evidence and audit comment to the exact target item', async () => {
    const { store, query } = rejectHarness();
    await expect(store.appendReview(rejectInput())).resolves.toMatchObject({ action: 'reject', rejectFingerprint: 'a'.repeat(64) });

    const target = query.mock.calls.find(call => String(call[0]).includes('SELECT i.item_id,i.generation'))!;
    expect(String(target[0])).toContain('i.item_id=$3');
    expect(String(target[0])).toContain("i.value_json->>'valueFingerprint'=$6");
    expect(String(target[0])).toContain('newer.generation>i.generation');
    expect(String(target[0])).toContain('i.owner_principal IS NULL OR i.owner_principal=$5');
    expect(target[1]).toEqual(['tenant-a', 'entity-a', 'item-a', 'person', 'actor-a', 'a'.repeat(64)]);

    const evidence = query.mock.calls.find(call => String(call[0]).includes('SELECT source_id,collection_id,record_id'))!;
    expect(evidence[1]).toEqual(['tenant-a', '7', 'item-a']);
    expect(String(evidence[0])).toContain('FOR UPDATE');
    const audit = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO test_context_derived_item_reviews'))!;
    expect(JSON.parse(String(audit[1]![6]))).toMatchObject({ action: 'reject', targetItemId: 'item-a' });
  });

  it('rejects evidence not attached to the exact target before writing a review', async () => {
    const { store, query } = rejectHarness(false);
    await expect(store.appendReview(rejectInput())).rejects.toMatchObject({ code: 'DERIVED_EVIDENCE_INVALID' });
    expect(query.mock.calls.some(call => String(call[0]).includes('INSERT INTO test_context_derived_item_reviews'))).toBe(false);
    expect(query.mock.calls.map(call => String(call[0]))).toContain('ROLLBACK');
  });

  it.each([
    ['denial', async (): Promise<boolean> => false],
    ['exception', async (): Promise<boolean> => { throw new Error('acl unavailable'); }],
  ] as const)('fails closed on authorization callback %s before any write', async (_case, authorize) => {
    const { store, query } = rejectHarness();
    await expect(store.appendReview(rejectInput({ authorize }))).rejects.toMatchObject({ code: 'DERIVED_FORBIDDEN' });
    expect(query.mock.calls.some(call => String(call[0]).includes('INSERT INTO test_context_derived_item_reviews'))).toBe(false);
  });

  it('locks the exact snapshot before authorization, freezes it, and performs no write while authorization is pending', async () => {
    const { store, query } = rejectHarness();
    let release!: (allowed: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const authorize = vi.fn(async (snapshot: any) => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.scope)).toBe(true);
      expect(Object.isFrozen(snapshot.evidence)).toBe(true);
      expect(Object.isFrozen(snapshot.evidence[0])).toBe(true);
      expect(snapshot).toMatchObject({
        tenantId: 'tenant-a', entityId: 'entity-a', generation: '7', itemId: 'item-a', itemType: 'Status',
        semanticKey: 'status', valueFingerprint: 'a'.repeat(64), ownerPrincipal: null,
        scope: { type: 'person', personId: 'actor-a' }, evidence: [ref],
      });
      const sql = query.mock.calls.map(call => String(call[0]));
      expect(sql.findIndex(value => value.includes('SELECT en.generation')))
        .toBeLessThan(sql.findIndex(value => value.includes('SELECT i.item_id,i.generation')));
      expect(sql.findIndex(value => value.includes('SELECT i.item_id,i.generation')))
        .toBeLessThan(sql.findIndex(value => value.includes('SELECT source_id,collection_id,record_id')));
      return gate;
    });
    const pending = store.appendReview(rejectInput({ authorize }));
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    expect(query.mock.calls.some(call => String(call[0]).includes('INSERT INTO test_context_derived_item_reviews'))).toBe(false);
    release(true);
    await expect(pending).resolves.toMatchObject({ action: 'reject' });
  });

  it('suppresses only the exact reviewed generation/item and ignores review_decision rows', async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes('SELECT i.*')) return { rows: [itemRow('item-a'), itemRow('item-b')] };
      if (sql.includes('SELECT r.generation')) return { rows: [{
        generation: 7, item_id: 'item-a', comment: { action: 'reject', scope: { type: 'org' } },
      }] };
      return { rows: [] };
    });
    const store = new DerivedContextStore({
      pool: { query } as never, tablePrefix: 'test',
      roleGate: { mayCorrectOrganization: vi.fn(async () => true) },
    });
    await expect(store.listActiveItems({ tenantId: 'tenant-a', entityId: 'entity-a' }))
      .resolves.toEqual([expect.objectContaining({ itemId: 'item-b' })]);
    const reviews = query.mock.calls.find(call => String(call[0]).includes('SELECT r.generation'))!;
    expect(String(reviews[0])).toContain("r.comment::jsonb->>'action'='reject'");
  });
});
