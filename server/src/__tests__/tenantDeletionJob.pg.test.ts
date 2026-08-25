import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgGovernanceChangeJobStore, TENANT_DELETE_DOMAINS } from '../data/changeJobs/index.js';
import {
  createDurableTenantDeletionExecutor,
  type TenantDeletionReport,
} from '../data/tenants/cleanup.js';
import { TenantStore } from '../data/tenants/store.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

async function waitForJob(
  jobs: PgGovernanceChangeJobStore,
  tenantId: string,
  jobId: string,
  status: 'succeeded' | 'retry_wait',
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await jobs.get(tenantId, jobId))?.status === status) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${jobId} to become ${status}`);
}

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
    await tenantStore.create({ id: 'remaining', name: 'Remaining', createdBy: 'test' });

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

  it('recovers an expired running PostgreSQL job when a new service instance starts', async () => {
    const jobs = new PgGovernanceChangeJobStore({ pool, tablePrefix: prefix });
    await jobs.init();
    const tenantStore = new TenantStore(join(tmpRoot, 'restart-tenants.json'));
    await tenantStore.create({ id: 'restart-acme', name: 'Restart Acme', createdBy: 'test' });
    await tenantStore.create({ id: 'restart-guard', name: 'Restart Guard', createdBy: 'test' });
    const created = await jobs.create({
      tenantId: 'restart-acme', jobType: 'tenant_delete', targetType: 'tenant', targetId: 'restart-acme',
      idempotencyKey: 'restart-delete-v1', request: { reasonCode: 'test' },
      domains: [...TENANT_DELETE_DOMAINS],
      createdBy: 'admin',
    });
    await jobs.claim('restart-acme', created.job.jobId, created.job.revision, 'dead-service');
    await new Promise(resolve => setTimeout(resolve, 30));

    const errors: unknown[] = [];
    const restarted = createDurableTenantDeletionExecutor({
      jobs,
      tenantStore,
      leaseMs: 10,
      pollIntervalMs: 10,
      governanceCleanup: { execute: async () => undefined } as never,
      deleteResources: async tenantId => ({ tenantId } as TenantDeletionReport),
      onJobError: error => errors.push(error),
    });
    restarted.start();
    await waitForJob(jobs, 'restart-acme', created.job.jobId, 'succeeded');
    await restarted.stop();

    expect(errors).toEqual([]);
    expect(tenantStore.findById('restart-acme')).toBeUndefined();
    expect((await jobs.get('restart-acme', created.job.jobId))?.attempt).toBe(2);
  }, 30_000);

  it('continuously consumes a retry when next_retry_at becomes due without another route call', async () => {
    const jobs = new PgGovernanceChangeJobStore({ pool, tablePrefix: prefix });
    await jobs.init();
    const tenantStore = new TenantStore(join(tmpRoot, 'retry-tenants.json'));
    await tenantStore.create({ id: 'retry-acme', name: 'Retry Acme', createdBy: 'test' });
    await tenantStore.create({ id: 'retry-guard', name: 'Retry Guard', createdBy: 'test' });
    let attempts = 0;
    const executor = createDurableTenantDeletionExecutor({
      jobs,
      tenantStore,
      retryDelayMs: 40,
      pollIntervalMs: 10,
      governanceCleanup: { execute: async () => undefined } as never,
      deleteResources: async tenantId => {
        attempts += 1;
        if (attempts === 1) throw new Error('RETRY_ONCE');
        return { tenantId } as TenantDeletionReport;
      },
    });

    const first = await executor.execute({
      tenantId: 'retry-acme', idempotencyKey: 'retry-delete-v1', requestedBy: 'admin', reasonCode: 'test',
    });
    expect(first.job.status).toBe('retry_wait');
    executor.start();
    await waitForJob(jobs, 'retry-acme', first.job.jobId, 'succeeded');
    await executor.stop();

    expect(attempts).toBe(2);
    expect(tenantStore.findById('retry-acme')).toBeUndefined();
  }, 30_000);
});
