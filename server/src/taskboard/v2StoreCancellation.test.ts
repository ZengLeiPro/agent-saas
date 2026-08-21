import { describe, expect, it, vi } from 'vitest';

import { cancelIntegrationTask } from './v2Store.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };

function taskRow(status: string) {
  return {
    id: 'integration-1', board_id: 'board-1', identifier: 'INT-1', kind: 'integration',
    title: 'Integration', description: '', attachments: [], status, priority: 'none', labels: [],
    sort_order: 1, stage_models: {}, version: status === 'canceled' ? 2 : 1, workflow_version: 3,
    workflow_epoch: status === 'canceled' ? 2 : 1, next_action: 'none', next_action_revision: 1,
    created_at: new Date('2026-08-21T00:00:00.000Z'), updated_at: new Date('2026-08-21T00:00:00.000Z'),
    comment_count: 0,
  };
}

describe('Workflow v3 integration cancellation convergence', () => {
  it('clears a requested worker checkpoint and lease so canceled cleanup can be claimed', async () => {
    const loaded = {
      ...taskRow('in_progress'), actual_board_id: 'board-1', board_owner_user_id: 'owner-1',
      board_name: 'Board', board_description: '', board_visibility: 'private', board_prompt: '',
      board_stage_prompts: {}, board_stage_models: {}, board_version: 1, board_role: 'owner',
      board_created_at: new Date(), board_updated_at: new Date(),
    };
    const candidate = {
      id: 'candidate-1', repository_id: 'repo-1', lane_epoch: 3, state: 'working',
      worker_status: 'processing', worker_checkpoint: { status: 'requested' }, worker_lease_id: 'stale-lease',
    };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loaded] };
      if (sql.includes('FROM executions') && sql.includes("status IN ('queued'")) return { rows: [] };
      if (sql.includes('SELECT * FROM integration_candidates')) return { rows: [candidate] };
      if (sql.includes('SELECT 1 FROM integration_provider_operations')) return { rows: [] };
      if (sql.includes('UPDATE integration_candidates')) return { rows: [{ id: candidate.id }] };
      if (sql.includes('FROM tasks t WHERE t.id=$1')) return { rows: [taskRow('canceled')] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const result = await cancelIntegrationTask({
      pool: { connect: vi.fn(async () => client) }, tasksTable: 'tasks', boardsTable: 'boards', membersTable: 'members',
      commentsTable: 'comments', changesTable: 'changes', executionsTable: 'executions', integrationSourcesTable: 'integration',
      remediationAttemptsTable: 'remediation', integrationLanesTable: 'lanes', mergeOperationsTable: 'merge_operations',
    } as never, identity, 'integration-1', { expectedVersion: 1, reason: 'operator canceled' });

    expect(result.status).toBe('canceled');
    const cancellationSql = String(query.mock.calls.find(([sql]) => String(sql).includes('UPDATE integration_candidates'))?.[0]);
    expect(cancellationSql).toContain("worker_status='idle'");
    expect(cancellationSql).toContain("worker_checkpoint='{}'::jsonb");
    expect(cancellationSql).toContain('worker_error=NULL');
    expect(cancellationSql).toContain('worker_lease_id=NULL');
    expect(cancellationSql).toContain('worker_lease_expires_at=NULL');
    expect(cancellationSql).toContain('worker_available_at=now()');
    const providerCancellationCall = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE integration_provider_operations_v3'));
    expect(String(providerCancellationCall?.[0])).toContain("state='failed'");
    expect(String(providerCancellationCall?.[0])).toContain("state='prepared'");
    expect(providerCancellationCall?.[1]).toEqual([
      candidate.id,
      'Candidate canceled before provider execution: operator canceled',
    ]);
    expect(String(query.mock.calls.at(-1)?.[0])).toBe('COMMIT');
  });
});
