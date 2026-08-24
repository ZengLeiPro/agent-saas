import { describe, expect, it, vi } from 'vitest';

import { PgRelationReadStore } from './pgReadStore.js';

describe('PgRelationReadStore', () => {
  it('reads active evidence-bound candidates without making an authorization claim', async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [{
      link_id: 'relation-1', link_type: 'task_of', relation_class: 'explicit', authority: 'informational',
      review_status: 'confirmed', lifecycle: 'active', valid_from: '2026-08-23T00:00:00Z', valid_to: null,
      from_entity_id: 'task-1', to_entity_id: 'project-1',
      from_source_id: 'source', from_collection_id: 'collection', from_record_id: 'task-record', from_revision: '2',
      to_source_id: 'source', to_collection_id: 'collection', to_record_id: 'project-record', to_revision: '4',
      evidence_source_id: 'source', evidence_collection_id: 'collection', evidence_record_id: 'task-record',
      evidence_revision: '2', evidence_id: 'evidence-2',
    }] }));
    const store = new PgRelationReadStore({ query } as never, 'test');

    const result = await store.listAdjacent({ tenantId: 'tenant', entityIds: ['task-1', 'task-1'], limit: 10 });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("lifecycle='active' AND revoked=FALSE"), ['tenant', ['task-1'], 10]);
    expect(String(query.mock.calls[0]![0])).toContain('evidence_id IS NOT NULL');
    expect(result).toEqual([expect.objectContaining({
      relationId: 'relation-1', relationType: 'task_of', relationClass: 'explicit', authorization: 'unchecked',
      from: expect.objectContaining({ entityId: 'task-1', recordRevision: 2 }),
      to: expect.objectContaining({ entityId: 'project-1', recordRevision: 4 }),
      evidence: expect.objectContaining({ evidenceId: 'evidence-2', recordRevision: 2 }),
    })]);
  });

  it('bounds identifiers, fanout and candidate reads', async () => {
    const store = new PgRelationReadStore({ query: vi.fn() } as never, 'test');
    await expect(store.listAdjacent({ tenantId: 'tenant', entityIds: ['entity'], limit: 501 }))
      .rejects.toThrow('RELATION_READ_INVALID');
    await expect(store.listAdjacent({ tenantId: 'tenant', entityIds: Array.from({ length: 201 }, (_, i) => `e${i}`), limit: 1 }))
      .rejects.toThrow('RELATION_READ_INVALID');
  });
});
