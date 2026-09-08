import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { readMigrationPostconditions } from './read-migration-postconditions.mjs';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';
const { Pool } = createRequire(new URL('../../server/package.json', import.meta.url))('pg');
const url = process.env.TEST_DATABASE_URL;

test(
  'D-03: PostgreSQL checks real column types, index readiness and backfill; readback cannot write',
  { skip: !url },
  async () => {
    const prefix = `audit_${process.pid}_${Date.now()}`;
    const pool = new Pool({ connectionString: url });
    const config = { runtimeEventStore: { connectionString: url, tablePrefix: prefix } };
    const manifest = {
      releaseId: 'rc-20260907-01',
      digest: 'sha256:' + 'a'.repeat(64),
      migrationPlan: { phase: 'expand', planDigest: 'sha256:' + 'b'.repeat(64) },
    };
    const check = async (sql) => {
      const postconditions = [
        {
          id: 'schema',
          configPath: 'runtimeEventStore',
          description: 'schema readback',
          sql,
          params: [],
        },
      ];
      Object.assign(manifest.migrationPlan, {
        postconditions,
        postconditionsDigest: digestBuffer(canonicalJson(postconditions)),
      });
      return readMigrationPostconditions({ manifest, config, environment: 'staging', Pool });
    };
    try {
      const column = `SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('${prefix}') AND attname='value' AND atttypid='integer'::regtype AND NOT attisdropped) AS ok`;
      await assert.rejects(check(column), /postcondition failed/);
      await pool.query(`CREATE TABLE ${prefix}(value text)`);
      await assert.rejects(check(column), /postcondition failed/);
      await pool.query(
        `ALTER TABLE ${prefix} ALTER COLUMN value TYPE integer USING value::integer`,
      );
      assert.equal((await check(column)).status, 'passed');
      const index = `SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('${prefix}_idx') AND indisvalid AND indisready) AS ok`;
      await assert.rejects(check(index), /postcondition failed/);
      await pool.query(`CREATE INDEX ${prefix}_idx ON ${prefix}(value)`);
      assert.equal((await check(index)).status, 'passed');
      await pool.query(`INSERT INTO ${prefix} VALUES (NULL)`);
      const backfill = `SELECT NOT EXISTS(SELECT 1 FROM ${prefix} WHERE value IS NULL) AS ok`;
      await assert.rejects(check(backfill), /postcondition failed/);
      await pool.query(`UPDATE ${prefix} SET value=1`);
      assert.equal((await check(backfill)).status, 'passed');
      await assert.rejects(
        check(
          `WITH changed AS (UPDATE ${prefix} SET value=2 RETURNING *) SELECT true AS ok FROM changed`,
        ),
        /read-only/,
      );
      assert.equal((await pool.query(`SELECT value FROM ${prefix}`)).rows[0].value, 1);
      await assert.rejects(check('SELECT true AS ok; SELECT true AS ok'), /multiple commands/);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${prefix}`);
      await pool.end();
    }
  },
);

test('catalog rejects incomplete existing quota schemas that cannot execute the actual write contract', { skip: !url }, async () => {
  const prefix = `qa_${process.pid}_${Date.now().toString(36)}`;
  const snapshots = `${prefix}_provider_quota_snapshots`;
  const edits = `${prefix}_provider_plan_expiry_edits`;
  const pool = new Pool({ connectionString: url });
  const catalog = JSON.parse(await readFile(new URL('../../config/release-migration-postconditions.json', import.meta.url), 'utf8'));
  const quotaEntries = catalog.entries.filter(
    (entry) => entry.path === 'server/src/quota/providerQuotaSnapshotStore.ts',
  );
  assert.ok(quotaEntries.length > 0);
  const postconditions = quotaEntries[0].checks;
  for (const entry of quotaEntries) assert.deepEqual(entry.checks, postconditions);
  const manifest = { releaseId: 'rc-20260908-01', digest: `sha256:${'a'.repeat(64)}`, migrationPlan: { phase: 'expand', planDigest: `sha256:${'b'.repeat(64)}`, postconditions, postconditionsDigest: digestBuffer(canonicalJson(postconditions)) } };
  const readback = () => readMigrationPostconditions({ manifest, config: { runtimeEventStore: { connectionString: url, tablePrefix: prefix } }, environment: 'staging', Pool });
  try {
    await pool.query(`CREATE TABLE ${snapshots} (id BIGSERIAL PRIMARY KEY, account_key TEXT NOT NULL, source_kind TEXT NOT NULL, collected_at TIMESTAMPTZ NOT NULL, ok BOOLEAN NOT NULL, snapshot JSONB NOT NULL);
      CREATE INDEX ${snapshots}_account_time_idx ON ${snapshots} (account_key,collected_at DESC);
      CREATE TABLE ${edits} (id BIGSERIAL PRIMARY KEY,identity_key TEXT NOT NULL,end_time TIMESTAMPTZ,updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX ${edits}_identity_idx ON ${edits} (identity_key,id DESC)`);
    assert.equal((await readback()).status, 'passed');
    const cases = [
      [`ALTER TABLE ${edits} ALTER COLUMN id DROP DEFAULT`, `ALTER TABLE ${edits} ALTER COLUMN id SET DEFAULT nextval('${edits}_id_seq')`],
      [`ALTER TABLE ${edits} ALTER COLUMN updated_at DROP DEFAULT`, `ALTER TABLE ${edits} ALTER COLUMN updated_at SET DEFAULT now()`],
      [`ALTER TABLE ${edits} DROP CONSTRAINT ${edits}_pkey`, `ALTER TABLE ${edits} ADD PRIMARY KEY (id)`],
      [`ALTER TABLE ${edits} ALTER COLUMN updated_by DROP NOT NULL`, `ALTER TABLE ${edits} ALTER COLUMN updated_by SET NOT NULL`],
      [`DROP INDEX ${edits}_identity_idx; CREATE INDEX ${edits}_identity_idx ON ${edits} (id,identity_key DESC)`, `DROP INDEX ${edits}_identity_idx; CREATE INDEX ${edits}_identity_idx ON ${edits} (identity_key,id DESC)`],
      [`DROP INDEX ${edits}_identity_idx; CREATE INDEX ${edits}_identity_idx ON ${edits} (identity_key,id DESC) WHERE end_time IS NOT NULL`, `DROP INDEX ${edits}_identity_idx; CREATE INDEX ${edits}_identity_idx ON ${edits} (identity_key,id DESC)`],
      [`ALTER TABLE ${snapshots} DROP COLUMN snapshot`, `ALTER TABLE ${snapshots} ADD COLUMN snapshot JSONB NOT NULL`],
    ];
    for (const [damage, restore] of cases) {
      await pool.query(damage);
      await assert.rejects(readback(), /postcondition failed/, damage);
      if (damage.includes('id DROP DEFAULT')) {
        await assert.rejects(pool.query(`INSERT INTO ${edits} (identity_key,end_time,updated_by) VALUES ('test',NULL,'audit')`), { code: '23502' });
      }
      await pool.query(restore);
      assert.equal((await readback()).status, 'passed', restore);
    }
    const inserted = await pool.query(`INSERT INTO ${edits} (identity_key,end_time,updated_by) VALUES ('test',NULL,'audit') RETURNING id,updated_at`);
    assert.ok(inserted.rows[0].id);
    assert.ok(inserted.rows[0].updated_at);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${snapshots}, ${edits} CASCADE`);
    await pool.end();
  }
});
