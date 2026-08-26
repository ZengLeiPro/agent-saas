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
    query: vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('UPDATE tasks task') && sql.includes('SET workflow_version=3')) {
        rows.forEach((row) => { if (Number(row.workflow_version ?? 2) === 2) row.workflow_version = 3; });
      }
      if (sql.includes("SET status='in_progress'") && sql.includes("task.status IN ('in_review','ready_to_merge')")) {
        rows.forEach((row) => {
          if (row.status === 'in_review' || row.status === 'ready_to_merge') row.status = 'in_progress';
        });
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
  it('normalizes historical Review/Merge stages and dispatches every Integration through work', async () => {
    const { host, client } = hostWithRows([
      integrationRow('work-task', 'in_progress'),
      integrationRow('review-task', 'in_review'),
      integrationRow('merge-task', 'ready_to_merge'),
    ]);

    await expect(claimIntegrationDispatchCandidates(
      host as unknown as Parameters<typeof claimIntegrationDispatchCandidates>[0],
      10,
    )).resolves.toMatchObject([
      { task: { id: 'work-task', status: 'in_progress' }, purpose: 'work' },
      { task: { id: 'review-task', status: 'in_progress' }, purpose: 'work' },
      { task: { id: 'merge-task', status: 'in_progress' }, purpose: 'work' },
    ]);
    const queries = client.query.mock.calls.map(([sql]) => String(sql));
    expect(queries.some((sql) => sql.includes("task.status IN ('in_review','ready_to_merge')"))).toBe(true);
    const dispatchSql = queries.find((sql) => sql.includes('SELECT t.*, b.tenant_id'))!;
    expect(dispatchSql).toContain("t.status IN ('todo','in_progress')");
    expect(dispatchSql).toContain("agent.status='active'");
    expect(dispatchSql).not.toContain('agent.verdict');
    expect(dispatchSql).not.toContain('review_execution_id');
    expect(dispatchSql).not.toContain('JOIN lanes');
  });

  it('atomically migrates historical v2 integrations into the idempotent Agent rendezvous path', async () => {
    const legacy = { ...integrationRow('legacy-task', 'in_progress'), workflow_version: 2 };
    const { host, client } = hostWithRows([legacy]);

    await expect(claimIntegrationDispatchCandidates(
      host as unknown as Parameters<typeof claimIntegrationDispatchCandidates>[0],
      10,
    )).resolves.toMatchObject([{ task: { id: 'legacy-task', workflowVersion: 3 }, purpose: 'work' }]);

    const queries = client.query.mock.calls.map(([sql]) => String(sql));
    const rendezvousSql = queries.find((sql) => sql.includes('WITH candidates AS'))!;
    const migrationSql = queries.find((sql) => sql.includes('UPDATE tasks task') && sql.includes('SET workflow_version=3'))!;
    expect(rendezvousSql).toContain('ORDER BY t.updated_at,t.id');
    expect(rendezvousSql).toContain('LIMIT $1\n          FOR UPDATE OF t SKIP LOCKED');
    expect(client.query.mock.calls.find(([sql]) => String(sql).includes('WITH candidates AS'))?.[1]).toEqual([10]);
    expect(rendezvousSql).toContain('ON CONFLICT (integration_task_id) DO NOTHING');
    expect(migrationSql).toContain('SET workflow_version=3');
    expect(migrationSql).toContain('FROM candidates candidate');
    expect(client.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE tasks task') && String(sql).includes('SET workflow_version=3'))?.[1]).toEqual([10]);
    expect(migrationSql).toContain("agent.integration_branch='integration/' || task.id");
    const dispatchSql = client.query.mock.calls.map(([sql]) => String(sql))
      .find((sql) => sql.includes('SELECT t.*, b.tenant_id'))!;
    expect(dispatchSql).toContain("t.workflow_version=3");
    expect(dispatchSql).not.toContain("workflow_version,2)=2");
  });
});
