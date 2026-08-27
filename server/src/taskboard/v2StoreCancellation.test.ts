import { describe, expect, it, vi } from 'vitest';

import { cancelIntegrationTask } from './v2Store.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };

function taskRow(status: string, workflowVersion = 3) {
  return {
    id: 'integration-1', board_id: 'board-1', identifier: 'INT-1', kind: 'integration',
    title: 'Integration', description: '', attachments: [], status, priority: 'none', labels: [],
    sort_order: 1, stage_models: {}, version: status === 'canceled' ? 2 : 1, workflow_version: workflowVersion,
    workflow_epoch: status === 'canceled' ? 2 : 1, next_action: 'none', next_action_revision: 1,
    created_at: new Date('2026-08-21T00:00:00.000Z'), updated_at: new Date('2026-08-21T00:00:00.000Z'),
    comment_count: 0,
  };
}

function loadedTask(status: string, workflowVersion = 3) {
  return {
    ...taskRow(status, workflowVersion), actual_board_id: 'board-1', board_owner_user_id: 'owner-1',
    board_name: 'Board', board_description: '', board_visibility: 'private', board_prompt: '',
    board_stage_prompts: {}, board_stage_models: {}, board_version: 1, board_role: 'owner',
    board_created_at: new Date(), board_updated_at: new Date(),
  };
}

function options(client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) {
  return {
    pool: { connect: vi.fn(async () => client) }, tasksTable: 'tasks', boardsTable: 'boards', membersTable: 'members',
    commentsTable: 'comments', changesTable: 'changes', executionsTable: 'executions', integrationSourcesTable: 'integration_sources',
    remediationAttemptsTable: 'remediation', integrationLanesTable: 'lanes', mergeAuthorizationsTable: 'merge_authorizations',
    mergeOperationsTable: 'merge_operations', cancellationOutboxTable: 'cancellation_outbox',
  } as never;
}

describe('integration cancellation convergence', () => {
  it('fences active Integration Agent executions through the cancellation outbox', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask('in_progress')] };
      if (sql.includes('FROM integration_agents') && sql.includes('FOR UPDATE')) {
        return { rows: [{ repository_id: 'repo-1', status: 'active', merge_receipt: null, merge_in_flight_execution_id: null }] };
      }
      if (sql.includes("UPDATE executions") && sql.includes("SET status='cancelled'")) {
        return { rows: [{ id: 'execution-1', run_id: 'run-1', task_id: 'integration-1', fence_epoch: 2 }], rowCount: 1 };
      }
      if (sql.includes('FROM tasks t WHERE t.id=$1')) return { rows: [taskRow('canceled')] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    await expect(cancelIntegrationTask(options(client), identity, 'integration-1', {
      expectedVersion: 1, reason: 'operator canceled',
    })).resolves.toMatchObject({ status: 'canceled' });

    const fenceCall = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE executions") && String(sql).includes("SET status='cancelled'"));
    expect(fenceCall?.[1]).toEqual([['integration-1'], null, 'integration_canceled']);
    const cancellationOutboxCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO cancellation_outbox'));
    expect(cancellationOutboxCall?.[1]).toEqual([
      expect.any(String), 'execution-1', 'run-1', 'integration-1', 'integration_canceled', 2,
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('SELECT 1 FROM executions'))).toBe(false);
  });

  it('cancels without relying on obsolete Provider merge-in-flight state', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask('in_progress')] };
      if (sql.includes('FROM integration_agents') && sql.includes('FOR UPDATE')) {
        return { rows: [{ repository_id: 'repo-1' }] };
      }
      if (sql.includes("UPDATE executions") && sql.includes("SET status='cancelled'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tasks t WHERE t.id=$1')) return { rows: [taskRow('canceled')] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    await expect(cancelIntegrationTask(options(client), identity, 'integration-1', { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: 'canceled' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE executions") && String(sql).includes("SET status='cancelled'"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('merge_in_flight_execution_id'))).toBe(false);
  });

  it('fences active workflow v2 executions through the cancellation outbox', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask('in_progress', 2)] };
      if (sql.includes('JOIN integration_sources') && sql.includes("state IN ('executing','unknown')")) return { rows: [] };
      if (sql.includes("UPDATE executions") && sql.includes("SET status='cancelled'")) {
        return { rows: [{ id: 'execution-2', run_id: 'run-2', task_id: 'integration-1', fence_epoch: 2 }], rowCount: 1 };
      }
      if (sql.includes('FROM tasks t WHERE t.id=$1')) return { rows: [taskRow('canceled', 2)] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    await expect(cancelIntegrationTask(options(client), identity, 'integration-1', { expectedVersion: 1 }))
      .resolves.toMatchObject({ status: 'canceled' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO cancellation_outbox'))).toBe(true);
  });

  it('returns an already canceled integration task without re-fencing executions', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('JOIN boards b') && sql.includes('FOR UPDATE OF t')) return { rows: [loadedTask('canceled')] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };

    const result = await cancelIntegrationTask(options(client), identity, 'integration-1', {
      expectedVersion: 1, reason: 'operator canceled',
    });
    expect(result).toMatchObject({ status: 'canceled', version: 2 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE executions") && String(sql).includes("SET status='cancelled'"))).toBe(false);
  });
});
