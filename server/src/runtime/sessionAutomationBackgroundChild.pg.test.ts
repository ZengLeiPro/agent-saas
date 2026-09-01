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
import { PgToolInvocationStore } from './toolInvocationStore.js';
import type { RunContext } from './types.js';

const { Pool } = pg;
const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip; // real PostgreSQL recovery coverage

describePg('automation background child recovery on PostgreSQL', () => {
  const prefix = `abc_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
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
    runs = new PgRunStore({ pool, tablePrefix: prefix, writerCapability: { capability: 'tenant-native-v1', allowPrivilegedRoleForTests: true } });
    await runs.init();
    await new PgToolInvocationStore({ pool, tablePrefix: prefix }).init();
    store = new PgSessionAutomationStore(pool, prefix, runs.runsTable);
    await store.init();
    guard = new SessionAutomationRuntimeGuard(pool, () => true, prefix, runs.runsTable);
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
    await runs.markStatus(dispatch.targetRunId, 'running', 'automation_execution_started');
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

  async function preparedInterruptedChild(childStatus: 'pending' | 'running' = 'running') {
    const setup = await activeExecution();
    const parentRunId = `bg-${randomUUID()}`;
    const parentSessionId = `bg-session-${randomUUID()}`;
    const childRunId = `child-${randomUUID()}`;
    const childSessionId = `child-session-${randomUUID()}`;
    const rootFence = {
      ...setup.context.automationFence!, runId: parentRunId,
      rootSessionId: setup.sessionId, rootRunId: setup.dispatch.targetRunId,
    };
    await runs.createPending({
      runId: parentRunId, tenantId, sessionId: parentSessionId, userId: 'user-a',
      metadata: {
        backgroundTask: true, automationFence: rootFence,
        executionChildSessionId: childSessionId, executionChildRunId: childRunId,
      },
    });
    await runs.createPending({
      runId: childRunId, tenantId, sessionId: childSessionId, userId: 'user-a',
      metadata: {
        subagent: true, parentRunId, parentSessionId,
        automationFence: { ...rootFence, runId: childRunId },
      },
    });
    const context = {
      tenantId, sessionId: parentSessionId, runId: parentRunId, automationFence: rootFence,
    } as RunContext;
    await guard.recordBackgroundResource(context, parentRunId, { childSessionId, childRunId }, 'prepared');
    await pool.query(
      `UPDATE ${runs.runsTable}
          SET status=CASE WHEN run_id=$1 THEN 'running' ELSE $3 END,
              worker_id='dead-worker',lease_expires_at=now()-interval '1 minute'
        WHERE run_id=ANY($2::text[])`,
      [parentRunId, [parentRunId, childRunId], childStatus],
    );
    return { setup, context, parentRunId, parentSessionId, childRunId, childSessionId };
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
        const { childRunId, childSessionId } = params.preparedChildIdentity!;
        await params.beforeChildSideEffects?.({ childSessionId, childRunId });
        await guard.recordBackgroundResource(
          {
            tenantId,
            sessionId: params.parentContext.sessionId!,
            runId: params.parentContext.runId!,
            automationFence: params.parentContext.automationFence,
          },
          persisted!.runId,
          { childSessionId, childRunId },
          'prepared',
        );
        await params.beforeChildSideEffects?.({ childSessionId, childRunId });
        const preparedResource = await pool.query(
          `SELECT state,provider_resource_id,metadata FROM ${store.tables.backgroundResources}
            WHERE tenant_id=$1 AND resource_key=$2`,
          [tenantId, persisted!.runId],
        );
        expect(preparedResource.rows[0]).toMatchObject({
          state: 'prepared', provider_resource_id: childRunId, metadata: { childSessionId, childRunId },
        });
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
        await runs.markStatus(childRunId, 'running', 'subagent_started');
        await params.onChildRunCreated?.({ childSessionId, childRunId, model: 'test-model' });
        await params.beforeChildSideEffects?.({ childSessionId, childRunId });
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
        const replay = await guard.beforeModel(childContext, 'turn:background-child:first', {
          model: 'test-model', inputTokens: 10, maxOutputTokens: 20,
        });
        expect(replay?.providerAttemptId).toBe(attempt!.providerAttemptId);
        expect(replay?.sourceKey).toBe(attempt!.sourceKey);
        await guard.finishModel(childContext, attempt, { inputTokens: 10, outputTokens: 5 });
        await runs.markStatus(childRunId, 'completed', 'subagent_completed');
        expect((await runs.get(childRunId))?.status).toBe('completed');
        return {
          status: 'completed', text: 'done', totalTokens: 15, toolUseCount: 0, turnCount: 1,
          durationMs: 1, childSessionId, childRunId, model: 'test-model',
        } satisfies SubagentOutcome;
      },
    });
    const runningParent = await runs.markStatus(persisted!.runId, 'running', 'background_worker_started');
    await restored.execute(runningParent!);
    if (!childContext) {
      const failed = await runs.get(persisted!.runId);
      throw new Error(`background child did not start: ${JSON.stringify(failed?.metadata.backgroundResult)}`);
    }
    const released = await pool.query(
      `SELECT state FROM ${store.tables.backgroundResources} WHERE tenant_id=$1 AND resource_key=$2`,
      [tenantId, persisted!.runId],
    );
    if (released.rows[0]?.state !== 'released') {
      const failed = await runs.get(persisted!.runId);
      throw new Error(`background child resource did not release: ${JSON.stringify(failed?.metadata.backgroundResult)}`);
    }

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

  it('rejects the remote dispatch barrier when the root execution Run is already terminal', async () => {
    const prepared = await preparedInterruptedChild();
    await runs.markStatus(prepared.setup.dispatch.targetRunId, 'completed', 'root_terminal_race');

    await expect(guard.recordBackgroundResource(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId }, 'active',
    )).rejects.toMatchObject({ reason: 'background_dispatch_authority_lost' });
    expect((await pool.query(
      `SELECT state FROM ${store.tables.backgroundResources} WHERE resource_key=$1`,
      [prepared.parentRunId],
    )).rows[0]?.state).toBe('prepared');
  });

  it('releases an active resource only after the authoritative child Run is terminal', async () => {
    const prepared = await preparedInterruptedChild();
    await guard.recordBackgroundResource(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId }, 'active',
    );
    await runs.markStatus(prepared.childRunId, 'completed', 'subagent_completed');

    await expect(guard.resolveBackgroundResourceFromChild(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId },
    )).resolves.toBe('released');
    expect((await pool.query(
      `SELECT state FROM ${store.tables.backgroundResources} WHERE resource_key=$1`,
      [prepared.parentRunId],
    )).rows[0]?.state).toBe('released');
  });

  it('parks an active resource and lifecycle work as result_unknown when child terminality is unknown', async () => {
    const prepared = await preparedInterruptedChild();
    await guard.recordBackgroundResource(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId }, 'active',
    );
    const resource = (await pool.query(
      `SELECT background_resource_id FROM ${store.tables.backgroundResources} WHERE resource_key=$1`,
      [prepared.parentRunId],
    )).rows[0];
    await pool.query(
      `INSERT INTO ${store.tables.lifecycleWork}
        (work_id,tenant_id,session_id,automation_id,incarnation_id,generation,
         object_incarnation_id,object_generation,object_type,object_id,action)
       VALUES($1,$2,$3,$4,$5,1,$5,1,'background_resource',$6,'release')`,
      [randomUUID(), tenantId, prepared.setup.sessionId, prepared.setup.automationId,
        prepared.setup.incarnationId, resource.background_resource_id],
    );

    await expect(guard.resolveBackgroundResourceFromChild(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId },
    )).resolves.toBe('result_unknown');
    expect((await pool.query(
      `SELECT state FROM ${store.tables.backgroundResources} WHERE resource_key=$1`,
      [prepared.parentRunId],
    )).rows[0]?.state).toBe('result_unknown');
    expect((await pool.query(
      `SELECT state FROM ${store.tables.lifecycleWork} WHERE object_id=$1`,
      [resource.background_resource_id],
    )).rows[0]?.state).toBe('result_unknown');
    expect(await store.get(tenantId, prepared.setup.sessionId, prepared.setup.automationId))
      .toMatchObject({ status: 'reconcile_required' });
  });

  it('atomically requeues a running prepared child and clears both run leases', async () => {
    const prepared = await preparedInterruptedChild();
    await expect(guard.recoverInterruptedBackgroundChild(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId },
    )).resolves.toBe('requeued');
    const rows = await pool.query(
      `SELECT run_id,status,worker_id,lease_expires_at,metadata FROM ${runs.runsTable}
        WHERE run_id=ANY($1::text[]) ORDER BY run_id`,
      [[prepared.parentRunId, prepared.childRunId]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every(row => row.status === 'pending'
      && row.worker_id === null && row.lease_expires_at === null)).toBe(true);
    expect(rows.rows.find(row => row.run_id === prepared.parentRunId)?.metadata)
      .toMatchObject({ executionChildRunId: prepared.childRunId });
  });

  it('recovers a prepared checkpoint with a pending child and clears both run leases', async () => {
    const prepared = await preparedInterruptedChild('pending');
    const before = await pool.query(
      `SELECT run_id,status,worker_id,lease_expires_at FROM ${runs.runsTable}
        WHERE run_id=ANY($1::text[]) ORDER BY run_id`,
      [[prepared.parentRunId, prepared.childRunId]],
    );
    expect(before.rows.find(row => row.run_id === prepared.parentRunId))
      .toMatchObject({ status: 'running', worker_id: 'dead-worker' });
    expect(before.rows.find(row => row.run_id === prepared.childRunId))
      .toMatchObject({ status: 'pending', worker_id: 'dead-worker' });

    await expect(guard.recoverInterruptedBackgroundChild(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId },
    )).resolves.toBe('requeued');

    const recovered = await pool.query(
      `SELECT run_id,status,worker_id,lease_expires_at FROM ${runs.runsTable}
        WHERE run_id=ANY($1::text[]) ORDER BY run_id`,
      [[prepared.parentRunId, prepared.childRunId]],
    );
    expect(recovered.rows).toHaveLength(2);
    expect(recovered.rows.every(row => row.status === 'pending'
      && row.worker_id === null && row.lease_expires_at === null)).toBe(true);
  });

  it('does not requeue active resources and retains cancellation authority', async () => {
    const prepared = await preparedInterruptedChild();
    await guard.recordBackgroundResource(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId }, 'active',
    );
    await expect(guard.recoverInterruptedBackgroundChild(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId },
    )).resolves.toBe('reconcile_required');
    expect((await pool.query(
      `SELECT state FROM ${store.tables.backgroundResources} WHERE resource_key=$1`,
      [prepared.parentRunId],
    )).rows[0]?.state).toBe('active');
    expect(await store.get(tenantId, prepared.setup.sessionId, prepared.setup.automationId))
      .toMatchObject({ status: 'reconcile_required' });
  });

  it.each(['provider', 'interaction', 'tool'] as const)(
    'does not requeue a prepared child after a %s side effect', async sideEffect => {
      const prepared = await preparedInterruptedChild();
      const childContext = {
        ...prepared.context, sessionId: prepared.childSessionId, runId: prepared.childRunId,
        model: 'test-model',
        automationFence: { ...prepared.context.automationFence!, runId: prepared.childRunId },
      } as RunContext;
      if (sideEffect === 'provider') {
        await guard.beforeModel(childContext, `recovery:${randomUUID()}`, {
          model: 'test-model', inputTokens: 1, maxOutputTokens: 1,
        });
      } else if (sideEffect === 'interaction') {
        await guard.recordInteraction(childContext, `interaction:${randomUUID()}`, 'approval', 'active', {});
      } else {
        await pool.query(
          `INSERT INTO ${prefix}_tool_invocations
            (invocation_id,tenant_id,run_id,session_id,tool_call_id,tool_name,execution_target,status,started_at,updated_at)
           VALUES($1,$2,$3,$4,'call-1','Shell','server-container','running',now(),now())`,
          [randomUUID(), tenantId, prepared.childRunId, prepared.childSessionId],
        );
      }
      await expect(guard.recoverInterruptedBackgroundChild(
        prepared.context, prepared.parentRunId,
        { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId },
      )).resolves.toBe('reconcile_required');
      expect((await runs.get(prepared.parentRunId))?.status).toBe('running');
    },
  );

  it('preserves a concurrent cancellation and never revives either identity', async () => {
    const prepared = await preparedInterruptedChild();
    await runs.markStatus(prepared.parentRunId, 'cancelled', 'user_cancelled');
    await expect(guard.recoverInterruptedBackgroundChild(
      prepared.context, prepared.parentRunId,
      { childSessionId: prepared.childSessionId, childRunId: prepared.childRunId },
    )).resolves.toBe('terminal_preserved');
    expect(await runs.get(prepared.parentRunId)).toMatchObject({ status: 'cancelled' });
    expect((await runs.get(prepared.childRunId))?.status).toBe('running');
  });

});
