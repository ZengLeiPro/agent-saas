import { describe, expect, it } from 'vitest';

import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV44KyAppDeliveryStatements } from './v44KyAppDeliveryMigration.js';

describe('治理库 V44 定制项目交付迁移', () => {
  const sql = governanceV44KyAppDeliveryStatements('test_governance').join('\n');

  it('登记耐久开箱、交付清单、离场与余额通知状态', () => {
    expect(sql).toContain('test_governance_ky_app_onboard_executions');
    expect(sql).toContain('UNIQUE (tenant_id, system_id, installation_id)');
    expect(sql).toContain('test_governance_ky_app_delivery_records');
    expect(sql).toContain('offboarding_status');
    expect(sql).toContain('low_balance_notified_at');
    expect(sql).toContain('exhausted_notified_at');
  });

  it('只扩张、不破坏，并固定登记为 V44', () => {
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bALTER\s+COLUMN\b/iu);
    expect(
      governanceLatestMigrations('test_governance').find((item) => item.version === 44)?.statements,
    ).toEqual(governanceV44KyAppDeliveryStatements('test_governance'));
  });
});
