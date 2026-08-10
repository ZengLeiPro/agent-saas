import { describe, expect, it, vi } from 'vitest';

import {
  GovernanceProjectionInvariantError,
  GovernanceProjectionReconciler,
  PgGovernanceProjectionOutboxStore,
} from '../data/governanceProjection/index.js';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outbox_id: 'gpo-1',
    tenant_id: 'acme',
    projector: 'membership.compatibility',
    idempotency_key: 'membership:42:v3',
    payload_json: { membershipId: '42', enabled: true },
    status: 'pending',
    attempt: 0,
    max_attempts: 8,
    lease_fence: 0,
    lease_owner: null,
    lease_expires_at: null,
    next_attempt_at: new Date('2026-08-09T10:00:00.000Z'),
    last_error_code: null,
    created_at: new Date('2026-08-09T10:00:00.000Z'),
    updated_at: new Date('2026-08-09T10:00:00.000Z'),
    completed_at: null,
    ...overrides,
  };
}

describe('PgGovernanceProjectionOutboxStore', () => {
  it('enqueue 以 tenant/projector/idempotency key 幂等，并拒绝敏感 JSON 字段和值', async () => {
    const existing = row();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [existing] });
    const store = new PgGovernanceProjectionOutboxStore({
      pool: { query } as never,
      tablePrefix: 'gov',
    });
    const input = {
      tenantId: 'acme',
      projector: 'membership.compatibility',
      idempotencyKey: 'membership:42:v3',
      payload: { membershipId: '42', enabled: true },
    };

    const first = await store.enqueue(input);
    const second = await store.enqueue(input);

    expect(first.outboxId).toBe('gpo-1');
    expect(second.outboxId).toBe(first.outboxId);
    expect(store.outboxTable).toBe('gov_governance_projection_outbox');
    expect(query.mock.calls[0]?.[0]).toContain(
      'ON CONFLICT (tenant_id,projector,idempotency_key) DO UPDATE',
    );
    await expect(store.enqueue({
      ...input,
      payload: { nested: { accessToken: 'redacted' } },
    })).rejects.toEqual(expect.objectContaining<Partial<GovernanceProjectionInvariantError>>({
      code: 'GOVERNANCE_PROJECTION_PAYLOAD_SENSITIVE',
    }));
    await expect(store.enqueue({
      ...input,
      payload: { note: 'contains password material' },
    })).rejects.toEqual(expect.objectContaining<Partial<GovernanceProjectionInvariantError>>({
      code: 'GOVERNANCE_PROJECTION_PAYLOAD_SENSITIVE',
    }));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('get 通过 immutable outboxId 返回可轮询投影状态', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row({ status: 'retry_wait', attempt: 2 })] });
    const store = new PgGovernanceProjectionOutboxStore({ pool: { query } as never, tablePrefix: 'gov' });
    await expect(store.get('gpo-1')).resolves.toMatchObject({
      outboxId: 'gpo-1', status: 'retry_wait', attempt: 2,
    });
    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM gov_governance_projection_outbox WHERE outbox_id=$1', ['gpo-1'],
    );
  });

  it('claim 原子设置 owner/fence，complete 仅接受当前未过期租约', async () => {
    const running = row({
      status: 'running', attempt: 1, lease_fence: 4, lease_owner: 'worker-a',
      lease_expires_at: new Date('2026-08-09T10:01:00.000Z'), next_attempt_at: null,
    });
    const succeeded = row({
      ...running, status: 'succeeded', lease_owner: null, lease_expires_at: null,
      completed_at: new Date('2026-08-09T10:00:01.000Z'),
    });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [running] })
      .mockResolvedValueOnce({ rows: [succeeded] });
    const store = new PgGovernanceProjectionOutboxStore({ pool: { query } as never });

    const [claimed] = await store.claim({ leaseOwner: 'worker-a', leaseMs: 60_000, limit: 1 });
    expect(claimed).toMatchObject({ status: 'running', leaseOwner: 'worker-a', leaseFence: 4 });
    const claimSql = String(query.mock.calls[0]?.[0]);
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toContain('lease_fence=o.lease_fence+1');

    await expect(store.complete({
      outboxId: claimed!.outboxId,
      leaseOwner: claimed!.leaseOwner!,
      leaseFence: claimed!.leaseFence,
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(String(query.mock.calls[1]?.[0])).toContain('lease_expires_at > NOW()');
    expect(query.mock.calls[1]?.[1]).toEqual(['gpo-1', 'worker-a', 4]);
  });

  it('claim 会在同一条 fencing SQL 中回收 lease 已过期的 running 项', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row({
      status: 'running', attempt: 3, lease_fence: 9, lease_owner: 'worker-b',
      lease_expires_at: new Date('2026-08-09T10:01:00.000Z'), next_attempt_at: null,
    })] });
    const store = new PgGovernanceProjectionOutboxStore({ pool: { query } as never });

    await expect(store.claim({ leaseOwner: 'worker-b', leaseMs: 30_000, limit: 5 }))
      .resolves.toEqual([expect.objectContaining({ attempt: 3, leaseFence: 9 })]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("status='running' AND lease_expires_at <= NOW()");
    expect(sql).toContain("SET status='running',attempt=o.attempt+1");
    expect(query.mock.calls[0]?.[1]).toEqual(['worker-b', 30_000, 5]);
  });
});

describe('GovernanceProjectionReconciler', () => {
  it('projector 副作用通过 target fence 包裹后才允许 complete', async () => {
    const claimed = {
      outboxId: 'gpo-1', tenantId: 'acme', projector: 'assignment',
      idempotencyKey: 'skill:s1:2', payload: { resourceType: 'skill', resourceId: 's1' },
      status: 'running' as const, attempt: 1, maxAttempts: 8, leaseFence: 1,
      leaseOwner: 'worker-a', leaseExpiresAt: '2026-08-09T10:01:00.000Z',
      createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z',
    };
    const order: string[] = [];
    const store = {
      enqueue: vi.fn(), claim: vi.fn().mockResolvedValue([claimed]),
      renewLease: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockImplementation(async () => { order.push('complete'); return { ...claimed, status: 'succeeded' }; }),
      fail: vi.fn(),
    };
    const reconciler = new GovernanceProjectionReconciler({
      store,
      projectors: { assignment: async () => { order.push('project'); } },
      executeFenced: async (_item, operation) => {
        order.push('fence-enter'); await operation(); order.push('fence-exit');
      },
      workerId: 'worker-a',
    });
    await reconciler.reconcileOne();
    expect(order).toEqual(['fence-enter', 'project', 'fence-exit', 'complete']);
  });

  it('projector 失败按 attempt 指数退避，只持久化稳定 errorCode 而非错误正文', async () => {
    const claimed = {
      outboxId: 'gpo-1', tenantId: 'acme', projector: 'membership.compatibility',
      idempotencyKey: 'membership:42:v3', payload: { membershipId: '42' },
      status: 'running' as const, attempt: 3, maxAttempts: 8, leaseFence: 7,
      leaseOwner: 'worker-a', leaseExpiresAt: '2026-08-09T10:01:00.000Z',
      createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z',
    };
    const retry = { ...claimed, status: 'retry_wait' as const };
    const store = {
      enqueue: vi.fn(),
      claim: vi.fn().mockResolvedValue([claimed]),
      renewLease: vi.fn().mockResolvedValue(true),
      complete: vi.fn(),
      fail: vi.fn().mockResolvedValue(retry),
    };
    const reconciler = new GovernanceProjectionReconciler({
      store,
      projectors: {
        'membership.compatibility': async () => {
          throw new Error('database connection leaked a private detail');
        },
      },
      workerId: 'worker-a',
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 60_000,
      now: () => new Date('2026-08-09T10:00:00.000Z'),
    });

    await expect(reconciler.reconcileOne()).resolves.toMatchObject({ status: 'retry_wait' });
    expect(store.fail).toHaveBeenCalledWith({
      outboxId: 'gpo-1', leaseOwner: 'worker-a', leaseFence: 7,
      errorCode: 'GOVERNANCE_PROJECTION_FAILED',
      retryAt: '2026-08-09T10:00:04.000Z',
    });
    expect(JSON.stringify(store.fail.mock.calls)).not.toContain('private detail');
    expect(store.complete).not.toHaveBeenCalled();
  });
});
