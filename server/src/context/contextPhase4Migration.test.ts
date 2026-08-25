import { describe, expect, it, vi } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';
import { buildContextPhase4MigrationSql, tableNames } from './phase4/migration.js';

describe('Context Plane Phase 4 governance migration', () => {
  it('adds a tenant-first durable candidate table while keeping v25 links compatible', () => {
    const statements = buildContextPhase4MigrationSql('test');
    const sql = statements.join('\n');
    const names = tableNames('test');

    expect(names.relationCandidates).toBe('test_context_relation_candidates');
    expect(names.entityLinks).toBe('test_context_entity_links');
    for (const column of [
      'from_entity_id TEXT', 'to_entity_id TEXT', 'relation_class TEXT', 'authority TEXT',
      'review_status TEXT', 'evidence_id TEXT', 'valid_from TIMESTAMPTZ',
      'valid_to TIMESTAMPTZ', 'lifecycle TEXT',
    ]) {
      expect(sql).toContain(`ALTER TABLE test_context_entity_links ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_context_relation_candidates');
    expect(sql).toContain('PRIMARY KEY (tenant_id, relation_id)');
    expect(sql).toContain("resolution_status IN ('pending','materialized')");
    expect(sql).toContain("relation_type IN ('same_as','project_of','task_of','meeting_of','mentions','event_of')");
    expect(sql).toContain("relation_class IN ('explicit','cooccurrence','inferred')");
    expect(sql).toContain("authority IN ('informational','advisory','authoritative')");
    expect(sql).toContain("relation_class <> 'inferred' OR review_status = 'proposed'");
    expect(sql).toContain('relation_class IS NULL OR ('); // v25 links remain valid without backfill
    expect(sql).toContain('REFERENCES test_context_evidence(tenant_id,source_id,collection_id,record_id,revision,evidence_id)');
    expect(sql).toContain("lifecycle IN ('active','superseded','revoked','deleted')");
    expect(sql).toContain('valid_to IS NULL OR valid_to >= valid_from');
    expect(sql.match(/DO \$context_phase4\$/g)).toHaveLength(2);
    expect(sql).toContain("conname='test_c26_links_contract_ck' AND conrelid=to_regclass('test_context_entity_links')");
    expect(sql).toContain("conname='test_c26_links_evidence_fk' AND conrelid=to_regclass('test_context_entity_links')");

    const candidateIndexes = statements.filter(value => value.includes('ON test_context_relation_candidates (tenant_id,'));
    expect(candidateIndexes).toHaveLength(4);
    expect(candidateIndexes.some(value => value.includes('resolution_status'))).toBe(true);
    expect(candidateIndexes.some(value => value.includes('from_entity_id'))).toBe(true);
    expect(candidateIndexes.some(value => value.includes('to_entity_id'))).toBe(true);
    for (const statement of statements.filter(value => value.startsWith('CREATE INDEX'))) {
      expect(statement).toContain('CREATE INDEX IF NOT EXISTS');
      expect(statement).toMatch(/ON test_context_(?:entity_links|relation_candidates) \(tenant_id,/);
    }
    expect(sql).not.toMatch(/UPDATE\s+test_context_/i);
    expect(sql).not.toMatch(/DROP\s+/i);
    expect(sql).not.toMatch(/\bvector\b|graph/i);
  });

  it('registers v26 after v25 in the official monotonic ledger', async () => {
    const insertedVersions: number[] = [];
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('SELECT version FROM test_governance_schema_versions')) return { rows: [], rowCount: 0 };
      if (sql === 'INSERT INTO test_governance_schema_versions (version) VALUES ($1)') {
        insertedVersions.push(Number(params?.[0]));
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const runner = new PgGovernanceMigrationRunner({ connect: vi.fn(async () => client) } as never, 'test');

    await runner.run();

    expect(insertedVersions).toEqual(expect.arrayContaining([25, 26, 27]));
    expect(insertedVersions).toEqual([...insertedVersions].sort((a, b) => a - b));
    expect(new Set(insertedVersions).size).toBe(insertedVersions.length);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('test_context_relation_candidates'))).toBe(true);
  });
});
