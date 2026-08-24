import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/index.js';
import { tableNames as contextPhase4TableNames } from './phase4/migration.js';
import { contextTableNames } from './store/migration.js';
import { ContextStore, ContextStoreError } from './store/index.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('PgContextStore PostgreSQL integration', () => {
  const prefix = `ctx${randomBytes(4).toString('hex')}`;
  const tables = contextTableNames(prefix);
  let pool: Pool;
  let store: ContextStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 4 });
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    store = new ContextStore({ pool, tablePrefix: prefix });
  });

  afterAll(async () => {
    if (!pool) return;
    const result = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE $1`,
      [`${prefix}_%`],
    );
    for (const { tablename } of result.rows) {
      await pool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
    }
    await pool.end();
  });

  it('applies governance migration v24 and enforces tenant-wide collection identity and foreign keys', async () => {
    const version = await pool.query(
      `SELECT version FROM ${prefix}_governance_schema_versions WHERE version = 24`,
    );
    expect(version.rows).toHaveLength(1);

    await store.createSource({ tenantId: 'tenant-a', sourceId: 'source-a', kind: 'test', displayName: 'A' });
    await store.createSource({ tenantId: 'tenant-a', sourceId: 'source-b', kind: 'test', displayName: 'B' });
    await store.createCollection({
      tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-shared',
      externalKey: 'chat', displayName: '聊天',
    });
    await expect(store.createCollection({
      tenantId: 'tenant-a', sourceId: 'source-b', collectionId: 'collection-shared',
      externalKey: 'wiki', displayName: '文档',
    })).rejects.toMatchObject({ code: 'CONTEXT_IDENTITY_CONFLICT' } satisfies Partial<ContextStoreError>);

    await expect(pool.query(
      `INSERT INTO ${tables.evidence}
       (tenant_id, source_id, collection_id, record_id, revision, evidence_id, kind, data_json)
       VALUES ('tenant-a','source-a','collection-shared','missing',1,'ev','quote','{}')`,
    )).rejects.toThrow();
  });

  it('commits records/evidence/watermark atomically and keeps BIGINT outbox cursors exact', async () => {
    await store.ensurePartition({
      tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-shared', partitionKey: 'chat:main',
      windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-23T00:00:00.000Z',
    });
    const lease = await store.acquirePartitionLease({
      tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-shared', partitionKey: 'chat:main',
      leaseOwner: 'worker-a', leaseMs: 60_000,
    });
    expect(lease).not.toBeNull();

    await pool.query(`ALTER TABLE ${tables.outbox} ALTER COLUMN seq RESTART WITH 9007199254740993`);
    const result = await store.ingestPage({
      tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-shared', partitionKey: 'chat:main',
      leaseOwner: 'worker-a', leaseFence: lease!.leaseFence,
      records: [{
        recordId: 'message-1', externalRecordId: 'message-1', content: { text: '项目已获批' },
        entityType: 'project', recordKind: 'event', nativeId: '项目/泉州：一号',
        occurredAt: '2026-08-22T20:00:00+08:00', sourceEventId: 'taskboard-change:一',
        ownerPrincipal: 'user:owner', aclPrincipals: ['user:z', 'user:a', 'user:a'],
        sourceUpdatedAt: '2026-08-22T12:00:00.000Z',
        evidence: [{ evidenceId: 'message-1:source', kind: 'source_locator', data: { conversationId: 'chat-a' } }],
      }],
      checkpoint: {
        watermark: { to: '2026-08-23T00:00:00.000Z' },
        coverageStart: '2026-08-01T00:00:00.000Z', coverageEnd: '2026-08-23T00:00:00.000Z',
        complete: true, releaseLease: true,
      },
    });

    expect(result.outbox[0]?.seq).toBe('9007199254740993');
    expect(result.outbox[0]?.payload).toMatchObject({
      version: 2, entityType: 'project', recordKind: 'event', nativeId: '项目/泉州：一号',
      occurredAt: '2026-08-22T12:00:00.000Z', sourceEventId: 'taskboard-change:一',
      ownerPrincipal: 'user:owner', aclPrincipals: ['user:a', 'user:z'],
    });
    expect((await store.getOutboxCursor('tenant-a')).seq).toBe('9007199254740993');
    expect(await store.getRecord('tenant-a', 'source-a', 'collection-shared', 'message-1')).toMatchObject({
      record: {
        entityType: 'project', recordKind: 'event', nativeId: '项目/泉州：一号',
        occurredAt: '2026-08-22T12:00:00.000Z', sourceEventId: 'taskboard-change:一',
        ownerPrincipal: 'user:owner', aclPrincipals: ['user:a', 'user:z'],
      },
      revision: {
        entityType: 'project', recordKind: 'event', nativeId: '项目/泉州：一号',
        ownerPrincipal: 'user:owner', aclPrincipals: ['user:a', 'user:z'],
      },
    });
    expect(await store.getEvidence('tenant-a', 'source-a', 'collection-shared', 'message-1'))
      .toMatchObject([{ evidenceId: 'message-1:source', kind: 'source_locator' }]);
    const partition = await store.getPartition('tenant-a', 'source-a', 'collection-shared', 'chat:main');
    expect(partition).toMatchObject({ status: 'complete', watermark: { to: '2026-08-23T00:00:00.000Z' } });
    expect(partition).not.toHaveProperty('leaseOwner');
  });

  it('hard deletes every phase row in reverse-FK order, rolls back failures, and isolates tenants', async () => {
    const phase4 = contextPhase4TableNames(prefix);
    const targetTenant = 'tenant-purge-target';
    const otherTenant = 'tenant-purge-other';
    const sourceId = 'source-purge';
    const collectionId = 'collection-purge';
    const hash = 'a'.repeat(64);
    const tenantTables = [...Object.values(tables), ...Object.values(phase4)];
    const countRows = async (tenantId: string): Promise<Record<string, number>> => Object.fromEntries(
      await Promise.all(tenantTables.map(async (table) => {
        const result = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table} WHERE tenant_id=$1`, [tenantId]);
        return [table, result.rows[0]!.count];
      })),
    ) as Record<string, number>;
    const seed = async (tenantId: string) => {
      await pool.query(
        `INSERT INTO ${tables.sources} (tenant_id, source_id, kind, display_name)
         VALUES ($1,$2,'test','Purge fixture')`,
        [tenantId, sourceId],
      );
      await pool.query(
        `INSERT INTO ${tables.collections} (tenant_id, source_id, collection_id, external_key, display_name)
         VALUES ($1,$2,$3,'purge','Purge fixture')`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${tables.partitions} (tenant_id, source_id, collection_id, partition_key)
         VALUES ($1,$2,$3,'all')`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${tables.records}
          (tenant_id, source_id, collection_id, record_id, external_record_id, current_revision, content_hash, content_json, observed_at)
         VALUES
          ($1,$2,$3,'record-1','external-1',1,$4,'{}',NOW()),
          ($1,$2,$3,'record-2','external-2',1,$4,'{}',NOW())`,
        [tenantId, sourceId, collectionId, hash],
      );
      await pool.query(
        `INSERT INTO ${tables.revisions}
          (tenant_id, source_id, collection_id, record_id, revision, content_hash, content_json, observed_at)
         VALUES
          ($1,$2,$3,'record-1',1,$4,'{}',NOW()),
          ($1,$2,$3,'record-2',1,$4,'{}',NOW())`,
        [tenantId, sourceId, collectionId, hash],
      );
      await pool.query(
        `INSERT INTO ${tables.evidence}
          (tenant_id, source_id, collection_id, record_id, revision, evidence_id, kind, data_json)
         VALUES ($1,$2,$3,'record-1',1,'evidence-1','quote','{}')`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${tables.outbox}
          (tenant_id, event_type, source_id, collection_id, record_id, record_revision, payload_json)
         VALUES ($1,'context.record.upserted',$2,$3,'record-1',1,'{}')`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${phase4.entityLinks}
          (tenant_id, link_id, from_source_id, from_collection_id, from_record_id, from_revision,
           to_source_id, to_collection_id, to_record_id, to_revision, link_type)
         VALUES ($1,'link-1',$2,$3,'record-1',1,$2,$3,'record-2',1,'mentions')`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${phase4.consumers} (tenant_id, consumer_id) VALUES ($1,'consumer-1')`,
        [tenantId],
      );
      await pool.query(
        `INSERT INTO ${phase4.entities}
          (tenant_id, generation, entity_id, entity_type, native_id, source_id, collection_id, record_id, record_revision, display_name)
         VALUES ($1,1,'entity-1','project','project-1',$2,$3,'record-1',1,'Project 1')`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${phase4.derivedItems}
          (tenant_id, generation, item_id, item_type, subject_generation, subject_entity_id, semantic_key, value_json, derivation)
         VALUES ($1,1,'item-1','Task',1,'entity-1','task-1','{}','source')`,
        [tenantId],
      );
      await pool.query(
        `INSERT INTO ${phase4.itemEvidence}
          (tenant_id, generation, item_id, evidence_id, source_id, collection_id, record_id, record_revision)
         VALUES ($1,1,'item-1','item-evidence-1',$2,$3,'record-1',1)`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${phase4.reviews}
          (tenant_id, generation, item_id, review_id, review_status, reviewer_principal)
         VALUES ($1,1,'item-1','review-1','confirmed','user:reviewer')`,
        [tenantId],
      );
      await pool.query(
        `INSERT INTO ${phase4.profileFacets}
          (tenant_id, generation, principal_id, facet_id, facet_type, semantic_key, value_json, derivation)
         VALUES ($1,1,'user:one','facet-1','tasks','facet-1','{}','source')`,
        [tenantId],
      );
      await pool.query(
        `INSERT INTO ${phase4.profileFacetEvidence}
          (tenant_id, generation, principal_id, facet_id, evidence_id, source_id, collection_id, record_id, record_revision)
         VALUES ($1,1,'user:one','facet-1','facet-evidence-1',$2,$3,'record-2',1)`,
        [tenantId, sourceId, collectionId],
      );
      await pool.query(
        `INSERT INTO ${phase4.derivedOutbox}
          (tenant_id, event_id, event_type, aggregate_type, aggregate_id, generation, payload_json)
         VALUES ($1,'derived-event-1','context.entity.changed','entity','entity-1',1,'{}')`,
        [tenantId],
      );
      await pool.query(
        `INSERT INTO ${phase4.relationCandidates}
          (tenant_id, relation_id, from_entity_id, to_entity_id, relation_type, relation_class, authority, review_status,
           source_id, collection_id, record_id, record_revision,
           evidence_source_id, evidence_collection_id, evidence_record_id, evidence_revision, evidence_id, valid_from)
         VALUES ($1,'candidate-1','entity-1','entity-2','mentions','explicit','informational','proposed',
           $2,$3,'record-1',1,$2,$3,'record-1',1,'evidence-1',NOW())`,
        [tenantId, sourceId, collectionId],
      );
    };

    await seed(targetTenant);
    await seed(otherTenant);
    const targetBefore = await countRows(targetTenant);
    const otherBefore = await countRows(otherTenant);
    expect(Object.values(targetBefore).reduce((total, count) => total + count, 0)).toBe(19);
    expect(targetBefore).toEqual(otherBefore);

    const functionName = `${prefix}_purge_rollback`;
    const triggerName = `${prefix}_purge_rollback_trigger`;
    await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF OLD.tenant_id = '${targetTenant}' THEN RAISE EXCEPTION 'forced target delete failure'; END IF;
        RETURN OLD;
      END
    $fn$`);
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON ${tables.evidence}
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

    await expect(store.hardDeleteTenant(targetTenant)).rejects.toThrow(
      `CONTEXT_TENANT_HARD_DELETE_FAILED tenant=${targetTenant} step=evidenceDeleted: forced target delete failure`,
    );
    expect(await countRows(targetTenant)).toEqual(targetBefore);
    expect(await countRows(otherTenant)).toEqual(otherBefore);

    await pool.query(`DROP TRIGGER ${triggerName} ON ${tables.evidence}`);
    await pool.query(`DROP FUNCTION ${functionName}()`);

    await expect(store.hardDeleteTenant(targetTenant)).resolves.toMatchObject({
      relationCandidatesDeleted: 1, entityLinksDeleted: 1, itemEvidenceDeleted: 1, profileFacetEvidenceDeleted: 1,
      reviewsDeleted: 1, derivedItemsDeleted: 1, profileFacetsDeleted: 1, entitiesDeleted: 1, consumersDeleted: 1,
      derivedOutboxDeleted: 1, outboxDeleted: 1, evidenceDeleted: 1, revisionsDeleted: 2, recordsDeleted: 2,
      partitionsDeleted: 1, collectionsDeleted: 1, sourcesDeleted: 1, totalDeleted: 19,
    });
    expect(Object.values(await countRows(targetTenant))).toEqual(Array(tenantTables.length).fill(0));
    expect(await countRows(otherTenant)).toEqual(otherBefore);

    await expect(store.hardDeleteTenant(targetTenant)).resolves.toEqual({
      relationCandidatesDeleted: 0, entityLinksDeleted: 0, itemEvidenceDeleted: 0, profileFacetEvidenceDeleted: 0,
      reviewsDeleted: 0, derivedItemsDeleted: 0, profileFacetsDeleted: 0, entitiesDeleted: 0, consumersDeleted: 0,
      derivedOutboxDeleted: 0, outboxDeleted: 0, evidenceDeleted: 0, revisionsDeleted: 0, recordsDeleted: 0,
      partitionsDeleted: 0, collectionsDeleted: 0, sourcesDeleted: 0, totalDeleted: 0,
    });
  });
});
