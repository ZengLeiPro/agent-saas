import { describe, expect, it } from 'vitest';
import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV38SkillPresentationStatements } from './v38SkillPresentationMigration.js';

describe('治理库 V38 技能展示信息迁移', () => {
  it('创建展示信息表、作用域约束和查询索引', () => {
    const sql = governanceV38SkillPresentationStatements('test_governance').join('\n');
    expect(sql).toContain('test_governance_skill_presentations');
    expect(sql).toContain("resource_scope IN ('platform','tenant')");
    expect(sql).toContain(
      "resource_scope='tenant' AND resource_tenant_id<>'' AND audience_tenant_id=''",
    );
    expect(sql).toContain(
      'PRIMARY KEY (resource_scope,resource_tenant_id,skill_id,audience_tenant_id,locale)',
    );
    expect(sql).toContain('test_governance_skill_presentations_audience_idx');
  });

  it('登记为 V38 迁移', () => {
    const migrations = governanceLatestMigrations('test_governance');
    expect(migrations.find((migration) => migration.version === 38)?.statements).toEqual(
      governanceV38SkillPresentationStatements('test_governance'),
    );
  });
});
