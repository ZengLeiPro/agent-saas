import { describe, expect, it } from 'vitest';

import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV46KyAppCapabilityObservationStatements } from './v46KyAppCapabilityObservationMigration.js';

describe('治理库 V46 业务系统用户能力观测迁移', () => {
  it('只扩张地登记逐用户 /me 结果，并随安装实例删除', () => {
    const statements = governanceV46KyAppCapabilityObservationStatements('test_governance');
    const sql = statements.join('\n');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS test_governance_ky_app_user_capability_observations',
    );
    expect(sql).toContain(
      "status IN ('ready','insufficient_scope','capacity_limited','unavailable')",
    );
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bALTER\s+COLUMN\b/iu);
    expect(
      governanceLatestMigrations('test_governance').find((item) => item.version === 46)?.statements,
    ).toEqual(statements);
  });
});
