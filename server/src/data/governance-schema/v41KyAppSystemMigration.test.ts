import { describe, expect, it } from 'vitest';

import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV41KyAppSystemStatements } from './v41KyAppSystemMigration.js';

describe('治理库 V41 定制项目对接迁移', () => {
  it('创建九张 ky_app 表、状态与唯一约束，并把 system_installation 加进分配枚举', () => {
    const statements = governanceV41KyAppSystemStatements('test_governance');
    const sql = statements.join('\n');
    for (const table of [
      'test_governance_ky_app_system_definitions',
      'test_governance_ky_app_system_definition_versions',
      'test_governance_ky_app_tenant_system_installations',
      'test_governance_ky_app_signing_keys',
      'test_governance_ky_app_handshake_nonces',
      'test_governance_ky_app_outbound_events',
      'test_governance_ky_app_installation_runtime',
      'test_governance_ky_app_service_credentials',
      'test_governance_ky_app_installation_keys',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    // expand-only：建表建索引一律 IF NOT EXISTS，唯一的既有对象改动是分配枚举的 CHECK 重建。
    expect(
      statements.filter((statement) => /^CREATE (?:UNIQUE )?INDEX/u.test(statement)).length,
    ).toBeGreaterThan(0);
    for (const statement of statements) {
      if (statement.startsWith('CREATE')) expect(statement).toContain('IF NOT EXISTS');
    }
    expect(sql).toContain("status IN ('draft','published','disabled','retired')");
    expect(sql).toContain("status IN ('pending','enabled','disabled','deleted')");
    expect(sql).toContain("status IN ('active','next','retiring','revoked')");
    expect(sql).toContain("status IN ('pending','delivered','failed','abandoned')");
    expect(sql).toContain("status IN ('pending_ack','active','revoked','expired')");
    expect(sql).toContain("status IN ('current','previous','revoked')");
    expect(sql).toContain('UNIQUE (tenant_id,system_id)');
    expect(sql).toContain('UNIQUE (installation_id,type,state_version)');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS test_governance_ky_app_signing_keys_active_idx',
    );
    expect(sql).toContain(
      'ALTER TABLE test_governance_resource_assignments DROP CONSTRAINT IF EXISTS test_governance_resource_assignments_resource_type_check',
    );
    expect(sql).toContain(
      "resource_type IN ('org_agent','skill','credential','environment_template','org_knowledge','connector','org_memory','dws_delegation','system_installation')",
    );
  });

  it('登记为 V41 迁移', () => {
    const migrations = governanceLatestMigrations('test_governance');
    expect(migrations.find((migration) => migration.version === 41)?.statements).toEqual(
      governanceV41KyAppSystemStatements('test_governance'),
    );
  });
});
