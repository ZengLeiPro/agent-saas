import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceMigrationRunner } from '../../data/governance-schema/index.js';
import { ContextSourceAuthorizationRegistry, PgContextRecallService } from '../retrieval/index.js';
import { ContextStore } from '../store/index.js';
import { DerivedContextStore } from './store.js';
import { ProposedDistillValidator } from './proposedDistillValidator.js';
import { entityId } from './projector.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('DerivedContextStore PostgreSQL integration', () => {
  const prefix = `drv${randomBytes(4).toString('hex')}`;
  let pool: Pool;
  let source: ContextStore;
  let derived: DerivedContextStore;
  let fence = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 4 });
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    source = new ContextStore({ pool, tablePrefix: prefix });
    derived = new DerivedContextStore({
      pool, tablePrefix: prefix,
      roleGate: { mayCorrectOrganization: async ({ actorId }) => actorId === 'steward-a' },
    });
    await source.createSource({ tenantId: 'tenant-a', sourceId: 'source-a', kind: 'test', displayName: 'A' });
    await source.createCollection({ tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-a', externalKey: 'typed', displayName: 'Typed' });
    await source.ensurePartition({ tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-a', partitionKey: 'p' });
    const lease = await source.acquirePartitionLease({
      tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-a', partitionKey: 'p', leaseOwner: 'sync', leaseMs: 600_000,
    });
    fence = lease!.leaseFence;
  });

  afterAll(async () => {
    if (!pool) return;
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`, [`${prefix}_%`],
    );
    for (const { tablename } of tables.rows) await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
    await pool.end();
  });

  async function ingest(records: Parameters<ContextStore['ingestPage']>[0]['records']): Promise<void> {
    await source.ingestPage({
      tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-a', partitionKey: 'p',
      leaseOwner: 'sync', leaseFence: fence, records, checkpoint: { complete: false },
    });
  }

  async function drain(): Promise<void> {
    const lease = await derived.claimContextOutbox({
      tenantId: 'tenant-a', consumerId: 'projector', leaseOwner: 'derived-worker', leaseMs: 60_000,
    });
    expect(lease).not.toBeNull();
    await derived.projectClaimed(lease!);
  }

  it('isolates tenant/cursor, replays idempotently, supersedes same-source revisions and preserves conflicts', async () => {
    await ingest([{
      recordId: 'project-r', externalRecordId: 'project-r', entityType: 'project', recordKind: 'snapshot', nativeId: 'project-1',
      content: { title: 'Apollo' }, observedAt: '2026-08-22T08:00:00Z',
      evidence: [{ evidenceId: 'project-ev', kind: 'quote', data: { quote: 'Apollo' } }],
    }, {
      recordId: 'task-r', externalRecordId: 'task-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-1',
      content: { title: 'Ship', status: { code: 'open' }, projectId: 'project-1' }, occurredAt: '2026-08-22T09:00:00Z',
      observedAt: '2026-08-22T09:01:00Z', evidence: [{ evidenceId: 'task-ev', kind: 'quote', data: { quote: 'Ship open' } }],
    }]);
    await drain();
    const taskId = entityId('tenant-a', 'Task', 'task-1', 'source-a');
    const initialRelation = await pool.query(`SELECT link_id,from_revision,evidence_id,relation_class,lifecycle
      FROM ${derived.tables.entityLinks} WHERE tenant_id='tenant-a' AND from_entity_id=$1`, [taskId]);
    expect(initialRelation.rows).toEqual([expect.objectContaining({
      from_revision: '1', evidence_id: 'task-ev', relation_class: 'explicit', lifecycle: 'active',
    })]);
    expect(await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ itemType: 'Status', value: { code: 'open' } })]));
    expect(await derived.listActiveItems({ tenantId: 'tenant-b', entityId: taskId })).toEqual([]);

    // Empty replay does not duplicate rows or move another tenant's cursor.
    await drain();
    const before = await pool.query(`SELECT COUNT(*)::integer count FROM ${derived.tables.derivedItems} WHERE tenant_id='tenant-a'`);
    await drain();
    const after = await pool.query(`SELECT COUNT(*)::integer count FROM ${derived.tables.derivedItems} WHERE tenant_id='tenant-a'`);
    expect(after.rows[0].count).toBe(before.rows[0].count);

    await ingest([{
      recordId: 'task-r', externalRecordId: 'task-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-1',
      content: { title: 'Ship', status: { code: 'done' }, projectId: 'project-1' }, observedAt: '2026-08-22T10:00:00Z',
      evidence: [{ evidenceId: 'task-ev-2', kind: 'quote', data: { quote: 'Ship done' } }],
    }]);
    await drain();
    const revisedRelation = await pool.query(`SELECT link_id,from_revision,evidence_revision,evidence_id,lifecycle,revoked
      FROM ${derived.tables.entityLinks} WHERE tenant_id='tenant-a' AND from_entity_id=$1`, [taskId]);
    expect(revisedRelation.rows).toHaveLength(1);
    expect(revisedRelation.rows[0]).toMatchObject({
      link_id: initialRelation.rows[0].link_id, from_revision: '2', evidence_revision: '2',
      evidence_id: 'task-ev-2', lifecycle: 'active', revoked: false,
    });
    expect((await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId }))
      .filter(item => item.itemType === 'Status').map(item => item.value)).toEqual([{ code: 'done' }]);

    await ingest([{
      recordId: 'task-r-conflict', externalRecordId: 'task-r-conflict', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-1',
      content: { title: 'Ship', status: { code: 'blocked' }, projectId: 'project-1' }, observedAt: '2026-08-22T10:05:00Z',
      evidence: [{ evidenceId: 'task-conflict-ev', kind: 'quote', data: { quote: 'Ship blocked' } }],
    }]);
    await drain();
    const conflict = await pool.query(`SELECT DISTINCT conflict_status FROM ${derived.tables.derivedItems}
      WHERE tenant_id='tenant-a' AND subject_entity_id=$1 AND item_type='Status' AND lifecycle='active'`, [taskId]);
    expect(conflict.rows).toEqual([{ conflict_status: 'open' }]);

    const recall = new PgContextRecallService({
      pool, tablePrefix: prefix,
      sourceAuthorizationRegistry: new ContextSourceAuthorizationRegistry({
        test: { authorizeBatch: async (_subject, locators) => locators.map(() => true) },
      }),
    });
    const recalled = await recall.search({
      subject: { tenantId: 'tenant-a', userId: 'user-a' },
      scope: { collections: [{ collectionId: 'collection-a', assignmentVersion: 1 }], resolvedAt: '2026-08-22T10:06:00Z' },
      query: 'blocked', limit: 5, filters: {},
    });
    expect(recalled.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ derived: true, content: expect.stringContaining('"code":"blocked"') }),
    ]));
  });

  it('rewinds one idle tenant consumer with cursor CAS while preserving derived rows for idempotent replay', async () => {
    const beforeCursor = await pool.query(`SELECT cursor_seq,lease_fence FROM ${derived.tables.consumers}
      WHERE tenant_id='tenant-a' AND consumer_id='projector'`);
    const cursorSeq = String(beforeCursor.rows[0].cursor_seq);
    const itemCount = await pool.query(`SELECT COUNT(*)::integer count FROM ${derived.tables.derivedItems}
      WHERE tenant_id='tenant-a'`);
    const activeLease = await derived.claimContextOutbox({
      tenantId: 'tenant-a', consumerId: 'projector', leaseOwner: 'replay-race', leaseMs: 60_000,
    });
    expect(activeLease).not.toBeNull();
    await expect(derived.resetConsumerForReplay({
      tenantId: 'tenant-a', consumerId: 'projector', expectedCursorSeq: cursorSeq,
    })).rejects.toMatchObject({ code: 'DERIVED_VERSION_CONFLICT' });
    await expect(derived.failConsumerLease(activeLease!, 'DERIVED_PROJECTION_FAILED')).resolves.toBe(true);
    expect((await pool.query(`SELECT status,last_error_code FROM ${derived.tables.consumers}
      WHERE tenant_id='tenant-a' AND consumer_id='projector'`)).rows[0]).toMatchObject({
      status: 'retry_wait', last_error_code: 'DERIVED_PROJECTION_FAILED',
    });
    await expect(derived.resetConsumerForReplay({
      tenantId: 'tenant-a', consumerId: 'projector', expectedCursorSeq: `${cursorSeq}0`,
    })).rejects.toMatchObject({ code: 'DERIVED_VERSION_CONFLICT' });

    await expect(derived.resetConsumerForReplay({
      tenantId: 'tenant-a', consumerId: 'projector', expectedCursorSeq: cursorSeq,
    })).resolves.toEqual({ previousCursorSeq: cursorSeq });
    const reset = await pool.query(`SELECT cursor_seq,status,lease_owner,lease_fence
      FROM ${derived.tables.consumers} WHERE tenant_id='tenant-a' AND consumer_id='projector'`);
    expect(reset.rows[0]).toMatchObject({ cursor_seq: '0', status: 'idle', lease_owner: null });
    expect(BigInt(reset.rows[0].lease_fence)).toBe(BigInt(beforeCursor.rows[0].lease_fence) + 1n);
    expect((await pool.query(`SELECT COUNT(*)::integer count FROM ${derived.tables.derivedItems}
      WHERE tenant_id='tenant-a'`)).rows[0].count).toBe(itemCount.rows[0].count);
    await drain();
  });

  it('recomputes organization conflicts after convergence, revoke and delete while preserving real multi-value conflicts', async () => {
    const convergeId = entityId('tenant-a', 'Task', 'task-conflict-converge', 'source-a');
    const deleteId = entityId('tenant-a', 'Task', 'task-conflict-delete', 'source-a');
    const record = (recordId: string, nativeId: string, code: string, evidenceId: string,
      state: { revoked?: boolean; deleted?: boolean } = {}) => ({
      recordId, externalRecordId: recordId, entityType: 'task' as const, recordKind: 'snapshot' as const, nativeId,
      content: { title: nativeId, status: { code } }, ...state, observedAt: '2026-08-22T10:10:00Z',
      evidence: [{ evidenceId, kind: 'quote' as const, data: { quote: `${nativeId} ${code}` } }],
    });
    const statuses = async (subjectEntityId: string) => (await pool.query<{ conflict_status: string }>(
      `SELECT conflict_status FROM ${derived.tables.derivedItems}
       WHERE tenant_id='tenant-a' AND subject_entity_id=$1 AND item_type='Status'
         AND lifecycle='active' AND review_status='confirmed' AND owner_principal IS NULL
       ORDER BY item_id`, [subjectEntityId],
    )).rows.map(row => row.conflict_status);

    await ingest([
      record('task-conflict-converge-a', 'task-conflict-converge', 'open', 'task-conflict-converge-a-ev'),
      record('task-conflict-converge-b', 'task-conflict-converge', 'blocked', 'task-conflict-converge-b-ev'),
      record('task-conflict-delete-a', 'task-conflict-delete', 'open', 'task-conflict-delete-a-ev'),
      record('task-conflict-delete-b', 'task-conflict-delete', 'blocked', 'task-conflict-delete-b-ev'),
    ]);
    await drain();
    expect(await statuses(convergeId)).toEqual(['open', 'open']);
    expect(await statuses(deleteId)).toEqual(['open', 'open']);

    await ingest([record(
      'task-conflict-converge-b', 'task-conflict-converge', 'open', 'task-conflict-converge-b-converged-ev',
    )]);
    await drain();
    expect(await statuses(convergeId)).toEqual(['none', 'none']);

    await ingest([record(
      'task-conflict-converge-b', 'task-conflict-converge', 'blocked', 'task-conflict-converge-b-diverged-ev',
    )]);
    await drain();
    expect(await statuses(convergeId)).toEqual(['open', 'open']);

    await ingest([record(
      'task-conflict-converge-b', 'task-conflict-converge', 'blocked', 'task-conflict-converge-b-revoked-ev', { revoked: true },
    )]);
    await drain();
    expect(await statuses(convergeId)).toEqual(['none']);

    await ingest([record(
      'task-conflict-delete-b', 'task-conflict-delete', 'blocked', 'task-conflict-delete-b-deleted-ev', { deleted: true },
    )]);
    await drain();
    expect(await statuses(deleteId)).toEqual(['none']);
  });

  it('scopes personal corrections, gates org corrections, isolates proposed items and revokes reads live', async () => {
    const taskId = entityId('tenant-a', 'Task', 'task-1', 'source-a');
    const evidence = { sourceId: 'source-a', collectionId: 'collection-a', recordId: 'task-r', recordRevision: 2, evidenceId: 'task-ev-2' };
    const targetItemId = (await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId }))
      .find(item => item.itemType === 'Status'
        && item.evidence.some(ref => ref.recordId === evidence.recordId && ref.recordRevision === evidence.recordRevision))!.itemId;
    await expect(derived.appendReview({
      tenantId: 'tenant-a', actorId: 'user-a', entityId: taskId, expectedRevision: 1, scope: { type: 'org' },
      action: 'assert', targetItemId, itemType: 'Status', semanticKey: 'status', value: { code: 'accepted' }, evidence: [evidence],
      authorize: async () => false,
    })).rejects.toMatchObject({ code: 'DERIVED_FORBIDDEN' });
    const correctionInput = {
      tenantId: 'tenant-a', actorId: 'user-a', entityId: taskId, expectedRevision: 1,
      scope: { type: 'person' as const, personId: 'user-a' }, action: 'assert' as const, targetItemId,
      itemType: 'Status' as const, semanticKey: 'status', value: { code: 'accepted' }, evidence: [evidence],
      authorize: async () => true,
    };
    const correction = await derived.appendReview(correctionInput);
    expect((await derived.appendReview(correctionInput)).reviewId).toBe(correction.reviewId);
    expect((await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId, viewerId: 'user-a' }))
      .some(item => item.authority === 'user')).toBe(true);
    expect((await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId, viewerId: 'user-b' }))
      .some(item => item.authority === 'user')).toBe(false);

    await ingest([{
      recordId: 'task-r', externalRecordId: 'task-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-1',
      content: { title: 'Ship', status: { code: 'reopened' } }, observedAt: '2026-08-22T10:30:00Z',
      evidence: [{ evidenceId: 'task-ev-3', kind: 'quote', data: { quote: 'Ship reopened' } }],
    }]);
    await drain();
    expect((await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId, viewerId: 'user-a' }))
      .some(item => item.authority === 'user' && (item.value as { code?: string }).code === 'accepted')).toBe(true);

    const reopenedEvidence = { sourceId: 'source-a', collectionId: 'collection-a', recordId: 'task-r',
      recordRevision: 3, evidenceId: 'task-ev-3' };
    const reopenedTargetItemId = (await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId }))
      .find(item => item.itemType === 'Status' && item.evidence.some(ref => ref.recordId === reopenedEvidence.recordId
        && ref.recordRevision === reopenedEvidence.recordRevision))!.itemId;
    await expect(derived.appendReview({
      tenantId: 'tenant-a', actorId: 'user-a', entityId: taskId, expectedRevision: 1,
      scope: { type: 'person', personId: 'user-a' }, action: 'assert', targetItemId: reopenedTargetItemId,
      itemType: 'Status', semanticKey: 'status', value: { code: 'stale-write' }, evidence: [reopenedEvidence],
      authorize: async () => true,
    })).rejects.toMatchObject({ code: 'DERIVED_VERSION_CONFLICT' });

    const proposed = await new ProposedDistillValidator(derived).validate('tenant-a', {
      entityId: taskId, itemType: 'Decision', semanticKey: 'decision:done', value: { accepted: true },
      quote: 'Ship', evidence: [evidence],
    });
    await derived.appendProposed('tenant-a', proposed);
    expect((await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId })).some(item => item.state === 'proposed')).toBe(false);
    expect((await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId, includeProposed: true }))
      .some(item => item.state === 'proposed')).toBe(true);

    await ingest([{
      recordId: 'task-r', externalRecordId: 'task-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-1',
      content: { title: 'Ship', status: { code: 'done' } }, revoked: true, observedAt: '2026-08-22T11:00:00Z',
      evidence: [{ evidenceId: 'task-ev-revoked', kind: 'quote', data: { quote: 'revoked' } }],
    }, {
      recordId: 'task-r-conflict', externalRecordId: 'task-r-conflict', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-1',
      content: { title: 'Ship', status: { code: 'blocked' } }, revoked: true, observedAt: '2026-08-22T11:00:00Z',
      evidence: [{ evidenceId: 'task-conflict-revoked', kind: 'quote', data: { quote: 'revoked' } }],
    }]);
    // Queries join source records, so visibility disappears before the projector catches up.
    expect(await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId, viewerId: 'user-a' })).toEqual([]);
    expect((await derived.getProfile('tenant-a', taskId, 'user-a')).status).toBe('revoked');
    await drain();
    const revokedLinks = await pool.query(`SELECT lifecycle,revoked FROM ${derived.tables.entityLinks}
      WHERE tenant_id='tenant-a' AND (from_record_id IN ('task-r','task-r-conflict')
        OR evidence_record_id IN ('task-r','task-r-conflict'))`);
    expect(revokedLinks.rows.length).toBeGreaterThan(0);
    expect(revokedLinks.rows.every(row => row.lifecycle === 'revoked' && row.revoked === true)).toBe(true);
  });

  it('durably resolves Task before Project, refreshes incoming target revisions, revokes and replays idempotently', async () => {
    const taskId = entityId('tenant-a', 'Task', 'task-late', 'source-a');
    const projectId = entityId('tenant-a', 'Project', 'project-late', 'source-a');
    await ingest([{
      recordId: 'task-late-r', externalRecordId: 'task-late-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-late',
      content: { title: 'Late task', projectId: 'project-late' }, observedAt: '2026-08-23T08:00:00Z',
      evidence: [{ evidenceId: 'task-late-ev-1', kind: 'quote', data: { quote: 'Task before project' } }],
    }]);
    await drain();
    const pending = await pool.query(`SELECT relation_id,resolution_status,lifecycle
      FROM ${derived.tables.relationCandidates}
      WHERE tenant_id='tenant-a' AND from_entity_id=$1 AND to_entity_id=$2`, [taskId, projectId]);
    expect(pending.rows).toEqual([expect.objectContaining({ resolution_status: 'pending', lifecycle: 'active' })]);
    expect((await pool.query(`SELECT 1 FROM ${derived.tables.entityLinks}
      WHERE tenant_id='tenant-a' AND from_entity_id=$1 AND to_entity_id=$2`, [taskId, projectId])).rowCount).toBe(0);
    expect(await derived.resolvePendingRelationCandidates({ tenantId: 'tenant-a' }))
      .toEqual({ materialized: 0, pending: true });

    await ingest([{
      recordId: 'project-late-r', externalRecordId: 'project-late-r', entityType: 'project', recordKind: 'snapshot', nativeId: 'project-late',
      content: { title: 'Late project' }, observedAt: '2026-08-23T08:05:00Z',
      evidence: [{ evidenceId: 'project-late-ev-1', kind: 'quote', data: { quote: 'Project arrived' } }],
    }]);
    await drain();
    const materialized = await pool.query(`SELECT c.relation_id,c.resolution_status,l.to_revision,l.lifecycle,l.revoked
      FROM ${derived.tables.relationCandidates} c JOIN ${derived.tables.entityLinks} l
        ON l.tenant_id=c.tenant_id AND l.link_id=c.relation_id
      WHERE c.tenant_id='tenant-a' AND c.from_entity_id=$1 AND c.to_entity_id=$2`, [taskId, projectId]);
    expect(materialized.rows).toEqual([expect.objectContaining({
      resolution_status: 'materialized', to_revision: '1', lifecycle: 'active', revoked: false,
    })]);

    await ingest([{
      recordId: 'project-late-r', externalRecordId: 'project-late-r', entityType: 'project', recordKind: 'snapshot', nativeId: 'project-late',
      content: { title: 'Late project v2' }, observedAt: '2026-08-23T08:10:00Z',
      evidence: [{ evidenceId: 'project-late-ev-2', kind: 'quote', data: { quote: 'Project updated' } }],
    }]);
    await drain();
    expect((await pool.query(`SELECT to_revision FROM ${derived.tables.entityLinks}
      WHERE tenant_id='tenant-a' AND from_entity_id=$1 AND to_entity_id=$2`, [taskId, projectId])).rows)
      .toEqual([{ to_revision: '2' }]);

    await drain();
    expect((await pool.query(`SELECT COUNT(*)::integer count FROM ${derived.tables.relationCandidates}
      WHERE tenant_id='tenant-a' AND from_entity_id=$1 AND to_entity_id=$2`, [taskId, projectId])).rows[0]?.count).toBe(1);
    expect((await pool.query(`SELECT COUNT(*)::integer count FROM ${derived.tables.entityLinks}
      WHERE tenant_id='tenant-a' AND from_entity_id=$1 AND to_entity_id=$2`, [taskId, projectId])).rows[0]?.count).toBe(1);

    await ingest([{
      recordId: 'task-late-r', externalRecordId: 'task-late-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-late',
      content: { title: 'Late task', projectId: 'project-late' }, deleted: true, observedAt: '2026-08-23T08:15:00Z',
      evidence: [{ evidenceId: 'task-late-ev-del', kind: 'quote', data: { quote: 'Task deleted' } }],
    }]);
    await drain();
    expect((await pool.query(`SELECT lifecycle,resolution_status FROM ${derived.tables.relationCandidates}
      WHERE tenant_id='tenant-a' AND from_entity_id=$1 AND to_entity_id=$2`, [taskId, projectId])).rows)
      .toEqual([{ lifecycle: 'deleted', resolution_status: 'pending' }]);
    expect((await pool.query(`SELECT lifecycle,revoked FROM ${derived.tables.entityLinks}
      WHERE tenant_id='tenant-a' AND from_entity_id=$1 AND to_entity_id=$2`, [taskId, projectId])).rows)
      .toEqual([{ lifecycle: 'deleted', revoked: true }]);
  });

  it('drains more than 100 resolvable candidates across bounded public batches', async () => {
    const records: Array<Parameters<ContextStore['ingestPage']>[0]['records'][number]> = [{
      recordId: 'project-bulk-r', externalRecordId: 'project-bulk-r', entityType: 'project', recordKind: 'snapshot',
      nativeId: 'project-bulk', content: { title: 'Bulk project' }, observedAt: '2026-08-23T08:20:00Z',
      evidence: [{ evidenceId: 'project-bulk-ev', kind: 'quote', data: { quote: 'Bulk project' } }],
    }];
    for (let index = 0; index < 101; index += 1) records.push({
      recordId: `task-bulk-${index}-r`, externalRecordId: `task-bulk-${index}-r`, entityType: 'task', recordKind: 'snapshot',
      nativeId: `task-bulk-${index}`, content: { title: `Bulk task ${index}`, projectId: 'project-bulk' },
      observedAt: '2026-08-23T08:21:00Z',
      evidence: [{ evidenceId: `task-bulk-${index}-ev`, kind: 'quote', data: { quote: `Bulk task ${index}` } }],
    });
    await ingest(records);
    await drain();
    await drain();
    const candidates = await pool.query<{ relation_id: string }>(`SELECT relation_id
      FROM ${derived.tables.relationCandidates}
      WHERE tenant_id='tenant-a' AND record_id LIKE 'task-bulk-%-r'`);
    expect(candidates.rows).toHaveLength(101);
    const relationIds = candidates.rows.map(row => row.relation_id);
    await pool.query(`UPDATE ${derived.tables.relationCandidates}
      SET resolution_status='pending' WHERE tenant_id='tenant-a' AND relation_id=ANY($1::text[])`, [relationIds]);
    await pool.query(`DELETE FROM ${derived.tables.entityLinks}
      WHERE tenant_id='tenant-a' AND link_id=ANY($1::text[])`, [relationIds]);

    expect(await derived.resolvePendingRelationCandidates({ tenantId: 'tenant-a', limit: 100 }))
      .toEqual({ materialized: 100, pending: true });
    expect(await derived.resolvePendingRelationCandidates({ tenantId: 'tenant-a', limit: 100 }))
      .toEqual({ materialized: 1, pending: false });
  });

  it('isolates personal and organization CAS revisions across entity reprojection', async () => {
    const taskId = entityId('tenant-a', 'Task', 'task-scope-cas', 'source-a');
    await ingest([{
      recordId: 'task-scope-cas-r', externalRecordId: 'task-scope-cas-r', entityType: 'task', recordKind: 'snapshot',
      nativeId: 'task-scope-cas', content: { title: 'Scoped CAS', status: { code: 'open' } }, observedAt: '2026-08-23T08:30:00Z',
      evidence: [{ evidenceId: 'task-scope-cas-ev-1', kind: 'quote', data: { quote: 'Scoped CAS v1' } }],
    }]);
    await drain();
    const evidence1 = [{ sourceId: 'source-a', collectionId: 'collection-a', recordId: 'task-scope-cas-r',
      recordRevision: 1, evidenceId: 'task-scope-cas-ev-1' }];
    const targetItemId = (await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId }))
      .find(item => item.itemType === 'Status')!.itemId;
    const append = (actorId: string, expectedRevision: number, scope: { type: 'org' } | { type: 'person'; personId: string },
      value: string, evidence = evidence1, target = targetItemId) => derived.appendReview({
      tenantId: 'tenant-a', actorId, entityId: taskId, expectedRevision, scope, action: 'assert', targetItemId: target,
      itemType: 'Status', semanticKey: 'status', value, evidence, authorize: async () => true,
    });

    await expect(append('user-cas', 1, { type: 'person', personId: 'user-cas' }, 'personal-1'))
      .resolves.toMatchObject({ entityRevision: 2 });
    await expect(append('steward-a', 1, { type: 'org' }, 'organization-1'))
      .resolves.toMatchObject({ entityRevision: 2 });
    await expect(append('user-cas', 1, { type: 'person', personId: 'user-cas' }, 'personal-stale'))
      .rejects.toMatchObject({ code: 'DERIVED_VERSION_CONFLICT' });
    await expect(append('user-cas', 2, { type: 'person', personId: 'user-cas' }, 'personal-2'))
      .resolves.toMatchObject({ entityRevision: 3 });
    await expect(append('steward-a', 2, { type: 'org' }, 'organization-2'))
      .resolves.toMatchObject({ entityRevision: 3 });

    await ingest([{
      recordId: 'task-scope-cas-r', externalRecordId: 'task-scope-cas-r', entityType: 'task', recordKind: 'snapshot',
      nativeId: 'task-scope-cas', content: { title: 'Scoped CAS reprojected', status: { code: 'updated' } }, observedAt: '2026-08-23T08:35:00Z',
      evidence: [{ evidenceId: 'task-scope-cas-ev-2', kind: 'quote', data: { quote: 'Scoped CAS v2' } }],
    }]);
    await drain();
    const evidence2 = [{ sourceId: 'source-a', collectionId: 'collection-a', recordId: 'task-scope-cas-r',
      recordRevision: 2, evidenceId: 'task-scope-cas-ev-2' }];
    const targetItemId2 = (await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId }))
      .find(item => item.itemType === 'Status' && item.evidence.some(ref => ref.recordId === evidence2[0]!.recordId
        && ref.recordRevision === evidence2[0]!.recordRevision))!.itemId;
    await expect(append('user-cas', 3, { type: 'person', personId: 'user-cas' }, 'personal-3', evidence2, targetItemId2))
      .resolves.toMatchObject({ entityRevision: 4 });
    await expect(append('steward-a', 3, { type: 'org' }, 'organization-3', evidence2, targetItemId2))
      .resolves.toMatchObject({ entityRevision: 4 });
  });

  it('keeps personal corrections out of organization conflict statistics and updates', async () => {
    const taskId = entityId('tenant-a', 'Task', 'task-personal-conflict', 'source-a');
    await ingest([{
      recordId: 'task-personal-r', externalRecordId: 'task-personal-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-personal-conflict',
      content: { title: 'Personal isolation', status: { code: 'open' } }, observedAt: '2026-08-23T09:00:00Z',
      evidence: [{ evidenceId: 'task-personal-ev-1', kind: 'quote', data: { quote: 'Open' } }],
    }]);
    await drain();
    const targetItemId = (await derived.listActiveItems({ tenantId: 'tenant-a', entityId: taskId }))
      .find(item => item.itemType === 'Status')!.itemId;
    await derived.appendReview({
      tenantId: 'tenant-a', actorId: 'user-personal', entityId: taskId, expectedRevision: 1,
      scope: { type: 'person', personId: 'user-personal' }, action: 'assert', targetItemId,
      itemType: 'Status', semanticKey: 'status',
      value: { code: 'accepted' },
      evidence: [{ sourceId: 'source-a', collectionId: 'collection-a', recordId: 'task-personal-r', recordRevision: 1, evidenceId: 'task-personal-ev-1' }],
      authorize: async () => true,
    });
    await ingest([{
      recordId: 'task-personal-r', externalRecordId: 'task-personal-r', entityType: 'task', recordKind: 'snapshot', nativeId: 'task-personal-conflict',
      content: { title: 'Personal isolation', status: { code: 'reopened' } }, observedAt: '2026-08-23T09:05:00Z',
      evidence: [{ evidenceId: 'task-personal-ev-2', kind: 'quote', data: { quote: 'Reopened' } }],
    }]);
    await drain();
    const conflicts = await pool.query(`SELECT owner_principal,conflict_status
      FROM ${derived.tables.derivedItems}
      WHERE tenant_id='tenant-a' AND subject_entity_id=$1 AND item_type='Status' AND lifecycle='active'
      ORDER BY owner_principal NULLS FIRST`, [taskId]);
    expect(conflicts.rows).toEqual([
      { owner_principal: null, conflict_status: 'none' },
      { owner_principal: 'user-personal', conflict_status: 'none' },
    ]);
  });
});
