import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/index.js';
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
});
