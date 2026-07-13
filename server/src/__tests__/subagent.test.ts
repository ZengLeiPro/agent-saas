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
 *   - drainToolCalls 并行窗：多 Agent 并发重叠、结果按序、混合 batch 分段
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
  SUBAGENT_HARD_TIMEOUT_MS,
  SUBAGENT_MAX_TURNS,
  SubagentLimiter,
  SubagentLimitError,
} from '../runtime/subagent/subagentLimits.js';
import { runSubagent, type SubagentOutcome } from '../runtime/subagent/subagentRunner.js';
import { createTenantRemoteHandAuthTokenResolver } from '../runtime/tenantRemoteHandResolver.js';
import type { ModelAdapter, ModelEvent, ModelRequest, PlatformEvent, RunContext } from '../runtime/types.js';
import type { ChannelContext, OutboundEvent } from '../types/index.js';

// ────────────────────────── 共用 fixture ──────────────────────────

/** 一次成功即收束的模型：可选记录第一轮 request（工具集断言用）。 */
class TextOnlyAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];

  constructor(private readonly text = '子任务完成：结论 A。') {}

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: 'text_delta', content: this.text };
    yield {
      type: 'completed',
      content: this.text,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

/** 悬挂直到 signal abort（超时 / 级联取消路径）。 */
class HangingAdapter implements ModelAdapter {
  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error('model stream aborted'));
      if (request.signal?.aborted) return abort();
      request.signal?.addEventListener('abort', abort, { once: true });
    });
    throw new Error('unreachable');
  }
}

/** 首轮即抛（上游 API 5xx 形态）。 */
class FailingAdapter implements ModelAdapter {
  // eslint-disable-next-line require-yield
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    throw new Error('upstream 500: model unavailable');
  }
}

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
  it('单 run 总数超限立即硬拒绝，不排队', async () => {
    const limiter = new SubagentLimiter({ perRunMaxTotal: 2, perRunMaxConcurrency: 4 });
    const a = await limiter.acquire('run-1');
    const b = await limiter.acquire('run-1');
    await expect(limiter.acquire('run-1')).rejects.toThrow(SubagentLimitError);
    a.release();
    b.release();
    // 释放并发不回退总数：总数是「本 run 已派生数」而非「在飞数」
    await expect(limiter.acquire('run-1')).rejects.toThrow(/总数已达上限/);
    // 其他 run 不受影响
    (await limiter.acquire('run-2')).release();
  });

  it('并发满时排队等待，release 后放行；等待可被 signal 中断', async () => {
    const limiter = new SubagentLimiter({ perRunMaxConcurrency: 1, perRunMaxTotal: 10 });
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
});

describe('runSubagent', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('completed：结果文本回传、usage 落 channel=subagent、子事件不进父 store、catalog 记 kind=subagent', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const outcome = await runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [createBuiltinTools()],
      agentType: SUBAGENT_TYPES.general,
      request: { description: '测试子任务', prompt: '完成测试子任务', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new TextOnlyAdapter(),
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.text).toContain('子任务完成');
    expect(outcome.errorMessage).toBeUndefined();
    expect(outcome.childSessionId.startsWith('sub-')).toBe(true);
    expect(outcome.totalTokens).toBe(15);

    // 关键不变量 1：父 session event store 零事件（runner 只写 childSessionId）
    await expect(fixture.parentEventStore.list(fixture.parentSessionId)).resolves.toEqual([]);
    const childEvents = await fixture.config.eventStoreFactory!(
      createRuntimeSessionRecord({ sessionId: outcome.childSessionId, channel: 'web', cwd: fixture.tmp }),
    ).list(outcome.childSessionId);
    expect(childEvents.some((event) => event.type === 'run_started')).toBe(true);
    expect(childEvents.some((event) => event.type === 'run_finished' && event.subtype === 'success')).toBe(true);

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

  it('限额闸门：单 run 总数超限抛 SubagentLimitError', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const limiter = new SubagentLimiter({ perRunMaxTotal: 1 });
    const base = {
      ...runnerDeps(fixture),
      parentProviders: [] as ToolProvider[],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter,
      modelAdapterFactory: () => new TextOnlyAdapter(),
    };
    await runSubagent(base);
    await expect(runSubagent(base)).rejects.toThrow(/总数已达上限/);
    // 拒绝路径不产生 usage 记账
    expect(fixture.usageRecords).toHaveLength(1);
  });

  it('billing hard cap 拒绝：spawn 前抛错，不建子 session', async () => {
    const fixture = await makeFixture({
      cleanupDirs,
      billingService: {
        assertTenantCanStartRun: async () => ({ ok: false, reason: '组织积分余额不足，当前计费策略已启用硬封顶。' }),
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
    const pending = runSubagent({
      ...runnerDeps(fixture),
      parentProviders: [],
      agentType: SUBAGENT_TYPES.general,
      request: { description: 't', prompt: 'p', includeCompanyInfo: false },
      limiter: new SubagentLimiter(),
      modelAdapterFactory: () => new HangingAdapter(),
    });
    setTimeout(() => abortController.abort(), 30);
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

  it('工具剥夺清单：general 拿全量减 Agent/AskUserQuestion/Cron*/UpdateCompanyInfo', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    // 父 provider 集里刻意混入被剥夺名字（模拟嵌套/排程/强审批工具在父侧存在）
    const deniedNamesProvider: ToolProvider = {
      list: () => ['Agent', 'CronManage', 'CronList', 'UpdateCompanyInfo'].map((name) => ({
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
    for (const denied of ['Agent', 'AskUserQuestion', 'CronManage', 'CronList', 'UpdateCompanyInfo']) {
      expect(toolNames).not.toContain(denied);
    }
  });

  it('explore 白名单：只读集之外的工具（含 workspace 写工具）全部不可见', async () => {
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
    expect(toolNames).toContain('Glob');
    expect(toolNames).toContain('Grep');
    for (const excluded of ['Write', 'Edit', 'Shell', 'TodoWrite', 'AskUserQuestion', 'Agent', 'List']) {
      expect(toolNames).not.toContain(excluded);
    }
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
    expect(descriptor!.description).toContain('10 个子 agent');
    expect(descriptor!.description).toContain('并行 4 个');
    expect(descriptor!.description).toContain(`${SUBAGENT_MAX_TURNS} 轮`);
    expect(descriptor!.description).toContain(`${SUBAGENT_HARD_TIMEOUT_MS / 60_000} 分钟`);
    expect(descriptor!.description).toContain('general');
    expect(descriptor!.description).toContain('explore');
    expect(SUBAGENT_TYPES.general.maxTurns).toBe(SUBAGENT_MAX_TURNS);
    expect(SUBAGENT_TYPES.explore.maxTurns).toBe(SUBAGENT_MAX_TURNS);
  });

  it('durable 事件形态：subagent_started/finished 写父 session，字段完整', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    const outcome = fakeOutcome(fixture, { status: 'completed', totalTokens: 42, toolUseCount: 2 });
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
      childSessionId: outcome.childSessionId,
    });
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

describe('drainToolCalls 并行窗', () => {
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
    auditCategory: 'filesystem.read',
  };

  /**
   * Agent 调用用 barrier 证并发重叠：两个 invoke 必须同时在飞才能双双完成；
   * 串行执行会在 2s 超时上失败（防假绿）。
   */
  class BarrierToolRuntime implements ToolRuntime {
    readonly order: string[] = [];
    private started = 0;
    private releaseBarrier!: () => void;
    private readonly barrier = new Promise<void>((resolve) => { this.releaseBarrier = resolve; });

    constructor(private readonly expectedParallel: number) {}

    list(): ToolDescriptor[] {
      return [agentDescriptor, readDescriptor];
    }

    async invoke<TInput>(call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
      if (call.toolId === 'Agent') {
        const tag = (call.input as { tag: string }).tag;
        this.order.push(`start:${tag}`);
        this.started += 1;
        if (this.started >= this.expectedParallel) this.releaseBarrier();
        await Promise.race([
          this.barrier,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Agent 调用没有并行执行（barrier 2s 超时）')), 2_000);
            timer.unref?.();
          }),
        ]);
        this.order.push(`end:${tag}`);
        return { content: `done:${tag}` };
      }
      this.order.push('read');
      return { content: 'read-done' };
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

    // 并发重叠：两个 start 都先于任何 end
    const startIdx = toolRuntime.order.filter((entry) => entry.startsWith('start:'));
    expect(startIdx).toHaveLength(2);
    expect(toolRuntime.order.indexOf('end:a1')).toBeGreaterThan(toolRuntime.order.indexOf('start:a2'));

    // 结果按 toolCalls 原顺序
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:a2']);
    expect(results.map((event) => event.toolId)).toEqual(['c1', 'c2']);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('混合 batch 分段：Agent 段并行完成后，非 Agent 工具串行执行', async () => {
    const toolRuntime = new BarrierToolRuntime(2);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'a1' }) },
      { id: 'c2', name: 'Agent', arguments: JSON.stringify({ tag: 'a2' }) },
      { id: 'c3', name: 'Read', arguments: JSON.stringify({ path: 'x.txt' }) },
    ]));

    // Read 必须在两个 Agent 全部结束之后才开始
    const readIdx = toolRuntime.order.indexOf('read');
    expect(readIdx).toBeGreaterThan(toolRuntime.order.indexOf('end:a1'));
    expect(readIdx).toBeGreaterThan(toolRuntime.order.indexOf('end:a2'));

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:a2', 'read-done']);
  });

  it('单个 Agent 调用不进并行窗（barrier 需要 1 即自释放），行为与串行一致', async () => {
    const toolRuntime = new BarrierToolRuntime(1);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'solo' }) },
    ]));
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:solo']);
  });
});
