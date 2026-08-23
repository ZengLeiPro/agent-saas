import { describe, expect, it, vi } from 'vitest';

import { ContextSourceAuthorizationRegistry } from '../retrieval/sourceAuthorization.js';
import { ContextTimelineService } from './service.js';

const subject = { tenantId: 'tenant-a', userId: 'user-a' };
const scope = {
  collections: [{ collectionId: 'collection-a', assignmentVersion: 3 as const }],
  resolvedAt: '2026-08-23T00:00:00.000Z',
};
function row(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a', source_id: 'source-a', collection_id: 'collection-a', record_id: 'record-a',
    current_revision: 1, content_json: { title: 'visible' }, metadata_json: { kind: 'board', boardId: 'board-a' },
    deleted: false, revoked: false, source_kind: 'taskboard', entity_type: 'project', record_kind: 'snapshot',
    native_id: 'board-a', source_event_id: null, occurred_at: '2026-08-23T02:00:00.000Z',
    ...overrides,
  };
}
function registry(check: (recordId: string) => boolean = () => true) {
  return new ContextSourceAuthorizationRegistry({
    taskboard: { authorizeBatch: async (_subject, locators) => locators.map(value => check(value.recordId)) },
  });
}

describe('ContextTimelineService', () => {
  it('applies assignment in SQL before native ACL and hides denied content', async () => {
    const query = vi.fn(async () => ({ rows: [row(), row({ record_id: 'denied', content_json: { secret: true } })] }));
    const service = new ContextTimelineService({
      pool: { query } as never, tablePrefix: 'test', sourceAuthorizationRegistry: registry(id => id !== 'denied'),
      cursorSigningKey: 'test-key',
    });
    const result = await service.list({ subject, scope, limit: 10 });
    const firstCall = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(firstCall[0]).toContain('v.tenant_id=$1 AND v.collection_id=ANY($2::text[])');
    expect(firstCall[0]).toContain('current_record.deleted=FALSE AND current_record.revoked=FALSE');
    expect(firstCall[0]).toContain('current_record.owner_principal,current_record.acl_principals');
    expect(firstCall[0]).toContain("auth_partition.refused=TRUE OR auth_partition.status='refused'");
    expect(firstCall[1].slice(0, 2)).toEqual(['tenant-a', ['collection-a']]);
    expect(result).toMatchObject({ degraded: false, items: [{ recordId: 'record-a', content: { title: 'visible' } }] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does no record/native lookup when assignment denies the collection', async () => {
    const query = vi.fn();
    const authorizeBatch = vi.fn();
    const service = new ContextTimelineService({
      pool: { query } as never,
      sourceAuthorizationRegistry: new ContextSourceAuthorizationRegistry({ taskboard: { authorizeBatch } }),
    });
    await expect(service.list({ subject, scope: { ...scope, collections: [] }, limit: 10 }))
      .resolves.toEqual({ items: [], degraded: false });
    expect(query).not.toHaveBeenCalled();
    expect(authorizeBatch).not.toHaveBeenCalled();
  });

  it('denies deleted snapshots, keeps delete events, and deduplicates snapshot/event by sourceEventId', async () => {
    const query = vi.fn(async () => ({ rows: [
      row({ record_id: 'deleted-snapshot', deleted: true, entity_type: 'task', native_id: 'task-a', metadata_json: { deleted: true } }),
      row({ record_id: 'snapshot', entity_type: 'task', native_id: 'task-a', source_event_id: 'event-1', metadata_json: {} }),
      row({ record_id: 'event', deleted: true, entity_type: 'task', record_kind: 'event', native_id: 'task-a', source_event_id: 'event-1', metadata_json: {
        kind: 'event', recordType: 'event', taskId: 'task-a', sourceEventId: 'event-1', eventType: 'task.deleted',
      } }),
    ] }));
    const service = new ContextTimelineService({
      pool: { query } as never, sourceAuthorizationRegistry: registry(), cursorSigningKey: 'test-key',
    });
    const result = await service.list({ subject, scope, limit: 10 });
    expect(result.items).toEqual([expect.objectContaining({ recordId: 'event', recordType: 'event', eventType: 'task.deleted' })]);
    const sql = (query.mock.calls[0] as unknown as [string])[0];
    expect(sql).toContain("WHERE deleted=FALSE OR record_kind='event'");
    expect(sql).toContain('PARTITION BY COALESCE(source_event_id');
  });

  it('uses the full occurred/source/collection/record/revision tuple as a stable signed cursor', async () => {
    const pages = [
      { rows: [row({ record_id: 'a', current_revision: 2 }), row({ record_id: 'b', occurred_at: '2026-08-23T01:00:00.000Z' })] },
      { rows: [row({ record_id: 'c', occurred_at: '2026-08-23T00:00:00.000Z' })] },
    ];
    const query = vi.fn(async () => pages.shift()!);
    const service = new ContextTimelineService({
      pool: { query } as never, sourceAuthorizationRegistry: registry(), cursorSigningKey: 'test-key',
    });
    const first = await service.list({ subject, scope, limit: 2 });
    expect(first.nextCursor).toMatch(/^ct1\./);
    const second = await service.list({ subject, scope, limit: 2, cursor: first.nextCursor });
    expect(second.items[0]).toMatchObject({ recordId: 'c' });
    const secondCall = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(secondCall[1].slice(2, 7)).toEqual([
      '2026-08-23T01:00:00.000Z', 'source-a', 'collection-a', 'b', 1,
    ]);
    expect((query.mock.calls[0] as unknown as [string])[0])
      .toContain('ORDER BY occurred_at DESC,source_id DESC,collection_id DESC,record_id DESC,current_revision DESC');
  });

  it('fails unknown/error authorization closed with only a degraded reason', async () => {
    const query = vi.fn(async () => ({ rows: [row()] }));
    const missing = new ContextTimelineService({ pool: { query } as never });
    await expect(missing.list({ subject, scope, limit: 5 })).resolves.toEqual({
      items: [], degraded: true, degradationReasons: ['context_source_authorizer_missing'],
    });
    const broken = new ContextTimelineService({
      pool: { query } as never,
      sourceAuthorizationRegistry: new ContextSourceAuthorizationRegistry({
        taskboard: { authorizeBatch: async () => { throw new Error('db down'); } },
      }),
    });
    const result = await broken.list({ subject, scope, limit: 5 });
    expect(result).toEqual({ items: [], degraded: true, degradationReasons: ['context_source_authorization_error'] });
    expect(JSON.stringify(result)).not.toContain('visible');
  });
});
