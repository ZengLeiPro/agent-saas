import { describe, expect, it, vi } from 'vitest';

import { buildContextMigrationSql, contextTableNames, contextTablePrefix } from './store/migration.js';
import { ContextStore } from './store/store.js';
import { ContextStoreError, type ContextJson } from './store/types.js';
import { computeContextContentHash } from './store/validation.js';

const NOW = '2026-08-22T15:00:00.000Z';
const FUTURE = '2999-08-22T16:00:00.000Z';

function partitionRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a', source_id: 'source-a', collection_id: 'collection-a', partition_key: 'all',
    status: 'syncing', watermark_json: null, window_start: null, window_end: null, page_cursor: null,
    lease_owner: 'worker-a', lease_fence: 1, lease_expires_at: FUTURE, retry_count: 0,
    next_retry_at: null, last_error_code: null, coverage_start: null, coverage_end: null,
    source_kind: 'dws', source_status: 'active', collection_status: 'active',
    source_account_revision: '1', account_status: 'active', account_revision: 1,
    truncated: false, refused: false, updated_at: NOW, ...overrides,
  };
}

function recordRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a', source_id: 'source-a', collection_id: 'collection-a', record_id: 'record-a',
    external_record_id: 'external-a', current_revision: 1,
    content_hash: computeContextContentHash({ title: 'one' }), content_json: { title: 'one' },
    metadata_json: {}, deleted: false, revoked: false, source_updated_at: null, observed_at: NOW,
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

class IngestClient {
  readonly query = vi.fn(async (sql: string, params: unknown[] = []) => this.execute(sql, params));
  readonly release = vi.fn();
  record: Record<string, unknown> | undefined;
  revisions: Record<string, unknown>[] = [];
  evidence: Record<string, unknown>[] = [];
  outbox: Record<string, unknown>[] = [];
  partition = partitionRow();
  failCheckpoint = false;
  private snapshot?: string;

  private state() {
    return { record: this.record, revisions: this.revisions, evidence: this.evidence, outbox: this.outbox, partition: this.partition };
  }

  private async execute(sql: string, params: unknown[]) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized === 'BEGIN') {
      this.snapshot = JSON.stringify(this.state());
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'COMMIT') {
      this.snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized === 'ROLLBACK') {
      if (this.snapshot) {
        const restored = JSON.parse(this.snapshot) as ReturnType<IngestClient['state']>;
        this.record = restored.record;
        this.revisions = restored.revisions;
        this.evidence = restored.evidence;
        this.outbox = restored.outbox;
        this.partition = restored.partition;
      }
      this.snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes('FROM test_context_sources s') && normalized.includes('FOR SHARE OF s,c')) {
      return { rows: [{
        source_kind: this.partition.source_kind,
        source_status: this.partition.source_status,
        collection_status: this.partition.collection_status,
        config_json: {
          accountId: 'account-a',
          accountRevision: this.partition.source_account_revision,
        },
      }], rowCount: 1 };
    }
    if (normalized.includes('FROM test_agent_dws_accounts') && normalized.includes('FOR SHARE')) {
      return { rows: [{
        status: this.partition.account_status,
        revision: this.partition.account_revision,
      }], rowCount: 1 };
    }
    if (normalized.includes('SELECT * FROM test_context_sync_partitions') && normalized.includes('FOR UPDATE')) {
      return { rows: [this.partition], rowCount: 1 };
    }
    if (normalized === 'SELECT pg_advisory_xact_lock(hashtext($1))') {
      return { rows: [{}], rowCount: 1 };
    }
    if (normalized.includes('SELECT * FROM test_context_source_records') && normalized.includes('external_record_id')) {
      return { rows: this.record ? [this.record] : [], rowCount: this.record ? 1 : 0 };
    }
    if (normalized.includes('INSERT INTO test_context_source_records')) {
      this.record = recordRow({
        tenant_id: params[0], source_id: params[1], collection_id: params[2], record_id: params[3],
        external_record_id: params[4], content_hash: params[5], content_json: JSON.parse(String(params[6])),
        metadata_json: JSON.parse(String(params[7])), deleted: params[8], revoked: params[9],
        source_updated_at: params[10], observed_at: params[11],
      });
      return { rows: [this.record], rowCount: 1 };
    }
    if (normalized.includes('UPDATE test_context_source_records')) {
      this.record = recordRow({
        ...this.record, current_revision: params[4], content_hash: params[5],
        content_json: JSON.parse(String(params[6])), metadata_json: JSON.parse(String(params[7])),
        deleted: params[8], revoked: params[9], source_updated_at: params[10], observed_at: params[11],
      });
      return { rows: [this.record], rowCount: 1 };
    }
    if (normalized.includes('INSERT INTO test_context_record_revisions')) {
      this.revisions.push({
        revision: params[4], content_hash: params[5], metadata_json: JSON.parse(String(params[7])),
        deleted: params[8], revoked: params[9], source_updated_at: params[10],
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes('INSERT INTO test_context_evidence')) {
      this.evidence.push({
        revision: params[4], evidence_id: params[5], kind: params[6], data_json: JSON.parse(String(params[7])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes('INSERT INTO test_context_outbox')) {
      const row = {
        tenant_id: params[0], seq: String(this.outbox.length + 1), event_type: params[1], source_id: params[2],
        collection_id: params[3], record_id: params[4], record_revision: params[5],
        payload_json: JSON.parse(String(params[6])), created_at: NOW,
      };
      this.outbox.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (normalized.includes('UPDATE test_context_sync_partitions')) {
      if (this.failCheckpoint) return { rows: [], rowCount: 0 };
      this.partition = partitionRow({
        ...this.partition, watermark_json: params[7] ? JSON.parse(String(params[7])) : this.partition.watermark_json,
        page_cursor: params[10] ? null : params[12], status: params[10] ? 'complete' : 'syncing', updated_at: NOW,
      });
      return { rows: [this.partition], rowCount: 1 };
    }
    throw new Error(`Unhandled SQL: ${normalized}`);
  }
}

function ingestInput(content: ContextJson, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'collection-a', partitionKey: 'all',
    leaseOwner: 'worker-a', leaseFence: 1,
    records: [{
      recordId: 'record-a', externalRecordId: 'external-a', content,
      evidence: [{ evidenceId: 'evidence-a', kind: 'source_locator', data: { line: 1 } }],
      ...overrides,
    }],
    checkpoint: { watermark: { page: 'next' }, pageCursor: 'after-next' },
  } as const;
}

describe('ContextStore PostgreSQL data layer', () => {
  it('builds all seven tenant-first Phase 1 tables and constraints', () => {
    const sql = buildContextMigrationSql('test').join('\n');
    for (const table of [
      'context_sources', 'context_collections', 'context_sync_partitions', 'context_source_records',
      'context_record_revisions', 'context_evidence', 'context_outbox',
    ]) expect(sql).toContain(`test_${table}`);
    expect(sql).toContain('PRIMARY KEY (tenant_id, source_id, collection_id, record_id, revision)');
    expect(sql).toContain('UNIQUE (tenant_id, collection_id)');
    expect(sql).toContain("content_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain('seq BIGINT GENERATED ALWAYS AS IDENTITY');
  });

  it('accepts governance test prefixes while keeping truncated PostgreSQL identifiers distinct', () => {
    const prefix = 'p'.repeat(30);
    expect(contextTablePrefix(prefix)).toBe(prefix);
    expect(() => contextTablePrefix(`${prefix}x`)).toThrow('Invalid PostgreSQL identifier');

    const identifiers = buildContextMigrationSql(prefix)
      .map(statement => statement.match(/CREATE (?:TABLE|INDEX) IF NOT EXISTS ([a-zA-Z0-9_]+)/)?.[1])
      .filter((identifier): identifier is string => Boolean(identifier))
      .map(identifier => identifier.slice(0, 63));
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(contextTableNames(prefix).partitions).toBe(`${prefix}_context_sync_partitions`);
  });

  it('maps tenant-wide collection unique violations to the stable identity conflict code', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
    const store = new ContextStore({
      pool: { query: vi.fn().mockRejectedValue(duplicate) } as never,
      tablePrefix: 'test',
    });

    await expect(store.createCollection({
      tenantId: 'tenant-a', sourceId: 'source-a', collectionId: 'shared',
      externalKey: 'chat', displayName: '聊天',
    })).rejects.toMatchObject({ code: 'CONTEXT_IDENTITY_CONFLICT' });
  });

  it('keeps reads tenant-first and does not return another tenant row', async () => {
    const row = recordRow();
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({
      rows: params[0] === 'tenant-a' ? [{
        ...row,
        revision_revision: 1, revision_content_hash: row.content_hash,
        revision_content_json: row.content_json, revision_metadata_json: {}, revision_deleted: false,
        revision_revoked: false, revision_source_updated_at: null, revision_observed_at: NOW,
        revision_created_at: NOW,
      }] : [],
    }));
    const store = new ContextStore({ pool: { query } as never, tablePrefix: 'test' });
    await expect(store.getRecord('tenant-b', 'source-a', 'collection-a', 'record-a')).resolves.toBeNull();
    await expect(store.getRecord('tenant-a', 'source-a', 'collection-a', 'record-a')).resolves.toMatchObject({
      record: { tenantId: 'tenant-a', recordId: 'record-a' }, revision: { revision: 1 },
    });
    expect(query.mock.calls[0]![0]).toContain('WHERE r.tenant_id=$1');
    expect(query.mock.calls[0]![1]).toEqual(['tenant-b', 'source-a', 'collection-a', 'record-a']);
  });

  it('lists current visible evidence tenant-first with a bounded limit', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rows: [{
      tenant_id: 'tenant-a', source_id: 'source-a', collection_id: 'collection-a', record_id: 'record-a',
      revision: 3, evidence_id: 'evidence-a', kind: 'source_locator', data_json: { line: 1 }, created_at: NOW,
    }] }));
    const store = new ContextStore({ pool: { query } as never, tablePrefix: 'test' });

    await expect(store.listEvidence('tenant-a', 'source-a', 'collection-a', 25)).resolves.toMatchObject([
      { tenantId: 'tenant-a', collectionId: 'collection-a', recordId: 'record-a', revision: 3 },
    ]);
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('WHERE e.tenant_id=$1 AND e.source_id=$2 AND e.collection_id=$3');
    expect(sql).toContain('r.current_revision=e.revision');
    expect(sql).toContain('r.deleted=FALSE AND r.revoked=FALSE');
    expect(params).toEqual(['tenant-a', 'source-a', 'collection-a', 25]);
    await expect(store.listEvidence('tenant-a', 'source-a', 'collection-a', 0)).rejects.toMatchObject({
      code: 'CONTEXT_INVALID',
    });
  });

  it('keeps BIGINT outbox sequences as validated decimal strings beyond Number safety', async () => {
    const query = vi.fn(async (sql: string, _params: unknown[] = []) => sql.includes('MAX(seq)')
      ? { rows: [{ seq: '9007199254740993' }] }
      : { rows: [{
          tenant_id: 'tenant-a', seq: '9007199254740994', event_type: 'context.record.upserted',
          source_id: 'source-a', collection_id: 'collection-a', record_id: 'record-a', record_revision: 1,
          payload_json: {}, created_at: NOW,
        }] });
    const store = new ContextStore({ pool: { query } as never, tablePrefix: 'test' });

    await expect(store.getOutboxCursor('tenant-a')).resolves.toEqual({ tenantId: 'tenant-a', seq: '9007199254740993' });
    await expect(store.listOutbox('tenant-a', '9007199254740993', 10)).resolves.toMatchObject([
      { tenantId: 'tenant-a', seq: '9007199254740994' },
    ]);
    expect(query.mock.calls[1]![1]).toEqual(['tenant-a', '9007199254740993', 10]);
    for (const invalid of ['-1', '1.5', '01', '9223372036854775808']) {
      await expect(store.listOutbox('tenant-a', invalid)).rejects.toMatchObject({ code: 'CONTEXT_INVALID' });
    }
  });

  it('is version-fingerprint idempotent, creates revisions, and emits monotonic outbox seq', async () => {
    const client = new IngestClient();
    const store = new ContextStore({
      pool: { connect: vi.fn(async () => client) } as never, tablePrefix: 'test',
    });
    await expect(store.ingestPage(ingestInput({ title: 'one' }))).resolves.toMatchObject({ created: 1, revised: 0, unchanged: 0 });
    await expect(store.ingestPage(ingestInput({ title: 'one' }))).resolves.toMatchObject({ created: 0, revised: 0, unchanged: 1 });
    await expect(store.ingestPage(ingestInput({ title: 'two' }))).resolves.toMatchObject({ created: 0, revised: 1, unchanged: 0 });
    expect(client.revisions.map(row => row.revision)).toEqual([1, 2]);
    expect(client.evidence).toHaveLength(2);
    expect(client.outbox.map(row => row.seq)).toEqual(['1', '2']);
    expect(client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(3);
    const checkpointSql = client.query.mock.calls.find(([sql]) => String(sql).includes('coverage_start=CASE'))?.[0];
    expect(checkpointSql).toContain('LEAST(coverage_start');
    expect(checkpointSql).toContain('GREATEST(coverage_end');
  });

  it('resets refused partitions only through an explicit operator recovery action', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ partition_key: 'a' }, { partition_key: 'b' }],
    }));
    const store = new ContextStore({ pool: { query } as never, tablePrefix: 'test' });
    await expect(store.resetRefusedPartitions('tenant-a', 'source-a', 'collection-a')).resolves.toBe(2);
    expect(query.mock.calls[0]![0]).toContain("SET status='idle',refused=FALSE");
    expect(query.mock.calls[0]![1]).toEqual(['tenant-a', 'source-a', 'collection-a']);

    await expect(store.resetPartitionsForPolicyChange('tenant-a', 'source-a', 'collection-a')).resolves.toBe(2);
    expect(query.mock.calls[1]![0]).toContain('watermark_json=NULL');
    expect(query.mock.calls[1]![0]).toContain('coverage_start=NULL,coverage_end=NULL');
    expect(query.mock.calls[1]![0]).toContain('lease_fence=lease_fence+1');
  });

  it('fingerprints canonical content, caller hash, metadata, lifecycle, source time, and evidence', async () => {
    const client = new IngestClient();
    const store = new ContextStore({ pool: { connect: vi.fn(async () => client) } as never, tablePrefix: 'test' });
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const evidence = [
      { evidenceId: 'evidence-b', kind: 'source_locator', data: { column: 2, line: 1 } },
      { evidenceId: 'evidence-a', kind: 'source_locator', data: { line: 1 } },
    ] as const;
    const base = {
      contentHash: hashA,
      metadata: { z: 2, a: { y: true, x: false } },
      evidence,
    };

    await expect(store.ingestPage(ingestInput({ title: 'one', nested: { z: 2, a: 1 } }, base)))
      .resolves.toMatchObject({ created: 1 });
    await expect(store.ingestPage(ingestInput({ nested: { a: 1, z: 2 }, title: 'one' }, {
      ...base,
      metadata: { a: { x: false, y: true }, z: 2 },
      evidence: [...evidence].reverse(),
    }))).resolves.toMatchObject({ unchanged: 1, revised: 0 });

    const metadataChanged = { ...base, metadata: { z: 3, a: { y: true, x: false } } };
    await expect(store.ingestPage(ingestInput({ title: 'one', nested: { z: 2, a: 1 } }, metadataChanged)))
      .resolves.toMatchObject({ revised: 1 });
    const evidenceChanged = {
      ...metadataChanged,
      evidence: [evidence[0], { ...evidence[1], data: { line: 9 } }],
    };
    await expect(store.ingestPage(ingestInput({ title: 'one', nested: { z: 2, a: 1 } }, evidenceChanged)))
      .resolves.toMatchObject({ revised: 1 });
    const sourceTimeChanged = { ...evidenceChanged, sourceUpdatedAt: '2026-08-22T16:00:00+00:00' };
    await expect(store.ingestPage(ingestInput({ title: 'one', nested: { z: 2, a: 1 } }, sourceTimeChanged)))
      .resolves.toMatchObject({ revised: 1 });
    const deleted = { ...sourceTimeChanged, deleted: true };
    await expect(store.ingestPage(ingestInput({ title: 'one', nested: { z: 2, a: 1 } }, deleted)))
      .resolves.toMatchObject({ revised: 1 });
    const revoked = { ...deleted, revoked: true };
    await expect(store.ingestPage(ingestInput({ title: 'one', nested: { z: 2, a: 1 } }, revoked)))
      .resolves.toMatchObject({ revised: 1 });
    const callerHashChanged = { ...revoked, contentHash: hashB };
    await expect(store.ingestPage(ingestInput({ title: 'one', nested: { z: 2, a: 1 } }, callerHashChanged)))
      .resolves.toMatchObject({ revised: 1 });
    await expect(store.ingestPage(ingestInput({ title: 'changed', nested: { z: 2, a: 1 } }, callerHashChanged)))
      .resolves.toMatchObject({ revised: 1 });

    expect(client.revisions).toHaveLength(8);
    expect(client.evidence.slice(0, 2).map(row => row.evidence_id)).toEqual(['evidence-a', 'evidence-b']);
  });

  it('rolls record/revision/evidence/outbox back when the atomic watermark fence fails', async () => {
    const client = new IngestClient();
    client.failCheckpoint = true;
    const store = new ContextStore({ pool: { connect: vi.fn(async () => client) } as never, tablePrefix: 'test' });
    await expect(store.ingestPage(ingestInput({ title: 'one' }))).rejects.toMatchObject({
      code: 'CONTEXT_LEASE_LOST',
    } satisfies Partial<ContextStoreError>);
    expect(client.record).toBeUndefined();
    expect(client.revisions).toHaveLength(0);
    expect(client.evidence).toHaveLength(0);
    expect(client.outbox).toHaveLength(0);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects a stale lease fence before record writes', async () => {
    const client = new IngestClient();
    client.partition = partitionRow({ lease_fence: 2 });
    const store = new ContextStore({ pool: { connect: vi.fn(async () => client) } as never, tablePrefix: 'test' });
    await expect(store.ingestPage(ingestInput({ title: 'one' }))).rejects.toMatchObject({ code: 'CONTEXT_LEASE_LOST' });
    expect(client.record).toBeUndefined();
    expect(client.outbox).toHaveLength(0);
  });

  it('rejects DWS writes when the account revision no longer matches the source mirror', async () => {
    const client = new IngestClient();
    client.partition = partitionRow({ source_account_revision: '1', account_revision: 2 });
    const store = new ContextStore({ pool: { connect: vi.fn(async () => client) } as never, tablePrefix: 'test' });

    await expect(store.ingestPage(ingestInput({ title: 'one' })))
      .rejects.toMatchObject({ code: 'CONTEXT_LEASE_LOST' });
    expect(client.record).toBeUndefined();
    expect(client.outbox).toHaveLength(0);
  });

  it('persists revocation as a revision and emits a revoked event', async () => {
    const client = new IngestClient();
    client.record = recordRow();
    client.revisions = [{ revision: 1 }];
    const store = new ContextStore({ pool: { connect: vi.fn(async () => client) } as never, tablePrefix: 'test' });
    await expect(store.ingestPage(ingestInput({ title: 'one' }, { revoked: true }))).resolves.toMatchObject({ revised: 1 });
    expect(client.record).toMatchObject({ current_revision: 2, revoked: true });
    expect(client.revisions.at(-1)).toMatchObject({ revision: 2, revoked: true });
    expect(client.outbox.at(-1)).toMatchObject({ event_type: 'context.record.revoked', record_revision: 2 });
  });
});
