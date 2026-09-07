import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { governanceV41KyAppSystemStatements } from '../../data/governance-schema/v41KyAppSystemMigration.js';
import { governanceV44KyAppDeliveryStatements } from '../../data/governance-schema/v44KyAppDeliveryMigration.js';
import { PgKyAppSystemStore } from '../systems/store.js';
import { PLATFORM_ADMIN } from '../__tests__/harness.js';
import { KyAppManagementQueries } from './managementQueries.js';
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('业务系统集合查询 PostgreSQL', () => {
  const prefix = `p0_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const store = new PgKyAppSystemStore({ pool, tablePrefix: prefix });
  const queries = new KyAppManagementQueries(pool, store, prefix, `${prefix}_usage`);
  beforeAll(async () => {
    await pool.query(
      `CREATE TABLE ${prefix}_resource_assignments (assignment_id TEXT PRIMARY KEY,resource_type TEXT NOT NULL,resource_id TEXT,assignee_type TEXT,effect TEXT)`,
    );
    await pool.query(`CREATE TABLE ${prefix}_usage (event_type TEXT,event_json JSONB,timestamp TIMESTAMPTZ)`);
    await pool.query(`INSERT INTO ${prefix}_usage VALUES ('tool_audit','{"installationId":"one"}','2026-09-07T01:00:00Z')`);
    for (const sql of [
      ...governanceV41KyAppSystemStatements(prefix),
      ...governanceV44KyAppDeliveryStatements(prefix),
    ])
      await pool.query(sql);
    const result = await store.registerVersion({
      systemId: 'demo',
      name: '演示',
      manifest: { contractVersion: 1, capabilities: [{ riskLevel: 'external_write' }] },
      actor: 'admin',
    });
    await store.publishVersion({
      systemId: 'demo',
      digest: result.version.digest,
      expectedVersion: result.definition.version,
      actor: 'admin',
    });
    const other = await store.registerVersion({
      systemId: 'demo-two',
      name: '演示二',
      manifest: { contractVersion: 1, capabilities: [] },
      actor: 'admin',
    });
    await store.publishVersion({
      systemId: 'demo-two',
      digest: other.version.digest,
      expectedVersion: other.definition.version,
      actor: 'admin',
    });
    for (const installationId of ['one', 'two', 'three'])
      await store.createInstallation({
        installationId,
        systemId: installationId === 'two' ? 'demo-two' : 'demo',
        tenantId: installationId === 'three' ? 'other' : 'target',
        baseUrl: 'https://demo.example',
        origin: 'https://demo.example',
        techContactUserId: 'tc',
        actor: 'admin',
      });
    await pool.query(
      `UPDATE ${store.installationsTable} SET updated_at='2026-09-07T00:00:00.123456Z'`,
    );
  });
  afterAll(async () => {
    const tables = await pool.query(
      'SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND starts_with(tablename,$1)',
      [prefix + '_'],
    );
    for (const row of tables.rows) await pool.query(`DROP TABLE "${row.tablename}" CASCADE`);
    await pool.end();
  });
  it('游标保留微秒，同一时间不会漏行，过滤组织', async () => {
    const first = await queries.installations({ tenantId: 'target', limit: 1 }, PLATFORM_ADMIN);
    expect(first.installations.map((item) => item.installationId)).toEqual(['one']);
    expect(first.installations[0]?.lastUsageAt).toBe('2026-09-07T01:00:00.000Z');
    const second = await queries.installations(
      { tenantId: 'target', limit: 1, cursor: first.nextCursor! },
      PLATFORM_ADMIN,
    );
    expect(second.installations.map((item) => item.installationId)).toEqual(['two']);
    expect(second.nextCursor).toBeNull();
  });
  it('聚合安装数和风险，列表不返回 Manifest', async () => {
    const list = await queries.systemsList();
    expect(list[0]?.metrics).toMatchObject({
      installationCount: 2,
      externalWriteCapabilityCount: 1,
    });
    expect(list[0]).not.toHaveProperty('manifest');
    expect(await queries.installationSummary('one')).toMatchObject({ assignmentSummary: { configured: false, ruleCount: 0 }, credentialSummary: [], ready: false });
    expect((await queries.systemDetail('demo', 'admin'))?.versions).toHaveLength(1);
  });
});
