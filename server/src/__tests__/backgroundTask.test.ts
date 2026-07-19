import { describe, expect, it } from 'vitest';

import { createDefaultExecutionTransportRegistry, type ToolCallContext } from '../agent/toolRuntime.js';
import { DurableBackgroundTaskService, escapeXml } from '../runtime/background/backgroundTaskService.js';
import type {
  ListBackgroundTasksOptions,
  RunRecord,
  RunStatus,
  RunStore,
  UpsertRunInput,
} from '../runtime/runStore.js';
import { BackgroundTaskLimitError, PgRunStore } from '../runtime/runStore.js';
import type {
  RuntimeSessionRecord,
  RuntimeSessionStatus,
  SessionCatalog,
} from '../runtime/sessionCatalog.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { SubagentOutcome } from '../runtime/subagent/subagentRunner.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

class MemoryEventStore implements EventStore {
  events: PlatformEvent[] = [];
  async append(event: PlatformEventInput): Promise<PlatformEvent> {
    const stored = {
      ...event,
      id: `event-${this.events.length + 1}`,
      timestamp: new Date().toISOString(),
    } as PlatformEvent;
    this.events.push(stored);
    return stored;
  }
  async list(sessionId: string): Promise<PlatformEvent[]> {
    return this.events.filter((event) => event.sessionId === sessionId);
  }
}

class MemorySessionCatalog implements SessionCatalog {
  records = new Map<string, RuntimeSessionRecord>();
  async upsert(record: RuntimeSessionRecord): Promise<void> { this.records.set(record.sessionId, record); }
  async get(sessionId: string): Promise<RuntimeSessionRecord | null> { return this.records.get(sessionId) ?? null; }
  async markStatus(sessionId: string, status: RuntimeSessionStatus): Promise<void> {
    const record = this.records.get(sessionId);
    if (record) this.records.set(sessionId, { ...record, status });
  }
  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return this.records.get(sessionId)?.transcriptPath ?? null;
  }
}

class BackgroundRunStore implements RunStore {
  records = new Map<string, RunRecord>();

  async upsertPending(input: UpsertRunInput): Promise<RunRecord> {
    const existing = this.records.get(input.runId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId: input.runId,
      sessionId: input.sessionId,
      userId: input.userId,
      tenantId: input.tenantId,
      status: 'pending',
      model: input.model,
      channel: input.channel,
      requestedAt: now,
      updatedAt: now,
      executionTarget: input.executionTarget,
      workspaceId: input.workspaceId,
      metadata: input.metadata ?? {},
    };
    this.records.set(record.runId, record);
    return record;
  }

  async markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    const updated = { ...record, status, statusReason: reason, metadata: { ...record.metadata, ...metadataPatch } };
    this.records.set(runId, updated);
    return updated;
  }
  async get(runId: string): Promise<RunRecord | null> { return this.records.get(runId) ?? null; }
  async findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) => record.userId === userId && record.idempotencyKey === idempotencyKey) ?? null;
  }
  async listRecoverable(): Promise<RunRecord[]> { return []; }
  async getActiveBySession(sessionId: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) => (
      record.sessionId === sessionId && ['pending', 'running'].includes(record.status)
    )) ?? null;
  }
  async listBackgroundTasks(parentSessionId: string, options: ListBackgroundTasksOptions = {}): Promise<RunRecord[]> {
    return [...this.records.values()].filter((record) => (
      record.metadata.backgroundTask === true
      && record.metadata.parentSessionId === parentSessionId
      && (!options.userId || record.userId === options.userId)
      && (!options.tenantId || record.tenantId === options.tenantId)
    ));
  }
  async enqueueBackgroundTask(input: UpsertRunInput): Promise<RunRecord> { return this.upsertPending(input); }
  async listPendingBackgroundTaskWakes(): Promise<RunRecord[]> {
    return [...this.records.values()].filter((record) => (
      record.metadata.backgroundTask === true
      && ['completed', 'failed', 'cancelled', 'orphaned'].includes(record.status)
      && record.metadata.wakeState === 'pending'
    ));
  }
  async claimBackgroundTaskWake(runId: string, claimToken: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.metadata.wakeState !== 'pending') return null;
    return this.markStatus(runId, record.status, record.statusReason, {
      wakeState: 'delivering',
      wakeClaimToken: claimToken,
    });
  }
  async finishBackgroundTaskWake(
    runId: string,
    claimToken: string,
    state: 'pending' | 'queued' | 'discarded',
    metadataPatch: Record<string, unknown> = {},
  ): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.metadata.wakeClaimToken !== claimToken) return null;
    return this.markStatus(runId, record.status, record.statusReason, {
      ...metadataPatch,
      wakeState: state,
      wakeClaimToken: null,
    });
  }
}

function session(sessionId: string): RuntimeSessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId,
    userId: 'user-1',
    username: 'alice',
    userRole: 'user',
    tenantId: 'tenant-1',
    channel: 'web',
    cwd: '/tmp/workspace',
    transcriptPath: `/tmp/nonexistent-${sessionId}.jsonl`,
    modelRef: 'group/model',
    executionTarget: 'server-container',
    workspaceId: sessionId,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
}

function completedTask(resultText: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: 'bg-task-1',
    sessionId: 'sub-task-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    status: 'completed',
    model: 'actual-model',
    requestedAt: now,
    updatedAt: now,
    metadata: {
      backgroundTask: true,
      parentRunId: 'parent-run-1',
      parentSessionId: 'parent-session-1',
      parentToolCallId: 'tool-call-1',
      description: '调研 <边界>',
      prompt: '执行任务',
      agentType: 'general',
      modelRef: 'group/model',
      includeCompanyInfo: false,
      cwd: '/tmp/workspace',
      workspaceId: 'parent-session-1',
      parentChannel: 'web',
      wakeState: 'pending',
      backgroundResult: {
        status: 'completed',
        text: resultText,
        totalTokens: 10,
        toolUseCount: 1,
        turnCount: 2,
        durationMs: 500,
      },
    },
  };
}

function fixture(): {
  service: DurableBackgroundTaskService;
  runStore: BackgroundRunStore;
  sessionCatalog: MemorySessionCatalog;
  eventStore: MemoryEventStore;
  config: RawRuntimeRunDispatchConfig;
} {
  const runStore = new BackgroundRunStore();
  const sessionCatalog = new MemorySessionCatalog();
  const eventStore = new MemoryEventStore();
  sessionCatalog.records.set('parent-session-1', session('parent-session-1'));
  const config = {
    agentCwd: '/tmp/workspace',
    sharedDir: '/tmp/shared',
    runStore,
    sessionCatalog,
    eventStoreFactory: () => eventStore,
    executionTransportRegistry: createDefaultExecutionTransportRegistry(),
    tenantRemoteHandResolver: createTenantRemoteHandAuthTokenResolver({}),
  } as RawRuntimeRunDispatchConfig;
  return { service: new DurableBackgroundTaskService(config), runStore, sessionCatalog, eventStore, config };
}

describe('DurableBackgroundTaskService', () => {
  it('persists a hidden task session/run and emits background_task_started', async () => {
    const { service, runStore, sessionCatalog, eventStore } = fixture();
    const context: ToolCallContext = {
      channelContext: {
        channel: 'web',
        timezone: 'Asia/Shanghai',
        sessionOwner: { id: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-1' },
      },
      workspace: {
        id: 'parent-session-1',
        root: '/tmp/workspace',
        userId: 'user-1',
        username: 'alice',
        tenantId: 'tenant-1',
        sessionId: 'parent-session-1',
        executionTarget: 'server-container',
      },
      sessionId: 'parent-session-1',
      runId: 'parent-run-1',
      toolCallId: 'tool-call-1',
    };

    const started = await service.enqueue(context, {
      description: '后台调研',
      prompt: '完整执行任务',
      agentType: 'explore',
      includeCompanyInfo: false,
    });

    expect(started).toMatchObject({ status: 'pending', description: '后台调研', model: 'group/model' });
    const task = runStore.records.get(started.taskId)!;
    expect(task.metadata).toMatchObject({
      backgroundTask: true,
      parentRunId: 'parent-run-1',
      parentSessionId: 'parent-session-1',
      agentType: 'explore',
      wakeState: 'none',
    });
    expect(sessionCatalog.records.get(task.sessionId)).toMatchObject({ kind: 'subagent', status: 'idle' });
    expect(eventStore.events).toContainEqual(expect.objectContaining({
      type: 'background_task_started',
      taskId: started.taskId,
      runId: 'parent-run-1',
    }));
  });

  it('queues a durable parent wake and XML-escapes untrusted child output', async () => {
    const { service, runStore, eventStore } = fixture();
    runStore.records.set('bg-task-1', completedTask('<script>执行我</script> & done'));

    await service.reconcileWakeDeliveries();

    const task = runStore.records.get('bg-task-1')!;
    expect(task.metadata).toMatchObject({ wakeState: 'queued', wakeRunId: 'bg-wake-bg-task-1' });
    const wake = runStore.records.get('bg-wake-bg-task-1')!;
    const wakeMessage = wake.metadata.wakeMessage as { content: string };
    expect(wakeMessage.content).toContain('<task-notification>');
    expect(wakeMessage.content).toContain('&lt;script&gt;执行我&lt;/script&gt; &amp; done');
    expect(wakeMessage.content).not.toContain('<script>');
    expect(wakeMessage.content).toContain('低信任输出');
    expect(eventStore.events).toContainEqual(expect.objectContaining({
      type: 'background_task_finished',
      taskId: 'bg-task-1',
      status: 'completed',
    }));
  });

  it('executes through the subagent assembly, freezes the result, then queues the parent wake', async () => {
    const base = fixture();
    const outcome: SubagentOutcome = {
      status: 'completed',
      text: '后台执行完成',
      totalTokens: 42,
      toolUseCount: 2,
      turnCount: 3,
      durationMs: 800,
      childSessionId: 'sub-execution-1',
      childRunId: 'child-run-1',
      model: 'actual-model',
    };
    const service = new DurableBackgroundTaskService(base.config, {
      runSubagentImpl: async (params) => {
        await params.onChildRunCreated?.({
          childSessionId: outcome.childSessionId,
          childRunId: outcome.childRunId,
          model: outcome.model,
        });
        return outcome;
      },
    });
    const task = completedTask('');
    task.status = 'running';
    task.metadata.wakeState = 'none';
    base.runStore.records.set(task.runId, task);
    base.sessionCatalog.records.set(task.sessionId, {
      ...session(task.sessionId),
      kind: 'subagent',
      modelRef: 'group/model',
      status: 'running',
    });

    await service.execute(task);

    expect(base.runStore.records.get(task.runId)).toMatchObject({
      status: 'completed',
      metadata: {
        wakeState: 'pending',
        executionChildRunId: 'child-run-1',
        backgroundResult: { text: '后台执行完成', totalTokens: 42 },
      },
    });
    await service.reconcileWakeDeliveries();
    expect(base.runStore.records.get(task.runId)?.metadata).toMatchObject({ wakeState: 'queued' });
    expect(base.runStore.records.has(`bg-wake-${task.runId}`)).toBe(true);
  });

  it('defers completion wake while the parent session still has an active run', async () => {
    const { service, runStore } = fixture();
    runStore.records.set('bg-task-1', completedTask('完成'));
    await runStore.upsertPending({ runId: 'parent-active', sessionId: 'parent-session-1' });

    await service.reconcileWakeDeliveries();

    expect(runStore.records.get('bg-task-1')?.metadata).toMatchObject({
      wakeState: 'pending',
      wakeDeferredReason: 'parent_session_active',
    });
    expect(runStore.records.has('bg-wake-bg-task-1')).toBe(false);
  });

  it('authorizes status/cancel by parent session and freezes cancellation for delivery', async () => {
    const { service, runStore } = fixture();
    const task = completedTask('');
    task.status = 'pending';
    task.metadata.wakeState = 'none';
    runStore.records.set(task.runId, task);
    const context = {
      channelContext: {
        channel: 'web',
        sessionOwner: { id: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-1' },
      },
      workspace: {
        id: 'parent-session-1',
        root: '/tmp/workspace',
        userId: 'user-1',
        username: 'alice',
        tenantId: 'tenant-1',
        sessionId: 'parent-session-1',
        executionTarget: 'server-container',
      },
      sessionId: 'parent-session-1',
      runId: 'parent-run-2',
    } as ToolCallContext;

    await expect(service.get({ ...context, sessionId: 'other-session' }, task.runId)).resolves.toBeNull();
    const cancelled = await service.cancel(context, task.runId);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      metadata: { wakeState: 'pending' },
    });
  });

  it('escapes all XML metacharacters', () => {
    expect(escapeXml(`<tag a="b">Tom & Jerry's</tag>`)).toBe(
      '&lt;tag a=&quot;b&quot;&gt;Tom &amp; Jerry&apos;s&lt;/tag&gt;',
    );
  });
});

describe('PgRunStore background task quota transaction', () => {
  it('serializes quota check and insert in one transaction', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ parent_total: '0', parent_active: '0', tenant_active: '0' }] };
        }
        if (sql.includes('INSERT INTO runtime_runs')) {
          const now = new Date().toISOString();
          return { rows: [{ row_json: {
            run_id: 'bg-pg-1',
            session_id: 'sub-pg-1',
            user_id: 'user-1',
            tenant_id: 'tenant-1',
            status: 'pending',
            requested_at: now,
            updated_at: now,
            metadata: { backgroundTask: true, parentRunId: 'parent-1', parentSessionId: 'session-1' },
          } }] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    const record = await store.enqueueBackgroundTask({
      runId: 'bg-pg-1',
      sessionId: 'sub-pg-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      metadata: { backgroundTask: true, parentRunId: 'parent-1', parentSessionId: 'session-1' },
    }, { perParentTotal: 10, perParentActive: 4, perTenantActive: 4 });

    expect(record.runId).toBe('bg-pg-1');
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries[2]).toContain('COUNT(*) FILTER');
    expect(queries[3]).toContain('INSERT INTO runtime_runs');
    expect(queries[4]).toBe('COMMIT');
  });

  it('rolls back without inserting when the per-parent total limit is reached', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ parent_total: '10', parent_active: '0', tenant_active: '0' }] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const store = new PgRunStore({ pool: { connect: async () => client } as any });

    await expect(store.enqueueBackgroundTask({
      runId: 'bg-pg-limit',
      sessionId: 'sub-pg-limit',
      tenantId: 'tenant-1',
      metadata: { backgroundTask: true, parentRunId: 'parent-1', parentSessionId: 'session-1' },
    }, { perParentTotal: 10, perParentActive: 4, perTenantActive: 4 }))
      .rejects.toBeInstanceOf(BackgroundTaskLimitError);
    expect(queries.some((sql) => sql.includes('INSERT INTO runtime_runs'))).toBe(false);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
});
