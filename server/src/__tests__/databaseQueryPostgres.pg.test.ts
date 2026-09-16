import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseQueryExecutor } from '../databaseQuery/executor.js';
import {
  PgDatabaseConnectionStore,
  type DatabaseConnectionRecord,
} from '../data/databaseConnections/index.js';
import { InMemorySecretVault, tenantOwnerId } from '../security/secretVault.js';

const connectionString = process.env.EXTERNAL_DATABASE_TEST_PG_URL;
const describePg = connectionString ? describe : describe.skip;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const prefix = `extdb_${suffix}`;
const schema = `reporting_${suffix}`;
const role = `readonly_${suffix}`;
const password = `ReadOnly_${suffix}`;

describePg('external database read-only PostgreSQL integration', () => {
  const adminPool = new pg.Pool({ connectionString });
  const store = new PgDatabaseConnectionStore(adminPool, { tablePrefix: prefix });
  const vault = new InMemorySecretVault();
  let connection: DatabaseConnectionRecord;

  beforeAll(async () => {
    const target = new URL(connectionString!);
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    await adminPool.query(
      `CREATE TABLE "${schema}".orders (id INTEGER PRIMARY KEY, email TEXT, total INTEGER)`,
    );
    await adminPool.query(
      `INSERT INTO "${schema}".orders VALUES (1,'buyer@example.test',42),(2,'other@example.test',9)`,
    );
    await adminPool.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await adminPool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await adminPool.query(`GRANT SELECT ON "${schema}".orders TO "${role}"`);
    const ref = await vault.putSecret(
      tenantOwnerId('tenant-a'),
      'external_database_postgresql',
      JSON.stringify({ password }),
      {
        actor: 'connector_proxy',
        userId: 'admin',
        tenantId: 'tenant-a',
        scopes: ['secret:external_database_postgresql:write'],
      },
    );
    await store.init();
    const pending = await store.create({
      tenantId: 'tenant-a',
      name: 'PG reporting',
      engine: 'postgresql',
      host: target.hostname,
      port: Number(target.port || 5432),
      databaseName: target.pathname.slice(1),
      username: role,
      sslMode: 'disable',
      secretRef: ref.id,
      allowedSchemas: [schema],
      allowedTables: [`${schema}.orders`],
      sensitiveColumns: ['email'],
      actorUserId: 'admin',
    });
    connection = (await store.updateValidation({
      connectionId: pending.connectionId,
      tenantId: pending.tenantId,
      ok: true,
      actorUserId: 'admin',
    }))!;
  });

  afterAll(async () => {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.query(`DROP ROLE IF EXISTS "${role}"`);
    await adminPool.query(`DROP TABLE IF EXISTS "${store.tables.queryAudit}" CASCADE`);
    await adminPool.query(`DROP TABLE IF EXISTS "${store.tables.connections}" CASCADE`);
    await adminPool.end();
  });

  it('validates the restricted role and executes in a read-only transaction', async () => {
    const executor = new DatabaseQueryExecutor({ store, vault, maxRows: 10 });
    await expect(executor.testConnection(connection)).resolves.toBeUndefined();
    const result = await executor.execute({
      connection,
      sql: `SELECT id,email,total FROM "${schema}".orders ORDER BY id`,
    });
    expect(result.rows).toEqual([
      [1, '[REDACTED]', 42],
      [2, '[REDACTED]', 9],
    ]);
    await expect(
      executor.execute({
        connection,
        sql: `DELETE FROM "${schema}".orders`,
      }),
    ).rejects.toMatchObject({ code: 'database_query_rejected' });
    expect(
      (await adminPool.query(`SELECT count(*)::int AS count FROM "${schema}".orders`)).rows[0]
        .count,
    ).toBe(2);
  });

  it('passes the release postcondition bound to the new store and schema', async () => {
    const catalog = JSON.parse(
      await readFile(
        new URL('../../../config/release-migration-postconditions.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: Array<{ path: string; checks: Array<{ sql: string }> }> };
    for (const path of [
      'server/src/data/databaseConnections/store.ts',
      'server/src/data/databaseConnections/schema.ts',
    ]) {
      const check = catalog.entries.find((entry) => entry.path === path)?.checks[0];
      expect(check, `${path} postcondition`).toBeDefined();
      await expect(adminPool.query(check!.sql, [prefix])).resolves.toMatchObject({
        rows: [{ ok: true }],
      });
    }
  });

  it('persists only hashed query audit data', async () => {
    await store.recordQueryAudit({
      connectionId: connection.connectionId,
      tenantId: connection.tenantId,
      apiClientId: 'client-1',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      runId: 'run-1',
      sqlHash: 'a'.repeat(64),
      status: 'completed',
      durationMs: 2,
      rowCount: 2,
      resultBytes: 64,
      truncated: false,
    });
    const result = await adminPool.query(
      `SELECT sql_hash,error_code FROM "${store.tables.queryAudit}"`,
    );
    expect(result.rows).toEqual([{ sql_hash: 'a'.repeat(64), error_code: null }]);
  });
});
