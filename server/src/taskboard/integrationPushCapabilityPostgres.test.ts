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
    expect(sql).toContain('r.base_oid');
    expect(sql).not.toContain('AND c.id=$2');
  });

  it('binds both the remote lease head and immutable revision base from authoritative rows', async () => {
    const query = vi.fn(async () => ({ rows: [{
      execution_id: 'execution-1', tenant_id: 'tenant-1', repository_id: 'github-id:123',
      integration_task_id: 'task-1', candidate_id: 'candidate-1', current_revision: 4,
      branch: 'integration/task-1', head_oid: 'a'.repeat(40), base_oid: 'b'.repeat(40),
      lane_epoch: 7, workflow_epoch: 9, owner_user_id: 'owner-1',
    }] }));
    const target = await host(query).resolveExecutionTarget({ tenantId: 'tenant-1', executionId: 'execution-1' });
    expect(target?.binding).toMatchObject({
      expectedOldOid: 'a'.repeat(40), expectedBaseOid: 'b'.repeat(40),
      exactRef: 'refs/heads/integration/task-1',
    });
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
