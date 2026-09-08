import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { PgToolDescriptionStore, ToolDescriptionConflictError } from './toolDescriptionStore.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const workerPool = new pg.Pool({ connectionString: databaseUrl });
  const prefix = `tool_test_${randomUUID().replaceAll('-', '')}`;
  cleanups.push(async () => {
    await pool.query(
      `DROP TABLE IF EXISTS ${prefix}_tool_description_audit, ${prefix}_tool_descriptions`,
    );
    await Promise.all([pool.end(), workerPool.end()]);
  });
  const store = new PgToolDescriptionStore(pool, prefix);
  const worker = new PgToolDescriptionStore(workerPool, prefix);
  await Promise.all([store.init(), worker.init()]);
  return { pool, prefix, store, worker };
}

describe.skipIf(!databaseUrl)('PG tool descriptions', () => {
  it('persists across independent readers/reinitialization and serializes concurrent writers with audit', async () => {
    const { pool, prefix, store, worker } = await fixture();
    const before = await store.get();
    const results = await Promise.allSettled([
      store.update('Shell', { mode: 'append', text: 'admin one' }, before.revision, 'admin-one'),
      worker.update('Read', { mode: 'append', text: 'admin two' }, before.revision, 'admin-two'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected && rejected.status === 'rejected' && rejected.reason).toBeInstanceOf(
      ToolDescriptionConflictError,
    );
    const saved = await store.get();
    expect(await worker.get()).toEqual(saved);
    const toolId = Object.keys(saved.overrides)[0];
    await worker.update(toolId, null, saved.revision, 'clear-admin');
    await store.init();
    expect((await store.get()).overrides[toolId]).toBeNull();
    const audit = await pool.query(
      `SELECT actor, next_override FROM ${prefix}_tool_description_audit ORDER BY created_at`,
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[1]).toEqual({ actor: 'clear-admin', next_override: null });
  });

  it('rolls back the description if audit persistence fails', async () => {
    const { pool, prefix, store, worker } = await fixture();
    const before = await store.get();
    await pool.query(
      `ALTER TABLE ${prefix}_tool_description_audit ADD CONSTRAINT fail_audit CHECK (actor <> 'reject')`,
    );
    await expect(
      store.update('Shell', { mode: 'append', text: 'must not commit' }, before.revision, 'reject'),
    ).rejects.toThrow();
    expect(await worker.get()).toEqual(before);
    expect((await pool.query(`SELECT * FROM ${prefix}_tool_description_audit`)).rows).toEqual([]);
  });
});
