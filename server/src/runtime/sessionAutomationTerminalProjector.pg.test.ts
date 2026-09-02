import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionAutomationTools } from '../agent/tools/sessionAutomationTools.js';
import { PgEventStore } from './pgEventStore.js';
import { PgRunStore } from './runStore.js';
import { readTerminalEventOutbox } from './runTerminalCoordinator.js';
import { finalizeWakeTerminalRun } from './wakeTerminalCoordinator.js';
import { resolveAutomationBudgetReason } from './sessionAutomationBudgetProgress.js';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';
import { SessionAutomationTerminalProjector } from './sessionAutomationTerminalProjector.js';

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;

describePg('session automation terminal projector state machine (real PostgreSQL)', () => {
  const prefix = `automation_terminal_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const tenantId = 'terminal-projector-tenant';
  let pool: InstanceType<typeof Pool>;
  let events: PgEventStore;
  let runs: PgRunStore;
  let store: PgSessionAutomationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 6 });
    events = new PgEventStore({ connectionString: databaseUrl!, tablePrefix: prefix, poolMax: 3 });
    await events.init();
    runs = new PgRunStore({
      pool,
      tablePrefix: prefix,
      writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true },
    });
    await runs.init();
    store = new PgSessionAutomationStore(pool, prefix, runs.runsTable);
    await store.init();
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables
        WHERE schemaname='public' AND tablename LIKE '${prefix}_%'
      LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE',r.tablename); END LOOP;
    END $$`);
  });

  afterAll(async () => {
    if (!pool) return;
    await events.close();
    await pool.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables
        WHERE schemaname='public' AND tablename LIKE '${prefix}_%'
      LOOP EXECUTE format('DROP TABLE IF EXISTS %I CASCADE',r.tablename); END LOOP;
    END $$`).catch(() => undefined);
    await pool.end();
  }, 30_000);

  async function createAutomation(input: {
    kind: 'loop' | 'goal';
    mode: 'fixed' | 'adaptive' | 'goal';
    spec: Record<string, unknown>;
    continuationEpoch?: number;
  }) {
    const automationId = randomUUID();
    const incarnationId = randomUUID();
    const sessionId = `terminal-projector-${randomUUID()}`;
    await pool.query(
      `INSERT INTO ${store.tables.automations}
        (automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,
         generation,spec_version,control_version,projection_version,continuation_epoch)
       VALUES($1,$2,$3,'user-a',$4,$5,$6,'active','idle',1,1,1,1,$7)`,
      [automationId, tenantId, sessionId, incarnationId, input.kind, input.mode, input.continuationEpoch ?? 0],
    );
    await pool.query(
      `INSERT INTO ${store.tables.specs}
        (automation_id,tenant_id,session_id,spec_version,spec_digest,spec)
       VALUES($1,$2,$3,1,$4,$5)`,
      [automationId, tenantId, sessionId, randomUUID(), JSON.stringify(input.spec)],
    );
    return { automationId, incarnationId, sessionId };
  }

  async function dispatch(input: {
    automationId: string;
    incarnationId: string;
    sessionId: string;
    triggerKey: string;
    continuationEpoch: number;
    dueAt?: Date;
  }) {
    await store.tx(client => store.scheduleTx(client, {
      tenantId,
      sessionId: input.sessionId,
      automationId: input.automationId,
      incarnationId: input.incarnationId,
      generation: 1,
      specVersion: 1,
      continuationEpoch: input.continuationEpoch,
      triggerKey: input.triggerKey,
      dueAt: input.dueAt ?? new Date(0),
      payload: {},
    }));
    await store.claimDue();
    const claimed = await store.claimDispatch();
    const item = claimed.find(candidate => candidate.automationId === input.automationId);
    expect(item).toBeDefined();
    await runs.createPending({
      runId: item!.targetRunId,
      sessionId: input.sessionId,
      tenantId,
      userId: 'user-a',
      metadata: { schedulerState: 'staged' },
    });
    await store.markDispatched(item!);
    return item!;
  }

  it('claims a state-only terminal repair exactly once across concurrent workers', async () => {
    const runId = `state-only-repair-${randomUUID()}`;
    const sessionId = `state-only-repair-session-${randomUUID()}`;
    await runs.createPending({ runId, sessionId, tenantId, userId: 'user-a' });
    await runs.markStatus(runId, 'completed', 'legacy_state_only');
    const run = (await runs.get(runId))!;

    const results = await Promise.all([
      finalizeWakeTerminalRun({
        config: { runStore: runs }, eventStore: events, run,
        status: 'completed', reason: 'legacy_state_only',
      }),
      finalizeWakeTerminalRun({
        config: { runStore: runs }, eventStore: events, run,
        status: 'completed', reason: 'legacy_state_only',
      }),
    ]);
    expect(results).toEqual([undefined, undefined]); // Both callers complete; exactly one wins the SQL claim.
    const stored = await events.listByRun(tenantId, sessionId, runId);
    expect(stored.filter((event) => event.type === 'run_state_changed')).toHaveLength(1);
    expect(readTerminalEventOutbox(await runs.get(runId))).toMatchObject({ state: 'delivered' });
  });

  it('keeps the fixed anchor single when an active run-now terminates', async () => {
    const fixed = await createAutomation({
      kind: 'loop', mode: 'fixed', continuationEpoch: 5,
      spec: { kind: 'loop', mode: 'fixed', prompt: 'continue', intervalMs: 60_000, budget: {} },
    });
    const anchorDueAt = new Date(Date.now() + 3_600_000);
    await store.tx(client => store.scheduleTx(client, {
      tenantId, sessionId: fixed.sessionId, automationId: fixed.automationId,
      incarnationId: fixed.incarnationId, generation: 1, specVersion: 1, continuationEpoch: 6,
      triggerKey: `fixed:${fixed.automationId}:g1:slot6`, dueAt: anchorDueAt, payload: {},
    }));
    await store.tx(async client => {
      const current = await store.getLocked(client, tenantId, fixed.sessionId, fixed.automationId);
      await store.control(client, current!, 'run');
    });
    await store.claimDue();
    const item = (await store.claimDispatch()).find(candidate => candidate.automationId === fixed.automationId)!;
    await runs.createPending({ runId: item.targetRunId, sessionId: fixed.sessionId, tenantId, userId: 'user-a' });
    await store.markDispatched(item);
    await new SessionAutomationTerminalProjector(store, `manual-fixed-${randomUUID()}`).project({
      globalSequence: 1, tenantId, sessionId: fixed.sessionId, runId: item.targetRunId, status: 'completed',
    });

    const wakeups = await pool.query(
      `SELECT trigger_key,due_at FROM ${store.tables.wakeups}
        WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed') ORDER BY due_at`,
      [tenantId, fixed.automationId],
    );
    expect(wakeups.rows).toHaveLength(1);
    expect(wakeups.rows[0].trigger_key).toBe(`fixed:${fixed.automationId}:g1:slot6`);
    expect(new Date(wakeups.rows[0].due_at).getTime()).toBe(anchorDueAt.getTime());
    expect(await store.get(tenantId, fixed.sessionId, fixed.automationId)).toMatchObject({ phase: 'waiting' });
    const automation = await pool.query(
      `SELECT continuation_epoch FROM ${store.tables.automations} WHERE tenant_id=$1 AND automation_id=$2`,
      [tenantId, fixed.automationId],
    );
    expect(automation.rows[0].continuation_epoch).toBe('5');
  });

  async function projectUsage(input: {
    providerUsage?: { turns: number; tokens: number; credits: number };
    providerAttempt?: boolean;
    settlement?: boolean;
    reservedCredits?: number;
    sdkCostUSD?: number;
  } = {}) {
    // Normalize fixed-scale NUMERIC values to whole microcredits for semantic assertions.
    const adaptive = await createAutomation({
      kind: 'loop', mode: 'adaptive',
      spec: { kind: 'loop', mode: 'adaptive', prompt: 'continue', budget: { maxTurns: 4, maxTokens: 31, maxCredits: 4 } },
    });
    const item = await dispatch({ ...adaptive, triggerKey: `usage-${randomUUID()}`, continuationEpoch: 1 });
    if (input.providerAttempt !== false && input.providerUsage) {
      const prepared = await pool.query(
        `SELECT prepared_dispatch_attempt_id FROM ${store.tables.preparedDispatchAttempts} WHERE execution_id=$1`,
        [item.outboxId],
      );
      const attemptId = randomUUID();
      const reservationId = randomUUID();
      const sourceKey = `model:${randomUUID()}`;
      const settled = input.settlement !== false;
      const reservedCredits = input.reservedCredits ?? input.providerUsage.credits;
      await pool.query(
        `INSERT INTO ${store.tables.providerAttempts}
          (provider_attempt_id,prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,
           execution_id,run_id,provider,operation,idempotency_key,request_payload,state)
         VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'model','test',$9,$10,$11)`,
        [attemptId,prepared.rows[0].prepared_dispatch_attempt_id,tenantId,adaptive.sessionId,adaptive.automationId,
          adaptive.incarnationId,item.outboxId,item.targetRunId,sourceKey,JSON.stringify({ purpose: 'work' }),
          settled ? 'completed' : 'result_unknown'],
      );
      await pool.query(
        `INSERT INTO ${store.tables.budgetReservations}
          (reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,
           budget_kind,purpose,amount,unit,idempotency_key,state)
         VALUES($1,$2,$3,$4,$5,1,$6,$7,'credits','work',$8,'microcredits',$9,$10)`,
        [reservationId,tenantId,adaptive.sessionId,adaptive.automationId,adaptive.incarnationId,item.outboxId,
          item.targetRunId,reservedCredits,`${sourceKey}:credits`,settled ? 'settled' : 'result_unknown'],
      );
      if (settled) {
        await pool.query(
          `INSERT INTO ${store.tables.budgetSettlements}
            (settlement_id,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,
             run_id,idempotency_key,amount,outcome,provider_receipt)
           VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,'charged',$11)`,
          [randomUUID(),reservationId,tenantId,adaptive.sessionId,adaptive.automationId,adaptive.incarnationId,
            item.outboxId,item.targetRunId,`settle:${sourceKey}:credits`,input.providerUsage.credits,
            JSON.stringify({ authority: 'tenant_pricing' })],
        );
        await store.recordUsage({
          tenantId, sessionId: adaptive.sessionId, automationId: adaptive.automationId,
          executionId: item.outboxId, sourceKey, sourceKind: 'model', ...input.providerUsage,
        });
      }
    }
    await new SessionAutomationTerminalProjector(store, `usage-${randomUUID()}`).project({
      globalSequence: 1, tenantId, sessionId: adaptive.sessionId, runId: item.targetRunId,
      status: 'completed', numTurns: 3,
      modelUsage: { model: { inputTokens: 20, outputTokens: 10, reasoningTokens: 7, costUSD: input.sdkCostUSD ?? 3 } },
    });
    const usage = await pool.query(
      `SELECT source_kind,turns,tokens,credits::numeric(20,0)::text AS credits FROM ${store.tables.usage}
        WHERE tenant_id=$1 AND automation_id=$2 ORDER BY source_kind`,
      [tenantId, adaptive.automationId],
    );
    const budgetReason = await resolveAutomationBudgetReason({
      client: pool, tables: store.tables, tablePrefix: prefix, runsTable: runs.runsTable,
      tenantId, sessionId: adaptive.sessionId, automationId: adaptive.automationId,
    });
    return { usage: usage.rows, automation: await store.get(tenantId,adaptive.sessionId,adaptive.automationId), budgetReason };
  }

  it('uses authoritative provider credits and a positive terminal turns/tokens delta for partial provider usage', async () => {
    const projected = await projectUsage({ providerUsage: { turns: 1, tokens: 10, credits: 1_000_000 } });
    expect(projected.usage).toEqual([
      { source_kind: 'automation_run', turns: '2', tokens: '20', credits: '0' },
      { source_kind: 'model', turns: '1', tokens: '10', credits: '1000000' },
    ]);
    expect(projected.automation).toMatchObject({ status: 'active', phase: 'idle' });
    expect(projected.budgetReason).toBeUndefined();
  });

  it('uses only the complete provider settlement when terminal aggregate is fully represented', async () => {
    const projected = await projectUsage({ providerUsage: { turns: 3, tokens: 30, credits: 3_000_000 } });
    expect(projected.usage).toEqual([
      { source_kind: 'automation_run', turns: '0', tokens: '0', credits: '0' },
      { source_kind: 'model', turns: '3', tokens: '30', credits: '3000000' },
    ]);
    expect(projected.automation).toMatchObject({ status: 'active', phase: 'idle' });
  });

  it.each([
    ['no provider attempt', { providerAttempt: false }],
    ['provider attempt without settlement', {
      providerUsage: { turns: 1, tokens: 10, credits: 1_000_000 }, settlement: false, reservedCredits: 4_000_000,
    }],
  ] as const)('fails closed for %s instead of admitting zero credits', async (_label, input) => {
    const projected = await projectUsage(input);
    expect(projected.automation).toMatchObject({ status: 'reconcile_required', phase: 'waiting' });
    expect(projected.usage.find(row => row.source_kind === 'automation_run')).toMatchObject({ credits: '0' });
    if (!('providerAttempt' in input)) expect(projected.budgetReason).toBe('max_credits');
  });

  it('ignores abnormal SDK costUSD and keeps credits sourced from tenant-priced provider settlement', async () => {
    const projected = await projectUsage({
      providerUsage: { turns: 3, tokens: 30, credits: 250_000 }, sdkCostUSD: Number.MAX_VALUE,
    });
    expect(projected.usage).toEqual([
      { source_kind: 'automation_run', turns: '0', tokens: '0', credits: '0' },
      { source_kind: 'model', turns: '3', tokens: '30', credits: '250000' },
    ]);
    expect(projected.budgetReason).toBeUndefined();
  });

  async function projectStateOnlyCredits(input: {
    status?: 'completed' | 'orphaned';
    executionState?: 'prepared';
    attemptState?: 'prepared' | 'dispatched' | 'completed' | 'cancelled' | 'result_unknown' | 'reconcile';
    reservationState?: 'reserved' | 'settled' | 'released' | 'result_unknown' | 'reconcile';
    charged?: boolean;
  }) {
    const automation = await createAutomation({
      kind: 'loop', mode: 'adaptive',
      spec: { kind: 'loop', mode: 'adaptive', prompt: 'continue', budget: { maxCredits: 4 } },
    });
    const item = await dispatch({ ...automation, triggerKey: `state-only-credits-${randomUUID()}`, continuationEpoch: 1 });
    if (input.executionState === 'prepared') {
      await pool.query(`UPDATE ${store.tables.executions} SET state='prepared' WHERE execution_id=$1`, [item.outboxId]);
    }
    if (input.attemptState) {
      const prepared = await pool.query(
        `SELECT prepared_dispatch_attempt_id FROM ${store.tables.preparedDispatchAttempts} WHERE execution_id=$1`,
        [item.outboxId],
      );
      const sourceKey = `model:${randomUUID()}`;
      const reservationId = randomUUID();
      await pool.query(
        `INSERT INTO ${store.tables.providerAttempts}
          (provider_attempt_id,prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,
           execution_id,run_id,provider,operation,idempotency_key,request_payload,state)
         VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'model','test',$9,$10,$11)`,
        [randomUUID(),prepared.rows[0].prepared_dispatch_attempt_id,tenantId,automation.sessionId,automation.automationId,
          automation.incarnationId,item.outboxId,item.targetRunId,sourceKey,JSON.stringify({ purpose: 'work' }),input.attemptState],
      );
      await pool.query(
        `INSERT INTO ${store.tables.budgetReservations}
          (reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,
           budget_kind,purpose,amount,unit,idempotency_key,state)
         VALUES($1,$2,$3,$4,$5,1,$6,$7,'credits','work',1000000,'microcredits',$8,$9)`,
        [reservationId,tenantId,automation.sessionId,automation.automationId,automation.incarnationId,item.outboxId,
          item.targetRunId,`${sourceKey}:credits`,input.reservationState ?? 'reserved'],
      );
      if (input.charged) {
        await pool.query(
          `INSERT INTO ${store.tables.budgetSettlements}
            (settlement_id,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,
             run_id,idempotency_key,amount,outcome,provider_receipt)
           VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,1000000,'charged',$10)`,
          [randomUUID(),reservationId,tenantId,automation.sessionId,automation.automationId,automation.incarnationId,
            item.outboxId,item.targetRunId,`settle:${sourceKey}:credits`,JSON.stringify({ authority: 'tenant_pricing' })],
        );
        await store.recordUsage({
          tenantId, sessionId: automation.sessionId, automationId: automation.automationId,
          executionId: item.outboxId, sourceKey, sourceKind: 'model', turns: 1, tokens: 10, credits: 1_000_000,
        });
      }
    }
    await events.append({
      type: 'run_state_changed', runId: item.targetRunId, sessionId: automation.sessionId,
      status: input.status ?? 'completed', previousStatus: 'running', reason: 'state_only_credits_test',
    }, { tenantId });
    await new SessionAutomationTerminalProjector(store, `state-only-credits-${randomUUID()}`).recover(events);
    return store.get(tenantId, automation.sessionId, automation.automationId);
  }

  it.each(['completed', 'orphaned'] as const)(
    'fails closed for state-only maxCredits %s without an authoritative chain',
    async (status) => {
      expect(await projectStateOnlyCredits({ status })).toMatchObject({
        status: 'reconcile_required', phase: 'waiting', activeRunId: undefined,
      });
    },
  );

  it('accepts a durable prepared execution with no provider or reservation facts as pre-model', async () => {
    expect(await projectStateOnlyCredits({ executionState: 'prepared' })).toMatchObject({
      status: 'active', phase: 'idle', activeRunId: undefined,
    });
  });

  it('accepts a completed attempt only with charged settlement and matching provider usage', async () => {
    expect(await projectStateOnlyCredits({ attemptState: 'completed', reservationState: 'settled', charged: true }))
      .toMatchObject({ status: 'active', phase: 'idle', activeRunId: undefined });
  });

  it('does not lock a cancelled provider attempt whose credits reservation was released', async () => {
    expect(await projectStateOnlyCredits({ attemptState: 'cancelled', reservationState: 'released' }))
      .toMatchObject({ status: 'active', phase: 'idle', activeRunId: undefined });
  });

  it.each(['prepared', 'dispatched', 'result_unknown', 'reconcile'] as const)(
    'fails closed for non-terminal provider attempt state %s',
    async (attemptState) => {
      expect(await projectStateOnlyCredits({ attemptState, reservationState: 'reserved' })).toMatchObject({
        status: 'reconcile_required', phase: 'waiting', activeRunId: undefined,
      });
    },
  );

  it.each(['completed', 'orphaned'] as const)(
    'projects a state-only %s runtime terminal event',
    async (status) => {
      const adaptive = await createAutomation({
        kind: 'loop', mode: 'adaptive',
        spec: { kind: 'loop', mode: 'adaptive', prompt: 'continue', budget: {} },
      });
      const item = await dispatch({ ...adaptive, triggerKey: `state-only-${status}`, continuationEpoch: 1 });
      await events.append({
        type: 'run_state_changed', runId: item.targetRunId, sessionId: adaptive.sessionId,
        status, previousStatus: 'running', reason: `state_only_${status}`,
      }, { tenantId });
      const projector = new SessionAutomationTerminalProjector(store, `state-only-${status}-${randomUUID()}`);

      await expect(projector.recover(events)).resolves.toBe(1);
      expect(await store.get(tenantId, adaptive.sessionId, adaptive.automationId)).toMatchObject({
        phase: 'idle', activeRunId: undefined,
      });
      const execution = await pool.query(
        `SELECT state,terminal_status FROM ${store.tables.executions} WHERE run_id=$1`,
        [item.targetRunId],
      );
      expect(execution.rows).toEqual([{ state: 'terminal', terminal_status: status }]);
    },
  );

  it('keeps a shared cursor monotonic when a delayed non-terminal recover follows sequence 103', async () => {
    const consumerName = `cursor-race-${randomUUID()}`;
    const slow = new SessionAutomationTerminalProjector(store, consumerName);
    const fast = new SessionAutomationTerminalProjector(store, consumerName);
    let releasePage!: () => void;
    let pageRequested!: () => void;
    const requested = new Promise<void>((resolve) => { pageRequested = resolve; });
    const gate = new Promise<void>((resolve) => { releasePage = resolve; });
    const nonTerminal = {
      id: randomUUID(), timestamp: new Date().toISOString(), type: 'run_state_changed',
      runId: 'cursor-race-run', sessionId: 'cursor-race-session', status: 'running', previousStatus: 'pending',
    } as const;
    const delayedStore = {
      listGlobalPage: async () => {
        pageRequested();
        await gate;
        return { events: [{ globalSequence: 101, sessionSequence: 1, tenantId, sessionId: nonTerminal.sessionId, event: nonTerminal }], hasMore: false };
      },
    } as unknown as PgEventStore;

    const recovering = slow.recover(delayedStore);
    await requested;
    await fast.project({
      globalSequence: 103, tenantId, sessionId: 'cursor-race-session', runId: 'cursor-race-terminal', status: 'completed',
    });
    releasePage();
    await expect(recovering).resolves.toBe(0);

    await expect(slow.cursor()).resolves.toBe(103);
  });

  it('fails closed without advancing when recover observes an unknown run status', async () => {
    const projector = new SessionAutomationTerminalProjector(store, `cursor-unknown-${randomUUID()}`);
    const unknownEvent = {
      id: randomUUID(), timestamp: new Date().toISOString(), type: 'run_state_changed',
      runId: 'cursor-unknown-run', sessionId: 'cursor-unknown-session', status: 'future_terminal_status',
    };
    const unknownStore = {
      listGlobalPage: async () => ({
        events: [{ globalSequence: 101, sessionSequence: 1, tenantId, sessionId: unknownEvent.sessionId, event: unknownEvent }],
        hasMore: false,
      }),
    } as unknown as PgEventStore;

    await expect(projector.recover(unknownStore)).rejects.toThrow('unknown runtime run status');
    await expect(projector.cursor()).resolves.toBe(0);
  });

  it('does not advance the cursor on transient EventStore failure and releases active_run on retry', async () => {
    const adaptive = await createAutomation({
      kind: 'loop', mode: 'adaptive',
      spec: { kind: 'loop', mode: 'adaptive', prompt: 'continue', budget: {} },
    });
    const item = await dispatch({ ...adaptive, triggerKey: 'transient-retry', continuationEpoch: 1 });
    await events.append({
      type: 'run_finished', runId: item.targetRunId, sessionId: adaptive.sessionId,
      subtype: 'success', numTurns: 1,
    }, { tenantId });
    const projector = new SessionAutomationTerminalProjector(store, `transient-${randomUUID()}`);
    const transientStore = {
      listGlobalPage: events.listGlobalPage.bind(events),
      listPage: async () => { throw new Error('transient event store failure'); },
    } as unknown as PgEventStore;

    await expect(projector.recover(transientStore)).rejects.toThrow('transient event store failure');
    expect(await projector.cursor()).toBe(0);
    expect((await store.get(tenantId, adaptive.sessionId, adaptive.automationId))?.activeRunId).toBe(item.targetRunId);
    await expect(projector.recover(events)).resolves.toBeGreaterThan(0);
    expect((await store.get(tenantId, adaptive.sessionId, adaptive.automationId))?.activeRunId).toBeUndefined();
    expect(await projector.cursor()).toBeGreaterThan(0);
  });

  it('does not add no_checkpoint when UpdateGoal already persisted a continuation for the run lineage', async () => {
    const goal = await createAutomation({
      kind: 'goal', mode: 'goal',
      spec: { kind: 'goal', mode: 'goal', prompt: 'finish', completionCondition: 'done', budget: {} },
    });
    const item = await dispatch({ ...goal, triggerKey: 'goal-update', continuationEpoch: 7 });
    const flags = {
      read: () => ({
        controlEnabled: true, executionEnabled: true, fixedLoopEnabled: true,
        adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
      }),
      executionEnabled: () => true,
    };
    const tools = new SessionAutomationTools(store, flags);
    await expect(tools.updateGoal({
      action: 'continue', summary: 'keep going', tenantId, sessionId: goal.sessionId,
      automationId: goal.automationId, incarnationId: goal.incarnationId, generation: 1,
      specVersion: 1, executionId: item.outboxId, runId: item.targetRunId,
    })).resolves.toEqual({ accepted: true });

    await new SessionAutomationTerminalProjector(store, `goal-existing-${randomUUID()}`).project({
      globalSequence: 1, tenantId, sessionId: goal.sessionId, runId: item.targetRunId, status: 'completed',
    });
    const pending = await pool.query(
      `SELECT trigger_key FROM ${store.tables.wakeups}
        WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,
      [tenantId, goal.automationId],
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].trigger_key).toContain(`:from:${item.targetRunId}`);
    expect(pending.rows[0].trigger_key).not.toContain('no_checkpoint');
  });


  it('uses persisted evaluating phase to fence claimDue, claimDispatch, and markDispatched', async () => {
    const goal = await createAutomation({
      kind: 'goal', mode: 'goal',
      spec: { kind: 'goal', mode: 'goal', prompt: 'finish', completionCondition: 'done', budget: {} },
    });
    await store.tx(client => store.scheduleTx(client, {
      tenantId, sessionId: goal.sessionId, automationId: goal.automationId,
      incarnationId: goal.incarnationId, generation: 1, specVersion: 1, continuationEpoch: 2,
      triggerKey: `goal:${goal.automationId}:g1:e2:fence`, dueAt: new Date(0), payload: {},
    }));
    await pool.query(`UPDATE ${store.tables.automations} SET phase='evaluating',active_run_id=NULL
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`, [tenantId,goal.sessionId,goal.automationId]);
    await expect(store.claimDue()).resolves.toBe(0);

    await pool.query(`UPDATE ${store.tables.automations} SET phase='waiting'
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`, [tenantId,goal.sessionId,goal.automationId]);
    await expect(store.claimDue()).resolves.toBe(1);
    await pool.query(`UPDATE ${store.tables.automations} SET phase='evaluating'
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`, [tenantId,goal.sessionId,goal.automationId]);
    await expect(store.claimDispatch()).resolves.toEqual([]);

    await pool.query(`UPDATE ${store.tables.automations} SET phase='waiting'
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`, [tenantId,goal.sessionId,goal.automationId]);
    const item=(await store.claimDispatch()).find(candidate=>candidate.automationId===goal.automationId)!;
    expect(item).toBeDefined();
    await pool.query(`UPDATE ${store.tables.automations} SET phase='evaluating'
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`, [tenantId,goal.sessionId,goal.automationId]);
    await expect(store.markDispatched(item)).rejects.toThrow('dispatch fence lost');
    expect(await store.get(tenantId,goal.sessionId,goal.automationId)).toMatchObject({phase:'evaluating',activeRunId:undefined});
  });

  it('rejects an invalid frozen candidate and restores exactly one continuation idempotently', async () => {
    const goal = await createAutomation({
      kind: 'goal', mode: 'goal', continuationEpoch: 4,
      spec: { kind: 'goal', mode: 'goal', prompt: 'finish', completionCondition: 'done', budget: {} },
    });
    const item = await dispatch({ ...goal, triggerKey: 'goal-invalid-candidate', continuationEpoch: 4 });
    await pool.query(`INSERT INTO ${store.tables.goalCompletionCandidates}
      (candidate_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,run_id,summary,evidence_refs,evidence_manifest,evidence_manifest_hash)
      VALUES($1,$2,$3,$4,$5,$6,1,1,$7,'done','[]','{}','invalid')`,
    [randomUUID(),tenantId,goal.sessionId,goal.automationId,item.outboxId,goal.incarnationId,item.targetRunId]);
    const projector=new SessionAutomationTerminalProjector(store,`invalid-candidate-${randomUUID()}`);
    const terminal={globalSequence:41,tenantId,sessionId:goal.sessionId,runId:item.targetRunId,status:'completed' as const};
    await expect(projector.project(terminal)).resolves.toBe(true);
    await expect(projector.project(terminal)).resolves.toBe(false);
    const successors=await pool.query(`SELECT trigger_key,state FROM ${store.tables.wakeups}
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4
        AND generation=1 AND spec_version=1 AND state IN ('pending','claimed')`,
    [tenantId,goal.sessionId,goal.automationId,goal.incarnationId]);
    expect(successors.rows).toHaveLength(1);
    expect(successors.rows[0].trigger_key).toContain(`:from:${item.targetRunId}:no_checkpoint`);
    expect(await store.get(tenantId,goal.sessionId,goal.automationId)).toMatchObject({status:'active',phase:'waiting'});
    expect((await pool.query(`SELECT rejection_reason FROM ${store.tables.goalCompletionCandidates} WHERE execution_id=$1`,[item.outboxId])).rows[0].rejection_reason).toBeTruthy();
  });

  it('continues a goal with no_checkpoint and eventually applies no-progress pause', async () => {
    const goal = await createAutomation({
      kind: 'goal', mode: 'goal',
      spec: { kind: 'goal', mode: 'goal', prompt: 'finish', completionCondition: 'done', budget: {} },
    });
    const projector = new SessionAutomationTerminalProjector(store, `goal-no-checkpoint-${randomUUID()}`, 2);
    let item = await dispatch({ ...goal, triggerKey: 'goal-first', continuationEpoch: 0 });
    for (let sequence = 1; sequence <= 3; sequence++) {
      await projector.project({
        globalSequence: sequence, tenantId, sessionId: goal.sessionId,
        runId: item.targetRunId, status: 'completed',
      });
      if (sequence < 3) {
        const snapshot = await store.get(tenantId, goal.sessionId, goal.automationId);
        expect(snapshot).toMatchObject({ status: 'active', phase: 'waiting' });
        const pending = await pool.query(
          `SELECT trigger_key FROM ${store.tables.wakeups}
            WHERE tenant_id=$1 AND automation_id=$2 AND state='pending'`,
          [tenantId, goal.automationId],
        );
        expect(pending.rows).toHaveLength(1);
        expect(pending.rows[0].trigger_key).toContain('no_checkpoint');
        await store.claimDue();
        item = (await store.claimDispatch()).find(candidate => candidate.automationId === goal.automationId)!;
        await runs.createPending({ runId: item.targetRunId, sessionId: goal.sessionId, tenantId, userId: 'user-a' });
        await store.markDispatched(item);
      }
    }
    expect(await store.get(tenantId, goal.sessionId, goal.automationId)).toMatchObject({
      status: 'paused', phase: 'idle', lastError: 'no_progress', noProgressCount: 2,
    });
    const pending = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tables.wakeups}
        WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`,
      [tenantId, goal.automationId],
    );
    expect(pending.rows[0].count).toBe(0);
  });
});
