import { describe, expect, it, vi } from 'vitest';

import { PgOrgGroupAgentStore } from './store.js';
import { validateEffectiveConfig } from './storeMappers.js';
import { queueWorkOrderAttempt } from './workOrderLifecycle.js';

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

function workOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    work_order_id: 'work-a',
    short_id: 'W-ABCDEF123456',
    tenant_id: 'tenant-a',
    agent_id: 'agent-a',
    binding_id: 'binding-a',
    work_conversation_id: 'work-conversation-a',
    idempotency_key: 'idempotency-a',
    title: '整理采购异常',
    state: 'completed',
    visibility: 'conversation',
    current_attempt_no: 1,
    created_by_actor_json: {
      kind: 'external_user', provider: 'dingtalk', corpId: 'corp-a', openId: 'member-a',
      assurance: 'mapped', mappedUserId: 'user-a', role: 'member',
    },
    policy_snapshot_json: {},
    cancel_policy_json: {},
    control_json: { revision: 1, supplements: [], workerType: 'general' },
    result_envelope_json: { status: 'completed', summary: '旧结果', facts: [], artifacts: [], writeScope: [] },
    version: 3,
    created_at: '2026-09-04T00:00:00.000Z',
    updated_at: '2026-09-04T00:00:00.000Z',
    completed_at: '2026-09-04T00:01:00.000Z',
    ...overrides,
  };
}

function queueStore(deliveryStates: string[], updatedRow = workOrderRow()) {
  const query = vi.fn(async (sql: string, ..._args: unknown[]) => {
    if (sql.includes('SELECT * FROM work_orders')) return { rows: [workOrderRow()] };
    if (sql.includes('SELECT delivery_state FROM deliveries')) {
      return { rows: deliveryStates.map(delivery_state => ({ delivery_state })) };
    }
    if (sql.includes("UPDATE work_orders SET state='queued'")) return { rows: [updatedRow] };
    return { rows: [] };
  });
  const release = vi.fn();
  return { pool: { connect: vi.fn(async () => ({ query, release })) }, query, release };
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
  it('fails closed instead of converting unknown governance roles into unrestricted access', () => {
    expect(() => validateEffectiveConfig({
      identity: {}, knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: { skillIds: [], toolNames: [] },
      access: { triggerRoles: ['admin'], approvalRoles: [] },
      speech: { proactive: false, requireMention: true },
    })).toThrow('ORG_AGENT_EFFECTIVE_CONFIG_ROLE_INVALID');
  });

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

  it('atomically supersedes pending completion delivery before queueing a controlled continuation', async () => {
    const nextControl = {
      revision: 2,
      workerType: 'explore' as const,
      supplements: [{ text: '补充核对供应商资料', actorOpenId: 'admin-a', createdAt: '2026-09-04T01:00:00.000Z', kind: 'supplement' as const }],
    };
    const updated = workOrderRow({
      state: 'queued', version: 4, result_envelope_json: null, completed_at: null, control_json: nextControl,
    });
    const { pool, query, release } = queueStore(['pending'], updated);

    await expect(queueWorkOrderAttempt(pool as never, 'work_orders', 'deliveries', {
      tenantId: 'tenant-a', workOrderId: 'work-a', expectedVersion: 3,
      control: nextControl, supersedePendingCompletion: true,
    })).resolves.toMatchObject({
      state: 'queued', version: 4, control: nextControl,
    });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE deliveries SET delivery_state='dead_letter'"))).toBe(true);
    expect(query.mock.calls.some(([sql, args]) => (
      String(sql).includes("UPDATE work_orders SET state='queued'")
      && Array.isArray(args) && args.includes(JSON.stringify(nextControl))
    ))).toBe(true);
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['sending', 'unknown'])('blocks continuation when completion delivery is %s', async (deliveryState) => {
    const { pool, query, release } = queueStore([deliveryState]);

    await expect(queueWorkOrderAttempt(pool as never, 'work_orders', 'deliveries', {
      tenantId: 'tenant-a', workOrderId: 'work-a', expectedVersion: 3,
      supersedePendingCompletion: true,
    })).rejects.toThrow('ORG_AGENT_WORK_ORDER_COMPLETION_UNCERTAIN');

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE deliveries SET delivery_state='dead_letter'"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE work_orders SET state='queued'"))).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back without persisting a control change when pending completion was not explicitly superseded', async () => {
    const nextControl = { revision: 2, workerType: 'general' as const, supplements: [] };
    const { pool, query } = queueStore(['pending']);

    await expect(queueWorkOrderAttempt(pool as never, 'work_orders', 'deliveries', {
      tenantId: 'tenant-a', workOrderId: 'work-a', expectedVersion: 3, control: nextControl,
    })).rejects.toThrow('ORG_AGENT_WORK_ORDER_RESUME_CONFLICT');

    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE deliveries SET delivery_state='dead_letter'"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE work_orders SET state='queued'"))).toBe(false);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });
});
