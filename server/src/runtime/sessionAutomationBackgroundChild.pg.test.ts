import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultExecutionTransportRegistry, type ToolCallContext } from '../agent/toolRuntime.js';
import { DurableBackgroundTaskService } from './background/backgroundTaskService.js';
import { PgEventStore } from './pgEventStore.js';
import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatch.js';
import { PgRunStore } from './runStore.js';
import type { RuntimeSessionRecord, SessionCatalog } from './sessionCatalog.js';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';
import { SessionAutomationRuntimeGuard } from './sessionAutomationRuntimeGuard.js';
import { deriveChildAutomationFence, type SubagentOutcome } from './subagent/subagentRunner.js';
import { createTenantRemoteHandAuthTokenResolver } from './tenantRemoteHandResolver.js';
import type { RunContext } from './types.js';

const { Pool } = pg;
const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

describePg('automation background child recovery on PostgreSQL', () => {
  const prefix = `automation_background_child_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const tenantId = 'tenant-automation-background-child';
  let pool: InstanceType<typeof Pool>;
  let events: PgEventStore;
  let runs: PgRunStore;
  let store: PgSessionAutomationStore;
  let guard: SessionAutomationRuntimeGuard;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 8 });
    events = new PgEventStore({ connectionString: url!, tablePrefix: prefix, poolMax: 4 });
    await events.init();
    runs = new PgRunStore({ pool, tablePrefix: prefix });
    await runs.init();
    store = new PgSessionAutomationStore(pool, prefix, runs.runsTable);
    await store.init();
    guard = new SessionAutomationRuntimeGuard(pool, prefix, runs.runsTable);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await events.close();
    await pool.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '${prefix}_%'
      LOOP EXECUTE format('DROP TABLE IF EXISTS %I CASCADE',r.tablename); END LOOP;
    END $$`).catch(() => undefined);
    await pool.end();
  }, 30_000);

  async function activeExecution() {
    const automationId = randomUUID();
    const incarnationId = randomUUID();
    const sessionId = `session-automation-background-${randomUUID()}`;
    await pool.query(
      `INSERT INTO ${store.tables.automations}
        (automation_id,tenant_id,session_id,owner_user_id,incarnation_id,kind,mode,status,phase,generation,spec_version,control_version,projection_version)
       VALUES($1,$2,$3,'user-a',$4,'goal','goal','active','idle',1,1,1,1)`,
      [automationId, tenantId, sessionId, incarnationId],
    );
    await pool.query(
      `INSERT INTO ${store.tables.specs}
        (automation_id,tenant_id,session_id,spec_version,spec_digest,spec)
       VALUES($1,$2,$3,1,$4,$5)`,
      [automationId, tenantId, sessionId, randomUUID(), JSON.stringify({
        kind: 'goal', mode: 'adaptive', prompt: 'continue', condition: 'done', budget: {},
      })],
    );
    await pool.query(
      `INSERT INTO ${store.tables.completionAllowances}
        (automation_id,tenant_id,session_id,remaining_attempts,max_output_tokens)
       VALUES($1,$2,$3,2,500)`,
      [automationId, tenantId, sessionId],
    );
    await store.tx(client => store.scheduleTx(client, {
      tenantId, sessionId, automationId, incarnationId, generation: 1, specVersion: 1,
      continuationEpoch: 1, triggerKey: `initial:${automationId}`, dueAt: new Date(0), payload: {},
    }));
    await store.claimDue();
    const dispatch = (await store.claimDispatch(20)).find(item => item.automationId === automationId)!;
    await store.prepareDispatch(dispatch, { prompt: 'continue' });
    await runs.createPending({
      runId: dispatch.targetRunId, tenantId, sessionId, userId: 'user-a', metadata: { schedulerState: 'staged' },
    });
    await store.markDispatched(dispatch);
    const context = {
      runId: dispatch.targetRunId,
      sessionId,
      tenantId,
      model: 'test-model',
      automationFence: {
        automationId, incarnationId, generation: 1, specVersion: 1,
        executionId: dispatch.outboxId, runId: dispatch.targetRunId,
      },
    } as RunContext;
    return { automationId, incarnationId, sessionId, dispatch, context };
  }

  it('persists and restores background-agent lineage through resource lifecycle and first child admission', async () => {
    const setup = await activeExecution();
    const rootFence = {
      ...setup.context.automationFence!,
      rootSessionId: setup.sessionId,
      rootRunId: setup.dispatch.targetRunId,
    };
    const sessions = new Map<string, RuntimeSessionRecord>();
    const now = new Date().toISOString();
    sessions.set(setup.sessionId, {
      sessionId: setup.sessionId,
      userId: 'user-a',
      username: 'alice',
      userRole: 'user',
      tenantId,
      channel: 'web',
      cwd: '/tmp/automation-background',
      transcriptPath: `/tmp/nonexistent-${randomUUID()}.jsonl`,
      modelRef: 'test-model',
      executionTarget: 'server-container',
      workspaceId: setup.sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
    const sessionCatalog: SessionCatalog = {
      get: async id => sessions.get(id) ?? null,
      upsert: async record => { sessions.set(record.sessionId, record); },
      ensure: async record => { if (!sessions.has(record.sessionId)) sessions.set(record.sessionId, record); },
      findTranscriptPath: async id => sessions.get(id)?.transcriptPath ?? null,
      markStatus: async (id, status) => {
        const current = sessions.get(id);
        if (!current) return;
        sessions.set(id, { ...current, status, updatedAt: new Date().toISOString() });
      },
    };
    const config = {
      agentCwd: '/tmp/automation-background',
      sharedDir: '/tmp',
      runStore: runs,
      sessionCatalog,
      eventStoreFactory: () => events,
      executionTransportRegistry: createDefaultExecutionTransportRegistry(),
      tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({}),
      sessionAutomationRuntimeGuard: guard,
    } as RawRuntimeRunDispatchConfig;
    const context = {
      channelContext: {
        channel: 'web',
        sessionOwner: { id: 'user-a', username: 'alice', role: 'user', tenantId },
      },
      workspace: {
        id: setup.sessionId,
        root: '/tmp/automation-background',
        userId: 'user-a',
        username: 'alice',
        tenantId,
        sessionId: setup.sessionId,
        executionTarget: 'server-container',
      },
      sessionId: setup.sessionId,
      runId: setup.dispatch.targetRunId,
      toolCallId: 'automation-background-agent',
      automationFence: rootFence,
    } as ToolCallContext;
    const creator = new DurableBackgroundTaskService(config);
    const started = await creator.enqueue(context, {
      description: 'automation background agent',
      prompt: 'continue in background',
      agentType: 'general',
      includeCompanyInfo: false,
    });
    const persisted = await runs.get(started.taskId);
    expect(persisted?.metadata.automationFence).toMatchObject({
      rootSessionId: setup.sessionId,
      rootRunId: setup.dispatch.targetRunId,
      runId: started.taskId,
    });

    let childContext!: RunContext;
    const restored = new DurableBackgroundTaskService(config, {
      runSubagentImpl: async params => {
        expect(params.parentContext).toMatchObject({
          sessionId: persisted!.sessionId,
          runId: persisted!.runId,
          automationFence: {
            rootSessionId: setup.sessionId,
            rootRunId: setup.dispatch.targetRunId,
            runId: persisted!.runId,
          },
        });
        const childRunId = `child-${randomUUID()}`;
        const childSessionId = `child-session-${randomUUID()}`;
        await runs.createPending({
          runId: childRunId,
          tenantId,
          sessionId: childSessionId,
          userId: 'user-a',
          metadata: {
            subagent: true,
            parentRunId: persisted!.runId,
            parentSessionId: persisted!.sessionId,
          },
        });
        await params.onChildRunCreated?.({ childSessionId, childRunId, model: 'test-model' });
        const active = await pool.query(
          `SELECT state,session_id,run_id,provider_resource_id,metadata FROM ${store.tables.backgroundResources}
            WHERE tenant_id=$1 AND resource_key=$2`,
          [tenantId, persisted!.runId],
        );
        expect(active.rows[0]).toMatchObject({
          state: 'active',
          session_id: setup.sessionId,
          run_id: setup.dispatch.targetRunId,
          provider_resource_id: childRunId,
          metadata: {
            childRunId,
            invokingSessionId: persisted!.sessionId,
            invokingRunId: persisted!.runId,
            rootSessionId: setup.sessionId,
            rootRunId: setup.dispatch.targetRunId,
          },
        });
        childContext = {
          ...setup.context,
          sessionId: childSessionId,
          runId: childRunId,
          automationFence: deriveChildAutomationFence(
            params.parentContext.automationFence,
            childRunId,
            { sessionId: persisted!.sessionId, runId: persisted!.runId },
          ),
        } as RunContext;
        const attempt = await guard.beforeModel(childContext, 'turn:background-child:first', {
          model: 'test-model', inputTokens: 10, maxOutputTokens: 20,
        });
        expect(attempt).toBeDefined();
        const providerAttempt = await pool.query(
          `SELECT session_id,run_id,invoking_session_id,invoking_run_id
             FROM ${store.tables.providerAttempts} WHERE provider_attempt_id=$1`,
          [attempt!.providerAttemptId],
        );
        expect(providerAttempt.rows[0]).toMatchObject({
          session_id: setup.sessionId,
          run_id: setup.dispatch.targetRunId,
          invoking_session_id: childSessionId,
          invoking_run_id: childRunId,
        });
        await guard.finishModel(childContext, attempt, { inputTokens: 10, outputTokens: 5 });
        return {
          status: 'completed', text: 'done', totalTokens: 15, toolUseCount: 0, turnCount: 1,
          durationMs: 1, childSessionId, childRunId, model: 'test-model',
        } satisfies SubagentOutcome;
      },
    });
    await restored.execute(persisted!);
    const released = await pool.query(
      `SELECT state FROM ${store.tables.backgroundResources} WHERE tenant_id=$1 AND resource_key=$2`,
      [tenantId, persisted!.runId],
    );
    expect(released.rows[0]?.state).toBe('released');

    await expect(guard.beforeModel({
      ...childContext,
      automationFence: { ...childContext.automationFence!, rootSessionId: `${setup.sessionId}-spoofed` },
    }, 'turn:spoof-root-session', { model: 'test-model', inputTokens: 1, maxOutputTokens: 1 }))
      .rejects.toMatchObject({ reason: 'automation_not_found' });
    await expect(guard.beforeModel({
      ...childContext,
      automationFence: { ...childContext.automationFence!, rootRunId: `root-${randomUUID()}` },
    }, 'turn:spoof-root-run', { model: 'test-model', inputTokens: 1, maxOutputTokens: 1 }))
      .rejects.toMatchObject({ reason: 'execution_mismatch' });
    await expect(guard.beforeModel({ ...childContext, runId: `invoking-${randomUUID()}` },
      'turn:spoof-invoking-run', { model: 'test-model', inputTokens: 1, maxOutputTokens: 1 }))
      .rejects.toMatchObject({ reason: 'context_run_mismatch' });
  });

});
