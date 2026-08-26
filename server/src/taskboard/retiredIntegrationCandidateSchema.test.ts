import { describe, expect, it, vi } from 'vitest';

import { retireIntegrationCandidateSchema } from './retiredIntegrationCandidateSchema.js';

describe('retireIntegrationCandidateSchema', () => {
  it('drops retired children before the Candidate aggregate without CASCADE', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    await retireIntegrationCandidateSchema('runtime_taskboard_integration_sources', { query } as never);
    const sql = String(query.mock.calls[0]?.[0]);
    const names = [
      'runtime_taskboard_integration_requests_outbox_v3',
      'runtime_taskboard_integration_provider_operations_v3',
      'runtime_taskboard_integration_candidate_source_snapshots',
      'runtime_taskboard_integration_candidate_revisions',
      'runtime_taskboard_integration_candidates',
      'runtime_taskboard_integration_activation_heartbeats_v3',
      'runtime_taskboard_integration_candidate_schema_migrations_v3',
    ];
    for (const name of names) expect(sql).toContain(`DROP TABLE IF EXISTS ${name};`);
    expect(names.map((name) => sql.indexOf(`DROP TABLE IF EXISTS ${name};`)))
      .toEqual([...names.keys()].map((index) => expect.any(Number)));
    expect(sql.indexOf(names[0]!)).toBeLessThan(sql.indexOf(names[4]!));
    expect(sql.indexOf(names[2]!)).toBeLessThan(sql.indexOf(names[4]!));
    expect(sql).not.toContain('CASCADE');
  });
});
