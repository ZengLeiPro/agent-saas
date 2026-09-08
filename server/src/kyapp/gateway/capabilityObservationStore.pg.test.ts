import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { governanceV41KyAppSystemStatements } from '../../data/governance-schema/v41KyAppSystemMigration.js';
import { governanceV46KyAppCapabilityObservationStatements } from '../../data/governance-schema/v46KyAppCapabilityObservationMigration.js';
import { PgKyAppUserCapabilityObservationStore } from './capabilityObservationStore.js';

const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)('业务系统逐用户能力观测 PostgreSQL', () => {
  const prefix = `obs_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const store = new PgKyAppUserCapabilityObservationStore(pool, prefix);

  beforeAll(async () => {
    await pool.query(
      `CREATE TABLE ${prefix}_resource_assignments
       (resource_type TEXT NOT NULL CHECK (resource_type IN ('system_installation')))`,
    );
    for (const sql of [
      ...governanceV41KyAppSystemStatements(prefix),
      ...governanceV46KyAppCapabilityObservationStatements(prefix),
    ])
      await pool.query(sql);
    await pool.query(
      `INSERT INTO ${prefix}_ky_app_system_definitions
         (system_id,name,status,version,created_by,updated_by)
       VALUES ('erp','ERP','published',1,'fixture','fixture')`,
    );
    await pool.query(
      `INSERT INTO ${prefix}_ky_app_tenant_system_installations
         (installation_id,tenant_id,system_id,base_url,origin,tech_contact_user_id,
          status,state_version,created_by,updated_by)
       VALUES ('install-1','tenant-a','erp','https://api.example.com','https://app.example.com',
         'u1','enabled',1,'fixture','fixture')`,
    );
  });

  afterAll(async () => {
    const tables = await pool.query(
      'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND starts_with(tablename,$1)',
      [`${prefix}_`],
    );
    for (const row of tables.rows) await pool.query(`DROP TABLE "${row.tablename}" CASCADE`);
    await pool.end();
  });

  it('按用户和实例幂等更新最新 /me 结果', async () => {
    const base = {
      tenantId: 'tenant-a',
      installationId: 'install-1',
      userId: 'u1',
      registeredDigest: 'a'.repeat(64),
    };
    await store.record({
      ...base,
      status: 'unavailable',
      enabledCapabilityCount: 0,
    });
    await store.record({
      ...base,
      status: 'ready',
      enabledCapabilityCount: 2,
    });

    expect(await store.get('tenant-a', 'install-1', 'u1')).toMatchObject({
      ...base,
      status: 'ready',
      enabledCapabilityCount: 2,
      checkedAt: expect.any(String),
    });
    expect(await store.listForInstallation('tenant-a', 'install-1')).toHaveLength(1);
  });
});
