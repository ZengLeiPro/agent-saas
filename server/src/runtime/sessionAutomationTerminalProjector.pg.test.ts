import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionAutomationTools } from '../agent/tools/sessionAutomationTools.js';
import { PgEventStore } from './pgEventStore.js';
import { PgRunStore } from './runStore.js';
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
    mode: 'fixed' | 'adaptive';
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

  async function projectUsage(providerUsage?: { turns: number; tokens: number; credits: number }) {
    const adaptive = await createAutomation({
      kind: 'loop', mode: 'adaptive',
      spec: { kind: 'loop', mode: 'adaptive', prompt: 'continue', budget: { maxTurns: 4, maxTokens: 31, maxCredits: 4 } },
    });
    const item = await dispatch({ ...adaptive, triggerKey: `usage-${randomUUID()}`, continuationEpoch: 1 });
    if (providerUsage) {
      await store.recordUsage({
        tenantId, sessionId: adaptive.sessionId, automationId: adaptive.automationId,
        executionId: item.outboxId, sourceKey: `provider:${randomUUID()}`, sourceKind: 'model',
        ...providerUsage,
      });
    }
    await new SessionAutomationTerminalProjector(store, `usage-${randomUUID()}`).project({
      globalSequence: 1, tenantId, sessionId: adaptive.sessionId, runId: item.targetRunId,
      status: 'completed', numTurns: 3,
      modelUsage: { model: { inputTokens: 20, outputTokens: 10, reasoningTokens: 0, costUSD: 3 } },
    });
    const usage = await pool.query(
      `SELECT source_kind,turns,tokens,credits::text FROM ${store.tables.usage}
        WHERE tenant_id=$1 AND automation_id=$2 ORDER BY source_kind`,
      [tenantId, adaptive.automationId],
    );
    await expect(resolveAutomationBudgetReason({
      client: pool, tables: store.tables, tablePrefix: prefix, runsTable: runs.runsTable,
      tenantId, sessionId: adaptive.sessionId, automationId: adaptive.automationId,
    })).resolves.toBeUndefined();
    return usage.rows;
  }

  it('records the positive terminal delta when provider model usage is partial', async () => {
    await expect(projectUsage({ turns: 1, tokens: 10, credits: 1_000_000 })).resolves.toEqual([
      { source_kind: 'automation_run', turns: '2', tokens: '20', credits: '2000000' },
      { source_kind: 'model', turns: '1', tokens: '10', credits: '1000000' },
    ]);
  });

  it('records a zero terminal delta when provider model usage is complete', async () => {
    await expect(projectUsage({ turns: 3, tokens: 30, credits: 3_000_000 })).resolves.toEqual([
      { source_kind: 'automation_run', turns: '0', tokens: '0', credits: '0' },
      { source_kind: 'model', turns: '3', tokens: '30', credits: '3000000' },
    ]);
  });

  it('records the complete terminal aggregate when provider model usage is absent', async () => {
    await expect(projectUsage()).resolves.toEqual([
      { source_kind: 'automation_run', turns: '3', tokens: '30', credits: '3000000' },
    ]);
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
      kind: 'goal', mode: 'adaptive',
      spec: { kind: 'goal', mode: 'adaptive', prompt: 'finish', completionCondition: 'done', budget: {} },
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

  it('continues a goal with no_checkpoint and eventually applies no-progress pause', async () => {
    const goal = await createAutomation({
      kind: 'goal', mode: 'adaptive',
      spec: { kind: 'goal', mode: 'adaptive', prompt: 'finish', completionCondition: 'done', budget: {} },
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
