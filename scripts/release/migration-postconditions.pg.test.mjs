import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
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
