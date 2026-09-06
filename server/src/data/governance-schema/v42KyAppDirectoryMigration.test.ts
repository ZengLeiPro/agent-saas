import { describe, expect, it } from 'vitest';

import { governanceLatestMigrations } from './latestMigrations.js';
import { GOVERNANCE_SCHEMA_VERSION } from './migrations.js';
import { governanceV42KyAppDirectoryStatements } from './v42KyAppDirectoryMigration.js';

describe('治理库 V42 组织目录变更流迁移', () => {
  const sql = governanceV42KyAppDirectoryStatements('test_governance').join('\n');

  it('建变更日志表：全局单调 seq、事件类型枚举与 eventId 唯一', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_ky_app_directory_change_log');
    expect(sql).toContain('seq BIGSERIAL PRIMARY KEY');
    expect(sql).toContain('event_id TEXT NOT NULL UNIQUE');
    expect(sql).toContain("'user.upsert','user.remove','group.upsert','group.remove'");
    expect(sql).toContain("source IN ('governance','dingtalk')");
  });

  it('建投影态表与两类索引（续流游标 + 保留期清理）', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governance_ky_app_directory_state');
    expect(sql).toContain('PRIMARY KEY (tenant_id,entity_type,entity_id)');
    expect(sql).toContain("entity_type IN ('user','group')");
    expect(sql).toContain('test_governance_ky_app_directory_change_log_tenant_seq_idx');
    expect(sql).toContain('test_governance_ky_app_directory_change_log_retention_idx');
    expect(sql).toContain('test_governance_ky_app_directory_state_watermark_idx');
  });

  it('给成员表加 employee_no 列与索引，长度上限与附录 L 一致', () => {
    expect(sql).toContain(
      'ALTER TABLE test_governance_tenant_memberships ADD COLUMN IF NOT EXISTS employee_no TEXT',
    );
    expect(sql).toContain('char_length(employee_no) BETWEEN 1 AND 32');
    expect(sql).toContain('test_governance_tenant_memberships_employee_no_idx');
  });

  it('expand-only：不出现 DROP / TRUNCATE / SET NOT NULL / ALTER COLUMN TYPE', () => {
    expect(sql).not.toMatch(/\bDROP\b/iu);
    expect(sql).not.toMatch(/\bTRUNCATE\b/iu);
    expect(sql).not.toMatch(/\bSET\s+NOT\s+NULL\b/iu);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/iu);
    for (const statement of governanceV42KyAppDirectoryStatements('test_governance')) {
      if (statement.startsWith('CREATE TABLE')) expect(statement).toContain('IF NOT EXISTS');
      if (statement.startsWith('CREATE INDEX')) expect(statement).toContain('IF NOT EXISTS');
      if (statement.startsWith('ALTER TABLE'))
        expect(statement).toContain('ADD COLUMN IF NOT EXISTS');
    }
  });

  it('登记为 V42 迁移，且是当前最新版本', () => {
    const migrations = governanceLatestMigrations('test_governance');
    expect(migrations.find((migration) => migration.version === 42)?.statements).toEqual(
      governanceV42KyAppDirectoryStatements('test_governance'),
    );
    expect(GOVERNANCE_SCHEMA_VERSION).toBe(42);
    expect(Math.max(...migrations.map((migration) => migration.version))).toBe(42);
  });
});
