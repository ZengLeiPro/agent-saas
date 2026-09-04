import { describe, expect, it, vi } from 'vitest';
import { disablePgRunStoreLegacyWriterCapability, type PgRunStoreSchemaTarget } from './runStoreSchema.js';

function createDrainHarness(activeCounts: number[], registryExists = true) {
  const sqlCalls: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    sqlCalls.push(normalized);
    if (normalized.includes('SELECT enabled FROM runtime_runs_writer_capabilities')) {
      return { rows: registryExists ? [{ enabled: false }] : [], rowCount: registryExists ? 1 : 0 };
    }
    if (normalized.startsWith("SELECT format('ALTER ROLE %I NOLOGIN'")) {
      return { rows: [{ sql: 'ALTER ROLE legacy_writer NOLOGIN' }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT COUNT(*)::int count FROM pg_stat_activity')) {
      return { rows: [{ count: activeCounts.shift() ?? 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release };
  const store: PgRunStoreSchemaTarget = {
    pool: { connect: vi.fn(async () => client) } as never,
    runsTable: 'runtime_runs',
    messageSubmissionsTable: 'runtime_message_submissions',
    steeringInputsTable: 'runtime_steering_inputs',
    steeringSessionsTable: 'runtime_steering_sessions',
  };
  return { store, sqlCalls, release };
}

describe('disablePgRunStoreLegacyWriterCapability', () => {
  it('commits NOLOGIN and disabled registry state before draining activity', async () => {
    const { store, sqlCalls, release } = createDrainHarness([0]);

    await disablePgRunStoreLegacyWriterCapability(store, 'legacy_writer');

    const position = (fragment: string) => sqlCalls.findIndex((sql) => sql.includes(fragment));
    expect(position('pg_advisory_lock')).toBeLessThan(position('BEGIN'));
    expect(position('BEGIN')).toBeLessThan(position('SELECT enabled FROM runtime_runs_writer_capabilities'));
    expect(position('SELECT enabled FROM runtime_runs_writer_capabilities')).toBeLessThan(position('ALTER ROLE legacy_writer NOLOGIN'));
    expect(position('ALTER ROLE legacy_writer NOLOGIN')).toBeLessThan(position('UPDATE runtime_runs_writer_capabilities'));
    expect(position('UPDATE runtime_runs_writer_capabilities')).toBeLessThan(position('COMMIT'));
    expect(position('COMMIT')).toBeLessThan(position('pg_terminate_backend'));
    expect(position('pg_terminate_backend')).toBeLessThan(position('SELECT COUNT(*)::int count'));
    expect(position('SELECT COUNT(*)::int count')).toBeLessThan(position('pg_advisory_unlock'));
    expect(sqlCalls.some((sql) => sql === 'ROLLBACK')).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps committed fail-safe state and permits retry after an incomplete drain', async () => {
    const { store, sqlCalls, release } = createDrainHarness([1, 0]);

    await expect(disablePgRunStoreLegacyWriterCapability(store, 'legacy_writer'))
      .rejects.toThrow('legacy writer drain could not terminate every session_user activity');
    await expect(disablePgRunStoreLegacyWriterCapability(store, 'legacy_writer')).resolves.toBeUndefined();

    expect(sqlCalls.filter((sql) => sql === 'COMMIT')).toHaveLength(2);
    expect(sqlCalls.filter((sql) => sql === 'ALTER ROLE legacy_writer NOLOGIN')).toHaveLength(2);
    expect(sqlCalls.filter((sql) => sql.includes('pg_terminate_backend'))).toHaveLength(2);
    expect(sqlCalls.filter((sql) => sql === 'ROLLBACK')).toHaveLength(0);
    expect(sqlCalls.filter((sql) => sql.includes('pg_advisory_unlock'))).toHaveLength(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('rolls back only a still-open first-phase transaction', async () => {
    const { store, sqlCalls, release } = createDrainHarness([], false);

    await expect(disablePgRunStoreLegacyWriterCapability(store, 'legacy_writer'))
      .rejects.toThrow('legacy writer capability was not registered');

    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls.some((sql) => sql === 'COMMIT')).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes('pg_terminate_backend'))).toBe(false);
    expect(sqlCalls.at(-1)).toContain('pg_advisory_unlock');
    expect(release).toHaveBeenCalledOnce();
  });
});
