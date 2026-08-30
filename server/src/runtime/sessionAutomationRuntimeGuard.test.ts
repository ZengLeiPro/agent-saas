import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { SessionAutomationRuntimeGuard } from './sessionAutomationRuntimeGuard.js';
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
  async connect(): Promise<pg.PoolClient> {
    return { query: this.query.bind(this), release() {} } as unknown as pg.PoolClient;
  }
  async query<T>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('SELECT a.run_count')) return { rows: [{ run_count: 0, spec: { budget: {} } }] as T[], rowCount: 1 };
    if (sql.includes('COALESCE(SUM(turns)')) return { rows: [{ turns: 0, tokens: 0, credits: '0' }] as T[], rowCount: 1 };
    if (sql.includes('FROM runtime_session_automation_provider_attempts') && sql.includes('FOR UPDATE')) return { rows: [] as T[], rowCount: 0 };
    if (sql.includes('SELECT prepared_dispatch_attempt_id')) return { rows: [{ prepared_dispatch_attempt_id: '44444444-4444-4444-8444-444444444444' }] as T[], rowCount: 1 };
    return { rows: [] as T[], rowCount: 1 };
  }
}

describe('SessionAutomationRuntimeGuard', () => {
  it('在模型外部调用前先提交 reservation 与 prepared→dispatched attempt', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool);
    const handle = await guard.beforeModel(context, 'turn:1');

    expect(handle).toBeDefined();
    const joined = pool.statements.join('\n');
    expect(joined).toContain('INSERT INTO runtime_session_automation_budget_reservations');
    expect(joined).toContain('INSERT INTO runtime_session_automation_provider_attempts');
    expect(joined).toContain("SET state='dispatched'");
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
