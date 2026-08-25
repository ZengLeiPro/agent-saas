import { describe, expect, it, vi } from 'vitest';

import { PgGovernanceMigrationRunner } from '../data/governance-schema/migrations.js';
import { buildContextPhase23MigrationSql, tableNames } from './phase23/migration.js';

describe('Context Plane Phase 2/3 governance migration', () => {
  it('builds the additive relational v25 schema with tenant-first keys and locators', () => {
    const statements = buildContextPhase23MigrationSql('test');
    const sql = statements.join('\n');
    const names = tableNames('test');

    expect(names).toEqual({
      entityLinks: 'test_context_entity_links',
      consumers: 'test_context_consumers',
      entities: 'test_context_entities',
      derivedItems: 'test_context_derived_items',
      itemEvidence: 'test_context_derived_item_evidence',
      reviews: 'test_context_derived_item_reviews',
      profileFacets: 'test_context_profile_facets',
      profileFacetEvidence: 'test_context_profile_facet_evidence',
      derivedOutbox: 'test_context_derived_outbox',
    });
    for (const name of Object.values(names)) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${name}`);
    }

    for (const table of ['test_context_source_records', 'test_context_record_revisions']) {
      for (const column of [
        'entity_type TEXT', 'record_kind TEXT', 'native_id TEXT', 'occurred_at TIMESTAMPTZ',
        'source_event_id TEXT', 'owner_principal TEXT', "acl_principals JSONB DEFAULT '[]'::jsonb",
      ]) {
        expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`);
      }
    }
    expect(sql).toContain("entity_type IN ('customer','project','person','meeting','task')");
    expect(sql).toContain("record_kind IN ('snapshot','event')");
    expect(sql).toContain("link_type IN ('same_as','project_of','task_of','meeting_of','mentions','event_of')");
    expect(sql).toContain("item_type IN ('Decision','Status','Task','Risk','Commitment')");
    expect(sql).toContain("derivation IN ('source','llm','user','steward')");
    expect(sql).toContain("review_status IN ('proposed','confirmed','rejected')");
    expect(sql).toContain("facet_type IN ('role','tasks','workflow','artifacts','knowhow')");

    for (const primaryKey of [
      'PRIMARY KEY (tenant_id, link_id)',
      'PRIMARY KEY (tenant_id, consumer_id)',
      'PRIMARY KEY (tenant_id, generation, entity_id)',
      'PRIMARY KEY (tenant_id, generation, item_id)',
      'PRIMARY KEY (tenant_id, generation, item_id, evidence_id)',
      'PRIMARY KEY (tenant_id, generation, item_id, review_id)',
      'PRIMARY KEY (tenant_id, generation, principal_id, facet_id)',
      'PRIMARY KEY (tenant_id, generation, principal_id, facet_id, evidence_id)',
      'PRIMARY KEY (tenant_id, seq)',
    ]) {
      expect(sql).toContain(primaryKey);
    }
    expect(sql).toContain(
      'FOREIGN KEY (tenant_id, from_source_id, from_collection_id, from_record_id, from_revision)',
    );
    expect(sql).toContain(
      'REFERENCES test_context_record_revisions(tenant_id, source_id, collection_id, record_id, revision)',
    );
    expect(sql).toContain('FOREIGN KEY (tenant_id, subject_generation, subject_entity_id)');
    expect(sql).toContain('REFERENCES test_context_entities(tenant_id, generation, entity_id)');
    expect(sql).toContain('FOREIGN KEY (tenant_id, generation, item_id)');

    const indexStatements = statements.filter(statement => statement.startsWith('CREATE INDEX'));
    expect(indexStatements.length).toBeGreaterThan(0);
    for (const statement of indexStatements) {
      expect(statement).toContain('CREATE INDEX IF NOT EXISTS');
      expect(statement).toMatch(/ON test_[a-z0-9_]+ \(tenant_id,/);
    }
    expect(statements.filter(statement => statement.startsWith('CREATE TABLE'))
      .every(statement => statement.startsWith('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(statements.filter(statement => statement.startsWith('ALTER TABLE'))
      .every(statement => statement.includes('ADD COLUMN IF NOT EXISTS'))).toBe(true);

    expect(sql).not.toMatch(/UPDATE\s+test_context_(source_records|record_revisions)/i);
    expect(sql).not.toMatch(/\bvector\b/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
  });

  it('registers v25 before the additive v26 migration in monotonically increasing governance versions', async () => {
    const insertedVersions: number[] = [];
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('SELECT version FROM test_governance_schema_versions')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'INSERT INTO test_governance_schema_versions (version) VALUES ($1)') {
        insertedVersions.push(Number(params?.[0]));
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const runner = new PgGovernanceMigrationRunner({ connect: vi.fn(async () => client) } as never, 'test');

    await runner.run();

    expect(insertedVersions).toEqual(expect.arrayContaining([25, 26, 27]));
    expect(insertedVersions).toEqual([...insertedVersions].sort((left, right) => left - right));
    expect(new Set(insertedVersions).size).toBe(insertedVersions.length);
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      'CREATE TABLE IF NOT EXISTS test_context_derived_items',
    ))).toBe(true);
  });
});
