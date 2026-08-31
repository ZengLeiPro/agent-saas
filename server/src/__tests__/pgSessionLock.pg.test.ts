import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { PgSessionLockHandle } from '../runtime/pgSessionLock.js';
import { PgSessionLock } from '../runtime/pgSessionLock.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
if (!connectionString) {
  console.warn('[pgSessionLock.pg] SKIPPED: TEST_DATABASE_URL is not configured');
}

describePg('PgSessionLock rolling dual -> lease overlap', () => {
  // Keep every derived identifier within PostgreSQL's 63-byte limit. Long explicit names and
  // PostgreSQL's suffix-preserving automatic constraint names truncate differently.
  const prefix = `plr_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      lock_timeout: 5_000,
      max: 8,
    });
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_session_leases CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${prefix}_tenant_session_leases CASCADE`);
      await pool.query(`DROP FUNCTION IF EXISTS ${prefix}_session_leases_guard_tenant_lease() CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it('does not let a failed lease contender break a live dual renewal', async () => {
    const warn = vi.fn();
    const onLost = vi.fn();
    const dual = new PgSessionLock({
      pool,
      tablePrefix: prefix,
      mode: 'dual',
      leaseMs: 10_000,
      renewIntervalMs: 1_000,
      logger: { warn },
    });
    const lease = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'lease', leaseMs: 10_000 });
    const handles: PgSessionLockHandle[] = [];
    const lockHolder = await pool.connect();
    let holderInTransaction = false;
    try {
      await dual.init();
      await lease.init();

      const dualHandle = await dual.tryAcquire('tenant-a', 'contended-session', { onLost });
      expect(dualHandle).not.toBeNull();
      if (dualHandle) handles.push(dualHandle);

      const initial = await pool.query<{ lease_expires_at: Date }>(`
        SELECT lease_expires_at FROM ${prefix}_session_leases
        WHERE tenant_id = $1 AND session_id = $2
      `, ['tenant-a', 'contended-session']);
      const initialExpiry = initial.rows[0]?.lease_expires_at.getTime() ?? 0;

      // Precisely pause a lease contender after taking the same transaction-scoped guard
      // used by tryAcquire. The dual timer renews while this lock is held.
      await lockHolder.query('BEGIN');
      holderInTransaction = true;
      await lockHolder.query(`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            length($1::text)::text || ':' || $1::text ||
            length($2::text)::text || ':' || $2::text,
            0
          )
        )
      `, ['tenant-a', 'contended-session']);

      // The same session in another tenant is guarded by a different key and stays parallel.
      const otherTenant = await lease.tryAcquire('tenant-b', 'contended-session');
      expect(otherTenant).not.toBeNull();
      if (otherTenant) handles.push(otherTenant);

      await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 4_000, interval: 50 });
      expect(onLost).not.toHaveBeenCalled();
      expect(await lease.tryAcquire('tenant-a', 'contended-session')).toBeNull();

      await lockHolder.query('COMMIT');
      holderInTransaction = false;

      // The contender did not take over. Once contention clears, the same dual owner renews.
      expect(await lease.tryAcquire('tenant-a', 'contended-session')).toBeNull();
      await vi.waitFor(async () => {
        const current = await pool.query<{ lease_expires_at: Date }>(`
          SELECT lease_expires_at FROM ${prefix}_session_leases
          WHERE tenant_id = $1 AND session_id = $2
        `, ['tenant-a', 'contended-session']);
        expect(current.rows[0]?.lease_expires_at.getTime()).toBeGreaterThan(initialExpiry);
      }, { timeout: 4_000, interval: 50 });
      expect(onLost).not.toHaveBeenCalled();

      await dualHandle?.release();
      const acquiredAfterRelease = await lease.tryAcquire('tenant-a', 'contended-session');
      expect(acquiredAfterRelease).not.toBeNull();
      if (acquiredAfterRelease) handles.push(acquiredAfterRelease);
    } finally {
      if (holderInTransaction) await lockHolder.query('ROLLBACK').catch(() => undefined);
      lockHolder.release();
      await Promise.allSettled(handles.map((handle) => handle.release()));
      await Promise.allSettled([dual.close(), lease.close()]);
    }
  }, 10_000);

  it('keeps live dual ON CONFLICT compatible while lease remains tenant-native', async () => {
    const dual = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'dual', leaseMs: 10_000 });
    const lease = new PgSessionLock({ pool, tablePrefix: prefix, mode: 'lease', leaseMs: 10_000 });
    const handles: PgSessionLockHandle[] = [];
    try {
      await dual.init();
      await lease.init();

      // A dual worker whose process survived lease init still relies on ON CONFLICT(session_id).
      const secondDual = await dual.tryAcquire('tenant-a', 'rolling-session');
      expect(secondDual).not.toBeNull();
      if (secondDual) handles.push(secondDual);
      expect(await lease.tryAcquire('tenant-a', 'rolling-session')).toBeNull();
      await secondDual?.release();

      const [tenantA, tenantB] = await Promise.all([
        lease.tryAcquire('tenant-a', 'tenant-native-session'),
        lease.tryAcquire('tenant-b', 'tenant-native-session'),
      ]);
      expect(tenantA).not.toBeNull();
      expect(tenantB).not.toBeNull();
      if (tenantA) handles.push(tenantA);
      if (tenantB) handles.push(tenantB);

      // The compatibility trigger prevents a surviving dual worker entering the same tenant/session.
      const blockedDual = await dual.tryAcquire('tenant-a', 'tenant-native-session');
      expect(blockedDual).toBeNull();
      if (blockedDual) handles.push(blockedDual);
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.release()));
      await Promise.allSettled([dual.close(), lease.close()]);
    }
  });
});
