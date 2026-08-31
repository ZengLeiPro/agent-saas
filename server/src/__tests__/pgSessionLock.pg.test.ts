import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgSessionLock } from '../runtime/pgSessionLock.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
if (!connectionString) {
  console.warn('[pgSessionLock.pg] SKIPPED: TEST_DATABASE_URL is not configured');
}

describePg('PgSessionLock rolling dual -> lease overlap', () => {
  const prefix = `pg_lock_roll_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 8 });
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_session_leases CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_tenant_session_leases CASCADE`);
    await pool.query(`DROP FUNCTION IF EXISTS ${prefix}_session_leases_guard_tenant_lease() CASCADE`);
    await pool.end();
  });

  it('keeps live dual ON CONFLICT compatible while lease remains tenant-native', async () => {
    const dual = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'dual', leaseMs: 10_000 });
    const lease = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'lease', leaseMs: 10_000 });
    await dual.init();
    await lease.init();

    // A dual worker whose process survived lease init still relies on ON CONFLICT(session_id).
    const secondDual = await dual.tryAcquire('tenant-a', 'rolling-session');
    expect(secondDual).not.toBeNull();
    expect(await lease.tryAcquire('tenant-a', 'rolling-session')).toBeNull();
    await secondDual!.release();

    const [tenantA, tenantB] = await Promise.all([
      lease.tryAcquire('tenant-a', 'tenant-native-session'),
      lease.tryAcquire('tenant-b', 'tenant-native-session'),
    ]);
    expect(tenantA).not.toBeNull();
    expect(tenantB).not.toBeNull();

    // The compatibility trigger prevents a surviving dual worker entering the same tenant/session.
    expect(await dual.tryAcquire('tenant-a', 'tenant-native-session')).toBeNull();
    await Promise.all([tenantA!.release(), tenantB!.release()]);
    await Promise.all([dual.close(), lease.close()]);
  });
});
