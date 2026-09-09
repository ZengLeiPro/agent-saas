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
    await pool.query(
      `CREATE TABLE ${prefix}_usage (event_type TEXT,event_json JSONB,timestamp TIMESTAMPTZ)`,
    );
    await pool.query(
      `INSERT INTO ${prefix}_usage VALUES ('tool_audit','{"installationId":"one"}','2026-09-07T01:00:00Z')`,
    );
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
    await pool.query(
      `INSERT INTO ${store.definitionsTable}
         (system_id,name,status,version,created_by,updated_by)
       SELECT 'bulk-' || lpad(n::text,3,'0'),'批量系统 ' || n,'draft',1,'admin','admin'
       FROM generate_series(1,105) n`,
    );
    await pool.query(
      `INSERT INTO ${store.installationsTable}
         (installation_id,tenant_id,system_id,base_url,origin,tech_contact_user_id,
          status,state_version,created_by,updated_by,updated_at)
       SELECT 'bulk-install-' || lpad(n::text,3,'0'),'large',
         'bulk-' || lpad(n::text,3,'0'),'https://demo.example','https://demo.example',
         'tc','pending',1,'admin','admin','2026-09-07T00:00:00.123456Z'
       FROM generate_series(1,105) n`,
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
  it('登记人可直接发布历史待复核版本，退役系统不提供发布操作', async () => {
    const pending = await store.registerVersion({
      systemId: 'legacy-review',
      name: '历史版本',
      manifest: { capabilities: [] },
      actor: 'admin',
      reviewStatus: 'pending',
    });
    const detail = await queries.systemDetail('legacy-review', 'admin');
    expect(detail?.versions[0]?.allowedActions).toEqual(['publish_version']);
    expect(detail?.allowedActions).not.toContain('review_version');
    const published = await store.publishVersion({
      systemId: 'legacy-review',
      digest: pending.version.digest,
      expectedVersion: pending.definition.version,
      actor: 'admin',
    });
    await store.updateDefinitionStatus({
      systemId: 'legacy-review',
      status: 'retired',
      expectedVersion: published.definition.version,
      actor: 'admin',
    });
    expect(
      (await queries.systemDetail('legacy-review', 'admin'))?.versions[0]?.allowedActions,
    ).toEqual([]);
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
  it('超过 100 个接入记录可通过服务端游标完整翻页', async () => {
    const first = await queries.installations({ tenantId: 'large', limit: 60 }, PLATFORM_ADMIN);
    expect(first.installations).toHaveLength(60);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await queries.installations(
      { tenantId: 'large', limit: 60, cursor: first.nextCursor! },
      PLATFORM_ADMIN,
    );
    expect(second.installations).toHaveLength(45);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.installations, ...second.installations].map((item) => item.installationId))
        .size,
    ).toBe(105);
  });
  it('搜索和业务状态在服务端筛选，pending 属于需要处理', async () => {
    const result = await queries.installations(
      { tenantId: 'target', query: '演示二', businessStatus: 'action_required', limit: 10 },
      PLATFORM_ADMIN,
    );
    expect(result.installations.map((item) => item.installationId)).toEqual(['two']);
  });
  it('无事件表时异常筛选安全返回空集合', async () => {
    const withoutEvents = new KyAppManagementQueries(pool, store, prefix);
    expect(
      (await withoutEvents.installations({ signal: 'digest_mismatch', limit: 10 }, PLATFORM_ADMIN))
        .installations,
    ).toEqual([]);
  });
  it('聚合安装数和风险，列表不返回 Manifest', async () => {
    const list = await queries.systemsList();
    const demo = list.find((item) => item.systemId === 'demo');
    expect(demo?.metrics).toMatchObject({
      installationCount: 2,
      externalWriteCapabilityCount: 1,
    });
    expect(demo).not.toHaveProperty('manifest');
    expect(await queries.installationSummary('one')).toMatchObject({
      assignmentSummary: { configured: false, ruleCount: 0 },
      credentialSummary: [],
      ready: false,
    });
    expect((await queries.systemDetail('demo', 'admin'))?.versions).toHaveLength(1);
  });
});
