import { describe, expect, it } from 'vitest';

import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV49PlatformDemoStatements } from './v49PlatformDemoMigration.js';

describe('治理库 V49 平台演示模式迁移', () => {
  const statements = governanceV49PlatformDemoStatements('safe');
  const sql = statements.join('\n');

  it('只创建 capability grants 与 demo_session 表及索引', () => {
    expect(sql).toContain('safe_membership_capability_grants');
    expect(sql).toContain('safe_platform_demo_sessions');
    expect(sql).toContain("CHECK (capability = 'platform_demo_access')");
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS safe_membership_capability_grants_tenant_active_idx');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS safe_platform_demo_sessions_expiry_idx');
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/iu);
  });

  it('连续登记为 V49 且为最新版本', () => {
    expect(governanceLatestMigrations('safe').find(({ version }) => version === 49)).toEqual({
      version: 49,
      statements: governanceV49PlatformDemoStatements('safe'),
    });
    expect(governanceLatestMigrations('safe').at(-1)?.version).toBe(49);
  });
});
