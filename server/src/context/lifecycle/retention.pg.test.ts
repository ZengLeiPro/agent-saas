import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgGovernanceMigrationRunner } from '../../data/governance-schema/index.js';
import { tableNames as phase4TableNames } from '../phase4/migration.js';
import { ContextStore } from '../store/store.js';
import { ContextRetentionStore, ContextRetentionWorker } from './retention.js';
import { contextRetentionTableNames } from './migration.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('Context retention PostgreSQL lifecycle', () => {
  const prefix = `ret${randomBytes(4).toString('hex')}`;
  let pool: Pool;
  let context: ContextStore;
  let retention: ContextRetentionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 4 });
    await new PgGovernanceMigrationRunner(pool, prefix).run();
    context = new ContextStore({ pool, tablePrefix: prefix });
    retention = new ContextRetentionStore({ pool, tablePrefix: prefix });
  });

  afterAll(async () => {
    if (pool) {
      const tables = [
        ...Object.values(phase4TableNames(prefix)),
        ...Object.values(context.tables),
        ...Object.values(contextRetentionTableNames(prefix)),
      ];
      await pool.query(`DROP TABLE IF EXISTS ${[...new Set(tables)].reverse().join(',')} CASCADE`);
      await pool.end();
    }
  });

  it('honors watermarks, defaults to dry-run, emits a verifiable receipt and isolates tenants', async () => {
    const seed = async (tenantId: string) => {
      await context.createSource({ tenantId, sourceId: 'source', kind: 'test', displayName: 'Source' });
      await context.createCollection({ tenantId, sourceId: 'source', collectionId: 'collection', externalKey: 'records', displayName: 'Records' });
      await context.ensurePartition({ tenantId, sourceId: 'source', collectionId: 'collection', partitionKey: 'all' });
      const lease = await context.acquirePartitionLease({
        tenantId, sourceId: 'source', collectionId: 'collection', partitionKey: 'all',
        leaseOwner: `seed-${tenantId}`, leaseMs: 60_000,
      });
      const ingest = async (value: string, evidenceId: string) => context.ingestPage({
        tenantId, sourceId: 'source', collectionId: 'collection', partitionKey: 'all',
        leaseOwner: `seed-${tenantId}`, leaseFence: lease!.leaseFence,
        records: [{ recordId: 'record', externalRecordId: 'record', content: { value }, observedAt: '2020-01-01T00:00:00Z',
          evidence: [{ evidenceId, kind: 'quote', data: { quote: value } }] }],
        checkpoint: {},
      });
      await ingest('old', 'evidence-old');
      await ingest('current', 'evidence-current');
      const outbox = await pool.query(`SELECT MAX(seq) max FROM ${context.tables.outbox} WHERE tenant_id=$1`, [tenantId]);
      const sourceWatermark = String(outbox.rows[0].max);
      const d = phase4TableNames(prefix);
      await pool.query(`INSERT INTO ${d.consumers} (tenant_id,consumer_id,cursor_seq) VALUES ($1,'retention-guard',$2)`, [tenantId, sourceWatermark]);
      const derived = await pool.query(`INSERT INTO ${d.derivedOutbox}
        (tenant_id,event_id,event_type,aggregate_type,aggregate_id,generation,payload_json,status,created_at)
        VALUES ($1,'derived-old','context.entity.changed','entity','entity',1,'{}','delivered','2020-01-01') RETURNING seq`, [tenantId]);
      await pool.query(`UPDATE ${context.tables.outbox} SET created_at='2020-01-01' WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`UPDATE ${context.tables.revisions} SET created_at='2020-01-01' WHERE tenant_id=$1 AND revision=1`, [tenantId]);
      await pool.query(`UPDATE ${context.tables.evidence} SET created_at='2020-01-01' WHERE tenant_id=$1 AND revision=1`, [tenantId]);
      return { sourceWatermark, derivedWatermark: String(derived.rows[0].seq) };
    };
    const target = await seed('tenant-a');
    await seed('tenant-b');
    const request = {
      tenantId: 'tenant-a', sourceOutboxWatermark: target.sourceWatermark,
      derivedOutboxWatermark: target.derivedWatermark, retainAfter: '2021-01-01T00:00:00Z',
    };

    const plan = await retention.collect(request);
    expect(plan).toMatchObject({ dryRun: true, safeSourceOutboxWatermark: target.sourceWatermark,
      counts: { sourceOutbox: 2, derivedOutbox: 1, evidence: 1, revisions: 1 } });
    expect(plan.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await pool.query(`SELECT COUNT(*)::integer count FROM ${context.tables.revisions} WHERE tenant_id='tenant-a'`)).rows[0].count).toBe(2);

    const applied = await retention.collect({ ...request, dryRun: false });
    expect(applied.counts).toEqual(plan.counts);
    const receiptRows = await pool.query(`SELECT tenant_id,audit_status,receipt_json FROM ${contextRetentionTableNames(prefix).receipts}
      WHERE receipt_id=$1`, [applied.receiptId]);
    expect(receiptRows.rows).toMatchObject([{ tenant_id: 'tenant-a', audit_status: 'pending',
      receipt_json: { receiptId: applied.receiptId, receiptSha256: applied.receiptSha256 } }]);
    expect((await pool.query(`SELECT revision FROM ${context.tables.revisions} WHERE tenant_id='tenant-a' ORDER BY revision`)).rows)
      .toEqual([{ revision: '2' }]);
    expect((await pool.query(`SELECT COUNT(*)::integer count FROM ${context.tables.revisions} WHERE tenant_id='tenant-b'`)).rows[0].count).toBe(2);
  });

  it('rejects a source watermark ahead of every consumer cursor without deleting', async () => {
    await expect(retention.collect({
      tenantId: 'tenant-b', sourceOutboxWatermark: '999999999999', derivedOutboxWatermark: '0',
      retainAfter: '2030-01-01T00:00:00Z', dryRun: false,
    })).rejects.toThrow('CONTEXT_RETENTION_UNSAFE_WATERMARK');
    expect((await pool.query(`SELECT COUNT(*)::integer count FROM ${context.tables.revisions} WHERE tenant_id='tenant-b'`)).rows[0].count).toBe(2);
  });

  it('durably retries audit failures and cannot claim the receipt across tenants', async () => {
    const cursors = await pool.query(`SELECT MIN(cursor_seq) watermark FROM ${phase4TableNames(prefix).consumers}
      WHERE tenant_id='tenant-b'`);
    const audit = vi.fn().mockRejectedValueOnce(new Error('audit offline')).mockResolvedValue(undefined);
    const worker = new ContextRetentionWorker(retention, audit);
    const result = await worker.run([{
      tenantId: 'tenant-b', sourceOutboxWatermark: String(cursors.rows[0].watermark),
      derivedOutboxWatermark: '0', retainAfter: '2021-01-01T00:00:00Z',
    }]);
    const receipt = result.failures[0]?.receipt;
    expect(receipt).toBeDefined();
    const table = contextRetentionTableNames(prefix).receipts;
    expect((await pool.query(`SELECT audit_status,audit_attempt FROM ${table}
      WHERE tenant_id='tenant-b' AND receipt_id=$1`, [receipt!.receiptId])).rows)
      .toEqual([{ audit_status: 'retry_wait', audit_attempt: 1 }]);

    await expect(worker.retryAudit('tenant-a', receipt!.receiptId))
      .rejects.toThrow('CONTEXT_RETENTION_RECEIPT_NOT_FOUND');
    await expect(worker.retryAudit('tenant-b', receipt!.receiptId)).resolves.toMatchObject({ receiptId: receipt!.receiptId });
    expect((await pool.query(`SELECT audit_status,audit_attempt FROM ${table}
      WHERE tenant_id='tenant-b' AND receipt_id=$1`, [receipt!.receiptId])).rows)
      .toEqual([{ audit_status: 'delivered', audit_attempt: 2 }]);
  });

});
