import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import {
  createDurableTenantDeletionExecutor,
  type TenantDeletionReport,
} from '../data/tenants/cleanup.js';
import { TenantStore } from '../data/tenants/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('durable tenant deletion PostgreSQL recovery', () => {
  const prefix = `tdel_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const tmpRoot = mkdtempSync(join(tmpdir(), 'tenant-delete-job-'));
  let pool: InstanceType<typeof Pool>;

  beforeAll(() => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
  });

  afterAll(async () => {
    try {
      if (pool) {
        const tables = await pool.query<{ tablename: string }>(`
          SELECT tablename FROM pg_tables
          WHERE schemaname=current_schema() AND LEFT(tablename,LENGTH($1))=$1
        `, [prefix]);
        for (const row of tables.rows) await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
      }
    } finally {
      await pool?.end();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('freezes first, persists failed phase, and resumes without making tenant writable', async () => {
    const jobs = new PgGovernanceChangeJobStore({ pool, tablePrefix: prefix });
    await jobs.init();
    const tenantStore = new TenantStore(join(tmpRoot, 'tenants.json'));
    await tenantStore.create({ id: 'acme', name: 'Acme', createdBy: 'test' });

    const calls: string[] = [];
    let resourceAttempts = 0;
    const executor = createDurableTenantDeletionExecutor({
      jobs,
      tenantStore,
      retryDelayMs: 0,
      governanceCleanup: {
        execute: async (_tenantId: string, domain: string) => { calls.push(domain); },
      } as never,
      deleteResources: async tenantId => {
        calls.push(`resources:${tenantStore.findById(tenantId)?.disabled}`);
        resourceAttempts += 1;
        if (resourceAttempts === 1) throw new Error('INJECTED_RESOURCE_FAILURE');
        return { tenantId } as TenantDeletionReport;
      },
      onFrozen: tenantId => { calls.push(`frozen:${tenantStore.findById(tenantId)?.disabled}`); },
    });

    const first = await executor.execute({
      tenantId: 'acme', idempotencyKey: 'delete-acme-v1', requestedBy: 'admin', reasonCode: 'test',
    });
    expect(first.job.status).toBe('retry_wait');
    expect(tenantStore.findById('acme')).toMatchObject({ disabled: true });
    expect(first.domains.find(item => item.domain === 'tenant_freeze')).toMatchObject({ status: 'succeeded' });
    expect(first.domains.find(item => item.domain === 'legacy_resources')).toMatchObject({
      status: 'failed', lastErrorCode: 'INJECTED_RESOURCE_FAILURE',
    });
    expect(calls).toEqual(['frozen:true', 'resources:true']);

    const second = await executor.execute({
      tenantId: 'acme', idempotencyKey: 'delete-acme-v1', requestedBy: 'admin', reasonCode: 'test',
    });
    expect(second.job.status).toBe('succeeded');
    expect(second.created).toBe(false);
    expect(tenantStore.findById('acme')).toBeUndefined();
    expect(calls.filter(item => item.startsWith('frozen:'))).toHaveLength(1);
    expect(calls.filter(item => item === 'resources:true')).toHaveLength(2);
    expect(second.domains.every(item => item.status === 'succeeded')).toBe(true);

    const replay = await executor.execute({
      tenantId: 'acme', idempotencyKey: 'delete-acme-v1', requestedBy: 'admin', reasonCode: 'test',
    });
    expect(replay.job.jobId).toBe(second.job.jobId);
    expect(replay.job.status).toBe('succeeded');
    expect(resourceAttempts).toBe(2);
  }, 30_000);
});
