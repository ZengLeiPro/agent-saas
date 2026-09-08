import { describe, expect, it } from 'vitest';

import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV46OrgGroupBindingGenerationStatements } from './v46OrgGroupBindingGenerationMigration.js';

describe('治理库 V46 钉钉账号身份分代迁移', () => {
  const sql = governanceV46OrgGroupBindingGenerationStatements('safe').join('\n');

  it('保留旧 writer 依赖的二列唯一约束并增加可归档分代字段', () => {
    expect(sql).toContain('logical_conversation_id');
    expect(sql).toContain('retired_at');
    expect(sql).not.toContain(
      'DROP CONSTRAINT IF EXISTS safe_org_agent_channel_bindings_account_id_conversation_id_key',
    );
    expect(sql).toContain('ON UPDATE CASCADE');
  });

  it('连续登记为 V46', () => {
    expect(
      governanceLatestMigrations('safe').find((item) => item.version === 46)?.statements,
    ).toEqual(governanceV46OrgGroupBindingGenerationStatements('safe'));
  });
});
