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

  it('scopes personal corrections, gates org corrections, isolates proposed items and revokes reads live', async () => {
    const taskId = entityId('tenant-a', 'Task', 'task-1', 'source-a');
    const evidence = { sourceId: 'source-a', collectionId: 'collection-a', recordId: 'task-r', recordRevision: 2, evidenceId: 'task-ev-2' };
    await expect(derived.appendReview({
      tenantId: 'tenant-a', actorId: 'user-a', entityId: taskId, expectedRevision: 1, scope: { type: 'org' },
      action: 'assert', itemType: 'Status', semanticKey: 'status', value: { code: 'accepted' }, evidence: [evidence],
    })).rejects.toMatchObject({ code: 'DERIVED_FORBIDDEN' });
    const correctionInput = {
      tenantId: 'tenant-a', actorId: 'user-a', entityId: taskId, expectedRevision: 1,
      scope: { type: 'person' as const, personId: 'user-a' }, action: 'assert' as const,
      itemType: 'Status' as const, semanticKey: 'status', value: { code: 'accepted' }, evidence: [evidence],
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

    await expect(derived.appendReview({
      tenantId: 'tenant-a', actorId: 'user-a', entityId: taskId, expectedRevision: 1,
      scope: { type: 'person', personId: 'user-a' }, action: 'assert', itemType: 'Status', semanticKey: 'status',
      value: { code: 'stale-write' }, evidence: [evidence],
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
  });
});
