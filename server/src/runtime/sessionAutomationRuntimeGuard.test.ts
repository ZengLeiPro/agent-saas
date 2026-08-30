import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  AutomationBudgetExceededError,
  AutomationFenceRejectedError,
  SessionAutomationRuntimeGuard,
} from './sessionAutomationRuntimeGuard.js';
import type { RunContext } from './types.js';

const context = {
  tenantId: 'tenant-a', sessionId: 'session-a', runId: 'run-a', model: 'model-a',
  automationFence: {
    automationId: '11111111-1111-4111-8111-111111111111',
    incarnationId: '22222222-2222-4222-8222-222222222222',
    generation: 2, specVersion: 3,
    executionId: '33333333-3333-4333-8333-333333333333', runId: 'run-a',
  },
} as RunContext;

class FakePool {
  readonly statements: string[] = [];
  automation = {
    status: 'active', incarnation_id: context.automationFence!.incarnationId,
    generation: 2, spec_version: 3, active_run_id: 'run-a',
  };
  budget: Record<string, unknown> = {};
  reserved = { turns: '0', tokens: '0', credits: '0' };

  async connect(): Promise<pg.PoolClient> {
    return { query: this.query.bind(this), release() {} } as unknown as pg.PoolClient;
  }

  async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(normalized);
    if (normalized.includes('SELECT status,incarnation_id,generation,spec_version,active_run_id')) {
      return { rows: [this.automation] as T[], rowCount: 1 };
    }
    if (normalized.includes('SELECT a.run_count')) {
      return { rows: [{ run_count: 0, spec: { budget: this.budget } }] as T[], rowCount: 1 };
    }
    if (normalized.includes('COALESCE(SUM(turns)') && normalized.includes('FROM runtime_session_automation_usage')) {
      return { rows: [{ turns: 0, tokens: 0, credits: '0' }] as T[], rowCount: 1 };
    }
    if (normalized.includes('FROM runtime_session_automation_budget_reservations') && normalized.includes('FILTER')) {
      return { rows: [this.reserved] as T[], rowCount: 1 };
    }
    if (normalized.includes('FROM runtime_session_automation_provider_attempts') && normalized.includes('FOR UPDATE')) {
      return { rows: [] as T[], rowCount: 0 };
    }
    if (normalized.includes('SELECT prepared_dispatch_attempt_id')) {
      return { rows: [{ prepared_dispatch_attempt_id: '44444444-4444-4444-8444-444444444444' }] as T[], rowCount: 1 };
    }
    return { rows: [] as T[], rowCount: 1 };
  }
}

describe('SessionAutomationRuntimeGuard', () => {
  it('在同一事务内校验 fence、预算并提交 reservation 与 provider attempt', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool);
    const handle = await guard.beforeModel(context, 'turn:1');

    expect(handle).toBeDefined();
    const joined = pool.statements.join('\n');
    expect(pool.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    expect(joined.indexOf('SELECT status,incarnation_id')).toBeLessThan(joined.indexOf('INSERT INTO runtime_session_automation_budget_reservations'));
    expect(joined).toContain('INSERT INTO runtime_session_automation_provider_attempts');
    expect(joined).toContain("SET state='dispatched'");
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('旧 generation 或非 active 状态不能创建模型与工具副作用 admission', async () => {
    const stale = new FakePool();
    stale.automation.generation = 3;
    const staleGuard = new SessionAutomationRuntimeGuard(stale as unknown as pg.Pool);
    await expect(staleGuard.beforeModel(context, 'turn:1')).rejects.toBeInstanceOf(AutomationFenceRejectedError);
    expect(stale.statements.some((sql) => sql.startsWith('INSERT INTO'))).toBe(false);

    const cancelling = new FakePool();
    cancelling.automation.status = 'cancelling';
    const cancellingGuard = new SessionAutomationRuntimeGuard(cancelling as unknown as pg.Pool);
    await expect(cancellingGuard.barrier(context)).rejects.toBeInstanceOf(AutomationFenceRejectedError);
  });

  it('并发保留已占最后一轮预算时 fail-closed 且不新增 provider attempt', async () => {
    const pool = new FakePool();
    pool.budget = { maxTurns: 1 };
    pool.reserved.turns = '1';
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool);
    await expect(guard.beforeModel(context, 'turn:last')).rejects.toBeInstanceOf(AutomationBudgetExceededError);
    expect(pool.statements.join('\n')).toContain("SET status='expired'");
    expect(pool.statements.some((sql) => sql.includes('INSERT INTO runtime_session_automation_provider_attempts'))).toBe(false);
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('模型结果未知时封锁 automation，并保留 provider 与 reservation 待 reconcile', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool);
    await guard.finishModel(context, {
      providerAttemptId: '55555555-5555-4555-8555-555555555555',
      reservationId: '66666666-6666-4666-8666-666666666666', sourceKey: 'model:run-a:turn:1',
    }, undefined, new Error('connection reset after dispatch'));

    const joined = pool.statements.join('\n');
    expect(joined).toContain("SET state='result_unknown'");
    expect(joined).toContain("status='reconcile_required'");
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('普通会话没有 automation fence 时不访问账本', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool);
    await expect(guard.beforeModel({ ...context, automationFence: undefined }, 'turn:1')).resolves.toBeUndefined();
    expect(pool.statements).toEqual([]);
  });
});
