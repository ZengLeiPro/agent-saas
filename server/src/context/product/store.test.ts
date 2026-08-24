import { describe, expect, it, vi } from 'vitest';

import { PgContextProductStore } from './store.js';

function timelineRow() {
  return {
    source_id: 'source-a', collection_id: 'collection-a', record_id: 'record-a', current_revision: '3',
    record_revision: '3', record_kind: 'snapshot', metadata_json: { taskId: 'task-a' }, owner_principal: null,
    acl_principals: ['actor-a'], source_event_id: null, deleted: false, revoked: false,
    updated_at: '2026-08-23T10:00:00.000Z', content_json: { title: 'Source change', summary: 'native event' },
    entity_type: 'task', occurred_at: '2026-08-23T09:00:00.000Z', source_kind: 'taskboard',
    entity_id: 'entity-a', display_name: 'Task A', refused: false,
    evidence_json: [{ sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a',
      recordRevision: 3, evidenceId: 'evidence-a' }],
  };
}

function reviewRow(itemId: string, reviewStatus: string, conflictStatus: string) {
  return {
    generation: 7, item_id: itemId, subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status',
    value_json: { value: itemId, valueFingerprint: itemId }, authority: 'informational', review_status: reviewStatus,
    conflict_status: conflictStatus, revision: 1, valid_from: '2026-08-23T09:00:00.000Z',
    updated_at: '2026-08-23T10:00:00.000Z', evidence_json: [], display_name: 'Entity A',
  };
}

function relationRow(id = 'edge-a') {
  return {
    link_id: id, link_type: 'task_of', relation_class: 'explicit', authority: 'informational',
    review_status: 'confirmed', lifecycle: 'active', valid_from: '2026-08-23T09:00:00Z', valid_to: null,
    from_entity_id: 'entity-a', to_entity_id: `entity-${id}`,
    from_source_id: 'source-a', from_collection_id: 'collection-a', from_record_id: 'record-a', from_revision: 3,
    to_source_id: 'source-a', to_collection_id: 'collection-a', to_record_id: `record-${id}`, to_revision: 2,
    evidence_source_id: 'source-a', evidence_collection_id: 'collection-a', evidence_record_id: `edge-record-${id}`,
    evidence_revision: 4, evidence_id: `edge-evidence-${id}`,
  };
}

describe('PgContextProductStore hardened candidates', () => {
  it('reads current source-record timeline candidates with source filters, DWS exclusion and revision evidence', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [timelineRow()] }));
    const store = new PgContextProductStore({ query } as never, 'test');
    const result = await store.listTimeline({ tenantId: 'tenant-a', collectionIds: ['collection-a'], limit: 25,
      type: 'task', filter: 'native', entityId: 'entity-a', from: '2026-08-22T00:00:00Z', through: '2026-08-24T00:00:00Z' });

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('v.revision=r.current_revision');
    expect(sql).toContain("LOWER(s.kind)<>'dws'");
    expect(sql).toContain('r.collection_id=ANY($2::text[])');
    expect(sql).toContain('en.entity_id=$5');
    expect(sql).toContain('JOIN test_context_evidence ev');
    expect(result).toEqual([expect.objectContaining({ timelineId: 'source-a:collection-a:record-a:3',
      type: 'Task', label: 'Source change', summary: 'native event', entityId: 'entity-a',
      locator: expect.objectContaining({ recordId: 'record-a', recordRevision: 3, currentRevision: 3 }),
      evidence: [expect.objectContaining({ evidenceId: 'evidence-a', recordRevision: 3 })],
    })]);
  });

  it('searches entity display name and safe payload text while preserving DB type casing', async () => {
    const row = { ...timelineRow(), entity_type: 'Project', payload_json: { summary: 'Safe payload' }, generation: 4 };
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [row] }));
    const store = new PgContextProductStore({ query } as never, 'test');
    const result = await store.listEntities({ tenantId: 'tenant-a', collectionIds: ['collection-a'], limit: 25,
      type: 'Project', filter: 'payload' });

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("en.display_name ILIKE '%'||$4||'%'");
    expect(sql).toContain("en.payload_json::text ILIKE '%'||$4||'%'");
    expect(query.mock.calls[0]![1]![2]).toBe('Project');
    expect(result[0]).toMatchObject({ entityType: 'Project', summary: 'Safe payload' });
  });

  it('reads actor-personal and organization correction revisions independently of entity generation', async () => {
    const row = { ...timelineRow(), payload_json: {}, generation: 99,
      personal_correction_revision: 3, organization_correction_revision: 2 };
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [row] }));
    const store = new PgContextProductStore({ query } as never, 'test');

    const result = await store.getEntity('tenant-a', 'entity-a', ['collection-a'], 'actor-a');

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("rv.comment::jsonb->'scope'->>'personId'=$4");
    expect(sql).toContain("rv.comment::jsonb->'scope'->>'type'='org'");
    expect(query.mock.calls[0]![1]).toEqual(['tenant-a', 'entity-a', ['collection-a'], 'actor-a']);
    expect(result).toMatchObject({ revision: 99, correctionRevisions: { personal: 3, organization: 2 } });
  });

  it.each(['proposed', 'conflicted'] as const)('treats review filter %s as state, never search text', async state => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [reviewRow('proposed-item', 'proposed', 'none'), reviewRow('conflicted-item', 'confirmed', 'open')],
    }));
    const store = new PgContextProductStore({ query } as never, 'test');
    const result = await store.listReviews({ tenantId: 'tenant-a', collectionIds: ['collection-a'], limit: 25, filter: state });
    expect(query.mock.calls[0]![1]![3]).toBeNull();
    expect(query.mock.calls[0]![1]![9]).toBe(state);
    expect(String(query.mock.calls[0]![0])).toContain("$10='proposed' AND i.review_status='proposed'");
    expect(String(query.mock.calls[0]![0])).toContain("$10='conflicted' AND i.conflict_status='open'");
    expect(String(query.mock.calls[0]![0])).toContain('$11::boolean=FALSE OR i.owner_principal IS NULL');
    expect(query.mock.calls[0]![1]![10]).toBe(true);
    expect(result.map(item => item.state)).toEqual([state]);
    expect(result.map(item => item.itemId)).toEqual([`${state}-item`]);
  });

  it('keeps review_decision audit rows out of correction SQL', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const store = new PgContextProductStore({ query } as never, 'test');
    await store.listCorrections('tenant-a', 'entity-a', 'actor-a');
    expect(String(query.mock.calls[0]![0])).toContain("r.comment::jsonb->>'action' IN ('assert','reject')");
  });

  it('loads the exact review sibling group with real entity label and confirmed original summary', async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('SELECT subject_entity_id,item_type,semantic_key')
      ? { rows: [{ subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status' }] }
      : { rows: [
          { ...reviewRow('item-a', 'proposed', 'none'), display_name: 'Apollo Project',
            original_value_json: { value: { summary: 'Original status' } } },
          { ...reviewRow('confirmed-sibling', 'confirmed', 'none'), display_name: 'Apollo Project',
            original_value_json: null },
        ] });
    const store = new PgContextProductStore({ query } as never, 'test');
    await expect(store.getReviewGroup('tenant-a', 'item-a', 201)).resolves.toEqual([
      expect.objectContaining({ itemId: 'item-a', entityLabel: 'Apollo Project', originalSummary: 'Original status' }),
      expect.objectContaining({ itemId: 'confirmed-sibling', state: 'confirmed', entityLabel: 'Apollo Project' }),
    ]);
    const group = query.mock.calls[1]!;
    expect(String(group[0])).toContain('sibling.review_status=\'confirmed\'');
    expect(String(group[0])).toContain('i.semantic_key=$12');
    expect(group[1]![11]).toBe('status');
    expect(group[1]![8]).toBe(201);
  });

  it('returns source, author, excerpt, url and occurredAt from evidence data_json', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...timelineRow(), kind: 'quote', created_at: '2026-08-23T09:01:00Z',
      data_json: { source: 'DingTalk', author: 'Alice', excerpt: 'Exact quote', url: 'https://example.test/1',
        occurredAt: '2026-08-23T09:00:00Z' } }] }));
    const store = new PgContextProductStore({ query } as never, 'test');
    await expect(store.getEvidence('tenant-a', {
      sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a', recordRevision: 3, evidenceId: 'evidence-a',
    })).resolves.toMatchObject({ source: 'DingTalk', author: 'Alice', excerpt: 'Exact quote',
      url: 'https://example.test/1', occurredAt: '2026-08-23T09:00:00.000Z', createdAt: '2026-08-23T09:01:00.000Z' });
  });

  it.each(['confirmed', 'rejected'] as const)('CAS-updates proposed review to %s and appends its audit row', async decision => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes('SELECT i.generation,i.subject_entity_id')) return { rows: [{ generation: 7,
        subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status' }], rowCount: 1 };
      if (sql.includes('value_fingerprint') && sql.includes('FOR UPDATE')) return { rows: [reviewRow('item-a', 'proposed', 'none')], rowCount: 1 };
      if (sql.includes('UPDATE test_context_derived_items')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgContextProductStore({ query: vi.fn(), connect: vi.fn(async () => client) } as never, 'test');
    await expect(store.decideReview({ tenantId: 'tenant-a', actorId: 'actor-a', itemId: 'item-a',
      expectedRevision: 1, decision, authorize: async () => true })).resolves.toEqual({ status: decision });
    const lock = query.mock.calls.find(call => String(call[0]).includes('FOR UPDATE OF i'))!;
    expect(String(lock[0])).toContain('i.subject_entity_id=$2 AND i.item_type=$3 AND i.semantic_key=$4');
    const update = query.mock.calls.find(call => String(call[0]).includes("review_status='proposed'"))!;
    expect(update[1]).toEqual(['tenant-a', 7, 'item-a', 2, decision, 1]);
    expect(String(update[0])).toContain("conflict_status<>'open'");
    expect(query.mock.calls.filter(call => String(call[0]).includes('INSERT INTO test_context_derived_item_reviews'))).toHaveLength(1);
    expect(query.mock.calls.map(call => String(call[0]))).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    const identity = query.mock.calls.find(call => String(call[0]).includes('SELECT i.generation,i.subject_entity_id'))!;
    expect(String(identity[0])).toContain('owner_principal IS NULL');
    expect(String(lock[0])).toContain('owner_principal IS NULL');
    expect(String(update[0])).toContain('owner_principal IS NULL');
  });

  it.each([
    ['denial', async (): Promise<boolean> => false],
    ['exception', async (): Promise<boolean> => { throw new Error('acl unavailable'); }],
  ] as const)('locks entity, full group and evidence then fails closed on callback %s', async (_case, authorize) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT i.generation,i.subject_entity_id')) return { rows: [{ generation: 7,
        subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status' }] };
      if (sql.includes('value_fingerprint') && sql.includes('FOR UPDATE OF i')) {
        return { rows: [reviewRow('item-a', 'proposed', 'none')] };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgContextProductStore({ query: vi.fn(), connect: vi.fn(async () => client) } as never, 'test');
    await expect(store.decideReview({ tenantId: 'tenant-a', actorId: 'actor-a', itemId: 'item-a',
      expectedRevision: 1, decision: 'confirmed', authorize })).rejects.toThrowError('CONTEXT_PRODUCT_FORBIDDEN');
    const sql = query.mock.calls.map(call => String(call[0]));
    expect(sql.findIndex(value => value.includes('FOR UPDATE OF current_entity')))
      .toBeLessThan(sql.findIndex(value => value.includes('FOR UPDATE OF i')));
    expect(sql.findIndex(value => value.includes('FOR UPDATE OF i')))
      .toBeLessThan(sql.findIndex(value => value.includes('FOR UPDATE OF ie')));
    expect(sql.some(value => value.includes('UPDATE test_context_derived_items'))).toBe(false);
    expect(sql.some(value => value.includes('INSERT INTO test_context_derived_item_reviews'))).toBe(false);
  });

  it('keeps the authorization callback out of the decision idempotency hash', async () => {
    const run = async (authorize: () => Promise<boolean>) => {
      const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
        if (sql.includes('SELECT i.generation,i.subject_entity_id')) return { rows: [{ generation: 7,
          subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status' }] };
        if (sql.includes('value_fingerprint') && sql.includes('FOR UPDATE OF i')) {
          return { rows: [reviewRow('item-a', 'proposed', 'none')] };
        }
        if (sql.includes('UPDATE test_context_derived_items')) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      });
      const client = { query, release: vi.fn() };
      const store = new PgContextProductStore({ query: vi.fn(), connect: vi.fn(async () => client) } as never, 'test');
      await store.decideReview({ tenantId: 'tenant-a', actorId: 'actor-a', itemId: 'item-a', expectedRevision: 1,
        decision: 'confirmed', authorize });
      return query.mock.calls.find(call => String(call[0]).includes('INSERT INTO test_context_derived_item_reviews'))![1]![3];
    };
    expect(await run(async () => true)).toBe(await run(async () => true));
  });

  it('never selects a personal item for organization review decisions', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT i.generation,i.subject_entity_id')) return { rows: [] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PgContextProductStore({ query: vi.fn(), connect: vi.fn(async () => client) } as never, 'test');
    await expect(store.decideReview({ tenantId: 'tenant-a', actorId: 'actor-a', itemId: 'personal-item',
      expectedRevision: 1, decision: 'confirmed', authorize: async () => true })).rejects.toThrowError('CONTEXT_PRODUCT_NOT_FOUND');
    const identity = query.mock.calls.find(call => String(call[0]).includes('SELECT i.generation,i.subject_entity_id'))!;
    expect(String(identity[0])).toContain('owner_principal IS NULL');
    expect(query.mock.calls.some(call => String(call[0]).includes('FOR UPDATE OF i'))).toBe(false);
  });

  it('conflict confirm resolves target and supersedes every other active open organization item', async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes('SELECT i.generation,i.subject_entity_id')) return { rows: [{ generation: 7,
        subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status' }] };
      if (sql.includes('value_fingerprint') && sql.includes('FOR UPDATE')) return { rows: [
        reviewRow('item-a', 'confirmed', 'open'), reviewRow('item-b', 'confirmed', 'open'),
      ] };
      if (sql.includes('UPDATE test_context_derived_items')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgContextProductStore({ query: vi.fn(), connect: vi.fn(async () => client) } as never, 'test');
    await expect(store.decideReview({ tenantId: 'tenant-a', actorId: 'actor-a', itemId: 'item-a',
      expectedRevision: 1, decision: 'confirmed', authorize: async () => true })).resolves.toEqual({ status: 'confirmed' });

    const target = query.mock.calls.find(call => String(call[0]).includes("SET review_status=$5,conflict_status='resolved'"))!;
    expect(target[1]).toEqual(['tenant-a', 7, 'item-a', 2, 'confirmed', 1]);
    const supersede = query.mock.calls.find(call => String(call[0]).includes("lifecycle='superseded'"))!;
    expect(String(supersede[0])).toContain("lifecycle='active' AND conflict_status='open' AND owner_principal IS NULL");
    expect(String(supersede[0])).toContain('NOT (generation=$5 AND item_id=$6)');
    expect(supersede[1]).toEqual(['tenant-a', 'entity-a', 'Status', 'status', 7, 'item-a']);
  });

  it.each([[2, 'open'], [1, 'resolved']] as const)(
    'conflict reject uses remaining fingerprint count %s to leave group %s', async (count, conflictStatus) => {
      const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
        if (sql.includes('SELECT i.generation,i.subject_entity_id')) return { rows: [{ generation: 7,
          subject_entity_id: 'entity-a', item_type: 'Status', semantic_key: 'status' }] };
        if (sql.includes('value_fingerprint') && sql.includes('FOR UPDATE')) return { rows: [reviewRow('item-a', 'confirmed', 'open')] };
        if (sql.includes('COUNT(DISTINCT')) return { rows: [{ count }] };
        if (sql.includes('UPDATE test_context_derived_items')) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      });
      const client = { query, release: vi.fn() };
      const store = new PgContextProductStore({ query: vi.fn(), connect: vi.fn(async () => client) } as never, 'test');
      await store.decideReview({ tenantId: 'tenant-a', actorId: 'actor-a', itemId: 'item-a',
        expectedRevision: 1, decision: 'rejected', authorize: async () => true });

      const countQuery = query.mock.calls.find(call => String(call[0]).includes('COUNT(DISTINCT'))!;
      expect(String(countQuery[0])).toContain("lifecycle='active' AND review_status<>'rejected' AND owner_principal IS NULL");
      const remaining = query.mock.calls.find(call => String(call[0]).includes('SET conflict_status=$5'))!;
      expect(String(remaining[0])).toContain('owner_principal IS NULL');
      expect(remaining[1]).toEqual(['tenant-a', 'entity-a', 'Status', 'status', conflictStatus]);
      const audit = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO test_context_derived_item_reviews'))!;
      expect(JSON.parse(String(audit[1]![6]))).toMatchObject({ conflict: true, remainingValueFingerprints: count });
    });

  it('loads the exact endpoint revision with its actual current record locator', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ ...timelineRow(), source_kind: 'taskboard' }],
    }));
    const store = new PgContextProductStore({ query } as never, 'test');
    const result = await store.getCurrentRecordLocator('tenant-a', {
      sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a', recordRevision: 2,
    });

    expect(String(query.mock.calls[0]![0])).toContain('v.revision=$5');
    expect(query.mock.calls[0]![1]).toEqual(['tenant-a', 'source-a', 'collection-a', 'record-a', 2]);
    expect(result).toMatchObject({ recordId: 'record-a', recordRevision: 2, currentRevision: 3 });
  });

  it('builds truthful Evidence detail from revision content when locator data has no excerpt', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [{
      kind: 'source_locator', data_json: { source: 'azeroth', nativeId: 'customer-a' },
      created_at: '2026-08-23T10:00:00Z', source_kind: 'azeroth', source_display_name: 'Azeroth',
      content_json: { name: '客户甲' }, source_updated_at: '2026-08-23T09:30:00Z',
      observed_at: '2026-08-23T09:45:00Z', current_revision: 2, record_kind: 'snapshot',
      metadata_json: {}, owner_principal: null, acl_principals: [], source_event_id: null,
      deleted: false, revoked: false, refused: false,
    }] }));
    const store = new PgContextProductStore({ query } as never, 'test');
    const result = await store.getEvidence('tenant-a', {
      sourceId: 'source-a', collectionId: 'collection-a', recordId: 'record-a',
      recordRevision: 2, evidenceId: 'evidence-a',
    });

    expect(String(query.mock.calls[0]![0])).toContain('JOIN test_context_record_revisions v');
    expect(result).toMatchObject({ source: 'azeroth', excerpt: '客户甲',
      occurredAt: '2026-08-23T09:30:00.000Z', createdAt: '2026-08-23T10:00:00.000Z' });
  });

  it('marks adjacency degraded when the raw edge cap is reached', async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('SELECT link_id')
      ? { rows: [relationRow('one'), relationRow('two')] }
      : { rows: [{ kind: 'quote', data_json: {}, created_at: '2026-08-23T09:00:00Z', source_kind: 'taskboard',
          current_revision: 4, record_kind: 'snapshot', metadata_json: {}, deleted: false, revoked: false, refused: false }] });
    const store = new PgContextProductStore({ query } as never, 'test');

    const result = await store.listAdjacent('tenant-a', ['entity-a'], 1);

    expect(result.items).toHaveLength(1);
    expect(result.degraded).toBe(true);
    expect(query.mock.calls[0]![1]).toEqual(['tenant-a', ['entity-a'], 2]);
  });

  it('marks adjacency degraded when an edge loses its evidence candidate', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT link_id')
      ? { rows: [relationRow()] } : { rows: [] });
    const store = new PgContextProductStore({ query } as never, 'test');

    await expect(store.listAdjacent('tenant-a', ['entity-a'], 10))
      .resolves.toEqual({ items: [], degraded: true });
  });

  it('uses edge evidence current locator and never queries nonexistent link source columns', async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes('SELECT link_id')) return { rows: [{
        link_id: 'edge-a', link_type: 'task_of', relation_class: 'explicit', authority: 'informational',
        review_status: 'confirmed', lifecycle: 'active', valid_from: '2026-08-23T09:00:00Z', valid_to: null,
        from_entity_id: 'entity-a', to_entity_id: 'entity-b',
        from_source_id: 'source-a', from_collection_id: 'collection-a', from_record_id: 'record-a', from_revision: 3,
        to_source_id: 'source-a', to_collection_id: 'collection-a', to_record_id: 'record-b', to_revision: 2,
        evidence_source_id: 'source-a', evidence_collection_id: 'collection-a', evidence_record_id: 'edge-record',
        evidence_revision: 4, evidence_id: 'edge-evidence',
      }] };
      return { rows: [{ kind: 'quote', data_json: { excerpt: 'edge proof' }, created_at: '2026-08-23T09:00:00Z',
        source_kind: 'taskboard', current_revision: 5, record_kind: 'snapshot', metadata_json: {},
        owner_principal: null, acl_principals: [], source_event_id: null, deleted: false, revoked: false, refused: false }] };
    });
    const store = new PgContextProductStore({ query } as never, 'test');
    const result = await store.listAdjacent('tenant-a', ['entity-a'], 10);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('l.source_id');
    expect(result).toEqual({
      items: [expect.objectContaining({
        edge: expect.objectContaining({ relationId: 'edge-a', evidence: expect.objectContaining({ evidenceId: 'edge-evidence' }) }),
        locator: expect.objectContaining({ recordId: 'edge-record', recordRevision: 4, currentRevision: 5 }),
      })],
      degraded: false,
    });
  });
});
