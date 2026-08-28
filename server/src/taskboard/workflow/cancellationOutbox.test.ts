import { describe, expect, it, vi } from 'vitest';

import {
  claimWorkflowCancellations,
  finishWorkflowCancellation,
  reconcileWorkflowCancellationTerminal,
} from './cancellationOutbox.js';

function host(query: ReturnType<typeof vi.fn>) {
  const client = { query, release: vi.fn() };
  return {
    cancellationOutboxTable: 'cancellations',
    tasksTable: 'tasks',
    executionsTable: 'executions',
    executionOutboxTable: 'execution_outbox',
    changesTable: 'changes',
    pool: { query },
    withTransaction: async <T>(operation: (transactionClient: typeof client) => Promise<T>) => operation(client),
  } as never;
}

const transitionRow = {
  outbox_status: 'processing',
  reason: 'execution_transitioned',
  run_id: 'run-1',
  execution_id: 'execution-1',
  task_id: 'task-1',
  execution_status: 'running',
  transitioned_at: new Date('2026-08-28T07:30:36.795Z'),
  terminal_reason_code: 'execution_transitioned',
};

function lockQuery(sql: string, row: Record<string, unknown>) {
  if (sql.includes('SELECT execution_id,task_id FROM cancellations')) {
    return { rows: [{ execution_id: 'execution-1', task_id: 'task-1' }] };
  }
  if (sql.includes('SELECT id FROM tasks')) return { rows: [{ id: 'task-1' }] };
  if (sql.includes('SELECT id FROM executions')) return { rows: [{ id: 'execution-1' }] };
  if (sql.includes('SELECT o.status AS outbox_status')) return { rows: [row] };
  return undefined;
}

describe('workflow transition cancellation outbox', () => {
  it('keeps a grace period before claiming a transitioned Runtime Run', async () => {
    const query = vi.fn(async () => ({ rows: [{
      id: 'cancel-1', run_id: 'run-1', reason: 'execution_transitioned',
    }] }));

    await expect(claimWorkflowCancellations(host(query), 20)).resolves.toEqual([{
      id: 'cancel-1', runId: 'run-1', reason: 'execution_transitioned',
    }]);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("reason<>$2 OR created_at <= now()"),
      [20, 'execution_transitioned', 30_000],
    );
  });

  it('marks the transitioned Execution succeeded only after Runtime cancellation completes', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      const locked = lockQuery(sql, transitionRow);
      if (locked) return locked;
      if (sql.includes('UPDATE executions')) return { rows: [{ id: 'execution-1' }] };
      return { rows: [] };
    });

    await finishWorkflowCancellation(host(query), 'cancel-1');

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const taskLock = statements.indexOf('SELECT id FROM tasks WHERE id=$1 FOR UPDATE');
    const executionLock = statements.indexOf('SELECT id FROM executions WHERE id=$1 FOR UPDATE');
    const outboxLock = statements.findIndex((sql) => sql.includes('FOR UPDATE OF o'));
    expect(taskLock).toBeLessThan(executionLock);
    expect(executionLock).toBeLessThan(outboxLock);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status='succeeded'"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("'execution.handoff_completed'"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status='completed'"))).toBe(true);
  });

  it('does not overwrite a later operator cancellation with handoff success', async () => {
    const operatorCancelled = {
      ...transitionRow,
      execution_status: 'cancelled',
      terminal_reason_code: 'operator_cancelled',
    };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      return lockQuery(sql, operatorCancelled) ?? { rows: [] };
    });

    await finishWorkflowCancellation(host(query), 'cancel-1');

    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status='succeeded'"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status='completed'"))).toBe(true);
  });

  it('absorbs a concurrent Runtime cancellation event as successful handoff', async () => {
    const runtimeCancelled = { ...transitionRow, execution_status: 'cancelled' };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      const locked = lockQuery(sql, runtimeCancelled);
      if (locked) return locked;
      if (sql.includes('UPDATE executions')) return { rows: [{ id: 'execution-1' }] };
      return { rows: [] };
    });

    await reconcileWorkflowCancellationTerminal(host(query), 'cancel-1', {
      runId: 'run-1', status: 'orphaned', reason: 'Runtime was stopped for handoff',
    });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status='succeeded'"))).toBe(true);
    const reconciliation = query.mock.calls.find(([sql]) => String(sql).includes("'execution.terminal_reconciled'"));
    expect(String(reconciliation?.[1]?.[3])).toContain('"executionStatus":"succeeded"');
  });
});
