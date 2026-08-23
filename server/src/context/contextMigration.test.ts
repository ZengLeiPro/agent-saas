import { describe, expect, it, vi } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/index.js';
import { buildContextMigrationSql, contextTableNames } from './store/index.js';

describe('Context Plane official migration registration', () => {
  it('does not create a parallel context schema_versions ledger', () => {
    const names = contextTableNames('test');
    expect(Object.keys(names)).not.toContain('versions');
    expect(buildContextMigrationSql('test').join('\n')).not.toContain('context_schema_versions');
  });

  it('runs Context schema as governance migration version 24', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT version FROM test_governance_schema_versions')) {
        return { rows: Array.from({ length: 23 }, (_, index) => ({ version: index + 1 })) };
      }
      return { rows: [], rowCount: params?.[0] === 24 ? 1 : 0 };
    });
    const client = { query, release: vi.fn() };
    const runner = new PgGovernanceMigrationRunner({ connect: vi.fn(async () => client) } as never, 'test');
    await runner.run();

    expect(query).toHaveBeenCalledWith(
      'INSERT INTO test_governance_schema_versions (version) VALUES ($1)',
      [24],
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes('CREATE TABLE IF NOT EXISTS test_context_sources'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('context_schema_versions'))).toBe(false);
  });
});
