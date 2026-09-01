import type pg from 'pg'; // mirror pg: NUMERIC values are always strings
import { describe, expect, it } from 'vitest';
import {
  AutomationBudgetExceededError,
  AutomationFenceRejectedError,
  SessionAutomationRuntimeGuard,
  parseWholeNumeric,
} from './sessionAutomationRuntimeGuard.js';
import type { RunContext } from './types.js';

const context = {
  tenantId: 'tenant-a', sessionId: 'session-a', runId: 'run-a', model: 'claude-sonnet-4-5',
  automationFence: {
    automationId: '11111111-1111-4111-8111-111111111111',
    incarnationId: '22222222-2222-4222-8222-222222222222',
    generation: 2, specVersion: 3,
    executionId: '33333333-3333-4333-8333-333333333333', runId: 'run-a', rootSessionId: 'session-a',
  },
} as RunContext;

class FakePool { // SQL-aware transaction and live-switch test double for RuntimeGuard
  readonly statements: string[] = [];
  automation: {
    status: string; incarnation_id: string; generation: number; spec_version: number; active_run_id: string | null;
  } = {
    status: 'active', incarnation_id: context.automationFence!.incarnationId,
    generation: 2, spec_version: 3, active_run_id: 'run-a',
  };
  budget: Record<string, unknown> = {};
  runCount = 0;
  reserved = { turns: '0', tokens: '0', credits: '0' };
  allowanceRemaining = 2;
  settlementReservations: Array<{ budget_kind: string; amount: string }> = [];
  creditReservationAmounts: unknown[] = [];
  onCommit?: () => void;
  providerAttemptState: 'dispatched' | 'cancelled' | 'result_unknown' = 'dispatched';

  async connect(): Promise<pg.PoolClient> {
    return { query: this.query.bind(this), release() {} } as unknown as pg.PoolClient;
  }

  async query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(normalized);
    if (normalized === 'COMMIT') this.onCommit?.();
    if (normalized.startsWith('INSERT INTO runtime_session_automation_budget_reservations') && values?.[8] === 'credits') {
      this.creditReservationAmounts.push(values[10]);
    }
    if (normalized.includes('SELECT status,incarnation_id,generation,spec_version,active_run_id')) {
      return { rows: [this.automation] as T[], rowCount: 1 };
    }
    if (normalized.includes('SELECT a.run_count')) {
      return { rows: [{ run_count: this.runCount, spec: { budget: this.budget } }] as T[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT s.spec,a.run_count FROM runtime_session_automations')) {
      return { rows: [{ run_count: this.runCount, spec: { budget: this.budget } }] as T[], rowCount: 1 };
    }
    if (normalized.includes('COALESCE(SUM(turns)') && normalized.includes('FROM runtime_session_automation_usage')) {
      return { rows: [{ turns: '0', tokens: '0', credits: '0' }] as T[], rowCount: 1 };
    }
    if (normalized.includes('FROM runtime_session_automation_budget_reservations') && normalized.includes('FILTER')) {
      return { rows: [this.reserved] as T[], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE runtime_session_automation_completion_allowances')) {
      if (this.allowanceRemaining <= 0) return { rows: [] as T[], rowCount: 0 };
      this.allowanceRemaining -= 1;
      return { rows: [{ remaining_attempts: this.allowanceRemaining }] as T[], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT budget_kind,amount::text FROM runtime_session_automation_budget_reservations')) {
      return { rows: this.settlementReservations as T[], rowCount: this.settlementReservations.length };
    }
    if (normalized.startsWith("UPDATE runtime_session_automation_provider_attempts SET state='cancelled'")) {
      if (this.providerAttemptState !== 'dispatched') return { rows: [] as T[], rowCount: 0 };
      this.providerAttemptState = 'cancelled';
      return { rows: [] as T[], rowCount: 1 };
    }
    if (normalized.startsWith("UPDATE runtime_session_automation_provider_attempts SET state='result_unknown'")) {
      if (this.providerAttemptState !== 'dispatched') return { rows: [] as T[], rowCount: 0 };
      this.providerAttemptState = 'result_unknown';
      return { rows: [] as T[], rowCount: 1 };
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

describe('strict whole PostgreSQL NUMERIC parsing', () => {
  it('accepts integral scale and rejects fractional/exponent/non-canonical values', () => {
    expect(parseWholeNumeric('1.000000')).toBe(1n);
    expect(parseWholeNumeric('-0.000000')).toBe(0n);
    for (const value of ['1.000001', '1e0', 'NaN', '', ' 1.0']) expect(() => parseWholeNumeric(value)).toThrow(/invalid whole NUMERIC/);
  });
});

describe('SessionAutomationRuntimeGuard', () => {
  it('在同一事务内校验 fence、预算并提交 reservation 与 provider attempt', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    const handle = await guard.beforeModel(context, 'turn:1', {model: context.model, inputTokens: 10, maxOutputTokens: 20});

    expect(handle).toBeDefined();
    const joined = pool.statements.join('\n');
    expect(pool.statements.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
    expect(joined.indexOf('SELECT status,incarnation_id')).toBeLessThan(joined.indexOf('INSERT INTO runtime_session_automation_budget_reservations'));
    expect(joined).toContain('INSERT INTO runtime_session_automation_provider_attempts');
    expect(joined).toContain("'dispatched',now()");
    expect(pool.statements.filter((sql) => sql.includes('INSERT INTO runtime_session_automation_budget_reservations'))).toHaveLength(4);
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('旧 generation 或非 active 状态不能创建模型与工具副作用 admission', async () => {
    const stale = new FakePool();
    stale.automation.generation = 3;
    const staleGuard = new SessionAutomationRuntimeGuard(stale as unknown as pg.Pool, () => true);
    await expect(staleGuard.beforeModel(context, 'turn:1', {model: context.model, inputTokens: 10, maxOutputTokens: 20})).rejects.toBeInstanceOf(AutomationFenceRejectedError);
    expect(stale.statements.some((sql) => sql.startsWith('INSERT INTO'))).toBe(false);

    const cancelling = new FakePool();
    cancelling.automation.status = 'cancelling';
    const cancellingGuard = new SessionAutomationRuntimeGuard(cancelling as unknown as pg.Pool, () => true);
    await expect(cancellingGuard.barrier(context)).rejects.toBeInstanceOf(AutomationFenceRejectedError);
  });

  it('并发保留已占最后一轮预算时 fail-closed 且不新增 provider attempt', async () => {
    const pool = new FakePool();
    pool.budget = { maxTurns: 1 };
    pool.reserved.turns = '1';
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    await expect(guard.beforeModel(context, 'turn:last', {model: context.model, inputTokens: 10, maxOutputTokens: 20})).rejects.toBeInstanceOf(AutomationBudgetExceededError);
    expect(pool.statements.join('\n')).toContain("desired_terminal_status='expired'");
    expect(pool.statements.join('\n')).toContain("phase='draining'");
    expect(pool.statements.some((sql) => sql.includes('INSERT INTO runtime_session_automation_provider_attempts'))).toBe(false);
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('模型结果未知时即使 active_run_id 已清空仍以完整 fence 封锁 automation', async () => {
    const pool = new FakePool();
    pool.automation.active_run_id = null;
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    await guard.finishModel(context, {
      providerAttemptId: '55555555-5555-4555-8555-555555555555',
      reservationIds: ['66666666-6666-4666-8666-666666666666'], model: context.model, purpose: 'work', sourceKey: 'model:run-a:turn:1',
    }, undefined, new Error('connection reset after dispatch'));

    const joined = pool.statements.join('\n');
    expect(joined).toContain("SET state='result_unknown'");
    expect(joined).toContain("status='reconcile_required'");
    expect(joined).toContain('incarnation_id=$4 AND generation=$5 AND spec_version=$6');
    expect(joined).not.toContain('active_run_id=$4');
    expect(pool.statements.at(-1)).toBe('COMMIT');
  });

  it('未配置 credit 上限时未知模型价格允许执行且 credit reservation 为 0', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    await expect(guard.beforeModel(context, 'turn:unpriced', { model: 'unknown-model', inputTokens: 10, maxOutputTokens: 20 }))
      .resolves.toBeDefined();
    expect(pool.creditReservationAmounts).toEqual([0]);
  });

  it('配置 credit 上限时未知模型价格 fail-closed', async () => {
    const pool = new FakePool();
    pool.budget = { maxCredits: 1 };
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    await expect(guard.beforeModel(context, 'turn:priced', { model: 'unknown-model', inputTokens: 10, maxOutputTokens: 20 }))
      .rejects.toMatchObject({ reason: 'unknown_model_price' });
    expect(pool.statements.some((sql) => sql.includes('INSERT INTO runtime_session_automation_provider_attempts'))).toBe(false);
  });

  it('runs/tokens/credits 使用 current+reserved+prospective 的 inclusive 上界', async () => {
    const exactTokens = new FakePool(); exactTokens.budget = { maxTokens: 47 };
    await expect(new SessionAutomationRuntimeGuard(exactTokens as unknown as pg.Pool, () => true).beforeModel(context, 'tokens:exact', { model: 'claude-sonnet-4-5', inputTokens: 10, maxOutputTokens: 20 })).resolves.toBeDefined();
    const overTokens = new FakePool(); overTokens.budget = { maxTokens: 46 };
    await expect(new SessionAutomationRuntimeGuard(overTokens as unknown as pg.Pool, () => true).beforeModel(context, 'tokens:over', { model: 'claude-sonnet-4-5', inputTokens: 10, maxOutputTokens: 20 })).rejects.toMatchObject({ reason: 'max_tokens' });

    const exactCredits = new FakePool(); exactCredits.budget = { maxCredits: 0.69 };
    await expect(new SessionAutomationRuntimeGuard(exactCredits as unknown as pg.Pool, () => true).beforeModel(context, 'credits:exact', { model: 'claude-sonnet-4-5', inputTokens: 10, maxOutputTokens: 20 })).resolves.toBeDefined();
    const overCredits = new FakePool(); overCredits.budget = { maxCredits: 0.689999 };
    await expect(new SessionAutomationRuntimeGuard(overCredits as unknown as pg.Pool, () => true).beforeModel(context, 'credits:over', { model: 'claude-sonnet-4-5', inputTokens: 10, maxOutputTokens: 20 })).rejects.toMatchObject({ reason: 'max_credits' });

    const exactRuns = new FakePool(); exactRuns.budget = { maxRuns: 1 }; exactRuns.runCount = 1;
    await expect(new SessionAutomationRuntimeGuard(exactRuns as unknown as pg.Pool, () => true).beforeModel(context, 'runs:exact', { model: 'claude-sonnet-4-5', inputTokens: 1, maxOutputTokens: 1 })).resolves.toBeDefined();
    const overRuns = new FakePool(); overRuns.budget = { maxRuns: 1 }; overRuns.runCount = 2;
    await expect(new SessionAutomationRuntimeGuard(overRuns as unknown as pg.Pool, () => true).beforeModel(context, 'runs:over', { model: 'claude-sonnet-4-5', inputTokens: 1, maxOutputTokens: 1 })).rejects.toMatchObject({ reason: 'max_runs' });
  });

  it('completion allowance 只供 evaluator、固定 500 output 且最多两次', async () => {
    const pool = new FakePool();
    pool.budget = { maxTurns: 0 };
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    const evalAdmission = { model: 'claude-sonnet-4-5', inputTokens: 10, maxOutputTokens: 500, purpose: 'goal_evaluation' as const };
    await expect(guard.beforeModel(context, 'goal:1', evalAdmission)).resolves.toBeDefined();
    await expect(guard.beforeModel(context, 'goal:2', evalAdmission)).resolves.toBeDefined();
    await expect(guard.beforeModel(context, 'goal:3', evalAdmission)).rejects.toBeInstanceOf(AutomationBudgetExceededError);
    await expect(guard.beforeModel(context, 'work', { model: evalAdmission.model, inputTokens: 10, maxOutputTokens: 500 }))
      .rejects.toBeInstanceOf(AutomationBudgetExceededError);
  });


  it('已 admitted 的第 N 个 run 在 maxRuns 边界通过工具 barrier', async () => {
    const pool = new FakePool(); pool.budget = { maxRuns: 1 }; pool.runCount = 1;
    await expect(new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true).barrier(context)).resolves.toBeUndefined();
    expect(pool.statements.join('\n')).not.toContain("desired_terminal_status='expired'");
  });

  it('prospective 越限时 evaluator 可使用平台外 allowance，普通 work 不可消费', async () => {
    const evaluator = new FakePool(); evaluator.budget = { maxTokens: 46 };
    const guard = new SessionAutomationRuntimeGuard(evaluator as unknown as pg.Pool, () => true);
    await expect(guard.beforeModel(context, 'goal:prospective', {
      model: context.model, inputTokens: 10, maxOutputTokens: 500, purpose: 'goal_evaluation',
    })).resolves.toMatchObject({ allowanceUsed: true, purpose: 'goal_evaluation' });
    expect(evaluator.allowanceRemaining).toBe(1);

    const work = new FakePool(); work.budget = { maxTokens: 46 };
    await expect(new SessionAutomationRuntimeGuard(work as unknown as pg.Pool, () => true).beforeModel(
      context, 'work:prospective', { model: context.model, inputTokens: 10, maxOutputTokens: 20 },
    )).rejects.toMatchObject({ reason: 'max_tokens' });
    expect(work.allowanceRemaining).toBe(2);
  });

  it('root key 滚动兼容，child key 同时按 invoking session/run 隔离', async () => {
    const rootWithoutRootSession = {
      ...context,
      automationFence: { ...context.automationFence!, rootSessionId: undefined },
    } as RunContext;
    const first = await new SessionAutomationRuntimeGuard(new FakePool() as unknown as pg.Pool, () => true)
      .beforeModel(rootWithoutRootSession, 'turn:stable', { model: context.model, inputTokens: 1, maxOutputTokens: 1 });
    const retry = await new SessionAutomationRuntimeGuard(new FakePool() as unknown as pg.Pool, () => true)
      .beforeModel(rootWithoutRootSession, 'turn:stable', { model: context.model, inputTokens: 1, maxOutputTokens: 1 });
    expect(first?.sourceKey).toBe(`model:${context.automationFence!.executionId}:${context.runId}:turn:stable`);
    expect(retry?.sourceKey).toBe(first?.sourceKey);

    const child = (sessionId: string) => ({
      ...context,
      sessionId,
      runId: 'shared-child-run',
      automationFence: {
        ...context.automationFence!, rootSessionId: context.sessionId, rootRunId: context.runId,
        runId: 'shared-child-run',
      },
    } as RunContext);
    const childA = await new SessionAutomationRuntimeGuard(new FakePool() as unknown as pg.Pool, () => true)
      .beforeModel(child('child-session-a'), 'turn:stable', { model: context.model, inputTokens: 1, maxOutputTokens: 1 });
    const childB = await new SessionAutomationRuntimeGuard(new FakePool() as unknown as pg.Pool, () => true)
      .beforeModel(child('child-session-b'), 'turn:stable', { model: context.model, inputTokens: 1, maxOutputTokens: 1 });
    expect(childA?.sourceKey).toContain(':15:child-session-a:shared-child-run:turn:stable');
    expect(childB?.sourceKey).toContain(':15:child-session-b:shared-child-run:turn:stable');
    expect(childA?.sourceKey).not.toBe(childB?.sourceKey);
  });

  it('实际用量超过 reservation 时进入 reconcile，不能静默结算', async () => {
    const pool = new FakePool();
    pool.settlementReservations = [
      { budget_kind: 'runs', amount: '0' }, { budget_kind: 'turns', amount: '1' },
      { budget_kind: 'tokens', amount: '1' }, { budget_kind: 'credits', amount: '1' },
    ];
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    await guard.finishModel(context, {
      providerAttemptId: '55555555-5555-4555-8555-555555555555',
      reservationIds: ['66666666-6666-4666-8666-666666666666'], model: context.model,
      purpose: 'work', sourceKey: `model:${context.automationFence!.executionId}:${context.runId}:turn:over`,
    }, { inputTokens: 10, outputTokens: 20 });
    expect(pool.statements.join('\n')).toContain("status='reconcile_required'");
  });

  it('transport 前授权失败可释放 reservation 并返还 evaluator allowance', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    await guard.releaseModel(context, {
      providerAttemptId: '55555555-5555-4555-8555-555555555555',
      reservationIds: ['66666666-6666-4666-8666-666666666666'], model: context.model,
      purpose: 'goal_evaluation', allowanceUsed: true,
      sourceKey: `model:${context.automationFence!.executionId}:${context.runId}:goal`,
    }, 'billing denied');
    const joined = pool.statements.join('\n');
    expect(joined).toContain("state='cancelled'");
    expect(joined).toContain("state='released'");
    expect(joined).toContain('remaining_attempts=LEAST(2,remaining_attempts+1)');
  });

  it('live execution gate 在关闭时阻止模型/工具 admission，普通会话不受影响', async () => {
    const pool = new FakePool();
    let enabled = false;
    const guard = new SessionAutomationRuntimeGuard(
      pool as unknown as pg.Pool, () => enabled, 'runtime', 'runtime_runs',
    );
    await expect(guard.beforeModel(context, 'turn:disabled', {
      model: context.model, inputTokens: 10, maxOutputTokens: 20,
    })).rejects.toMatchObject({ reason: 'execution_disabled' });
    await expect(guard.barrier(context)).rejects.toMatchObject({ reason: 'execution_disabled' });
    expect(pool.statements).toEqual([]);

    const normal = { ...context, automationFence: undefined } as RunContext;
    await expect(guard.beforeModel(normal, 'turn:normal', {
      model: context.model, inputTokens: 10, maxOutputTokens: 20,
    })).resolves.toBeUndefined();
    await expect(guard.barrier(normal)).resolves.toBeUndefined();
  });

  it('background resource checkpoint reads the live gate before querying durable intent', async () => {
    const pool = new FakePool();
    let enabled = false;
    const guard = new SessionAutomationRuntimeGuard(
      pool as unknown as pg.Pool, () => enabled, 'runtime', 'runtime_runs',
    );
    const identity = { childSessionId: 'child-session', childRunId: 'child-run' };
    await expect(guard.assertBackgroundResourcePrepared(context, 'background-run', identity))
      .rejects.toMatchObject({ reason: 'execution_disabled' });
    expect(pool.statements).toEqual([]);

    enabled = true;
    await expect(guard.assertBackgroundResourcePrepared(context, 'background-run', identity)).resolves.toBeUndefined();
    expect(pool.statements.at(-1)).toContain('runtime_session_automation_background_resources');
  });

  it('pre-transport release 幂等恢复 allowance，已释放 attempt 不会被误标 result_unknown', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    const handle = {
      providerAttemptId: '55555555-5555-4555-8555-555555555555',
      reservationIds: ['66666666-6666-4666-8666-666666666666'],
      sourceKey: 'model:run-a:turn:release', model: context.model, purpose: 'goal_evaluation' as const,
      allowanceUsed: true,
    };

    await guard.releaseModel(context, handle, 'disabled');
    await guard.releaseModel(context, handle, 'disabled-again');
    await guard.finishModel(context, handle, undefined, new Error('pre-transport rejection'));

    expect(pool.statements.filter(sql => sql.includes('remaining_attempts=LEAST(2,remaining_attempts+1)'))).toHaveLength(1);
    expect(pool.statements.join('\n')).not.toContain("status='reconcile_required'");
  });

  it('预算 admission 提交时 gate 翻转会释放 claim，重新开启后可恢复', async () => {
    const pool = new FakePool();
    let enabled = true;
    let commitCount = 0;
    pool.onCommit = () => {
      commitCount += 1;
      if (commitCount === 1) enabled = false;
    };
    const guard = new SessionAutomationRuntimeGuard(
      pool as unknown as pg.Pool, () => enabled, 'runtime', 'runtime_runs',
    );
    await expect(guard.beforeModel(context, 'turn:flip', {
      model: context.model, inputTokens: 10, maxOutputTokens: 20,
    })).rejects.toMatchObject({ reason: 'execution_disabled' });
    const joined = pool.statements.join('\n');
    expect(joined).toContain("SET state='cancelled'");
    expect(joined).toContain("SET state='released'");

    enabled = true;
    pool.onCommit = undefined;
    await expect(guard.beforeModel(context, 'turn:reopened', {
      model: context.model, inputTokens: 10, maxOutputTokens: 20,
    })).resolves.toBeDefined();
  });

  it('普通会话没有 automation fence 时不访问账本', async () => {
    const pool = new FakePool();
    const guard = new SessionAutomationRuntimeGuard(pool as unknown as pg.Pool, () => true);
    await expect(guard.beforeModel({ ...context, automationFence: undefined }, 'turn:1', {model: context.model, inputTokens: 10, maxOutputTokens: 20})).resolves.toBeUndefined();
    expect(pool.statements).toEqual([]);
  });
});
