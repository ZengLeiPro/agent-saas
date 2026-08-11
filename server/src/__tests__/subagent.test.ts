/**
 * 子 agent 工具（Agent tool，2026-07-06）测试面。
 *
 * 覆盖对照施工计划第 6 节 + 外部踩坑清单：
 *   - subagentRunner：限额闸门 / billing cap 拒绝 / 模型白名单拒绝（显式传 tenantId）
 *     / 超时→timeout / 父 abort→cancelled / API 错误→failed（文本不伪装）
 *     / completed 全链路（usage channel:'subagent' 记账、子事件不进父 store、
 *     kind:'subagent' 落 catalog）
 *   - 工具剥夺清单 + explore 白名单（经真实 FilteredToolRuntime，从模型可见 tools[] 断言）
 *   - AgentToolProvider：截断+spill、durable subagent_started/finished 事件形态
 *   - 子 agent 事件不进父 contextProjection
 *   - drainToolCalls 并行窗：显式 opt-in 工具并发、结果按序、串行边界分段
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'zod';

import { createBuiltinTools } from '../agent/builtinTools.js';
import {
  createDefaultExecutionTransportRegistry,
  type AuthorizedToolCall,
  type ToolCallContext,
  type ToolDescriptor,
  type ToolProvider,
  type ToolResult,
  type ToolRuntime,
  type WorkspaceRef,
} from '../agent/toolRuntime.js';
import type { BillingService } from '../data/billing/service.js';
import type { RecordResultParams, TokenUsageStore } from '../data/usage/store.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { buildContextProjection } from '../runtime/contextProjection.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { RawRuntimeRunDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord, FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { AgentToolProvider } from '../runtime/subagent/agentToolProvider.js';
import { SUBAGENT_TYPES } from '../runtime/subagent/agentTypes.js';
import {
  SUBAGENT_GLOBAL_MAX_CONCURRENCY,
  SUBAGENT_HARD_TIMEOUT_MS,
  SUBAGENT_MAX_TURNS,
  SUBAGENT_PER_RUN_MAX_CONCURRENCY,
  SubagentLimiter,
} from '../runtime/subagent/subagentLimits.js';
import { runSubagent, type SubagentOutcome } from '../runtime/subagent/subagentRunner.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { ModelAdapter, ModelEvent, ModelRequest, PlatformEvent, RunContext } from '../runtime/types.js';
import type { ChannelContext, OutboundEvent } from '../types/index.js';
import { FailingAdapter, HangingAdapter, TextOnlyAdapter } from './helpers/subagentModelAdapters.js';

// ────────────────────────── 共用 fixture ──────────────────────────

interface SubagentFixture {
  tmp: string;
  config: RawRuntimeRunDispatchConfig;
  parentContext: ToolCallContext;
  parentSessionId: string;
  parentRunId: string;
  tenantId: string;
  parentEventStore: FileEventStore;
  usageRecords: RecordResultParams[];
  cleanupDirs: Set<string>;
}

async function makeFixture(options: {
  cleanupDirs: Set<string>;
  billingService?: BillingService;
  modelResolver?: RawRuntimeRunDispatchConfig['modelResolver'];
} = { cleanupDirs: new Set() }): Promise<SubagentFixture> {
  const tmp = await mkdtemp(join(tmpdir(), 'subagent-'));
  options.cleanupDirs.add(tmp);
  const tenantId = `t-sub-${randomUUID().slice(0, 8)}`;
  const parentSessionId = randomUUID();
  const parentRunId = `${Date.now()}-${randomUUID()}`;
  const usageRecords: RecordResultParams[] = [];

  const sessionCatalog = new FileSessionCatalog({ agentCwd: tmp });
  const eventStores = new Map<string, FileEventStore>();
  const eventStoreFor = (sessionId: string): FileEventStore => {
    let store = eventStores.get(sessionId);
    if (!store) {
      store = new FileEventStore(join(tmp, 'events', `${sessionId}.jsonl`));
      eventStores.set(sessionId, store);
    }
    return store;
  };

  const config: RawRuntimeRunDispatchConfig = {
    agentCwd: tmp,
    sharedDir: join(tmp, 'shared'),
    sessionCatalog,
    eventStoreFactory: (session) => eventStoreFor(session.sessionId),
    modelResolver: options.modelResolver
      ?? ((_ref: string, _tenantId?: string) => ({
        model: 'mock-model',
        connection: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:0' },
      })),
    ...(options.billingService ? { billingService: () => options.billingService } : {}),
    tokenUsageStore: () => ({
      recordResult: (params: RecordResultParams) => { usageRecords.push(params); },
    } as unknown as TokenUsageStore),
  };

  const parentRecord = createRuntimeSessionRecord({
    sessionId: parentSessionId,
    userId: 'user-1',
    username: 'alice',
    userRole: 'user',
    tenantId,
    channel: 'web',
    cwd: tmp,
    modelRef: 'mock/group-model',
    executionTarget: 'server-local',
    status: 'running',
  });
  // transcript 落在真实 legacy-transcripts 根下（getTranscriptPath 行为），tenant 目录随测试清理
  options.cleanupDirs.add(dirname(dirname(parentRecord.transcriptPath)));
  await sessionCatalog.upsert(parentRecord);

  const channelContext: ChannelContext = {
    channel: 'web',
    user: { id: 'user-1', username: 'alice', role: 'user', tenantId },
  };
  const workspace: WorkspaceRef = {
    id: `ws-${parentSessionId}`,
    root: tmp,
    userId: 'user-1',
    username: 'alice',
    tenantId,
    sessionId: parentSessionId,
    executionTarget: 'server-local',
  };
  const parentContext: ToolCallContext = {
    channelContext,
    workspace,
    sessionId: parentSessionId,
    runId: parentRunId,
    toolCallId: 'call_agent_1',
  };

  return {
    tmp,
    config,
    parentContext,
    parentSessionId,
    parentRunId,
    tenantId,
    parentEventStore: eventStoreFor(parentSessionId),
    usageRecords,
    cleanupDirs: options.cleanupDirs,
  };
}

function runnerDeps(fixture: SubagentFixture) {
  return {
    config: fixture.config,
    executionTransportRegistry: createDefaultExecutionTransportRegistry(),
    tenantHandResolver: createTenantRemoteHandAuthTokenResolver({}),
    parentContext: fixture.parentContext,
  };
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// ────────────────────────── 测试 ──────────────────────────

describe('SubagentLimiter', () => {
  it('单 run 累计派生次数不限，完成后可继续派生', async () => {
    const limiter = new SubagentLimiter({ perRunMaxConcurrency: 2 });
    for (let i = 0; i < 20; i += 1) {
      const slot = await limiter.acquire('run-1');
      slot.release();
    }
  });

  it('并发满时排队等待，release 后放行；等待可被 signal 中断', async () => {
    const limiter = new SubagentLimiter({ perRunMaxConcurrency: 1 });
    const first = await limiter.acquire('run-1');
    let secondAcquired = false;
    const second = limiter.acquire('run-1').then((slot) => { secondAcquired = true; return slot; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);
    first.release();
    (await second).release();
    expect(secondAcquired).toBe(true);

    const third = await limiter.acquire('run-1');
    const abortController = new AbortController();
    const waiting = limiter.acquire('run-1', abortController.signal);
    abortController.abort();
    await expect(waiting).rejects.toThrow(/取消/);
    third.release();
  });

  it('同一 run 的排队调用不占用进程槽，其他 run 可公平进入', async () => {
    const limiter = new SubagentLimiter({ globalMaxConcurrency: 1, perRunMaxConcurrency: 1 });
    const first = await limiter.acquire('run-1');
    let sameRunAcquired = false;
    let otherRunAcquired = false;
    const sameRun = limiter.acquire('run-1').then((slot) => { sameRunAcquired = true; return slot; });
    const otherRun = limiter.acquire('run-2').then((slot) => { otherRunAcquired = true; return slot; });
    await new Promise((resolve) => setTimeout(resolve, 20));

    first.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(otherRunAcquired).toBe(true);
    expect(sameRunAcquired).toBe(false);

    (await otherRun).release();
    (await sameRun).release();
  });
});

describe('runSubagent', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('child run 在模型调用前执行治理 preflight，enforce 拒绝时 fail closed', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const preflight = vi.fn().mockResolvedValue({
      proceed: false,
      enforcementMode: 'enforce',
      accessDecision: { reasonCode: 'SUBJECT_DISABLED' },
      snapshot: { runId: 'child' },
    });
    const append = vi.fn();
    fixture.config.runPreflightService = { preflight } as never;
    fixture.config.runResolutionSnapshotStore = { append } as never;
    const modelAdapterFactory = vi.fn(() => new TextOnlyAdapter());
    await expect(runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [createBuiltinTools()],
      agentType: SUBAGENT_TYPES.general,
      request: { description: '治理拒绝', prompt: '不应执行', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory,
    })).rejects.toThrow('SUBJECT_DISABLED');
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ phase: 'wake' }));
    expect(append).not.toHaveBeenCalled();
    expect(modelAdapterFactory).not.toHaveBeenCalled();
  });

  it('completed：结果文本回传、usage 落 channel=subagent、子事件不进父 store、catalog 记 kind=subagent', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    fixture.parentContext.env = {
      GH_TOKEN: 'connector-token-alice',
      GIT_CONFIG_COUNT: '2',
    };
    const modelAdapter = new TextOnlyAdapter();
    const outcome = await runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [createBuiltinTools()],
      agentType: SUBAGENT_TYPES.general,
      request: { description: '测试子任务', prompt: '完成测试子任务', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => modelAdapter,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.text).toContain('子任务完成');
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.childSessionId.startsWith('sub-')).toBe(true);
    expect(outcome.totalTokens).toBe(15);
    expect(modelAdapter.contexts[0]?.env).toEqual(fixture.parentContext.env);
    const firstUserMessage = modelAdapter.requests[0]?.messages.find((message) => message.role === 'user');
    expect(firstUserMessage?.content).toMatch(
      /^\[\d{4}\/\d{2}\/\d{2}\s+周[一二三四五六日]\s+\d{2}:\d{2}\]\s+完成测试子任务$/,
    );

    // 关键不变量 1：父 session event store 零事件（runner 只写 childSessionId）
    await expect(fixture.parentEventStore.list(fixture.parentSessionId)).resolves.toEqual([]);
    const childEvents = await fixture.config.eventStoreFactory!(
      createRuntimeSessionRecord({ sessionId: outcome.childSessionId, channel: 'web', cwd: fixture.tmp }),
    ).list(outcome.childSessionId);
    expect(childEvents.some((event) => event.type === 'run_started')).toBe(true);
    expect(childEvents.some((event) => event.type === 'run_finished' && event.subtype === 'success')).toBe(true);
    expect(childEvents.find((event) => event.type === 'user_message')).toMatchObject({
      content: '完成测试子任务',
      modelContent: firstUserMessage?.content,
    });

    // 关键不变量 2：usage 独立记账
    expect(fixture.usageRecords).toHaveLength(1);
    expect(fixture.usageRecords[0]).toMatchObject({
      username: 'alice',
      tenantId: fixture.tenantId,
      channel: 'subagent',
    });

    // hidden session 落 catalog 且带 kind
    const childRecord = await fixture.config.sessionCatalog!.get(outcome.childSessionId);
    expect(childRecord?.kind).toBe('subagent');
    expect(childRecord?.tenantId).toBe(fixture.tenantId);
  });

  it('billing hard cap 拒绝：child Run 实际用量门禁失败后停止模型调用', async () => {
    const fixture = await makeFixture({
      cleanupDirs,
      billingService: {
        authorizeRun: async () => ({
          ok: false,
          code: 'BILLING_ORG_BALANCE_EXHAUSTED',
          reason: '组织积分余额不足，当前计费策略已启用硬封顶。',
        }),
      } as unknown as BillingService,
    });
    await expect(runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new TextOnlyAdapter(),
    })).rejects.toThrow(/积分余额不足/);
    expect(fixture.usageRecords).toHaveLength(0);
  });

  it('模型白名单拒绝：model 参数校验显式携带父 tenantId', async () => {
    const resolver = vi.fn((_ref: string, _tenantId?: string) => null);
    const fixture = await makeFixture({ cleanupDirs, modelResolver: resolver });
    await expect(runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', model: 'evil/model', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new TextOnlyAdapter(),
    })).rejects.toThrow(/白名单/);
    // 关键不变量 3：resolver 收到显式 tenantId
    expect(resolver).toHaveBeenCalledWith('evil/model', fixture.tenantId);
  });

  it('硬超时：status=timeout，错误说明与结论文本分离', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const outcome = await runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      hardTimeoutMs: 60,
      modelAdapterFactory: () => new HangingAdapter(),
    });
    expect(outcome.status).toBe('timeout');
    expect(outcome.errorMessage).toMatch(/超时|终止/);
    expect(outcome.text).toBe('');
  });

  it('父 abort：status=cancelled 级联取消', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const abortController = new AbortController();
    fixture.parentContext.signal = abortController.signal;
    let childRunCreated!: () => void;
    const childRunReady = new Promise<void>((resolve) => { childRunCreated = resolve; });
    const pending = runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new HangingAdapter(),
      onChildRunCreated: childRunCreated,
    });
    await childRunReady;
    abortController.abort();
    const outcome = await pending;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.errorMessage).toMatch(/取消/);
  });

  it('API 错误：status=failed，错误名进 errorMessage 而不是结论文本', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const outcome = await runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new FailingAdapter(),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.errorMessage).toContain('upstream 500');
    // D5 红线：API 错误绝不伪装成结论
    expect(outcome.text).toBe('');
  });

  it('工具剥夺清单：general 拿全量减嵌套/交互/排程/后台治理工具', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    // 父 provider 集里刻意混入被剥夺名字（模拟嵌套/排程/强审批工具在父侧存在）
    const deniedNamesProvider: ToolProvider = {
      list: () => [
        'Agent',
        'CronManage',
        'CronList',
        'UpdateCompanyInfo',
        'BackgroundTask',
        'BackgroundTaskList',
        'BackgroundTaskStatus',
        'BackgroundTaskCancel',
      ].map((name) => ({
        id: name,
        name,
        displayName: name,
        description: 'x',
        schema: z.object({}),
        risk: 'safe' as const,
        approvalMode: 'never' as const,
        auditCategory: 'test',
      })),
      invoke: async () => undefined,
    };
    const adapter = new TextOnlyAdapter();
    await runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [createBuiltinTools(), deniedNamesProvider],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => adapter,
    });
    const toolNames = adapter.requests[0]!.tools.map((tool) => tool.name);
    expect(toolNames).toContain('TodoWrite');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Write');
    for (const denied of [
      'Agent',
      'AskUserQuestion',
      'CronManage',
      'CronList',
      'UpdateCompanyInfo',
      'BackgroundTask',
      'BackgroundTaskList',
      'BackgroundTaskStatus',
      'BackgroundTaskCancel',
    ]) {
      expect(toolNames).not.toContain(denied);
    }
  });

  it('explore 白名单：开放 Shell 搜索，但不暴露独立 Write/Edit 工具', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const adapter = new TextOnlyAdapter();
    await runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [createBuiltinTools()],
      agentType: SUBAGENT_TYPES.explore,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => adapter,
    });
    const toolNames = adapter.requests[0]!.tools.map((tool) => tool.name);
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Shell');
    for (const excluded of ['Write', 'Edit', 'TodoWrite', 'AskUserQuestion', 'Agent', 'List', 'Glob', 'Grep']) {
      expect(toolNames).not.toContain(excluded);
    }
    expect(SUBAGENT_TYPES.explore.systemPrompt).toContain('Shell 是完整命令行能力，不是只读边界');
    expect(SUBAGENT_TYPES.explore.systemPrompt).not.toContain('你只有只读工具');
  });
});

describe('AgentToolProvider', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  function fakeOutcome(fixture: SubagentFixture, overrides: Partial<SubagentOutcome> = {}): SubagentOutcome {
    return {
      status: 'completed',
      text: '结论文本',
      totalTokens: 100,
      toolUseCount: 3,
      turnCount: 4,
      durationMs: 1200,
      childSessionId: `sub-${randomUUID()}`,
      childRunId: `${Date.now()}-${randomUUID()}`,
      model: 'mock-model',
      ...overrides,
    };
  }

  function makeProvider(fixture: SubagentFixture, options: {
    outcome?: SubagentOutcome;
    resultMaxChars?: number;
    impl?: typeof runSubagent;
  }): AgentToolProvider {
    return new AgentToolProvider({
      config: fixture.config,
      executionTransportRegistry: createDefaultExecutionTransportRegistry(),
      tenantHandResolver: createTenantRemoteHandAuthTokenResolver({}),
      parentProviders: [],
      ...(options.resultMaxChars ? { resultMaxChars: options.resultMaxChars } : {}),
      runSubagentImpl: options.impl ?? (async (params) => {
        const outcome = options.outcome!;
        await params.onChildRunCreated?.({
          childSessionId: outcome.childSessionId,
          childRunId: outcome.childRunId,
          model: outcome.model,
        });
        return outcome;
      }),
    });
  }

  it('工具描述动态渲染限额，schema 参数极简', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const provider = makeProvider(fixture, { outcome: fakeOutcome(fixture) });
    const [descriptor] = provider.list();
    expect(descriptor!.name).toBe('Agent');
    expect(descriptor!.risk).toBe('safe');
    expect(descriptor!.approvalMode).toBe('never');
    expect(descriptor!.concurrency).toBe('parallel');
    expect(descriptor!.description).toContain('累计派生次数不限');
    expect(descriptor!.description).toContain(`并行 ${SUBAGENT_PER_RUN_MAX_CONCURRENCY} 个`);
    expect(descriptor!.description).toContain(`${SUBAGENT_MAX_TURNS} 轮`);
    expect(descriptor!.description).toContain(`${SUBAGENT_HARD_TIMEOUT_MS / 60_000} 分钟`);
    expect(descriptor!.description).toContain('general');
    expect(descriptor!.description).toContain('explore');
    expect(SUBAGENT_TYPES.general.maxTurns).toBe(SUBAGENT_MAX_TURNS);
    expect(SUBAGENT_TYPES.explore.maxTurns).toBe(SUBAGENT_MAX_TURNS);
    expect(SUBAGENT_PER_RUN_MAX_CONCURRENCY).toBe(6);
    expect(SUBAGENT_GLOBAL_MAX_CONCURRENCY).toBe(30);
    expect(SUBAGENT_MAX_TURNS).toBe(200);
  });

  it('durable 事件形态：subagent_started/finished 写父 session，字段完整', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const outcome = fakeOutcome(fixture, { status: 'completed', totalTokens: 42, toolUseCount: 2, turnCount: 6 });
    const provider = makeProvider(fixture, { outcome });
    const result = await provider.invoke(
      { toolId: 'Agent', input: { description: '整理调研', prompt: '做事' }, authorization: { approved: true, source: 'policy_auto' } },
      fixture.parentContext,
    );
    expect(result!.content).toContain('结论文本');

    const parentEvents = await fixture.parentEventStore.list(fixture.parentSessionId);
    const started = parentEvents.find((event) => event.type === 'subagent_started');
    const finished = parentEvents.find((event) => event.type === 'subagent_finished');
    expect(started).toMatchObject({
      runId: fixture.parentRunId,
      sessionId: fixture.parentSessionId,
      toolCallId: 'call_agent_1',
      agentType: 'general',
      description: '整理调研',
      childSessionId: outcome.childSessionId,
      childRunId: outcome.childRunId,
      model: 'mock-model',
    });
    expect(finished).toMatchObject({
      toolCallId: 'call_agent_1',
      status: 'completed',
      totalTokens: 42,
      toolUseCount: 2,
      turnCount: 6,
      childSessionId: outcome.childSessionId,
      resultPreview: '结论文本',
    });
  });

  it('mode=background 持久化入队后立即返回 taskId，不启动前台子 loop', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const enqueue = vi.fn().mockResolvedValue({
      taskId: 'bg-task-1',
      status: 'pending',
      description: '长时调研',
      model: 'mock-model',
    });
    fixture.config.backgroundTasks = { enqueue } as any;
    const foreground = vi.fn();
    const provider = makeProvider(fixture, { impl: foreground as typeof runSubagent });

    const result = await provider.invoke(
      {
        toolId: 'Agent',
        input: { description: '长时调研', prompt: '完整完成这项任务', mode: 'background', agent_type: 'explore' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      fixture.parentContext,
    );

    expect(JSON.parse(result!.content)).toMatchObject({ taskId: 'bg-task-1', status: 'pending' });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call_agent_1' }),
      expect.objectContaining({ description: '长时调研', agentType: 'explore' }),
    );
    expect(foreground).not.toHaveBeenCalled();
    const parentEvents = await fixture.parentEventStore.list(fixture.parentSessionId);
    expect(parentEvents.filter((event) => event.type.startsWith('subagent_'))).toEqual([]);
  });

  it('截断保险丝 + spill：超长输出按行 75/25 截断，全文落 assets/subagents/<childRunId>.md', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const longText = Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 行：一些内容内容内容内容`).join('\n');
    const outcome = fakeOutcome(fixture, { text: longText });
    const provider = makeProvider(fixture, { outcome, resultMaxChars: 800 });
    const result = await provider.invoke(
      { toolId: 'Agent', input: { description: 't', prompt: 'p' }, authorization: { approved: true, source: 'policy_auto' } },
      fixture.parentContext,
    );
    expect(result!.content.length).toBeLessThan(longText.length);
    expect(result!.content).toContain('第 1 行');
    expect(result!.content).toContain('中间省略');
    expect(result!.content).toContain(`assets/subagents/${outcome.childRunId}.md`);
    const spilled = await readFile(join(fixture.tmp, 'assets', 'subagents', `${outcome.childRunId}.md`), 'utf-8');
    expect(spilled).toBe(longText);
  });

  it('异常终态：status 与错误说明进正文头部，部分文本明确标注不可当结论', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const outcome = fakeOutcome(fixture, {
      status: 'timeout',
      text: '搜到一半的中间产出',
      errorMessage: '子 agent 超过硬超时 600s 被终止',
    });
    const provider = makeProvider(fixture, { outcome });
    const result = await provider.invoke(
      { toolId: 'Agent', input: { description: 't', prompt: 'p' }, authorization: { approved: true, source: 'policy_auto' } },
      fixture.parentContext,
    );
    expect(result!.content).toContain('[子 agent 异常终止] status=timeout');
    expect(result!.content).toContain('不可当作最终结论');
    expect(result!.content).toContain('搜到一半的中间产出');
  });

  it('前置校验失败（未发 started）：异常透传且父 store 无 subagent 事件', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const provider = makeProvider(fixture, {
      impl: async () => { throw new Error('组织积分余额不足'); },
    });
    await expect(provider.invoke(
      { toolId: 'Agent', input: { description: 't', prompt: 'p' }, authorization: { approved: true, source: 'policy_auto' } },
      fixture.parentContext,
    )).rejects.toThrow(/积分余额不足/);
    const parentEvents = await fixture.parentEventStore.list(fixture.parentSessionId);
    expect(parentEvents.filter((event) => event.type.startsWith('subagent_'))).toEqual([]);
  });
});

describe('contextProjection 与 subagent 事件', () => {
  it('subagent_started/finished 不进模型 messages 投影', () => {
    const sessionId = 'session-ctx';
    const runId = 'run-ctx';
    const at = (n: number) => new Date(1_700_000_000_000 + n).toISOString();
    const events: PlatformEvent[] = [
      { id: 'e1', timestamp: at(1), type: 'user_message', runId, sessionId, content: '你好' },
      {
        id: 'e2', timestamp: at(2), type: 'subagent_started', runId, sessionId,
        toolCallId: 'call1', agentType: 'explore', description: '调研', childSessionId: 'sub-1', childRunId: 'r1', model: 'm',
      },
      {
        id: 'e3', timestamp: at(3), type: 'subagent_finished', runId, sessionId,
        toolCallId: 'call1', agentType: 'explore', description: '调研', childSessionId: 'sub-1', childRunId: 'r1',
        status: 'completed', totalTokens: 10, toolUseCount: 1, durationMs: 500,
      },
      { id: 'e4', timestamp: at(4), type: 'assistant_message', runId, sessionId, content: '回复' },
    ];
    const projection = buildContextProjection(events, { sessionId, runId: 'run-next' });
    expect(projection.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '回复' },
    ]);
  });
});

describe('drainToolCalls 通用并行窗', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  const agentDescriptor: ToolDescriptor = {
    id: 'Agent',
    name: 'Agent',
    displayName: 'Agent',
    description: 'spawn subagent',
    schema: z.object({ tag: z.string() }),
    risk: 'safe',
    approvalMode: 'never',
    concurrency: 'parallel',
    auditCategory: 'agent.subagent',
  };
  const readDescriptor: ToolDescriptor = {
    id: 'Read',
    name: 'Read',
    displayName: 'Read',
    description: 'read',
    schema: z.object({ path: z.string() }),
    risk: 'safe',
    approvalMode: 'never',
    concurrency: 'parallel',
    auditCategory: 'filesystem.read',
  };
  const serialDescriptor: ToolDescriptor = {
    id: 'SerialRead',
    name: 'SerialRead',
    displayName: 'Serial Read',
    description: 'safe but not concurrency opt-in',
    schema: z.object({ path: z.string() }),
    risk: 'safe',
    approvalMode: 'never',
    auditCategory: 'test.serial',
  };

  /**
   * opt-in 调用用 barrier 证并发重叠：预期数量的 invoke 必须同时在飞才能完成；
   * 串行执行会在 2s 超时上失败（防假绿）。
   */
  class BarrierToolRuntime implements ToolRuntime {
    readonly order: string[] = [];
    private started = 0;
    private releaseBarrier!: () => void;
    private readonly barrier = new Promise<void>((resolve) => { this.releaseBarrier = resolve; });

    constructor(private readonly expectedParallel: number) {}

    list(): ToolDescriptor[] {
      return [agentDescriptor, readDescriptor, serialDescriptor];
    }

    async invoke<TInput>(call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
      if (call.toolId === 'SerialRead') {
        const path = (call.input as { path: string }).path;
        this.order.push(`serial:${path}`);
        return { content: `serial-done:${path}` };
      }

      const tag = call.toolId === 'Agent'
        ? (call.input as { tag: string }).tag
        : (call.input as { path: string }).path;
      this.order.push(`start:${call.toolId}:${tag}`);
      this.started += 1;
      if (this.started >= this.expectedParallel) this.releaseBarrier();
      await Promise.race([
        this.barrier,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('opt-in 工具没有并行执行（barrier 2s 超时）')), 2_000);
          timer.unref?.();
        }),
      ]);
      this.order.push(`end:${call.toolId}:${tag}`);
      return { content: `done:${tag}` };
    }
  }

  class BatchAdapter implements ModelAdapter {
    calls = 0;

    constructor(private readonly toolCalls: Array<{ id: string; name: string; arguments: string }>) {}

    async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
      this.calls += 1;
      if (this.calls === 1) {
        yield { type: 'completed', content: '', toolCalls: this.toolCalls };
        return;
      }
      yield { type: 'text_delta', content: '完成' };
      yield { type: 'completed', content: '完成', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }
  }

  async function runLoop(toolRuntime: ToolRuntime, adapter: ModelAdapter): Promise<OutboundEvent[]> {
    const cwd = await mkdtemp(join(tmpdir(), 'subagent-loop-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-par'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
    });
    return collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat', content: '并行测试' },
        prompt: '并行测试',
        instructions: 'test',
        maxTurns: 3,
        connection: { apiKey: 'k', baseUrl: 'http://127.0.0.1:0' },
      },
      {
        runId: 'run-par',
        sessionId: 'session-par',
        model: 'mock-model',
        cwd,
        channelContext: { channel: 'web', user: { id: 'u', username: 'alice', role: 'user', tenantId: 'kaiyan' } },
      },
    ));
  }

  it('连续多个 Agent 调用并发执行，tool_result 仍按原顺序回填', async () => {
    const toolRuntime = new BarrierToolRuntime(2);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'a1' }) },
      { id: 'c2', name: 'Agent', arguments: JSON.stringify({ tag: 'a2' }) },
    ]));

    const starts = toolRuntime.order.filter((entry) => entry.startsWith('start:'));
    expect(starts).toHaveLength(2);
    expect(toolRuntime.order.indexOf('end:Agent:a1')).toBeGreaterThan(
      toolRuntime.order.indexOf('start:Agent:a2'),
    );

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:a2']);
    expect(results.map((event) => event.toolId)).toEqual(['c1', 'c2']);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('非 Agent 的 opt-in 工具也并发执行', async () => {
    const toolRuntime = new BarrierToolRuntime(2);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Read', arguments: JSON.stringify({ path: 'a.txt' }) },
      { id: 'c2', name: 'Read', arguments: JSON.stringify({ path: 'b.txt' }) },
    ]));

    expect(toolRuntime.order.indexOf('end:Read:a.txt')).toBeGreaterThan(
      toolRuntime.order.indexOf('start:Read:b.txt'),
    );
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a.txt', 'done:b.txt']);
    expect(results.map((event) => event.toolId)).toEqual(['c1', 'c2']);
  });

  it('不同的 opt-in 工具可进入同一并行窗', async () => {
    const toolRuntime = new BarrierToolRuntime(3);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'a1' }) },
      { id: 'c2', name: 'Agent', arguments: JSON.stringify({ tag: 'a2' }) },
      { id: 'c3', name: 'Read', arguments: JSON.stringify({ path: 'x.txt' }) },
    ]));

    const starts = toolRuntime.order.filter((entry) => entry.startsWith('start:'));
    expect(starts).toHaveLength(3);
    expect(toolRuntime.order.findIndex((entry) => entry.startsWith('end:'))).toBeGreaterThan(2);
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:a2', 'done:x.txt']);
  });

  it('未 opt-in 的 safe 工具保持串行并切断并行窗', async () => {
    const toolRuntime = new BarrierToolRuntime(2);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'a1' }) },
      { id: 'c2', name: 'Read', arguments: JSON.stringify({ path: 'x.txt' }) },
      { id: 'c3', name: 'SerialRead', arguments: JSON.stringify({ path: 'later.txt' }) },
    ]));

    const serialIndex = toolRuntime.order.indexOf('serial:later.txt');
    expect(serialIndex).toBeGreaterThan(toolRuntime.order.indexOf('end:Agent:a1'));
    expect(serialIndex).toBeGreaterThan(toolRuntime.order.indexOf('end:Read:x.txt'));
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:x.txt', 'serial-done:later.txt']);
  });

  it('单个 opt-in 调用行为与串行路径一致', async () => {
    const toolRuntime = new BarrierToolRuntime(1);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Read', arguments: JSON.stringify({ path: 'solo.txt' }) },
    ]));
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:solo.txt']);
  });
});
