import { describe, expect, it, vi } from 'vitest';

import { claimContinuationReconcileCandidates } from './continuationOutbox.js';
import { markContinuationRunning } from './continuationStore.js';
import { claimExecutionReconcileCandidates } from './executionOutboxStore.js';

const tables = {
  boardsTable: 'boards', tasksTable: 'tasks', commentsTable: 'comments', changesTable: 'changes',
  executionsTable: 'executions', executionOutboxTable: 'execution_outbox',
  continuationOutboxTable: 'continuation_outbox', integrationSourcesTable: 'integration_sources',
  remediationAttemptsTable: 'remediation_attempts',
};

function expectLegacyAbsorptionSql(sql: string, outboxTable: string): void {
  expect(sql).toContain('WITH legacy_candidates AS');
  expect(sql).toContain("t.kind='integration' AND t.workflow_version<>3");
  expect(sql).toContain("SET status='failed'");
  expect(sql).toContain('reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL');
  expect(sql).toContain(`UPDATE ${outboxTable}`);
  expect(sql).toContain('last_error=\'Integration task requires Agent-first workflow migration\'');
  expect(sql).toContain("NOT (t.kind='integration' AND t.workflow_version<>3)");
}

describe('legacy integration reconcile guards', () => {
  it('execution claim uses one atomic statement and excludes absorbed rows', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    await expect(claimExecutionReconcileCandidates(
      { pool: { query }, ...tables } as never, new Date(0), 10, 'lease',
    )).resolves.toEqual([]);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expectLegacyAbsorptionSql(sql, 'execution_outbox');
    expect(sql).toContain("o.status='dispatched'");
    expect(sql).toContain("SET status='dispatched', lease_id=NULL, lease_expires_at=NULL");
  });

  it('continuation claim completes legacy outbox by task and excludes it from candidates', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    await expect(claimContinuationReconcileCandidates(
      { pool: { query }, ...tables } as never, new Date(0), 10, 'lease',
    )).resolves.toEqual([]);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expectLegacyAbsorptionSql(sql, 'continuation_outbox');
    expect(sql).toContain("SET status='completed', lease_id=NULL, lease_expires_at=NULL");
    expect(sql).toContain('e.task_id IN (SELECT task_id FROM legacy_outbox)');
  });

  it('mark running absorbs v2 before workflow facts or task writes', async () => {
    const statements: string[] = [];
    const taskRow = {
      id: 'task-v2', board_id: 'board-v2', identifier: 'TASK-2', title: 'legacy', description: '',
      kind: 'integration', workflow_version: 2, status: 'todo', priority: 'medium', labels: [],
      sort_order: 1024, comment_count: 1, version: 7,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      board_archived_at: null,
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT t.board_id, b.tenant_id')) {
          return { rows: [{ board_id: 'board-v2', tenant_id: 'tenant', owner_user_id: 'owner' }] };
        }
        if (sql.includes('SELECT t.*, b.archived_at')) return { rows: [taskRow] };
        if (sql.includes('FROM continuation_outbox') && sql.includes('FOR UPDATE')) {
          return { rows: [{ status: 'dispatched', reconcile_lease_valid: true }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    await expect(markContinuationRunning(
      { pool: { connect: vi.fn(async () => client) }, ...tables } as never,
      'task-v2', 'continuation-run',
    )).resolves.toMatchObject({ id: 'task-v2', status: 'todo', version: 7 });

    expect(statements.some((sql) => sql.includes("UPDATE executions\n        SET status='failed'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE continuation_outbox\n        SET status='completed'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('UPDATE tasks'))).toBe(false);
    expect(statements.some((sql) => sql.includes('FROM integration_sources'))).toBe(false);
    expect(statements.at(-1)).toBe('COMMIT');
  });
});
