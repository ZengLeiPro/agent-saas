import { describe, expect, it, vi } from 'vitest';

import { PostgresIntegrationPushCapabilityHost } from './integrationPushCapabilityPostgres.js';

function host(query: ReturnType<typeof vi.fn>) {
  return new PostgresIntegrationPushCapabilityHost({
    pool: { query, connect: vi.fn() } as never,
    capabilitiesTable: 'push_capabilities', fencesTable: 'push_fences',
    boardsTable: 'boards', tasksTable: 'tasks', executionsTable: 'executions',
    candidatesTable: 'candidates', revisionsTable: 'revisions',
  });
}

describe('PostgresIntegrationPushCapabilityHost execution target resolution', () => {
  it('derives the candidate from the active integration work execution without a caller candidate selector', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    await host(query).resolveExecutionTarget({ tenantId: 'tenant-1', executionId: 'execution-1' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("t.kind='integration'"), [
      'execution-1', 'tenant-1',
    ]);
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("e.purpose='work'");
    expect(sql).toContain("e.status IN ('queued','running','waiting_user','waiting_approval')");
    expect(sql).toContain('c.id=e.candidate_id');
    expect(sql).not.toContain('AND c.id=$2');
  });

  it('keeps candidate binding for capability verification paths', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    await host(query).resolveTarget({
      tenantId: 'tenant-1', executionId: 'execution-1', candidateId: 'candidate-1',
    });
    expect(query.mock.calls[0]![1]).toEqual(['execution-1', 'candidate-1', 'tenant-1']);
    expect(String(query.mock.calls[0]![0])).toContain('AND c.id=$2');
    expect(String(query.mock.calls[0]![0])).toContain("e.purpose IN ('work','review')");
  });
});
