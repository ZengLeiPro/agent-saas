import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { governanceV44KyAppDeliveryStatements } from '../../data/governance-schema/v44KyAppDeliveryMigration.js';
import { PgKyAppDeliveryStore } from './store.js';

const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
const { Pool } = pg;

describePg('定制项目交付状态 PostgreSQL 合约', () => {
  const prefix = `ky_app_delivery_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgKyAppDeliveryStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    for (const statement of governanceV44KyAppDeliveryStatements(prefix))
      await pool.query(statement);
    store = new PgKyAppDeliveryStore(pool, prefix);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_ky_app_delivery_records CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_ky_app_onboard_executions CASCADE`);
    await pool.end();
  });

  it('跨实例恢复命中同一执行；参数变化拒绝；完成态与交付/离场/通知持久化', async () => {
    const identity = {
      tenantId: 'tenant-1',
      systemId: 'demo-erp',
      installationId: 'iid-demo',
      requestDigest: 'a'.repeat(64),
      request: { tenantId: 'tenant-1', diagnostic: { readOnlyCapabilityId: 'order.search' } },
    };
    const first = await store.createOrResume(identity);
    const resumed = await store.createOrResume(identity);
    expect(first.created).toBe(true);
    expect(resumed.created).toBe(false);
    expect(resumed.execution.executionId).toBe(first.execution.executionId);
    await expect(
      store.createOrResume({ ...identity, requestDigest: 'b'.repeat(64) }),
    ).rejects.toThrow(/参数已变化/u);

    const completed = await store.update({
      executionId: first.execution.executionId,
      status: 'completed',
      currentStep: 'delivery_checklist',
      steps: [{ id: 'delivery_checklist', status: 'completed' }],
      result: { adminUserId: 'admin-1' },
    });
    expect(completed.completedAt).not.toBeNull();

    await store.upsertDelivery({
      installationId: identity.installationId,
      tenantId: identity.tenantId,
      systemId: identity.systemId,
      delivered: true,
      checklist: { diagnosticPassed: true },
    });
    expect(
      await store.setBalanceNotificationState({
        tenantId: identity.tenantId,
        kind: 'low',
        active: true,
      }),
    ).toBe(true);
    expect(
      await store.setBalanceNotificationState({
        tenantId: identity.tenantId,
        kind: 'low',
        active: true,
      }),
    ).toBe(false);
    const planned = await store.planOffboarding({
      installationId: identity.installationId,
      status: 'planned',
      plan: { reason: '合约结束', externalActions: ['客户书面确认'] },
    });
    expect(planned).toMatchObject({
      deliveredAt: expect.any(String),
      checklist: { diagnosticPassed: true },
      offboardingStatus: 'planned',
      lowBalanceNotifiedAt: expect.any(String),
    });
  }, 30_000);
});
