import { describe, expect, it, vi } from 'vitest';

import { claimIntegrationDispatchCandidates } from './integrationTriggers.js';

const now = '2026-08-25T09:00:00.000Z';

function integrationRow(id: string, status: 'in_progress' | 'in_review' | 'ready_to_merge') {
  return {
    id, board_id: 'board-1', identifier: id, kind: 'integration', workflow_version: 3,
    title: id, description: '', attachments: [], status, priority: 'none', labels: [], sort_order: 0,
    version: 1, created_at: now, updated_at: now, tenant_id: 'tenant-1', owner_user_id: 'owner-1',
    comment_count: 0,
  };
}

function hostWithRows(rows: Record<string, unknown>[]) {
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('WITH candidates AS')) {
        rows.forEach((row) => { if (Number(row.workflow_version ?? 2) === 2) row.workflow_version = 3; });
      }
      if (sql.includes('SELECT t.*, b.tenant_id')) return { rows };
      return { rows: [] };
    }),
  };
  const poolQuery = vi.fn(async () => ({ rows: [] }));
  return {
    host: {
      pool: { connect: vi.fn(async () => client), query: poolQuery },
      boardsTable: 'boards', tasksTable: 'tasks', commentsTable: 'comments', executionsTable: 'executions',
      membersTable: 'members', changesTable: 'changes', integrationLanesTable: 'lanes',
      integrationSourcesTable: 'sources', mergeAuthorizationsTable: 'authorizations',
      mergeOperationsTable: 'merge_operations', blockEpisodesTable: 'blocks',
      integrationTriggerOutboxTable: 'trigger_outbox', remediationAttemptsTable: 'remediation_attempts',
      cancellationOutboxTable: 'cancellations',
    },
    client,
  };
}

describe('claimIntegrationDispatchCandidates Agent-first routing', () => {
  it('dispatches work, re-dispatched review, and approved merge as separate controlled executions', async () => {
    const { host, client } = hostWithRows([
      integrationRow('work-task', 'in_progress'),
      integrationRow('review-task', 'in_review'),
      integrationRow('merge-task', 'ready_to_merge'),
    ]);

    await expect(claimIntegrationDispatchCandidates(
      host as unknown as Parameters<typeof claimIntegrationDispatchCandidates>[0],
      10,
    )).resolves.toMatchObject([
      { task: { id: 'work-task' }, purpose: 'work' },
      { task: { id: 'review-task' }, purpose: 'review' },
      { task: { id: 'merge-task' }, purpose: 'merge' },
    ]);
    const dispatchSql = client.query.mock.calls.map(([sql]) => String(sql))
      .find((sql) => sql.includes('SELECT t.*, b.tenant_id'))!;
    expect(dispatchSql).toContain("t.status IN ('todo','in_progress','in_review','ready_to_merge')");
    expect(dispatchSql).toContain("t.status='in_review' AND agent.status='reviewing'");
    expect(dispatchSql).toContain("agent.verdict='approved' AND agent.review_execution_id IS NOT NULL");
  });

  it('atomically migrates historical v2 integrations into the idempotent Agent rendezvous path', async () => {
    const legacy = { ...integrationRow('legacy-task', 'in_progress'), workflow_version: 2 };
    const { host, client } = hostWithRows([legacy]);

    await expect(claimIntegrationDispatchCandidates(
      host as unknown as Parameters<typeof claimIntegrationDispatchCandidates>[0],
      10,
    )).resolves.toMatchObject([{ task: { id: 'legacy-task', workflowVersion: 3 }, purpose: 'work' }]);

    const migrationSql = client.query.mock.calls.map(([sql]) => String(sql))
      .find((sql) => sql.includes('WITH candidates AS'))!;
    expect(migrationSql).toContain("SET workflow_version=3");
    expect(migrationSql).toContain('ON CONFLICT (integration_task_id) DO NOTHING');
    expect(migrationSql).toContain('UPDATE tasks task');
    const dispatchSql = client.query.mock.calls.map(([sql]) => String(sql))
      .find((sql) => sql.includes('SELECT t.*, b.tenant_id'))!;
    expect(dispatchSql).toContain("t.workflow_version=3");
    expect(dispatchSql).not.toContain("workflow_version,2)=2");
  });
});
