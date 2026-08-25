import { describe, expect, it, vi } from 'vitest';

import { migrateLegacyIntegrationSourceHeads } from './legacyIntegrationAgentMigration.js';

describe('migrateLegacyIntegrationSourceHeads', () => {
  it('copies only the frozen head from a legacy Candidate current-revision source snapshot', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('to_regclass')) return { rows: [{ snapshots_table: 'sources_candidate_source_snapshots' }] };
      return { rows: [], rowCount: 1 };
    });

    await migrateLegacyIntegrationSourceHeads(
      { integrationSourcesTable: 'sources', tasksTable: 'tasks' },
      { query } as never,
      'integration-1',
    );

    expect(query).toHaveBeenLastCalledWith(expect.stringContaining(
      'SET frozen_head_oid=snapshot.frozen_head_oid'), ['integration-1']);
    expect(query.mock.calls.at(-1)?.[0]).toContain('snapshot.revision=candidate.current_revision');
    expect(query.mock.calls.at(-1)?.[0]).toContain('s.frozen_head_oid IS NULL');
  });

  it('does not guess a head when the retired snapshot table is unavailable', async () => {
    const query = vi.fn(async () => ({ rows: [{ snapshots_table: null }] }));
    await migrateLegacyIntegrationSourceHeads(
      { integrationSourcesTable: 'sources', tasksTable: 'tasks' },
      { query } as never,
      'integration-1',
    );
    expect(query).toHaveBeenCalledOnce();
  });
});
