import { describe, expect, it, vi } from 'vitest';

import { PgOrgGroupAgentStore } from './store.js';

const input = {
  tenantId: 'tenant-a',
  workOrderId: 'work-a',
  runtimeRunId: 'run-a',
  attemptId: 'attempt-a',
  taskWorkspaceId: 'task-workspace-a',
  sandboxScopeId: 'sandbox-a',
  mountSubPath: 'tasks/a',
  sharedReadOnlySubPath: 'shared/agent-a',
};

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: input.attemptId,
    tenant_id: input.tenantId,
    work_order_id: input.workOrderId,
    attempt_no: 1,
    runtime_run_id: input.runtimeRunId,
    parent_attempt_id: null,
    status: 'queued',
    task_workspace_id: input.taskWorkspaceId,
    sandbox_scope_id: input.sandboxScopeId,
    mount_sub_path: input.mountSubPath,
    shared_read_only_sub_path: input.sharedReadOnlySubPath,
    publish_state: 'pending',
    checkpoint_json: null,
    artifact_manifest_json: null,
    created_at: '2026-09-04T00:00:00.000Z',
    updated_at: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function storeWithExisting(row: Record<string, unknown>) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT current_attempt_no')) return { rows: [{ current_attempt_no: 1 }] };
    if (sql.includes('runtime_run_id=$2')) return { rows: [row] };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) };
  return { store: new PgOrgGroupAgentStore(pool as never, 'test'), query, release };
}

describe('PgOrgGroupAgentStore work attempt identity', () => {
  it('returns an exact retry idempotently without creating another attempt', async () => {
    const { store, query, release } = storeWithExisting(attemptRow());

    await expect(store.createWorkAttempt(input)).resolves.toMatchObject({
      attemptId: 'attempt-a',
      attemptNo: 1,
    });

    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects runtime_run identity reuse across WorkOrder or sandbox scope and rolls back', async () => {
    const { store, query, release } = storeWithExisting(
      attemptRow({ work_order_id: 'work-other' }),
    );

    await expect(store.createWorkAttempt(input)).rejects.toThrow(
      'ORG_AGENT_WORK_ATTEMPT_IDEMPOTENCY_CONFLICT',
    );

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
});
