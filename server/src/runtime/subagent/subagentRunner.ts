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
import { SkillToolProvider } from '../../agent/skillToolProvider.js';
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
import { mergeOrgAgentWorkerRuntimePolicy } from '../../data/orgAgents/runtimePolicy.js';
import type { ExecutionTransportRegistry } from '../executionTransport.js';
import { LegacyTranscriptProjection } from '../legacyTranscriptProjection.js';
import { RawAgentLoop } from '../rawAgentLoop.js';
import { customerSafeRuntimeError } from '../runtimeFailure.js';
import { deriveRuntimeIsolationRequirement } from '../runtimeIsolationEvidence.js';
import {
  buildTenantRemoteHandWireEnv,
  createApprovalStoreForSession,
  createEventStoreForSession,
  createModelAdapterForProtocol,
  ensureRuntimeHandRegistered,
  appendResolvedRunSnapshot,
  markRunState,
  resolveSessionCatalog,
  resolveTenantRemoteHandsSource,
  resolveEffectiveApprovalPolicy,
  RunStateTrackingEventStore,
  visibleWorkspaceCwd,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord, type MemoryPolicyVersion, type RuntimeSessionRecord } from '../sessionCatalog.js';
import { applyMainSessionToolFilter } from '../toolProfiles.js';
import { SessionContextService, SessionToolProvider } from '../sessionContext.js';
import type { TenantRemoteHandAuthTokenResolver } from '../tenantRemoteHandResolver.js';
import type { RunRecord } from '../runStore.js';
import type { RunContext } from '../types.js';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import { addTimestampPrefix } from '../../utils/timestamp.js';
import type { SubagentTypeDefinition } from './agentTypes.js';
import {
  applyAgentRuntimeProfile,
  assertAgentProfileExecutionTarget,
  filterAgentProfileSkills,
  profileRunMetadata,
  resolveAgentProfileMaxTurns,
  type BoundAgentRuntimeProfile,
} from '../agentProfiles.js';
import {
  sharedSubagentLimiter,
  SubagentLimiter,
  SUBAGENT_HARD_TIMEOUT_MS,
} from './subagentLimits.js';

const logger = createLogger('SubagentRunner');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const SUBAGENT_CAPACITY_POLL_MS = 100;

/**
 * 无条件剥夺清单（D4，按 descriptor.name/id 匹配）：
 *   - Agent：禁嵌套（全行业共识，工具移除式——模型看不到 > 运行时报错）
 *   - AskUserQuestion：子 agent 无 UI 交互通道
 *   - CronManage：不能以父身份排程（OpenClaw/Hermes 同款黑名单）
 *   - BackgroundTask：禁止后台任务嵌套治理
 *   - CompanyInfo 刻意不剥夺：action=read 对子 agent 有价值；action=update
 *     由 neverAutoApprove 审批闸门挡（子 agent 无审批通道，调用即失败）
 *   - 旧名（CronList/UpdateCompanyInfo/BackgroundTaskList 等）保留匹配，
 *     防御存量配置与名字混用，冗余无害（2026-08-03 工具面收敛批次）
 */
export const SUBAGENT_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Agent',
  'AskUserQuestion',
  'CronList',
  'CronManage',
  'UpdateCompanyInfo',
  'BackgroundTask',
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
  failureKind?: RuntimeFailureKind;
  recoveryAction?: RuntimeRecoveryAction;
  totalTokens: number;
  toolUseCount: number;
  turnCount: number;
  durationMs: number;
  childSessionId: string;
  childRunId: string;
  model: string;
  modelUsage?: Record<string, SdkResultModelUsage>;
}

export function deriveChildAutomationFence(
  parentFence: ToolCallContext['automationFence'],
  childRunId: string,
  parent: { sessionId: string; runId: string },
): ToolCallContext['automationFence'] {
  if (!parentFence) return undefined;
  if (parentFence.runId !== parent.runId) {
    throw new Error('automation parent fence runId does not match the invoking parent run');
  }
  return {
    ...parentFence,
    rootSessionId: parentFence.rootSessionId ?? parent.sessionId,
    rootRunId: parentFence.rootRunId ?? parent.runId,
    runId: childRunId,
  };
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
  /** Background queue pins its Profile on the reservation session before execution. */
  profileSourceSession?: RuntimeSessionRecord;
  request: {
    description: string;
    prompt: string;
    model?: string;
    includeCompanyInfo: boolean;
  };
  /** 测试注入口；生产用进程级共享的单父限额器。 */
  limiter?: SubagentLimiter;
  /** 测试注入口；生产用 SUBAGENT_HARD_TIMEOUT_MS。 */
  hardTimeoutMs?: number;
  /** 测试注入口：替换真实 model adapter（默认 createModelAdapterForProtocol，会发真实 HTTP）。 */
  modelAdapterFactory?: (
    connection: { apiKey?: string; baseUrl?: string },
    providerOptions?: import('../../types/index.js').ModelProviderOptions,
  ) => import('../types.js').ModelAdapter;
  /** Durable caller-reserved identity. Recovery must pass the same pair instead of creating another child. */
  preparedChildIdentity?: { childSessionId: string; childRunId: string };
  /** Called before child session/run/lease/hand/provider side effects so the caller can assert durable intent. */
  beforeChildSideEffects?: (identity: { childSessionId: string; childRunId: string }) => Promise<void> | void;
  /** Durable fence immediately before a tenant remote provision request leaves the process. */
  beforeTenantRemoteProvision?: (identity: { childSessionId: string; childRunId: string }) => Promise<void> | void;
  /** Crash/recovery contract checkpoints; production callers normally leave this unset. */
  lifecycleCheckpoint?: (checkpoint: 'prepared' | 'session' | 'run' | 'lease' | 'hand' | 'before_active') => Promise<void> | void;
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
  const tenantCandidates = [
    parentSession?.tenantId,
    identity?.tenantId,
    parentContext.workspace.tenantId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const tenantId = tenantCandidates[0]?.trim();
  if (!tenantId) throw new Error(`无法确定子 agent tenant：父会话 ${parentSessionId} 缺少租户上下文。`);
  if (tenantCandidates.some((candidate) => candidate.trim() !== tenantId)) {
    throw new Error(`子 agent 父会话 tenant 上下文不一致：${parentSessionId}`);
  }
  const username = parentSession?.username || identity?.username || parentContext.workspace.username;
  const userId = parentSession?.userId || identity?.id || parentContext.workspace.userId;
  const executionTarget = parentContext.workspace.executionTarget;
  const approvalPolicy = resolveEffectiveApprovalPolicy(config, undefined, { userId, username });
  let boundProfile: BoundAgentRuntimeProfile | undefined;
  if (config.agentRuntimeProfileResolver) {
    const bindingKey = params.profileSourceSession?.profileBindingKey
      ?? (agentType.id === 'explore' ? 'subagent_explore' : 'subagent_general');
    boundProfile = await config.agentRuntimeProfileResolver.resolveForSession({
      existingSession: params.profileSourceSession ?? null,
      bindingKey,
    });
    if (parentSession?.orgAgentSnapshot) {
      boundProfile = {
        ...boundProfile,
        version: {
          ...boundProfile.version,
          config: mergeOrgAgentWorkerRuntimePolicy(
            boundProfile.version.config,
            parentSession.orgAgentSnapshot.runtime,
          ),
        },
      };
    }
    assertAgentProfileExecutionTarget(boundProfile.version.config, executionTarget);
  }

  // ── 闸门 1：模型白名单（关键不变量 3：显式传父 tenantId，不能沿用 dispatch 的单参调用） ──
  // Billing 在 childRunId 落库后按实际用量执行门禁；旧余额快照
  // 无法识别父 run 自身预占，会误拒绝合法子 Agent，因此不在派生前重复检查。
  const configuredWorkerModel = parentSession?.orgAgentSnapshot?.runtime.workerModel;
  const requestedRef = boundProfile?.version.config.model.strategy === 'fixed'
    ? boundProfile.version.config.model.modelRef
    : configuredWorkerModel?.strategy === 'fixed'
      ? configuredWorkerModel.modelRef
      : request.model?.trim() || undefined;
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
  const parentRun = await config.runStore?.get(parentRunId).catch(() => null);
  if (!model) {
    // 无 modelResolver（file backend / 测试）或父 session 无 modelRef：退回父 run 的实际模型
    model = refToResolve ?? parentRun?.model ?? undefined;
  }
  if (!model) {
    throw new Error('无法确定子 agent 模型：父会话无模型记录且未提供 model 参数。');
  }
  const apiKey = connection?.apiKey || process.env.OPENAI_API_KEY;
  const baseUrl = connection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  if (!apiKey && providerOptions?.responsesTransport !== 'codex_subscription') {
    throw new Error('子 agent 缺少模型 apiKey（模型组未配置连接且环境无 OPENAI_API_KEY）。');
  }

  // ── 闸门 3：单父并发 + 统一 Run 容量 ──
  // 每个子 run 都可动态竞选父槽；PG 容量锁保证同父同时最多一个继承者。
  // 当前继承者结束后，已等待的并行兄弟会在下一次重试中接棒，不会父等子自锁。
  const slot = await limiter.acquire(parentRunId, parentContext.signal);

  const startedAt = Date.now();
  const childSessionId = params.preparedChildIdentity?.childSessionId ?? `sub-${randomUUID()}`;
  const childRunId = params.preparedChildIdentity?.childRunId ?? `${Date.now()}-${randomUUID()}`;
  if (!childSessionId || !childRunId) throw new Error('prepared child identity is incomplete');
  const childAutomationFence = deriveChildAutomationFence(parentContext.automationFence, childRunId, {
    sessionId: parentSessionId,
    runId: parentRunId,
  });
  const parentWorkspace = parentContext.workspace;
  const childRuntimeIsolationRequirement = deriveRuntimeIsolationRequirement(
    parentContext.runtimeIsolationRequirement,
    { runId: childRunId, sessionId: childSessionId, workspaceId: parentWorkspace.id ?? childSessionId },
  );

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
    const childIdentity = { childSessionId, childRunId };
    await params.beforeChildSideEffects?.(childIdentity);
    await params.lifecycleCheckpoint?.('prepared');
    // ── 子 session/run 落库（D2：hidden session；runStore metadata 挂亲子链） ──
    let childRecord: RuntimeSessionRecord = createRuntimeSessionRecord({
      sessionId: childSessionId,
      userId,
      username,
      userRole: parentSession?.userRole ?? identity?.role,
      tenantId,
      ...(parentSession?.orgAgentId ? { orgAgentId: parentSession.orgAgentId } : {}),
      ...(parentSession?.orgAgentSnapshot ? { orgAgentSnapshot: parentSession.orgAgentSnapshot } : {}),
      ...(parentSession?.orgAgentId ? { executionRole: 'worker' as const } : {}),
      channel: parentContext.channelContext.channel,
      cwd: parentWorkspace.root,
      modelRef: refToResolve ?? model,
      sandboxProfile: parentSession?.sandboxProfile ?? 'coding',
      executionTarget,
      status: 'running',
      kind: 'subagent',
      memoryPolicyVersion: parentSession?.memoryPolicyVersion ?? 'v1',
      memoryAutomationEligible: false,
    });
    if (boundProfile && config.agentRuntimeProfileResolver) {
      childRecord = config.agentRuntimeProfileResolver.bindSessionRecord(childRecord, boundProfile);
    }
    await params.beforeChildSideEffects?.(childIdentity);
    await sessionCatalog.upsert(childRecord);
    await params.lifecycleCheckpoint?.('session');

    const baseEventStore = createEventStoreForSession(config, childRecord);
    const eventStore = new RunStateTrackingEventStore(baseEventStore, config.runStore, tenantId);
    await params.beforeChildSideEffects?.(childIdentity);
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
        outputTransactionMode: 'terminal_buffered',
        parentRunId,
        parentSessionId,
        parentToolCallId: parentContext.toolCallId,
        agentType: agentType.id,
        description: request.description,
        ...(childAutomationFence ? { automationFence: childAutomationFence } : {}),
        ...(parentSession?.orgAgentId ? { orgAgentId: parentSession.orgAgentId } : {}),
        ...(parentSession?.orgAgentId ? { executionRole: 'worker' } : {}),
        ...(parentSession?.orgAgentSnapshot?.runtime.executionMode
          ? { executionMode: parentSession.orgAgentSnapshot.runtime.executionMode }
          : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(boundProfile ? profileRunMetadata(boundProfile) : {}),
        cwd: parentWorkspace.root,
        // 刻意不写 wakeMessage：子 run 是父死子亡语义，绝不允许 scheduler 恢复重放
      },
    });
    await params.lifecycleCheckpoint?.('run');
    const billing = config.billingService?.();
    if (billing && tenantId) {
      const decision = await billing.authorizeRun({
        tenantId,
        userId,
        runId: childRunId,
      });
      if (!decision.ok) {
        const reason = `[${decision.code}] ${decision.reason}`;
        await markRunState(config.runStore, eventStore, childSessionId, childRunId, 'failed', reason, undefined, { tenantId }).catch(() => undefined);
        await sessionCatalog.markStatus(childSessionId, 'error').catch(() => undefined);
        throw new Error(reason);
      }
    }
    // 子 run 与顶层 run 通过同一个 PG advisory capacity lock 准入；容量满时留在父进程内
    // 等待而不交给 scheduler 重放。lease 时长覆盖硬超时 + 余量，短命 run 无需续租。
    try {
      await params.beforeChildSideEffects?.(childIdentity);
      await acquireSubagentRunLease({
        config,
        parentRun,
        parentRunId,
        childRunId,
        leaseMs: hardTimeoutMs + 60_000,
        signal: combinedSignal,
      });
      await markRunState(config.runStore, eventStore, childSessionId, childRunId, 'running', undefined, undefined, { tenantId });
      await params.lifecycleCheckpoint?.('lease');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await markRunState(config.runStore, eventStore, childSessionId, childRunId, combinedSignal.aborted ? 'cancelled' : 'failed', reason, undefined, { tenantId }).catch(() => undefined);
      await sessionCatalog.markStatus(childSessionId, 'error').catch(() => undefined);
      throw err;
    }

    // ── hand 注册（复用父的 workspaceId/mountSubPath → warm sandbox / tenant hand 路由对子生效） ──
    await params.beforeChildSideEffects?.(childIdentity);
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry: params.executionTransportRegistry,
      executionTarget,
      tenantId,
      sessionId: childSessionId,
      runId: childRunId,
      workspaceId: parentWorkspace.id ?? childSessionId,
      workspaceMountSubPath: parentWorkspace.mountSubPath,
      // 决策 7：hand recipe 会重算 sandboxScopeId，必须把顶层组键一并透传，
      // 否则子 Agent 的 hand 会落到 workspace 级 scope 而与父会话分到两个 pod。
      topLevelSessionId: parentWorkspace.topLevelSessionId ?? parentSessionId,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      sandboxProfile: childRecord.sandboxProfile,
      sandboxResources: parentWorkspace.sandboxResources,
      runtimeIsolationRequirement: childRuntimeIsolationRequirement,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: params.tenantHandResolver,
      userId,
      username,
      userTenantId: config.resolveUserTenantId?.({ userId, username }),
      logger: config.logger,
      beforeTenantRemoteProvision: async () => {
        await params.beforeTenantRemoteProvision?.(childIdentity);
      },
    });
    await appendResolvedRunSnapshot({
      config,
      runId: childRunId,
      session: childRecord,
      modelRef: refToResolve ?? model,
      executionTarget,
      hands: config.handStore ? await config.handStore.listBySession(childSessionId, tenantId) : [],
    });
    await params.lifecycleCheckpoint?.('hand');

    // ── 工具集派生（关键不变量 5：白名单派生 + 无条件剥夺，见 buildSubagentToolRuntime） ──
    const toolRuntime = buildSubagentToolRuntime({
      config,
      executionTransportRegistry: params.executionTransportRegistry,
      tenantHandResolver: params.tenantHandResolver,
      parentProviders: params.parentProviders,
      childEventStore: eventStore,
      childTenantId: tenantId,
      agentType,
      boundProfile,
      memoryPolicyVersion: childRecord.memoryPolicyVersion ?? 'v1',
    });

    const instructions = buildSubagentInstructions({
      agentType,
      cwd: visibleWorkspaceCwd(parentWorkspace.root, executionTarget),
      executionTarget,
      systemPrompt: config.getSystemPrompt?.(`subagent.${agentType.id}`),
      profileSystemInstructions: boundProfile?.version.config.context.systemInstructions,
      memoryReadOnly: childRecord.memoryPolicyVersion === 'v2',
      ...(parentSession?.orgAgentSnapshot ? {
        orgAgentName: parentSession.orgAgentSnapshot.name,
        orgAgentInstructions: parentSession.orgAgentSnapshot.instructions,
      } : {}),
      companyInfo: request.includeCompanyInfo
        && agentType.allowCompanyInfo
        && (!boundProfile || boundProfile.version.config.context.modules.includes('company_info'))
        ? loadCompanyInfoForSubagent(config.sharedDir, tenantId)
        : undefined,
    });

    const loop = new RawAgentLoop({
      modelAdapter: (
        params.modelAdapterFactory
        ?? config.modelAdapterFactory
        ?? createModelAdapterForProtocol
      )({ ...(apiKey ? { apiKey } : {}), baseUrl }, providerOptions),
      eventStore,
      approvalStore: createApprovalStoreForSession(config, childRecord, eventStore),
      transcriptProjection: new LegacyTranscriptProjection(childRecord.transcriptPath),
      toolRuntime,
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore,
      runtimeIsolationRequirement: childRuntimeIsolationRequirement,
      runStore: config.runStore,
      automationGuard: config.sessionAutomationRuntimeGuard,
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
    let resultMeta: {
      subtype?: string;
      resultText?: string;
      numTurns?: number;
      modelUsage?: Record<string, SdkResultModelUsage>;
      failureKind?: RuntimeFailureKind;
      recoveryAction?: RuntimeRecoveryAction;
    } | null = null;
    const childHooks: AgentRunHooks = {
      onResult: (meta) => {
        resultMeta = {
          subtype: meta.subtype,
          resultText: meta.resultText,
          numTurns: meta.numTurns,
          ...(meta.modelUsage ? { modelUsage: meta.modelUsage } : {}),
          ...(meta.failureKind ? { failureKind: meta.failureKind } : {}),
          ...(meta.recoveryAction ? { recoveryAction: meta.recoveryAction } : {}),
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
      modelRef: refToResolve ?? model,
      model,
      cwd: parentWorkspace.root,
      workspaceId: parentWorkspace.id ?? childSessionId,
      // per-session Sandbox（决策 7）：顶层组键原样继承父值——父自己若是顶层则
      // 其 topLevelSessionId 即自身；若父本身是子 Agent，则该值已是祖先顶层，
      // 于是孙/曾孙 Agent 天然递归到同一顶层，无需查库回溯。
      topLevelSessionId: parentWorkspace.topLevelSessionId ?? parentSessionId,
      sandboxScopeId: parentWorkspace.sandboxScopeId,
      mountSubPath: parentWorkspace.mountSubPath,
      sandboxResources: parentWorkspace.sandboxResources,
      tenantId,
      executionTarget,
      env: parentContext.env,
      sandboxPolicy: parentWorkspace.sandboxPolicy,
      channelContext: {
        ...parentContext.channelContext,
        outputTransactionMode: 'terminal_buffered',
      },
      approvalPolicy,
      ...(childAutomationFence ? { automationFence: childAutomationFence } : {}),
      hooks: childHooks,
      signal: combinedSignal,
      ...(billing && tenantId ? {
        authorizeModelTurn: async () => {
          const decision = await billing.authorizeRun({ tenantId, userId, runId: childRunId });
          if (!decision.ok) throw new Error(`[${decision.code}] ${decision.reason}`);
        },
      } : {}),
      ...(boundProfile ? {
        profileId: boundProfile.binding.profileId,
        profileVersionId: boundProfile.binding.profileVersionId,
        profileConfigDigest: boundProfile.binding.profileConfigDigest,
      } : {}),
    };

    await params.lifecycleCheckpoint?.('before_active');
    await params.beforeChildSideEffects?.(childIdentity);
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
    await params.beforeChildSideEffects?.(childIdentity);
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
        maxTurns: boundProfile
          ? resolveAgentProfileMaxTurns(boundProfile.version.config, agentType.maxTurns)!
          : agentType.maxTurns,
        connection: { apiKey: apiKey ?? '', baseUrl },
      },
      runContext,
    )) {
      if (event.type === 'tool_result') toolUseCount += 1;
      else if (event.type === 'error') streamError = event.error;
    }

    // ── 终态判定（关键不变量 4）：信号状态 > onResult subtype，绝不读模型文本 ──
    const durationMs = Date.now() - startedAt;
    const meta = resultMeta as {
      subtype?: string;
      resultText?: string;
      numTurns?: number;
      modelUsage?: Record<string, SdkResultModelUsage>;
      failureKind?: RuntimeFailureKind;
      recoveryAction?: RuntimeRecoveryAction;
    } | null;
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

    errorMessage = customerSafeRuntimeError(errorMessage, meta?.failureKind);

    const modelUsage = meta?.modelUsage;
    const totalTokens = sumUsageTokens(modelUsage);

    // ── 收尾：usage 记账（关键不变量 2）+ run/session 终态 ──
    if (modelUsage && username) {
      try {
        config.tokenUsageStore?.()?.recordResult({
          username,
          tenantId,
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
      undefined,
      { tenantId },
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
      ...(meta?.failureKind ? { failureKind: meta.failureKind } : {}),
      ...(meta?.recoveryAction ? { recoveryAction: meta.recoveryAction } : {}),
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
    await slot.release();
  }
}

export async function acquireSubagentRunLease(input: {
  config: RawRuntimeRunDispatchConfig;
  parentRun: RunRecord | null | undefined;
  parentRunId: string;
  childRunId: string;
  leaseMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const acquireLease = input.config.runStore?.acquireLease?.bind(input.config.runStore);
  const resolveCapacity = input.config.resolveRuntimeRunCapacity;
  if (!acquireLease || !resolveCapacity) return;

  const capacity = await resolveCapacity();
  while (!input.signal.aborted) {
    const acquired = await acquireLease(
      input.childRunId,
      `subagent:${input.parentRunId.slice(0, 16)}`,
      input.leaseMs,
      new Date(),
      capacity.maxConcurrentRuns,
      {
        foreground: isForegroundParentRun(input.parentRun),
        foregroundReservedRuns: capacity.foregroundReservedRuns,
        inheritFromRunId: input.parentRunId,
      },
    );
    if (acquired) return;
    await abortableDelay(SUBAGENT_CAPACITY_POLL_MS, input.signal);
  }
  throw input.signal.reason instanceof Error
    ? input.signal.reason
    : new Error('等待子 Agent 统一容量槽时被取消');
}

function isForegroundParentRun(record: RunRecord | null | undefined): boolean {
  if (!record) return true;
  if (record.metadata?.backgroundTask === true) return false;
  const toolProfile = record.metadata?.toolProfile;
  if (toolProfile === 'memory_poll' || toolProfile === 'memory_consolidate') return false;
  if (record.channel === 'cron') return false;
  if (record.metadata?.taskboardExecution === true || record.metadata?.taskboardContinuation === true) return false;
  return true;
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('等待已取消');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('等待已取消'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
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
  childTenantId: string;
  agentType: SubagentTypeDefinition;
  boundProfile?: BoundAgentRuntimeProfile;
  memoryPolicyVersion: MemoryPolicyVersion;
}): ToolRuntime {
  const profileSkillConfig = args.boundProfile?.version.config;
  const parentProviders = profileSkillConfig
    ? args.parentProviders.map((provider) => provider instanceof SkillToolProvider
        ? provider.withEntryFilter(
            (skill) => filterAgentProfileSkills([skill], profileSkillConfig).length === 1,
            profileSkillConfig.skills.defaultSkillIds,
          )
        : provider)
    : args.parentProviders;
  const inner = new PlatformToolRuntime({
    memoryIndexService: args.config.memoryIndexService,
    executionTransportRegistry: args.executionTransportRegistry,
    handStore: args.config.handStore,
    resolveHandAuthToken: (hand) => args.tenantHandResolver.resolveForHand(hand),
    resolveWireEnv: buildTenantRemoteHandWireEnv,
    artifactService: args.config.artifactService,
    // Session 工具绑定子 session 自己的 event store：子 agent 只能检索自己的事件历史
    providers: [...parentProviders, new SessionToolProvider(new SessionContextService(args.childEventStore, args.childTenantId))],
    toolControls: args.config.toolControls,
  });
  const allowlist = args.agentType.toolAllowlist ? new Set(args.agentType.toolAllowlist) : null;
  const isAllowed = (descriptor: ToolDescriptor): boolean => {
    if (SUBAGENT_DENIED_TOOL_NAMES.has(descriptor.name) || SUBAGENT_DENIED_TOOL_NAMES.has(descriptor.id)) return false;
    if (allowlist) return allowlist.has(descriptor.name) || allowlist.has(descriptor.id);
    return true;
  };
  const sceneFiltered = new FilteredToolRuntime(inner, isAllowed);
  const profileFiltered = args.boundProfile
    ? applyAgentRuntimeProfile(sceneFiltered, args.boundProfile)
    : sceneFiltered;
  return args.memoryPolicyVersion === 'v2'
    ? applyMainSessionToolFilter(profileFiltered, 'v2')
    : profileFiltered;
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
  profileSystemInstructions?: string;
  orgAgentName?: string;
  orgAgentInstructions?: string;
  memoryReadOnly?: boolean;
}): string {
  const sections: string[] = [args.systemPrompt ?? args.agentType.systemPrompt];
  if (args.profileSystemInstructions?.trim()) {
    sections.push(`<agent-profile-instructions>\n${args.profileSystemInstructions.trim()}\n</agent-profile-instructions>`);
  }
  if (args.orgAgentInstructions?.trim()) {
    sections.push([
      '<org-agent-worker-policy>',
      `你是组织 Agent「${args.orgAgentName ?? '未命名'}」派生的执行 Worker，不承担前台接待或再次派单。`,
      '以下组织规则继续约束你的执行；其中若包含“只负责调度”等前台职责，以本段 Worker 角色为准。',
      args.orgAgentInstructions.trim(),
      '</org-agent-worker-policy>',
    ].join('\n'));
  }
  sections.push([
    '<env>',
    `工作目录: ${args.cwd}（与主 agent 共享同一 workspace，文件读写彼此可见）`,
    `执行环境: ${args.executionTarget}`,
    'Shell 在子 agent 中仅允许 foreground；不要使用 mode="background"。',
    ...(args.memoryReadOnly
      ? ['记忆空间只读：只能用 MemorySearch/Read 查询，不得通过 Write/Edit/Shell 修改 MEMORY.md 或 memory/**。']
      : []),
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
