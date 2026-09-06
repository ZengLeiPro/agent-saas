import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { manifestDigest } from '@kaiyan/ky-app-contract';

import { governanceV41KyAppSystemStatements } from '../../data/governance-schema/v41KyAppSystemMigration.js';
import { PgKyAppSystemStore } from './store.js';
import { KyAppSystemConflictError } from './types.js';

const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
const { Pool } = pg;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    systemId: 'demo-erp',
    name: '演示 ERP',
    roles: { adminRole: 'admin' },
    pathPrefixes: { user: ['/api/app/'], admin: ['/api/admin/'] },
    capabilities: [],
    ...overrides,
  };
}

describePg('定制项目系统目录三表 PostgreSQL 合约', () => {
  const prefix = `ky_app_sys_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgKyAppSystemStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    // v41 依赖 resource_assignments 的 CHECK 重建，测试前缀下先建一张最小的同名表。
    await pool.query(`CREATE TABLE IF NOT EXISTS ${prefix}_resource_assignments (
      assignment_id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL
    )`);
    for (const statement of governanceV41KyAppSystemStatements(prefix)) await pool.query(statement);
    store = new PgKyAppSystemStore({ pool, tablePrefix: prefix });
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    for (const table of [
      `${prefix}_ky_app_tenant_system_installations`,
      `${prefix}_ky_app_system_definition_versions`,
      `${prefix}_ky_app_system_definitions`,
      `${prefix}_ky_app_signing_keys`,
      `${prefix}_ky_app_handshake_nonces`,
      `${prefix}_ky_app_outbound_events`,
      `${prefix}_ky_app_installation_runtime`,
      `${prefix}_ky_app_service_credentials`,
      `${prefix}_ky_app_installation_keys`,
      `${prefix}_resource_assignments`,
    ]) {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await pool.end();
  });

  it('同 digest 登记幂等、待复核不可发布、发布走乐观锁 CAS', async () => {
    const first = await store.registerVersion({
      systemId: 'demo-erp',
      name: '演示 ERP',
      manifest: manifest(),
      actor: 'admin-1',
    });
    expect(first.created).toBe(true);
    expect(first.version.digest).toBe(manifestDigest(manifest()));
    expect(first.definition.status).toBe('draft');

    const again = await store.registerVersion({
      systemId: 'demo-erp',
      name: '演示 ERP',
      manifest: manifest(),
      actor: 'admin-2',
    });
    expect(again.created).toBe(false);
    expect(again.version.createdBy).toBe('admin-1');

    const pending = await store.registerVersion({
      systemId: 'demo-erp',
      name: '演示 ERP',
      manifest: manifest({ name: '演示 ERP 二版' }),
      reviewStatus: 'pending',
      reviewReasons: ['riskLevel 降低'],
      actor: 'admin-1',
    });
    await expect(
      store.publishVersion({
        systemId: 'demo-erp',
        digest: pending.version.digest,
        expectedVersion: pending.definition.version,
        actor: 'admin-1',
      }),
    ).rejects.toBeInstanceOf(KyAppSystemConflictError);
    await expect(
      store.reviewVersion({
        systemId: 'demo-erp',
        digest: pending.version.digest,
        reviewer: 'admin-1',
      }),
    ).rejects.toThrow(/复核人/u);
    const reviewed = await store.reviewVersion({
      systemId: 'demo-erp',
      digest: pending.version.digest,
      reviewer: 'admin-2',
    });
    expect(reviewed.reviewStatus).toBe('approved');

    const definition = await store.getDefinition('demo-erp');
    const published = await store.publishVersion({
      systemId: 'demo-erp',
      digest: first.version.digest,
      expectedVersion: definition!.version,
      actor: 'admin-2',
    });
    expect(published.definition.status).toBe('published');
    expect(published.definition.publishedDigest).toBe(first.version.digest);
    await expect(
      store.publishVersion({
        systemId: 'demo-erp',
        digest: first.version.digest,
        expectedVersion: definition!.version,
        actor: 'admin-2',
      }),
    ).rejects.toBeInstanceOf(KyAppSystemConflictError);
  }, 30_000);

  it('安装实例 stateVersion 单调递增、非法跃迁被拒、registeredDigest CAS 需 ready 一致', async () => {
    const created = await store.createInstallation({
      installationId: 'tsi_01',
      tenantId: 't_demo',
      systemId: 'demo-erp',
      baseUrl: 'https://erp.example.com',
      origin: 'https://erp.example.com',
      techContactUserId: 'u_tech',
      actor: 'admin-1',
    });
    expect(created.stateVersion).toBe(1);
    expect(created.status).toBe('pending');

    const enabled = await store.updateInstallationStatus({
      installationId: 'tsi_01',
      status: 'enabled',
      actor: 'admin-1',
    });
    expect(enabled.stateVersion).toBe(2);
    // 幂等：同状态不推进 stateVersion。
    expect(
      (
        await store.updateInstallationStatus({
          installationId: 'tsi_01',
          status: 'enabled',
          actor: 'admin-1',
        })
      ).stateVersion,
    ).toBe(2);

    const digest = manifestDigest(manifest());
    await expect(
      store.setRegisteredDigest({
        installationId: 'tsi_01',
        digest,
        observedDigest: 'f'.repeat(64),
        expectedRegisteredDigest: null,
        actor: 'admin-1',
      }),
    ).rejects.toThrow(/manifestDigest/u);
    const registered = await store.setRegisteredDigest({
      installationId: 'tsi_01',
      digest,
      observedDigest: digest,
      expectedRegisteredDigest: null,
      actor: 'admin-1',
    });
    expect(registered.registeredDigest).toBe(digest);
    await expect(
      store.setRegisteredDigest({
        installationId: 'tsi_01',
        digest,
        observedDigest: digest,
        expectedRegisteredDigest: null,
        actor: 'admin-1',
      }),
    ).rejects.toThrow(/CAS/u);

    const deleted = await store.updateInstallationStatus({
      installationId: 'tsi_01',
      status: 'deleted',
      actor: 'admin-1',
    });
    expect(deleted.stateVersion).toBe(3);
    await expect(
      store.updateInstallationStatus({
        installationId: 'tsi_01',
        status: 'enabled',
        actor: 'admin-1',
      }),
    ).rejects.toThrow(/不能从 deleted/u);
    expect((await store.listInstallationsForTenant('t_demo')).length).toBe(0);
  }, 30_000);
});
