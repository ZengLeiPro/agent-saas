/**
 * 子 agent runner（2026-07-06，方案 D1-D6 的执行核心）。
 *
 * 一句话：在进程内为一次 Agent 工具调用装配并同步跑完一个独立 RawAgentLoop——
 * 独立 hidden session（`sub-` 前缀）+ 独立事件溯源 + 独立 Responses 接力链，
 * 共享父 workspace / hand / sandbox，最后一条 assistant 文本作为结果回传。
 *
 * 与 rawRuntimeRunDispatch 首跑路径的关系：复用它导出的装配小件
 * （event/approval store 工厂、model adapter 工厂、hand 注册、run 状态机），
 * 但**不复制**父路径的 session lock / 自动压缩 / approval resume / memory 注入
 * ——子 agent 是冷启动短命 run，这些机制对它要么无意义要么有害。
 *
 * 关键不变量（复核对照）：
 *   1. 子事件只进 childSessionId 的 event store，绝不写父 session；
 *   2. spawn 前过 billing hard cap，收尾必记 channel:'subagent' usage；
 *   3. model 白名单校验显式传父 tenantId；
 *   4. SubagentOutcome.status 来自 runtime outcome（信号 / onResult subtype），
 *      永不从模型文本推断，错误信息与结论文本分离。
 */

import { randomUUID } from 'crypto';

import type { AgentRunHooks, SdkResultModelUsage } from '../../agent/types.js';
import {
  LocalWorkspaceProvider,
  PlatformToolRuntime,
  type AuthorizedToolCall,
  type ToolCallContext,
  type ToolDescriptor,
  type ToolProvider,
  type ToolResult,
  type ToolRuntime,
} from '../../agent/toolRuntime.js';
import { readTenantCompanyInfoSync } from '../../data/tenants/companyInfo.js';
import { DEFAULT_TENANT_ID } from '../../data/tenants/types.js';
import type { ExecutionTransportRegistry } from '../executionTransport.js';
import { LegacyTranscriptProjection } from '../legacyTranscriptProjection.js';
import { RawAgentLoop } from '../rawAgentLoop.js';
import {
  buildTenantRemoteHandWireEnv,
  createApprovalStoreForSession,
  createEventStoreForSession,
  createModelAdapterForProtocol,
  ensureRuntimeHandRegistered,
  markRunState,
  resolveSessionCatalog,
  resolveTenantRemoteHandsSource,
  RunStateTrackingEventStore,
  visibleWorkspaceCwd,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord, type RuntimeSessionRecord } from '../sessionCatalog.js';
import { SessionContextService, SessionToolProvider } from '../sessionContext.js';
import type { TenantRemoteHandAuthTokenResolver } from '../tenantRemoteHandResolver.js';
import type { RunContext } from '../types.js';
import { createLogger } from '../../utils/logger.js';
import { addTimestampPrefix } from '../../utils/timestamp.js';
import type { SubagentTypeDefinition } from './agentTypes.js';
import {
  sharedSubagentLimiter,
  SubagentLimiter,
  SUBAGENT_HARD_TIMEOUT_MS,
} from './subagentLimits.js';

const logger = createLogger('SubagentRunner');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * 无条件剥夺清单（D4，按 descriptor.name/id 匹配）：
 *   - Agent：禁嵌套（全行业共识，工具移除式——模型看不到 > 运行时报错）
 *   - AskUserQuestion：子 agent 无 UI 交互通道
 *   - CronList/CronManage：不能以父身份排程（OpenClaw/Hermes 同款黑名单）
 *   - UpdateCompanyInfo：NEVER_AUTO_APPROVE 强审批工具，子 agent 内无审批通道
 */
export const SUBAGENT_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Agent',
  'AskUserQuestion',
  'CronList',
  'CronManage',
  'UpdateCompanyInfo',
  'BackgroundTaskList',
  'BackgroundTaskStatus',
  'BackgroundTaskCancel',
  'BashOutput',
  'KillBash',
]);

export type SubagentStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface SubagentOutcome {
  status: SubagentStatus;
  /** 子 run 最后一条 assistant 文本（失败/超时/取消时为已产出的部分文本，可能为空）。 */
  text: string;
  /** status !== 'completed' 时的错误说明（错误名 + message，与结论文本严格分离）。 */
  errorMessage?: string;
  totalTokens: number;
  toolUseCount: number;
  turnCount: number;
  durationMs: number;
  childSessionId: string;
  childRunId: string;
  model: string;
  modelUsage?: Record<string, SdkResultModelUsage>;
}

export interface RunSubagentParams {
  config: RawRuntimeRunDispatchConfig;
  executionTransportRegistry: ExecutionTransportRegistry;
  tenantHandResolver: TenantRemoteHandAuthTokenResolver;
  /**
   * 父 run 的 provider 集快照（**不含** AgentToolProvider 自身——collectRuntimeTooling
   * 在 push Agent 之前截取）。子工具集从这里派生，保证「子不可能拿到父没有的工具」。
   */
  parentProviders: ToolProvider[];
  /** 父 run 的 ToolCallContext（workspace/channelContext/signal/sessionId/runId/toolCallId 来源）。 */
  parentContext: ToolCallContext;
  agentType: SubagentTypeDefinition;
  request: {
    description: string;
    prompt: string;
    model?: string;
    includeCompanyInfo: boolean;
  };
  /** 测试注入口；生产用进程级共享单例。 */
  limiter?: SubagentLimiter;
  /** 测试注入口；生产用 SUBAGENT_HARD_TIMEOUT_MS。 */
  hardTimeoutMs?: number;
  /** 测试注入口：替换真实 model adapter（默认 createModelAdapterForProtocol，会发真实 HTTP）。 */
  modelAdapterFactory?: (
    connection: { apiKey: string; baseUrl: string },
    providerOptions?: import('../../types/index.js').ModelProviderOptions,
  ) => import('../types.js').ModelAdapter;
  /** 子 session/run 已建好、即将起跑时回调（AgentToolProvider 用它发 durable subagent_started）。 */
  onChildRunCreated?: (info: { childSessionId: string; childRunId: string; model: string }) => Promise<void> | void;
}

/**
 * 前置校验失败（限额 / billing / 模型白名单 / 装配缺件）用抛错表达：
 * 上层 invokeAuthorizedTool 的 catch 会把它转成标准化工具错误文本回给模型，
 * 不产生子 session，也不计 usage。
 */
export async function runSubagent(params: RunSubagentParams): Promise<SubagentOutcome> {
  const { config, parentContext, agentType, request } = params;
  const limiter = params.limiter ?? sharedSubagentLimiter;
  const hardTimeoutMs = params.hardTimeoutMs ?? SUBAGENT_HARD_TIMEOUT_MS;

  const parentSessionId = parentContext.sessionId ?? parentContext.workspace.sessionId;
  const parentRunId = parentContext.runId;
  if (!parentSessionId || !parentRunId) {
    throw new Error('Agent 工具需要父 run 上下文（sessionId/runId），当前调用缺失。');
  }

  const sessionCatalog = resolveSessionCatalog(config);
  const parentSession = await sessionCatalog.get(parentSessionId).catch(() => null);
  const identity = parentContext.channelContext.sessionOwner ?? parentContext.channelContext.user;
  const tenantId = parentSession?.tenantId
    ?? identity?.tenantId
    ?? parentContext.workspace.tenantId;
  const username = parentSession?.username || identity?.username || parentContext.workspace.username;
  const userId = parentSession?.userId || identity?.id || parentContext.workspace.userId;

  // ── 闸门 1：billing hard cap 前置（D6，多租户特有——防 cap 停用后经子 agent 继续烧 token） ──
  if (tenantId) {
    const billing = config.billingService?.();
    if (billing) {
      const allowed = await billing.assertTenantCanStartRun(tenantId);
      if (!allowed.ok) {
        throw new Error(`子 agent 派生被计费策略拒绝：${allowed.reason}`);
      }
    }
  }

  // ── 闸门 2：模型白名单（关键不变量 3：显式传父 tenantId，不能沿用 dispatch 的单参调用） ──
  const requestedRef = request.model?.trim() || undefined;
  const inheritedRef = parentSession?.modelRef;
  const refToResolve = requestedRef ?? inheritedRef;
  let model: string | undefined;
  let connection: { apiKey?: string; baseUrl?: string } | undefined;
  let providerOptions: import('../../types/index.js').ModelProviderOptions | undefined;
  if (refToResolve && config.modelResolver) {
    const resolved = config.modelResolver(refToResolve, tenantId);
    if (!resolved && requestedRef) {
      throw new Error(`子 agent 模型 "${requestedRef}" 不在当前组织可用模型白名单内。省略 model 参数可继承主 agent 模型。`);
    }
    if (resolved) {
      model = resolved.model;
      connection = resolved.connection;
      providerOptions = resolved.providerOptions;
    }
  }
  if (!model) {
    // 无 modelResolver（file backend / 测试）或父 session 无 modelRef：退回父 run 的实际模型
    model = refToResolve ?? (await config.runStore?.get(parentRunId).catch(() => null))?.model ?? undefined;
  }
  if (!model) {
    throw new Error('无法确定子 agent 模型：父会话无模型记录且未提供 model 参数。');
  }
  const apiKey = connection?.apiKey || process.env.OPENAI_API_KEY;
  const baseUrl = connection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  if (!apiKey) {
    throw new Error('子 agent 缺少模型 apiKey（模型组未配置连接且环境无 OPENAI_API_KEY）。');
  }

  // ── 闸门 3：并发/总数限额（总数超限立即拒绝；并发满则排队，受父 signal 中断） ──
  const slot = await limiter.acquire(parentRunId, parentContext.signal);

  const startedAt = Date.now();
  const childSessionId = `sub-${randomUUID()}`;
  const childRunId = `${Date.now()}-${randomUUID()}`;
  const parentWorkspace = parentContext.workspace;
  const executionTarget = parentWorkspace.executionTarget;

  // 硬超时与父 abort 合并；分离的 controller 让终态可区分 timeout / cancelled
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    timeoutController.abort(new Error(`subagent hard timeout after ${hardTimeoutMs}ms`));
  }, hardTimeoutMs);
  timeoutTimer.unref?.();
  const combinedSignal = parentContext.signal
    ? AbortSignal.any([parentContext.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    // ── 子 session/run 落库（D2：hidden session；runStore metadata 挂亲子链） ──
    const childRecord: RuntimeSessionRecord = createRuntimeSessionRecord({
      sessionId: childSessionId,
      userId,
      username,
      userRole: parentSession?.userRole ?? identity?.role,
      tenantId,
      channel: parentContext.channelContext.channel,
      cwd: parentWorkspace.root,
      modelRef: refToResolve ?? model,
      executionTarget,
      status: 'running',
      kind: 'subagent',
    });
    await sessionCatalog.upsert(childRecord);

    const baseEventStore = createEventStoreForSession(config, childRecord);
    const eventStore = new RunStateTrackingEventStore(baseEventStore, config.runStore, tenantId);
    await config.runStore?.upsertPending({
      runId: childRunId,
      sessionId: childSessionId,
      userId,
      tenantId,
      model,
      channel: parentContext.channelContext.channel,
      executionTarget,
      workspaceId: parentWorkspace.id ?? childSessionId,
      sandboxScopeId: parentWorkspace.sandboxScopeId,
      metadata: {
        subagent: true,
        parentRunId,
        parentSessionId,
        parentToolCallId: parentContext.toolCallId,
        agentType: agentType.id,
        description: request.description,
        cwd: parentWorkspace.root,
        // 刻意不写 wakeMessage：子 run 是父死子亡语义，绝不允许 scheduler 恢复重放
      },
    });
    // 占住 lease 让 scheduler 的 listRecoverable 不会把执行中的子 run 当孤儿捡走
    //（running + lease_expires_at 未过期 = 不可回收）。lease 时长覆盖硬超时 + 余量，
    // 短命 run 无需续租；进程崩溃后 lease 过期，由 wakeRuntimeSession 的 subagent
    // 守卫直接判 orphaned（见 rawRuntimeRunDispatch.ts）。
    await config.runStore?.acquireLease?.(childRunId, `subagent:${parentRunId.slice(0, 16)}`, hardTimeoutMs + 60_000)
      .catch(() => null);
    await markRunState(config.runStore, eventStore, childSessionId, childRunId, 'running');

    // ── hand 注册（复用父的 workspaceId/mountSubPath → warm sandbox / tenant hand 路由对子生效） ──
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry: params.executionTransportRegistry,
      executionTarget,
      sessionId: childSessionId,
      workspaceId: parentWorkspace.id ?? childSessionId,
      workspaceMountSubPath: parentWorkspace.mountSubPath,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: params.tenantHandResolver,
      userId,
      username,
      userTenantId: config.resolveUserTenantId?.({ userId, username }),
      logger: config.logger,
    });

    // ── 工具集派生（关键不变量 5：白名单派生 + 无条件剥夺，见 buildSubagentToolRuntime） ──
    const toolRuntime = buildSubagentToolRuntime({
      config,
      executionTransportRegistry: params.executionTransportRegistry,
      tenantHandResolver: params.tenantHandResolver,
      parentProviders: params.parentProviders,
      childEventStore: eventStore,
      agentType,
    });

    const instructions = buildSubagentInstructions({
      agentType,
      cwd: visibleWorkspaceCwd(parentWorkspace.root, executionTarget),
      executionTarget,
      systemPrompt: config.getSystemPrompt?.(`subagent.${agentType.id}`),
      companyInfo: request.includeCompanyInfo && agentType.allowCompanyInfo
        ? loadCompanyInfoForSubagent(config.sharedDir, tenantId)
        : undefined,
    });

    const loop = new RawAgentLoop({
      modelAdapter: (params.modelAdapterFactory ?? createModelAdapterForProtocol)({ apiKey, baseUrl }, providerOptions),
      eventStore,
      approvalStore: createApprovalStoreForSession(config, childRecord, eventStore),
      transcriptProjection: new LegacyTranscriptProjection(childRecord.transcriptPath),
      toolRuntime,
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore,
      runStore: config.runStore,
    });

    // ── 子 hooks（不透传父 hooks，防子事件泄进父通道）──
    //   - onInteraction：审批显式失败（D4）。ToolPolicyDecision 联合类型没有「错误」
    //     分支，无法在 policy 层直接转错误文本；但 executeToolCall 对 requires_approval
    //     的路径是 approvalStore.create → hooks.onInteraction，onInteraction 抛普通
    //     Error 会被它 catch 并转成 approval rejected + 标准化工具错误结果——正是
    //     「显式报错、不冒泡、不静默」要的行为（若不提供该 hook，loop 会抛
    //     ApprovalPendingWithoutInteractionHook 静默挂起子 run，绝不允许）。
    //   - onResult：捕获 runtime outcome（subtype/resultText/modelUsage），
    //     终态判定唯一依据，不解析模型文本。
    let resultMeta: { subtype?: string; resultText?: string; numTurns?: number; modelUsage?: Record<string, SdkResultModelUsage> } | null = null;
    const childHooks: AgentRunHooks = {
      onResult: (meta) => {
        resultMeta = {
          subtype: meta.subtype,
          resultText: meta.resultText,
          numTurns: meta.numTurns,
          ...(meta.modelUsage ? { modelUsage: meta.modelUsage } : {}),
        };
      },
      onInteraction: async (event) => {
        throw new Error(
          `工具 ${event.toolName ?? event.toolId ?? ''} 需要人工审批，子 agent 内没有审批通道，不可用。`
          + '请在报告中说明，由主 agent 自行执行或改用其他方式。',
        );
      },
    };

    const runContext: RunContext = {
      runId: childRunId,
      sessionId: childSessionId,
      model,
      cwd: parentWorkspace.root,
      workspaceId: parentWorkspace.id ?? childSessionId,
      sandboxScopeId: parentWorkspace.sandboxScopeId,
      mountSubPath: parentWorkspace.mountSubPath,
      tenantId,
      executionTarget,
      sandboxPolicy: parentWorkspace.sandboxPolicy,
      channelContext: parentContext.channelContext,
      hooks: childHooks,
      signal: combinedSignal,
    };

    await params.onChildRunCreated?.({ childSessionId, childRunId, model });
    logger.info(
      `[subagent] start type=${agentType.id} child=${childSessionId} run=${childRunId} `
      + `parent=${parentSessionId}/${parentRunId} model=${model}`,
    );

    // ── 消费子事件流：丢弃 delta，只聚合计数；子事件绝不 yield 进父 outbound 流 ──
    let toolUseCount = 0;
    let streamError: string | undefined;
    // 子 Agent 绕过主 dispatch/buildPrompt，因此在它自己的入站边界固化一次时间戳。
    // modelContent 会持久化这个值；后续 full replay 只能重放，adapter 不再按当前时钟改写。
    const prompt = addTimestampPrefix(request.prompt, parentContext.channelContext.timezone);
    for await (const event of loop.run(
      {
        message: {
          channel: parentContext.channelContext.channel as import('../../types/index.js').ChannelType,
          chatId: childSessionId,
          content: request.prompt,
          senderId: userId,
          senderName: username,
          metadata: { subagent: true, parentRunId, parentSessionId },
        },
        prompt,
        instructions,
        maxTurns: agentType.maxTurns,
        connection: { apiKey, baseUrl },
      },
      runContext,
    )) {
      if (event.type === 'tool_result') toolUseCount += 1;
      else if (event.type === 'error') streamError = event.error;
    }

    // ── 终态判定（关键不变量 4）：信号状态 > onResult subtype，绝不读模型文本 ──
    const durationMs = Date.now() - startedAt;
    const meta = resultMeta as { subtype?: string; resultText?: string; numTurns?: number; modelUsage?: Record<string, SdkResultModelUsage> } | null;
    let status: SubagentStatus;
    let errorMessage: string | undefined;
    if (timeoutController.signal.aborted) {
      status = 'timeout';
      errorMessage = `子 agent 超过硬超时 ${Math.round(hardTimeoutMs / 1000)}s 被终止`;
    } else if (parentContext.signal?.aborted) {
      status = 'cancelled';
      errorMessage = '父 run 被停止，子 agent 级联取消';
    } else if (meta?.subtype === 'success') {
      status = 'completed';
    } else {
      status = 'failed';
      errorMessage = streamError ?? `子 agent 异常终止（subtype=${meta?.subtype ?? 'unknown'}）`;
    }

    const modelUsage = meta?.modelUsage;
    const totalTokens = sumUsageTokens(modelUsage);

    // ── 收尾：usage 记账（关键不变量 2）+ run/session 终态 ──
    if (modelUsage && username) {
      try {
        config.tokenUsageStore?.()?.recordResult({
          username,
          tenantId: tenantId ?? DEFAULT_TENANT_ID,
          channel: 'subagent',
          modelUsage,
          occurredAtMs: Date.now(),
        });
      } catch (err) {
        logger.warn(`[subagent] usage 记账失败 child=${childRunId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const finalRunStatus = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    await markRunState(
      config.runStore,
      eventStore,
      childSessionId,
      childRunId,
      finalRunStatus,
      status === 'timeout' ? 'subagent_timeout' : errorMessage,
    ).catch(() => undefined);
    await sessionCatalog.markStatus(childSessionId, status === 'completed' ? 'finished' : 'error').catch(() => undefined);

    logger.info(
      `[subagent] finished type=${agentType.id} child=${childSessionId} status=${status} `
      + `tokens=${totalTokens} toolUses=${toolUseCount} durationMs=${durationMs}`,
    );

    return {
      status,
      text: meta?.resultText ?? '',
      ...(errorMessage ? { errorMessage } : {}),
      totalTokens,
      toolUseCount,
      turnCount: meta?.numTurns ?? 0,
      durationMs,
      childSessionId,
      childRunId,
      model,
      ...(modelUsage ? { modelUsage } : {}),
    };
  } finally {
    clearTimeout(timeoutTimer);
    slot.release();
  }
}

function sumUsageTokens(modelUsage: Record<string, SdkResultModelUsage> | undefined): number {
  if (!modelUsage) return 0;
  let total = 0;
  for (const usage of Object.values(modelUsage)) {
    total += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return total;
}

/**
 * 子 agent 工具运行时：以父 provider 快照 + 子 session 工具重建 PlatformToolRuntime，
 * 再包一层 descriptor 级过滤。过滤放在 runtime 层而不是 provider 层，因为 workspace
 * 文件工具（Read/Write/Shell/Edit…）来自 PlatformToolRuntime 内建的
 * WorkspaceToolProvider，不在 providers 数组里——provider 级过滤对它们无效。
 */
function buildSubagentToolRuntime(args: {
  config: RawRuntimeRunDispatchConfig;
  executionTransportRegistry: ExecutionTransportRegistry;
  tenantHandResolver: TenantRemoteHandAuthTokenResolver;
  parentProviders: ToolProvider[];
  childEventStore: import('../types.js').EventStore;
  agentType: SubagentTypeDefinition;
}): ToolRuntime {
  const inner = new PlatformToolRuntime({
    memoryIndexService: args.config.memoryIndexService,
    executionTransportRegistry: args.executionTransportRegistry,
    handStore: args.config.handStore,
    resolveHandAuthToken: (hand) => args.tenantHandResolver.resolveForHand(hand),
    resolveWireEnv: buildTenantRemoteHandWireEnv,
    artifactService: args.config.artifactService,
    // Session 工具绑定子 session 自己的 event store：子 agent 只能检索自己的事件历史
    providers: [...args.parentProviders, new SessionToolProvider(new SessionContextService(args.childEventStore))],
    toolControls: args.config.toolControls,
  });
  const allowlist = args.agentType.toolAllowlist ? new Set(args.agentType.toolAllowlist) : null;
  const isAllowed = (descriptor: ToolDescriptor): boolean => {
    if (SUBAGENT_DENIED_TOOL_NAMES.has(descriptor.name) || SUBAGENT_DENIED_TOOL_NAMES.has(descriptor.id)) return false;
    if (allowlist) return allowlist.has(descriptor.name) || allowlist.has(descriptor.id);
    return true;
  };
  return new FilteredToolRuntime(inner, isAllowed);
}

/**
 * descriptor 级白名单运行时。list() 过滤决定模型可见工具集（被剥夺的工具模型
 * 根本看不到，loop 的 descriptorsByName 查不到会返回「tool not found」标准错误）；
 * invoke() 再做一次防御性拦截（防未来出现绕过 list 的直调路径）。
 */
class FilteredToolRuntime implements ToolRuntime {
  constructor(
    private readonly inner: ToolRuntime,
    private readonly isAllowed: (descriptor: ToolDescriptor) => boolean,
  ) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    return this.inner.list(context).filter((descriptor) => this.isAllowed(descriptor));
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    const descriptor = this.inner.list(context).find(
      (candidate) => candidate.id === call.toolId || candidate.name === call.toolId,
    );
    if (!descriptor || !this.isAllowed(descriptor)) {
      throw new Error(`工具 ${call.toolId} 不在子 agent 可用工具集内`);
    }
    return this.inner.invoke(call, context);
  }
}

/**
 * 子 instructions（D3 冷启动）：agentType 角色 prompt + 环境段 + 可选 company-info。
 * 刻意**不**注入 MEMORY / PERSONA / 父对话历史 / workspace-shared prompts——
 * prompt 参数是父→子唯一信息通道，上下文卫生是子 agent 的核心价值。
 */
function buildSubagentInstructions(args: {
  agentType: SubagentTypeDefinition;
  cwd: string;
  executionTarget: string;
  companyInfo?: string;
  systemPrompt?: string;
}): string {
  const sections: string[] = [args.systemPrompt ?? args.agentType.systemPrompt];
  sections.push([
    '<env>',
    `工作目录: ${args.cwd}（与主 agent 共享同一 workspace，文件读写彼此可见）`,
    `执行环境: ${args.executionTarget}`,
    'Shell 在子 agent 中仅允许 foreground；不要使用 mode="background"。',
    `当前时间: ${new Date().toISOString()}`,
    '</env>',
  ].join('\n'));
  if (args.companyInfo) {
    sections.push(`<company-info>\n${args.companyInfo}\n</company-info>`);
  }
  return sections.join('\n\n');
}

function loadCompanyInfoForSubagent(sharedDir: string, tenantId: string | undefined): string | undefined {
  if (!tenantId) return undefined;
  try {
    const content = readTenantCompanyInfoSync(sharedDir, tenantId)?.trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}
