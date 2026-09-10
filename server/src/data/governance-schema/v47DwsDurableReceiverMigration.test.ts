import { describe, expect, it } from 'vitest';
import { governanceLatestMigrations } from './latestMigrations.js';
import { governanceV47DwsDurableReceiverStatements } from './v47DwsDurableReceiverMigration.js';

describe('治理库 V47 DWS 持久接收迁移', () => {
  const statements = governanceV47DwsDurableReceiverStatements('safe');
  const sql = statements.join('\n');

  it('只创建 reader-first 的 owner、原始 inbox、迁移账本与索引', () => {
    expect(sql).toContain('safe_dws_receiver_owners');
    expect(sql).toContain('safe_dws_receiver_inbox');
    expect(sql).toContain('safe_dws_receiver_migrations');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS safe_dws_receiver_inbox_pending_idx');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS safe_dws_receiver_migration_active_idx',
    );
    expect(
      statements.every(
        (statement) => !/^(?:ALTER|DROP|TRUNCATE|UPDATE|DELETE)\b/u.test(statement.trim()),
      ),
    ).toBe(true);
  });

  it('连续登记为 V47', () => {
    expect(governanceLatestMigrations('safe').at(-1)).toEqual({
      version: 47,
      statements: governanceV47DwsDurableReceiverStatements('safe'),
    });
  });
});
