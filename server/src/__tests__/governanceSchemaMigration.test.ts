import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';
import { governanceV22Statements } from '../data/governance-schema/v22Migration.js';
import { governanceV23Statements } from '../data/governance-schema/v23Migration.js';

describe('Governance schema migration SQL fixtures', () => {
  it('V22 在约束前确定性回填 V18 org_memory 的空名称与状态，且名称不引用正文', () => {
    const legacy = {
      tenantId: 'tenant-a',
      resourceId: 'memory-1',
      resourceName: null,
      resourceStatus: null,
      body: '不得进入展示名称的组织记忆正文',
    };
    const statements = governanceV22Statements({
      assignmentSets: 'safe_resource_assignment_sets',
      assignments: 'safe_resource_assignments',
    });
    const sql = statements.join('\n');
    const statusBackfill = statements.findIndex(statement => statement.includes("SET resource_status='enabled'"));
    const statusNotNull = statements.findIndex(statement => statement.includes('ALTER COLUMN resource_status SET NOT NULL'));
    const nameBackfill = statements.findIndex(statement => statement.includes("SET resource_name='Migrated org memory '"));
    const metadataConstraint = statements.findIndex(statement => statement.includes('ADD CONSTRAINT safe_resource_assignment_sets_org_memory_metadata_check'));

    expect(statusBackfill).toBeGreaterThanOrEqual(0);
    expect(statusBackfill).toBeLessThan(statusNotNull);
    expect(nameBackfill).toBeGreaterThanOrEqual(0);
    expect(nameBackfill).toBeLessThan(metadataConstraint);
    expect(sql).toContain("WHERE resource_status IS NULL");
    expect(sql).toContain("NULLIF(BTRIM(resource_name),'') IS NULL");
    expect(sql).toContain("MD5(tenant_id || ':' || resource_id)");
    expect(sql).not.toContain('body');
    expect(sql).not.toContain(legacy.body);

    const fixtureName = `Migrated org memory ${createHash('md5')
      .update(`${legacy.tenantId}:${legacy.resourceId}`)
      .digest('hex')
      .slice(0, 12)}`;
    expect(fixtureName).toMatch(/^Migrated org memory [0-9a-f]{12}$/);
    expect(fixtureName).not.toContain(legacy.resourceId);
  });

  it('V23-V27 ledger DDL 可从 V22 幂等升级，并保留 tenant-scoped 唯一键', async () => {
    const statements = governanceV23Statements({ credentialCommits: 'safe_credential_commits' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS safe_credential_commits');
    expect(statements[0]).toContain('PRIMARY KEY (tenant_id,operation,idempotency_key)');
    expect(statements[0]).toContain('UNIQUE (tenant_id,operation,nonce_digest)');

    const applied = new Set(Array.from({ length: 22 }, (_, index) => index + 1));
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const query = async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT version FROM')) {
        return { rows: [...applied].map(version => ({ version })), rowCount: applied.size };
      }
      if (sql.includes('INSERT INTO safe_governance_schema_versions')) {
        applied.add(Number(params?.[0]));
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = { connect: async () => ({ query, release: () => undefined }) };
    const runner = new PgGovernanceMigrationRunner(pool as never, 'safe');

    await runner.run();
    await runner.run();

    expect(applied.has(23)).toBe(true);
    expect(applied.has(24)).toBe(true);
    expect(applied.has(25)).toBe(true);
    expect(applied.has(26)).toBe(true);
    expect(applied.has(27)).toBe(true);
    expect(queries.filter(item => item.sql === 'BEGIN')).toHaveLength(5);
    expect(queries.filter(item => item.sql.includes('CREATE TABLE IF NOT EXISTS safe_credential_commits'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('CREATE TABLE IF NOT EXISTS safe_context_sources'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('CREATE TABLE IF NOT EXISTS safe_context_entities'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('safe_c26_links_contract_ck'))).toHaveLength(1);
    expect(queries.filter(item => item.sql.includes('INSERT INTO safe_governance_schema_versions')))
      .toEqual([
        expect.objectContaining({ params: [23] }),
        expect.objectContaining({ params: [24] }),
        expect.objectContaining({ params: [25] }),
        expect.objectContaining({ params: [26] }),
        expect.objectContaining({ params: [27] }),
      ]);
    expect(() => new PgGovernanceMigrationRunner(pool as never, 'unsafe-prefix')).toThrow('Invalid PostgreSQL identifier');
  });
});
