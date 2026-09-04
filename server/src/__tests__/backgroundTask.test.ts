import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

import {
  createDefaultExecutionTransportRegistry,
  PlatformToolRuntime,
  type ToolCallContext,
} from '../agent/toolRuntime.js';
import {
  DurableBackgroundTaskService,
  escapeXml,
  resolveBackgroundSkillUsername,
} from '../runtime/background/backgroundTaskService.js';
import type {
  ListBackgroundTasksOptions,
  RunRecord,
  RunStatus,
  RunStore,
  UpsertRunInput,
} from '../runtime/runStore.js';
import { BackgroundTaskLimitError, PgRunStore } from '../runtime/runStore.js';
import { DEFAULT_ORG_AGENT_RUNTIME_POLICY } from '../data/orgAgents/runtimePolicy.js';
import type {
  RuntimeSessionRecord,
  RuntimeSessionStatus,
  SessionCatalog,
} from '../runtime/sessionCatalog.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { ExecutionTransport } from '../runtime/executionTransport.js';
import { McpProxy } from '../mcp/proxy.js';
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
  async ensure(record: RuntimeSessionRecord): Promise<void> {
    if (!this.records.has(record.sessionId)) this.records.set(record.sessionId, record);
  }
  async get(sessionId: string): Promise<RuntimeSessionRecord | null> { return this.records.get(sessionId) ?? null; }
  async markStatus(sessionId: string, status: RuntimeSessionStatus): Promise<void> {
    const record = this.records.get(sessionId);
    if (record) this.records.set(sessionId, { ...record, status });
  }
  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return this.records.get(sessionId)?.transcriptPath ?? null;
  }
}

/** Tenant-aware in-memory RunStore fixture. */
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
      tenantId: input.tenantId ?? DEFAULT_TENANT_ID, status: 'pending',
      model: input.model,
      channel: input.channel,
      requestedAt: now,
      updatedAt: now,
      executionTarget: input.executionTarget,
      workspaceId: input.workspaceId, sandboxScopeId: input.sandboxScopeId,
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
  async findByIdempotencyKey(tenantId: string, userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) => (record.tenantId ?? tenantId) === tenantId && record.userId === userId && record.idempotencyKey === idempotencyKey) ?? null;
  }
  async listRecoverable(): Promise<RunRecord[]> { return []; }
  async getActiveBySession(tenantId: string, sessionId: string): Promise<RunRecord | null> {
    return [...this.records.values()].find((record) => (
      (record.tenantId ?? DEFAULT_TENANT_ID) === tenantId
      && record.sessionId === sessionId && ['pending', 'running'].includes(record.status)
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
    tenantId: 'tenant-1', sandboxScopeId: 'scope-parent-1',
    status: 'completed',
    model: 'actual-model',
    requestedAt: now,
    updatedAt: now,
    metadata: {
      backgroundTask: true,
      parentRunId: 'parent-run-1',
      parentSessionId: 'parent-session-1', topLevelSessionId: 'parent-session-1', sandboxScopeId: 'scope-parent-1',
      parentToolCallId: 'tool-call-1',
      description: '调研 <边界>',
      prompt: '执行任务',
      agentType: 'general',
      modelRef: 'group/model',
      includeCompanyInfo: false,
      cwd: '/tmp/workspace',
      workspaceId: 'parent-session-1',
      parentChannel: 'web',
      outputTransactionMode: 'terminal_buffered',
      parentOutputTransactionMode: 'replaceable_draft',
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
  it('skips member Skill materialization for organization service identities', () => {
    expect(resolveBackgroundSkillUsername(session('member'))).toBe('alice');
    expect(resolveBackgroundSkillUsername({
      username: 'agent-dws:org-kaikai', orgAgentSnapshot: {} as RuntimeSessionRecord['orgAgentSnapshot'],
    })).toBeUndefined();
  });

  it('reserves background Shell with the effective tenant remote workspace', async () => {
    const invoke = vi.fn(async () => ({
      status: 'success' as const,
      content: JSON.stringify({ taskId: 'shell-bg-effective', status: 'starting' }),
    }));
    const registry = createDefaultExecutionTransportRegistry();
    registry.register('server-remote', { listInternalTools: () => [], invoke });
    const hand = {
      handId: 'parent-session-1:agent-saas-acs',
      sessionId: 'parent-session-1',
      workspaceId: 'parent-session-1',
      type: 'server-remote' as const,
      status: 'ready' as const,
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    };
    const reserveCommand = vi.fn(async () => ({ taskId: 'shell-bg-effective', status: 'starting' as const }));
    const activateCommand = vi.fn(async () => undefined);
    const runtime = new PlatformToolRuntime({
      executionTransportRegistry: registry,
      handStore: {
        get: async () => hand,
        listBySession: async () => [hand],
        listByWorkspace: async () => [hand],
      } as never,
      backgroundTasks: {
        reserveCommand,
        activateCommand,
        failCommandStart: vi.fn(async () => undefined),
      } as never,
    });
    const context = commandContext();
    context.workspace.executionTarget = 'server-container';

    await runtime.invoke({
      toolId: 'Shell',
      input: { command: 'sleep 60', mode: 'background' },
      authorization: { approved: true, source: 'human_approval' },
    }, context);

    const effectiveContext = expect.objectContaining({
      workspace: expect.objectContaining({ executionTarget: 'server-remote' }),
    });
    expect(reserveCommand).toHaveBeenCalledWith(effectiveContext, expect.objectContaining({ command: 'sleep 60' }));
    expect(activateCommand).toHaveBeenCalledWith(effectiveContext, 'shell-bg-effective');
  });

  it('persists a hidden Worker session/run with dispatcher snapshot and emits background_task_started', async () => {
    const { service, runStore, sessionCatalog, eventStore } = fixture();
    sessionCatalog.records.set('parent-session-1', {
      ...session('parent-session-1'),
      orgAgentId: 'org-kaikai',
      executionRole: 'dispatcher',
      orgAgentSnapshot: {
        name: '开开',
        instructions: '遵守组织规则',
        allowedSkills: ['dws'],
        allowedKnowledge: ['kb-sales'],
        runtime: {
          ...structuredClone(DEFAULT_ORG_AGENT_RUNTIME_POLICY),
          executionMode: 'dispatcher',
          workerModel: { strategy: 'fixed', modelRef: 'group/worker' },
        },
      },
    });
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
        executionTarget: 'server-container', sandboxResources: { cpu: '2', memoryMb: 4096 },
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
    expect(started).toMatchObject({
      status: 'pending', description: '后台调研', model: 'group/worker', shortTaskId: expect.stringMatching(/^T-[A-F0-9]{24}$/),
    });
    const task = runStore.records.get(started.taskId)!;
    expect(task.metadata).toMatchObject({
      backgroundTask: true,
      parentRunId: 'parent-run-1',
      parentSessionId: 'parent-session-1',
      agentType: 'explore',
      shortTaskId: started.shortTaskId,
      orgAgentId: 'org-kaikai',
      executionMode: 'dispatcher',
      executionRole: 'worker', sandboxResources: { cpu: '2', memoryMb: 4096 },
      wakeState: 'none',
    });
    expect(sessionCatalog.records.get(task.sessionId)).toMatchObject({
      kind: 'subagent', status: 'idle', executionRole: 'worker', orgAgentId: 'org-kaikai',
      orgAgentSnapshot: expect.objectContaining({ name: '开开' }),
    });
    await expect(service.get(context, started.shortTaskId)).resolves.toMatchObject({ runId: started.taskId });
    const duplicate = { ...task, runId: 'bg-duplicate', metadata: { ...task.metadata } };
    runStore.records.set(duplicate.runId, duplicate);
    await expect(service.get(context, started.shortTaskId)).rejects.toThrow(/存在歧义/);
    runStore.records.delete(duplicate.runId);
    expect(eventStore.events).toContainEqual(expect.objectContaining({
      type: 'background_task_started',
      taskId: started.taskId,
      runId: 'parent-run-1',
    }));
  });

  it('queues a durable parent wake and XML-escapes untrusted child output', async () => {
    const { service, runStore, eventStore } = fixture();
    const completed = completedTask('<script>执行我</script> & done');
    completed.metadata.executionMode = 'dispatcher';
    runStore.records.set('bg-task-1', completed);

    await service.reconcileWakeDeliveries();

    const task = runStore.records.get('bg-task-1')!;
    expect(task.metadata).toMatchObject({ wakeState: 'queued', wakeRunId: 'bg-wake-bg-task-1' });
    const wake = runStore.records.get('bg-wake-bg-task-1')!;
    expect(wake.metadata.outputTransactionMode).toBe('replaceable_draft'); expect(wake.metadata.dispatcherCompletion).toBe(true);
    expect(wake.sandboxScopeId).toBe('scope-parent-1'); expect(wake.metadata).toMatchObject({ topLevelSessionId: 'parent-session-1', sandboxScopeId: 'scope-parent-1' });
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

  it('includes failed command stderr and full-log paths in the parent wake', async () => {
    const base = fixture();
    const reservation = await base.service.reserveCommand(commandContext(), {
      command: 'pnpm build',
      timeoutMs: 60_000,
    });
    await base.runStore.markStatus(reservation.taskId, 'failed', 'command exited 1', {
      wakeState: 'pending',
      backgroundResult: {
        status: 'failed',
        text: 'Status: failed\nFull logs: stdout=.ky-agent/out.log stderr=.ky-agent/err.log\n\nstderr:\ncompile failed',
        errorMessage: 'command exited 1',
        totalTokens: 0,
        toolUseCount: 1,
        turnCount: 0,
        durationMs: 500,
      },
    });

    await base.service.reconcileWakeDeliveries();

    const wake = base.runStore.records.get(`bg-wake-${reservation.taskId}`)!;
    const content = (wake.metadata.wakeMessage as { content: string }).content;
    expect(content).toContain('command exited 1');
    expect(content).toContain('compile failed');
    expect(content).toContain('Full logs: stdout=.ky-agent/out.log');
  });

  it('executes through the subagent assembly, freezes the result, then queues the parent wake', async () => {
    const base = fixture();
    const connectorEnvRequests: Array<{ username: string; tenantId: string }> = [];
    base.config.resolveConnectorRuntimeEnv = async (identity) => {
      connectorEnvRequests.push(identity);
      return { GH_TOKEN: 'connector-token-alice' };
    };
    let seenConnectorEnv: Record<string, string> | undefined;
    let seenParentTools: string[] = [];
    const mcpWarmup = vi.fn(async () => [{
      serverName: 'crm', toolName: 'lookup', description: '查询客户', inputSchema: { type: 'object' },
    }]);
    base.config.mcpProxy = new McpProxy({
      manager: {} as never,
      warmupWithCredential: mcpWarmup,
    });
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
        seenConnectorEnv = params.parentContext.env;
        seenParentTools = params.parentProviders.flatMap(provider => provider.list(params.parentContext).map(tool => tool.name));
        const identity = params.preparedChildIdentity ?? {
          childSessionId: outcome.childSessionId, childRunId: outcome.childRunId,
        };
        await params.beforeChildSideEffects?.(identity);
        await params.onChildRunCreated?.({ ...identity, model: outcome.model });
        return { ...outcome, ...identity };
      },
    });
    const task = completedTask('');
    task.status = 'running';
    task.metadata.wakeState = 'none';
    task.metadata.executionChildSessionId = outcome.childSessionId;
    task.metadata.executionChildRunId = outcome.childRunId;
    base.runStore.records.set(task.runId, task);
    base.sessionCatalog.records.set(task.sessionId, {
      ...session(task.sessionId),
      kind: 'subagent',
      modelRef: 'group/model',
      status: 'running',
    });
    await service.execute(task);
    expect(connectorEnvRequests).toEqual([{ userId: 'user-1', username: 'alice', tenantId: 'tenant-1' }]);
    expect(seenConnectorEnv).toMatchObject({
      GH_TOKEN: 'connector-token-alice',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'credential.helper',
    });
    expect(seenConnectorEnv?.GIT_CONFIG_VALUE_1).not.toContain('connector-token-alice');
    expect(mcpWarmup).toHaveBeenCalledWith(expect.objectContaining({
      username: 'alice', userId: 'user-1', sessionId: 'sub-task-1', runId: 'bg-task-1',
    }));
    expect(seenParentTools).toContain('mcp__crm__lookup');
    expect(base.runStore.records.get(task.runId)).toMatchObject({
      status: 'completed',
      statusReason: undefined,
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
    await runStore.upsertPending({ runId: 'parent-active', tenantId: 'tenant-1', sessionId: 'parent-session-1' });
    await service.reconcileWakeDeliveries();

    expect(runStore.records.get('bg-task-1')?.metadata).toMatchObject({
      wakeState: 'pending',
      wakeDeferredReason: 'parent_session_active',
    });
    expect(runStore.records.has('bg-wake-bg-task-1')).toBe(false);
  });
  it('authorizes status/cancel by parent session and durably freezes cancellation for delivery', async () => {
    const { service, runStore, sessionCatalog } = fixture();
    const task = completedTask('');
    sessionCatalog.records.set(task.sessionId, { ...session(task.sessionId), kind: 'subagent' });
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
      '&lt;tag a=&quot;b&quot;&gt;Tom &amp; Jerry&apos;s&lt;/tag&gt;');
  });

  it('restores the parent tenant hand and monitors a durable command after service reconstruction', async () => {
    const base = fixture();
    const invocations: Array<{ toolName: string; input: unknown; sessionId?: string }> = [];
    const transport: ExecutionTransport = {
      listInternalTools: () => [],
      invoke: async (request) => {
        invocations.push({
          toolName: request.toolName,
          input: request.input,
          sessionId: request.context.workspace.sessionId,
        });
        return {
          status: 'success',
          content: JSON.stringify({
            taskId: (request.input as { task_id?: string }).task_id,
            status: 'completed',
            stdout: 'build done',
            stderr: '',
            stdoutBytes: 10,
            stderrBytes: 0,
            exitCode: 0,
          }),
        };
      },
    };
    base.config.executionTransportRegistry!.register('server-remote', transport);
    const parentHand = {
      handId: 'parent-session-1:agent-saas-acs', tenantId: 'tenant-1',
      sessionId: 'parent-session-1',
      workspaceId: 'parent-session-1',
      type: 'server-remote' as const,
      status: 'ready' as const,
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    };
    const listBySession = vi.fn(async (sessionId: string, tenantId: string) => sessionId === parentHand.sessionId && tenantId === parentHand.tenantId ? [parentHand] : []);
    base.config.handStore = {
      get: async (handId: string, tenantId: string) => handId === parentHand.handId && tenantId === parentHand.tenantId ? parentHand : null,
      listBySession,
      listByWorkspace: async (_workspaceId: string, tenantId: string) => tenantId === parentHand.tenantId ? [parentHand] : [],
    } as never;
    const context = commandContext();
    const reservation = await base.service.reserveCommand(context, {
      command: 'pnpm build',
      timeoutMs: 60_000,
    });
    const reserved = base.runStore.records.get(reservation.taskId)!;
    expect(reserved.metadata).toMatchObject({
      backgroundTaskType: 'command',
      backgroundTaskReady: false,
      commandPreview: 'pnpm build',
      parentSessionId: 'parent-session-1', sandboxResources: { cpu: '1', memoryMb: 2048 },
      wakeState: 'none',
    });

    await base.service.activateCommand(context, reservation.taskId);
    expect(base.runStore.records.get(reservation.taskId)?.metadata).toMatchObject({ backgroundTaskReady: true });
    const reconstructedService = new DurableBackgroundTaskService(base.config);
    await reconstructedService.execute(base.runStore.records.get(reservation.taskId)!);
    expect(invocations).toEqual([expect.objectContaining({
      toolName: 'BashOutput',
      sessionId: 'parent-session-1',
    })]);
    expect(listBySession).toHaveBeenCalledWith('parent-session-1', 'tenant-1');
    expect(listBySession).not.toHaveBeenCalledWith(reserved.sessionId, 'tenant-1');
    expect(base.runStore.records.get(reservation.taskId)).toMatchObject({
      status: 'completed',
      statusReason: undefined,
      metadata: {
        wakeState: 'pending',
        backgroundResult: { status: 'completed', text: expect.stringContaining('build done') },
      },
    });
  });

  it('restores the parent tenant hand when cancelling a durable background command', async () => {
    const base = fixture();
    const invocations: Array<{ toolName: string; sessionId?: string }> = [];
    base.config.executionTransportRegistry!.register('server-remote', {
      listInternalTools: () => [],
      invoke: async (request) => {
        invocations.push({ toolName: request.toolName, sessionId: request.context.workspace.sessionId });
        return {
          status: 'success',
          content: JSON.stringify({
            taskId: (request.input as { task_id?: string }).task_id,
            status: 'cancelled',
            stdout: '',
            stderr: '',
            stdoutBytes: 0,
            stderrBytes: 0,
          }),
        };
      },
    });
    const parentHand = {
      handId: 'parent-session-1:agent-saas-acs', tenantId: 'tenant-1',
      sessionId: 'parent-session-1',
      workspaceId: 'parent-session-1',
      type: 'server-remote' as const,
      status: 'ready' as const,
      capabilities: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      metadata: { tenantRemoteHandId: 'agent-saas-acs' },
    };
    base.config.handStore = {
      get: async (handId: string, tenantId: string) => handId === parentHand.handId && tenantId === parentHand.tenantId ? parentHand : null,
      listBySession: async (sessionId: string, tenantId: string) => sessionId === parentHand.sessionId && tenantId === parentHand.tenantId ? [parentHand] : [],
      listByWorkspace: async (_workspaceId: string, tenantId: string) => tenantId === parentHand.tenantId ? [parentHand] : [],
    } as never;
    const context = commandContext();
    const reservation = await base.service.reserveCommand(context, { command: 'sleep 60', timeoutMs: 60_000 });
    await base.service.activateCommand(context, reservation.taskId);

    const reconstructedService = new DurableBackgroundTaskService(base.config);
    const cancelled = await reconstructedService.cancel(context, reservation.taskId);
    expect(invocations).toEqual([{ toolName: 'KillBash', sessionId: 'parent-session-1' }]);
    expect(cancelled).toMatchObject({ status: 'cancelled', metadata: { wakeState: 'pending' } });
  });

  it('hands off only the monitor during Server drain and leaves the ACS command running', async () => {
    const base = fixture();
    const invocations: string[] = [];
    let notifyBashOutputStarted!: () => void;
    const bashOutputStarted = new Promise<void>((resolve) => { notifyBashOutputStarted = resolve; });
    base.config.executionTransportRegistry!.register('server-remote', {
      listInternalTools: () => [],
      invoke: async (request) => {
        invocations.push(request.toolName);
        if (request.toolName !== 'BashOutput') return { status: 'success', content: '{}' };
        notifyBashOutputStarted();
        await new Promise<never>((_resolve, reject) => {
          const signal = request.context.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      },
    });
    const context = commandContext();
    const reservation = await base.service.reserveCommand(context, { command: 'sleep 600', timeoutMs: 600_000 });
    await base.service.activateCommand(context, reservation.taskId);
    await base.runStore.markStatus(reservation.taskId, 'running');
    const record = base.runStore.records.get(reservation.taskId)!;

    const execution = base.service.execute(record);
    await bashOutputStarted;
    base.service.handoffCommandMonitor(record);
    await execution;

    expect(invocations).toEqual(['BashOutput']);
    expect(base.runStore.records.get(reservation.taskId)).toMatchObject({ status: 'running' });
  });
});

function commandContext(): ToolCallContext {
  return {
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
      executionTarget: 'server-remote',
      sandboxScopeId: 'workspace-user-1', sandboxResources: { cpu: '1', memoryMb: 2048 },
      mountSubPath: 'workspaces/tenant-1/user-1',
    },
    sessionId: 'parent-session-1',
    runId: 'parent-run-command',
    toolCallId: 'tool-call-command',
  };
}

describe('PgRunStore background task quota transaction', () => {
  it('serializes quota check and insert in one transaction', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ parent_active: '0', tenant_active: '0' }] };
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
    }, { perParentActive: 4, perTenantActive: 4 });

    expect(record.runId).toBe('bg-pg-1');
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toContain('pg_advisory_xact_lock');
    expect(queries[2]).toContain('COUNT(*) FILTER');
    expect(queries[2]).not.toContain('AS parent_total');
    expect(queries[3]).toContain('INSERT INTO runtime_runs');
    expect(queries[4]).toBe('COMMIT');
  });

  it('rolls back without inserting when the per-parent active limit is reached', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('COUNT(*) FILTER')) {
          return { rows: [{ parent_active: '4', tenant_active: '0' }] };
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
    }, { perParentActive: 4, perTenantActive: 4 }))
      .rejects.toBeInstanceOf(BackgroundTaskLimitError);
    expect(queries.some((sql) => sql.includes('INSERT INTO runtime_runs'))).toBe(false);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
});
