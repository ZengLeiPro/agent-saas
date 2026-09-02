import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';

import type {
  AgentRunDispatch,
  AgentRunHooks,
  AgentRunOptions,
  InteractionResponse,
  RuntimeDrainHandoffState,
} from '../agent/types.js';
import type { AgentStore } from '../data/agents/store.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import {
  mergeOrgAgentFrontRuntimePolicy,
  resolveOrgAgentRuntimeSkillIds,
} from '../data/orgAgents/runtimePolicy.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { BillingService } from '../data/billing/service.js';
import type { RunPreflightService } from './runPreflight.js';
import { resolveEffectiveApprovalPolicy } from './approvalPolicyResolution.js';
import { resolveEffectiveMaxTurns } from './maxTurnsPolicy.js';
import type { PgRunResolutionSnapshotStore } from './runResolutionSnapshotStore.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { PgEnvironmentStore } from '../data/environments/index.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { resolveAzerothInjection } from '../integrations/azeroth/tokens.js';
import type { WorkspaceRef } from '../agent/toolRuntime.js';
import { readTenantCompanyInfoSync } from '../data/tenants/companyInfo.js';
import { readTenantInstructionsSync } from '../data/tenants/instructions.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import type { UserOverrides } from '../security/extraDirs.js';
import type { DispatchConfig } from '../app/config.js';
import { buildRuntimeRunContextHooks } from './rawRuntimeRunContextHooks.js';
import type { ArtifactService } from './artifactService.js';
import type { ChannelContext, InboundMessage, ModelProviderOptions, OutboundEvent } from '../types/index.js';
import { loadMemoryContext, loadPersona } from '../agent/memory.js';
import { buildPrompt, isCompactCommand } from '../agent/prompt.js';
import {
  createDefaultExecutionTransportRegistry,
  hasMemorySearchTool,
  isToolEnabled,
  LocalWorkspaceProvider,
  type ExecutionTargetKind,
} from '../agent/toolRuntime.js';
import {
  SkillToolProvider,
  type EffectiveSkillsResolver,
  type SkillEntry,
} from '../agent/skillToolProvider.js';
import { createBuiltinTools, type BuiltinToolsConfig } from '../agent/builtinTools.js';
import { WebToolProvider, type ResolvedWebToolsConfig } from '../agent/webToolProvider.js';
import {
  ImageGenToolProvider,
  listAvailableImageGenEngineIds,
  type ResolvedImageGenToolsConfig,
} from '../agent/imageGenToolProvider.js';
import type { ResolvedAudioTranscribeToolsConfig } from '../agent/audioTranscribeToolProvider.js';
import { buildAudioTranscribeSkillFilter, createAudioTranscribeRuntimeProvider } from './audioTranscribeRuntime.js';
import { CronToolProvider } from '../agent/cronToolProvider.js';
import { TenantCompanyInfoToolProvider } from '../agent/tenantCompanyInfoToolProvider.js';
import { UserActivityToolProvider } from '../agent/userActivityToolProvider.js';
import type { UserActivityService } from './userActivityService.js';
import {
  normalizeToolProfile,
  type MemoryWritePolicyVersion,
} from './toolProfiles.js';
import { createRuntimeToolRuntime } from './runtimeToolRuntimeFactory.js';
import {
  AgentRuntimeProfileResolver,
  assertAgentProfileExecutionTarget,
  filterAgentProfileSkills,
  profileRunMetadata,
  resolveAgentProfileBindingKey,
  resolveAgentProfileMaxTurns,
  type BoundAgentRuntimeProfile, appendDispatcherInstructionSection, resolveAgentModePolicy,
} from './agentProfiles.js';
import { McpClientToolProvider } from '../mcp/clientToolProvider.js';
import type { McpClientManager } from '../mcp/clientManager.js';
import type { McpProxy } from '../mcp/proxy.js';
import type { ToolProvider } from '../agent/toolRuntime.js';
import type { ExecutionTransportRegistry } from './executionTransport.js';
import { ChatCompletionsModelAdapter } from './chatCompletionsAdapter.js';
import { ResponsesApiAdapter } from './responsesApiAdapter.js';
import { resolveModelOutputTransactionMode } from './modelOutputTransaction.js';
import type { ModelAdapter } from './types.js';
import { createApprovalStoreForSession, createEventStoreForSession, resolveEventTenantId } from './rawRuntimeEventStores.js';
export { createApprovalStoreForSession, createEventStoreForSession, resolveEventTenantId } from './rawRuntimeEventStores.js';
import { CodexSubscriptionResponsesTransport } from './responses/codexSubscriptionResponsesTransport.js';
import type { CodexResponsesWebSocketPool } from './responses/codexResponsesWebSocketPool.js';
import type { CodexCredentialManager } from './responses/codexCredentialManager.js';
import {
  createExecutionConfig,
  resolveExecutionTarget,
  type ExecutionConfig,
} from './executionConfig.js';
import { HttpTransport } from './httpTransport.js';
import { LegacyTranscriptProjection } from './legacyTranscriptProjection.js';
import { createLogger } from '../utils/logger.js';
import { enterSessionContext } from '../utils/requestContext.js';
import { RawAgentLoop } from './rawAgentLoop.js';
import { resolveEffectiveMcpLoadingMode } from './mcpToolLoading.js';
import { modelSupportsImage } from './imageAttachments.js';
import { resolveRuntimeInboundAttachments } from './runtimeAttachmentResolution.js';
import {
  analyzeImagesWithFallback,
  type ImageUnderstandingModelConfig,
} from './imageUnderstanding.js';
import { MINIMAL_SYSTEM_PROMPT } from './systemPrompts.js';
import type { SystemPromptId } from '../systemPrompts/types.js';
import { appendTaskboardExecutionInstruction, stripTaskboardWritableGitCredentials } from '../taskboard/runtimeTaskboardPolicy.js';
import {
  isConsumedResume,
  isResumeApprovalMetadata,
  isResumeInteractionMetadata,
  isWakeMessage,
  resolveWakePrompt,
  WAKE_EVENT_LIST_TYPES,
} from './wakeDispatchHelpers.js';

// wake/续跑相关的常量与纯判定函数已迁至 ./wakeDispatchHelpers.ts，这里按既有 import 路径继续对外转发。
export {
  HIDDEN_WAKE_CONTINUE_PROMPT,
  INTERJECTION_FALLBACK_PROMPT,
  resolveWakePrompt,
  WAKE_EVENT_LIST_TYPES,
} from './wakeDispatchHelpers.js';
import type { ContextReconstructionPolicy } from './contextProjection.js';
import { appendResolvedRunSnapshot } from './appendResolvedRunSnapshot.js';
export { appendResolvedRunSnapshot } from './appendResolvedRunSnapshot.js';
import { buildConnectorRunEnv, reconcileConnectorRunEnv } from './connectorRunEnv.js';
import {
  rejectMemoryConsolidationWake,
  resolveMemoryConsolidationReplaySource,
} from './memoryConsolidationReplay.js';
import { SessionContextService, SessionToolProvider } from './sessionContext.js';
import { buildRuntimeReplayState, type RuntimeReplayState } from './replay.js';
import { createRuntimeSessionRecord, resolveSessionMemoryPolicy, FileSessionCatalog, type RuntimeSessionRecord, type SessionCatalog } from './sessionCatalog.js';
import { resolveSessionSandboxProfile, sandboxResourcesForSessionHand } from './sandboxProfile.js';
import { resolveOrgAgentOverrides, resolveOrgAgentSessionSnapshot } from './orgAgentSessionResolution.js';
export { resolveOrgAgentOverrides, resolveOrgAgentSessionSnapshot } from './orgAgentSessionResolution.js';
import type { ApprovalRecord, EventStore, ModelAttachmentRef, PlatformEvent, QueuedInterjection, RunContext } from './types.js';
import type { RunRecord, RunStore } from './runStore.js';
import type { HandRecord, HandStore, WorkspaceRecipe } from './handStore.js';
import {
  createTenantRemoteHandAuthTokenResolver,
  type TenantRemoteHandAuthTokenResolver,
} from './tenantRemoteHandResolver.js';
import { deriveSandboxScopeId, ensureRuntimeHandRegistered, integrationRuntimeIsolationRequirement, resolveSandboxWorkloadDescriptor, toAcsSandboxWorkloadDescriptor } from './runtimeHandRegistration.js';
import { cancelDeletedSessionWake, cancelDeletedSessionWakeIfPresent, deletedSessionResumeError, restoreRuntimeSessionForWake } from './runtimeWakeSessionRestore.js';
import { resolveRuntimeModelOptions, resolveRuntimeModelRef, resolveWakeModelRef } from './runtimeModelResolution.js';
export { resolveRuntimeModelOptions, resolveRuntimeModelRef, resolveWakeModelRef } from './runtimeModelResolution.js';
import {
  STEERING_RECOVERY_FAILURE_MESSAGE, STEERING_RECOVERY_MAX_HANDOFFS,
  isTerminalRunStatus, startWakeLeaseRenewal, type RuntimeWakeLease,
} from './runtimeWakeLeaseLifecycle.js';
export { startWakeLeaseRenewal, type RuntimeWakeLease };
import type { SecretVault } from '../security/secretVault.js';
import type { NetworkPolicyConfig } from './networkPolicy.js';
import { runtimeRunController } from './runController.js';
import { appendRunStateChanged, armRuntimeRunWallClock, coordinateRunFinishedEvent, markRunState, trackRunStateAfterEvent, type TerminalEventLogger } from './runTerminalCoordinator.js';

export {
  failRunningRunForWallClock,
  markRunState,
  retryPendingTerminalEvents,
} from './runTerminalCoordinator.js';
import type { ToolInvocationStore } from './toolInvocationStore.js';
import {
  buildPendingInteractionsFromEvents,
  getInteractionResolution,
  normalizeInteractionResponse,
} from './interactionProjection.js';
import { loadPrompt, renderPrompt, type PromptVars } from './promptRenderer.js';
import { buildRawRuntimeSandboxPolicy } from './rawRuntimeSandboxPolicy.js';
import { deriveStableWorkspaceId } from './workspaceIdentity.js';
// 注意：subagent/agentToolProvider.js 反向 import 本文件的装配小件（ESM 循环依赖，
// 仅函数级引用、无模块求值期访问，安全）。
import { AgentToolProvider } from './subagent/agentToolProvider.js';
import { orphanUnrecoverableSubagentWake } from './subagent/orphanUnrecoverableSubagentWake.js';
import { reconcileInterruptedForegroundToolCalls } from './subagent/recovery.js';
import type { BackgroundTaskRuntime } from './background/backgroundTaskRuntime.js';
import { BackgroundTaskToolProvider } from './background/backgroundTaskToolProvider.js';
export { deriveSandboxScopeId, ensureRuntimeHandRegistered };
const logger = createLogger('RawRuntime');

export type { ModelAdapterFactory, ModelAdapterFactoryDependencies, RawApprovalResumeRequest, RawInteractionResumeRequest, RawRuntimeRunDispatchConfig, RawRuntimeWakeState, ServerRemoteDispatchConfig, SessionLockAcquireOptions, SessionLockAcquirer, SessionLockHandle, SkillsDispatchConfig, TenantRemoteHandDispatchConfig, TenantRemoteHandsSource, WakeRuntimeSessionOptions } from './rawRuntimeRunDispatchTypes.js';
import type { ModelAdapterFactory, ModelAdapterFactoryDependencies, RawApprovalResumeRequest, RawInteractionResumeRequest, RawRuntimeRunDispatchConfig, RawRuntimeWakeState, ServerRemoteDispatchConfig, SessionLockAcquireOptions, SessionLockAcquirer, SessionLockHandle, SkillsDispatchConfig, TenantRemoteHandDispatchConfig, TenantRemoteHandsSource, WakeRuntimeSessionOptions } from './rawRuntimeRunDispatchTypes.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/**
 * RFC v1 P0.2：按 modelProviderOptions.protocol 路由 ModelAdapter。
 * - protocol="responses" → ResponsesApiAdapter（火山 /responses 端点，previous_response_id 接力）
 * - 其它（含 undefined） → ChatCompletionsModelAdapter（保留默认行为）
 *
 * 启动时静态决定，运行时不切换；config 改回 chat_completions 即回滚。
 */
export function createModelAdapterForProtocol(
  connection: { apiKey?: string; baseUrl?: string },
  modelProviderOptions: ModelProviderOptions | undefined,
  dependencies: ModelAdapterFactoryDependencies = {},
): ModelAdapter {
  if (modelProviderOptions?.protocol === 'responses') {
    if (modelProviderOptions.responsesTransport === 'codex_subscription') {
      if (!dependencies.codexCredentialManager) {
        throw new Error('Codex subscription transport 缺少 CodexCredentialManager');
      }
      return new ResponsesApiAdapter(
        {
          apiKey: connection.apiKey ?? '',
          baseUrl: connection.baseUrl ?? 'https://chatgpt.com/backend-api/codex',
        },
        {
          ...modelProviderOptions,
          disableResponseChaining: true,
          disablePromptCacheKey: false,
        },
        new CodexSubscriptionResponsesTransport(
          dependencies.codexCredentialManager,
          dependencies.codexFetch,
          dependencies.codexWebSocketPool,
        ),
      );
    }
    if (!connection.apiKey) throw new Error('Responses model 缺少 API Key');
    return new ResponsesApiAdapter({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl ?? DEFAULT_BASE_URL,
    }, modelProviderOptions);
  }
  if (!connection.apiKey) throw new Error('Chat Completions model 缺少 API Key');
  return new ChatCompletionsModelAdapter({
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl ?? DEFAULT_BASE_URL,
  }, modelProviderOptions ?? {});
}

function modelRequiresApiKey(options: ModelProviderOptions | undefined): boolean {
  return options?.responsesTransport !== 'codex_subscription';
}
/**
 * Skills wiring：dispatch 不知道 SkillConfigStore，只知道"给我 username/skill 名字，
 * 我返回有效 skill 集合或物理路径"。runtime.ts 在装配时把 SkillConfigStore + sharedDir
 * 缝进来。
 */
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

export function resolveSessionCatalog(config: RawRuntimeRunDispatchConfig): SessionCatalog {
  return config.sessionCatalog ?? new FileSessionCatalog({ agentCwd: config.agentCwd });
}
// cron/web fallback 直跑路径也会写 runtime_runs；不占 lease 时，scheduler 会把
// 正在跑的 run 误判为可恢复并二次 wake。
const DIRECT_RUNTIME_LEASE_MS = 120_000;
const DIRECT_RUNTIME_LEASE_RENEW_INTERVAL_MS = 30_000;
export interface DirectRuntimeLeaseHandle {
  workerId: string;
  release(): Promise<void>;
}

export class DirectRuntimeLeaseContendedError extends Error {
  constructor(readonly runId: string) {
    super(`Direct runtime lease not acquired run=${runId}`);
    this.name = 'DirectRuntimeLeaseContendedError';
  }
}
export class DirectRuntimeLeaseLostError extends Error {
  constructor(readonly runId: string, reason?: string) {
    super(`Direct runtime lease lost run=${runId}${reason ? `: ${reason}` : ''}`);
    this.name = 'DirectRuntimeLeaseLostError';
  }
}

export async function acquireDirectRuntimeRunLease(input: {
  runStore: RunStore | undefined;
  runId: string;
  runtimeWorkerId?: string;
  logger?: RawRuntimeRunDispatchConfig['logger'];
  onLeaseLost?: (error: DirectRuntimeLeaseLostError) => void;
  renewIntervalMs?: number;
}): Promise<DirectRuntimeLeaseHandle | null> {
  // scheduler wake 已持有自己的 lease；未启用 durable run store 的 legacy 路径也无需抢占。
  if (input.runtimeWorkerId || !input.runStore) return null;
  if (!input.runStore.acquireLease) {
    throw new Error(`Direct runtime lease is unavailable run=${input.runId}`);
  }

  const workerId = `direct-${process.pid}-${randomUUID()}`;
  let acquired: RunRecord | null;
  try {
    acquired = await input.runStore.acquireLease(input.runId, workerId, DIRECT_RUNTIME_LEASE_MS);
  } catch (err) {
    input.logger?.warn(`Direct runtime lease acquire failed run=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  if (!acquired) {
    const error = new DirectRuntimeLeaseContendedError(input.runId);
    input.logger?.warn(error.message);
    throw error;
  }
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let leaseLost = false;
  let released = false;
  const notifyLeaseLost = (reason?: string): void => {
    if (leaseLost || released) return;
    leaseLost = true;
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    const error = new DirectRuntimeLeaseLostError(input.runId, reason);
    input.logger?.warn(`${error.message} worker=${workerId}`);
    input.onLeaseLost?.(error);
  };
  if (input.runStore.renewLease) {
    let renewInFlight: Promise<void> | undefined;
    renewTimer = setInterval(() => {
      if (renewInFlight) return;
      renewInFlight = input.runStore!.renewLease!(input.runId, workerId, DIRECT_RUNTIME_LEASE_MS)
        .then((renewed) => {
          if (!renewed) notifyLeaseLost('renewal rejected');
        })
        .catch((err) => {
          notifyLeaseLost(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          renewInFlight = undefined;
        });
    }, input.renewIntervalMs ?? DIRECT_RUNTIME_LEASE_RENEW_INTERVAL_MS);
    renewTimer.unref?.();
  }

  return {
    workerId,
    async release() {
      released = true;
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      await input.runStore?.releaseLease?.(input.runId, workerId).catch((err) => {
        input.logger?.warn(`Direct runtime lease release failed run=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    },
  };
}
export function deriveWorkspaceMountSubPath(input: { agentCwd: string; cwd?: string }): string | undefined {
  if (!input.cwd) return undefined;
  const mountRoot = resolve(input.agentCwd, '..');
  const workspaceRoot = resolve(input.cwd);
  const rel = relative(mountRoot, workspaceRoot);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function deriveRuntimeWorkspaceId(params: {
  existingSession?: RuntimeSessionRecord | null;
  fallbackSessionId: string;
  identity?: { id?: string; tenantId?: string };
}): string {
  return params.existingSession?.workspaceId
    ?? deriveStableWorkspaceId(params.identity, params.fallbackSessionId);
}
function getTenantRemoteHandResolver(
  config: RawRuntimeRunDispatchConfig,
): TenantRemoteHandAuthTokenResolver {
  if (config.tenantRemoteHandResolver) return config.tenantRemoteHandResolver;
  return createTenantRemoteHandAuthTokenResolver({
    tenantRemoteHands: config.tenantRemoteHands,
    vault: config.secretVault,
    logger: config.logger,
  });
}

export function resolveTenantRemoteHandsSource(
  source: TenantRemoteHandsSource | undefined,
): TenantRemoteHandDispatchConfig[] | undefined {
  return typeof source === 'function' ? source() : source;
}

export class RunStateTrackingEventStore implements EventStore {
  constructor(
    private readonly inner: EventStore,
    private readonly runStore: RunStore | undefined,
    private readonly tenantId: string,
    private readonly terminalEventLogger?: TerminalEventLogger,
  ) {}
  async append(
    event: Parameters<EventStore['append']>[0],
    ctx: Parameters<EventStore['append']>[1],
  ): ReturnType<EventStore['append']> {
    const tenantContext = this.withTenant(ctx);
    // runtime_runs CAS is the sole terminal verdict; only its winner publishes.
    if (this.runStore && event.type === 'run_finished') {
      return coordinateRunFinishedEvent({
        runStore: this.runStore,
        eventStore: this.inner,
        event,
        ctx: tenantContext,
        logger: this.terminalEventLogger,
      });
    }
    // PR 5 修 P0-4：透传 ctx (tenantId) 到 inner store
    const stored = await this.inner.append(event, tenantContext);
    await this.afterAppend(stored);
    return stored;
  }

  async appendBatch(
    events: Parameters<NonNullable<EventStore['appendBatch']>>[0],
    ctx: Parameters<NonNullable<EventStore['appendBatch']>>[1],
  ) {
    // Never let an inner appendBatch place run_finished ahead of its durable CAS.
    if (events.some((event) => event.type === 'run_finished')) {
      const stored = [];
      for (const event of events) stored.push(await this.append(event, ctx));
      return stored;
    }
    // PR 5 修 P0-4：透传 ctx (tenantId) 到 inner store
    const stored = this.inner.appendBatch
      ? await this.inner.appendBatch(events, this.withTenant(ctx))
      : await Promise.all(events.map((event) => this.inner.append(event, this.withTenant(ctx))));
    for (const event of stored) await this.afterAppend(event);
    return stored;
  }
  list(tenantId: string, sessionId: string, options?: Parameters<EventStore['list']>[2]) {
    return this.inner.list(tenantId, sessionId, options);
  }
  listPage(tenantId: string, sessionId: string, options?: Parameters<NonNullable<EventStore['listPage']>>[2]) {
    return this.inner.listPage?.(tenantId, sessionId, options) ?? Promise.resolve({ events: [], hasMore: false });
  }
  private withTenant(ctx: Parameters<EventStore['append']>[1]): Parameters<EventStore['append']>[1] {
    if (ctx.tenantId !== this.tenantId) throw new Error('RunStateTrackingEventStore tenant scope mismatch');
    return ctx;
  }
  private async afterAppend(event: PlatformEvent): Promise<void> {
    await trackRunStateAfterEvent({
      runStore: this.runStore,
      eventStore: this.inner,
      event,
      ctx: { tenantId: this.tenantId },
    });
  }
}

/**
 * 子 agent 工具的装配依赖（2026-07-06）：executionTransportRegistry 与
 * tenantHandResolver 是各 dispatch 工厂的闭包级对象（非 config 字段），
 * AgentToolProvider 派生子 loop 时必须复用**同一实例**（serverRemote 注册、
 * vault 解析缓存都挂在上面），所以经参数显式传入 collectRuntimeTooling。
 */
interface SubagentToolingDeps {
  executionTransportRegistry: ExecutionTransportRegistry;
  tenantHandResolver: TenantRemoteHandAuthTokenResolver; agentModePolicy?: 'any' | 'background_only';
}
/**
 * 收集本次 dispatch 用到的所有 tool providers + buildInstructions 入参。
 * 两条 dispatch（首跑 / approval resume）共用同一构造，保证 instructions 一致。
 */
export async function collectRuntimeTooling(
  config: RawRuntimeRunDispatchConfig,
  username: string | undefined,
  skillFilter: RuntimeSkillFilter = allowAllRuntimeSkills,
  requiredSkillIds: readonly string[] = [],
  subagentDeps?: SubagentToolingDeps,
  preferredSkillIds: readonly string[] = [],
  mcpWarmupContext?: { runId: string; sessionId: string; userId: string },
): Promise<{
  providers: ToolProvider[];
}> {
  const providers: ToolProvider[] = [];
  // Skill 工具：注入 EffectiveSkillsResolver，SkillToolProvider.list(context) 会用它
  // 派生用户实际可用清单并拼进工具 description（模型注意力最集中的位置）。原
  // <available-skills> xml section 已废弃（2026-07-03）。
  await config.skills?.ensureReady?.(username, requiredSkillIds);
  if (config.skills && isToolEnabled(config.toolControls, 'Skill')) {
    providers.push(new SkillToolProvider(buildRuntimeSkillsResolver(
      config.skills,
      skillFilter,
      requiredSkillIds,
      preferredSkillIds,
    )));
  }

  // 2. BuiltinTools（TodoWrite/AskUserQuestion；workspace 文件工具由 WorkspaceToolProvider 提供）
  // createBuiltinTools 内部对 undefined 已经走默认全开；这里不再做 if/else 分支区分。
  const builtin = createBuiltinTools(config.builtinTools);
  providers.push(builtin);

  // 2.5 UserActivityList（safe 只读，身份只从 context 解析；记忆轮询 + 普通会话通用）
  if (config.userActivityService && isToolEnabled(config.toolControls, 'UserActivityList')) {
    providers.push(new UserActivityToolProvider(config.userActivityService));
  }
  // 3. Web 工具（平台托管网络出站，不走 workspace hand / shell）
  if (config.tenantStore) {
    providers.push(new TenantCompanyInfoToolProvider({
      sharedDir: config.sharedDir,
      tenantStore: config.tenantStore,
    }));
  }

  // 4. Web 工具（平台托管网络出站，不走 workspace hand / shell）
  if (config.webTools && config.webTools.enabled !== false) {
    const webProvider = new WebToolProvider(config.webTools, config.webFetchImpl ?? fetch);
    const webDescriptors = webProvider.list().filter((tool) => isToolEnabled(config.toolControls, tool));
    if (webDescriptors.length > 0) {
      providers.push(webProvider);
    }
  }
  // 4.5 GenerateImage 生图工具（brain 进程内执行，不进 WORKSPACE_HAND_TOOLS；
  // 凭据留在 server 侧，按张扣积分）。租户 gate（features.imageGenEnabled）由
  // provider 的 list/invoke 按 context 解析，默认 false fail-closed。
  if (config.imageGenTools && config.imageGenTools.enabled !== false
    && isToolEnabled(config.toolControls, 'GenerateImage')) {
    const tenantStore = config.tenantStore;
    providers.push(new ImageGenToolProvider({
      config: config.imageGenTools,
      billingService: config.billingService,
      appendPlatformEvent: config.appendPlatformEvent,
      isImageGenEnabledForTenant: (tenantId) => {
        if (!tenantId || !tenantStore) return false;
        try {
          return tenantStore.getSettings(tenantId)?.features?.imageGenEnabled === true;
        } catch {
          return false;
        }
      },
      logger: config.logger,
    }));
  }

  // 4.6 AudioTranscribe（server 直连，凭据不进入 sandbox）。
  const audioProvider = createAudioTranscribeRuntimeProvider(config);
  if (audioProvider) providers.push(audioProvider);
  // 5. 统一任务工具：默认 cron，target=taskboard 时管理看板与独立 Agent 流程。
  if (config.cronService || config.taskboard) providers.push(new CronToolProvider({
    service: config.cronService ?? (() => undefined), ...(config.sessionCatalog ? { sessionCatalog: config.sessionCatalog } : {}), ...(config.taskboard ? { taskboard: config.taskboard } : {}),
  }));

  // 6. MCP 工具（带超时兜底，单 server hang 不会卡 dispatch 主路径）
  if (config.mcpProxy || config.mcpClientManager) {
    const mcpProvider = new McpClientToolProvider(config.mcpProxy ?? config.mcpClientManager!);
    try {
      await mcpProvider.warmup({
        username,
        ...(mcpWarmupContext ?? {}),
      });
    } catch {
      // MCP 预热失败只影响本轮 MCP tool schema，不阻断主路径。
    }
    providers.push(mcpProvider);
  }

  // 6.5 durable 后台任务查询/取消。只在 PG background runtime 已装配时暴露；
  // 子 agent runner 会通过无条件剥夺清单再次移除，禁止后台任务嵌套治理。
  if (config.backgroundTasks && isToolEnabled(config.toolControls, 'Agent')) {
    providers.push(new BackgroundTaskToolProvider(config.backgroundTasks));
  }
  // 7. Agent 工具（子 agent 委派，2026-07-06）。必须最后 push：parentProviders 快照
  // 在 push 之前截取，子工具集从快照派生 → 子 agent 天然拿不到 Agent 工具（禁嵌套，
  // 工具移除式，D4）。subagentDeps 缺失（调用方未接线）时不挂载。
  if (subagentDeps && isToolEnabled(config.toolControls, 'Agent')) {
    providers.push(new AgentToolProvider({
      config,
      executionTransportRegistry: subagentDeps.executionTransportRegistry,
      tenantHandResolver: subagentDeps.tenantHandResolver,
      parentProviders: [...providers], modePolicy: subagentDeps.agentModePolicy ?? 'any',
    }));
  }

  return { providers };
}
type RuntimeSkillFilter = (skill: SkillEntry) => boolean;

function allowAllRuntimeSkills(): boolean {
  return true;
}
function filterRuntimeSkills(skills: SkillEntry[], filter: RuntimeSkillFilter): SkillEntry[] {
  return skills.filter(filter);
}

/**
 * 构造 Skill resolver。requiredSkillIds 只负责把专职 Agent 固有能力传给底层
 * SkillsDispatchConfig；最终仍会经过 runtime/browser filter 与 Agent 白名单。
 */
export function buildRuntimeSkillsResolver(
  skills: SkillsDispatchConfig,
  skillFilter: RuntimeSkillFilter = allowAllRuntimeSkills,
  requiredSkillIds: readonly string[] = [],
  preferredSkillIds: readonly string[] = [],
): EffectiveSkillsResolver {
  return {
    list: (ctx) => prioritizeRuntimeSkills(filterRuntimeSkills(
      skills.listForUser(resolveSkillContextUsername(ctx.channelContext), requiredSkillIds, resolveSkillContextTenantId(ctx.channelContext)),
      skillFilter,
    ), preferredSkillIds),
    resolveSkillDir: (skill, ctx) => skills.resolveSkillDir(resolveSkillContextUsername(ctx.channelContext), skill, requiredSkillIds, resolveSkillContextTenantId(ctx.channelContext)),
  };
}

function prioritizeRuntimeSkills(skills: SkillEntry[], preferredSkillIds: readonly string[]): SkillEntry[] {
  if (preferredSkillIds.length === 0) return skills;
  const priority = new Map(preferredSkillIds.map((id, index) => [id, index]));
  return skills
    .map((skill, index) => ({ skill, index }))
    .sort((left, right) => {
      const leftPriority = priority.get(left.skill.id) ?? priority.get(left.skill.name) ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = priority.get(right.skill.id) ?? priority.get(right.skill.name) ?? Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .map(({ skill }) => skill);
}
/** AND 组合多个 skill filter：任一 filter 拒绝即拒绝（browser-hand filter 与 org agent 白名单叠加用，不是替换）。 */
export function composeSkillFilters(...filters: RuntimeSkillFilter[]): RuntimeSkillFilter {
  return (skill) => filters.every((filter) => filter(skill));
}

/**
 * 将 Agent-local policy 合并进已经固定版本的 shared org_agent Profile。
 * binding/version 身份保持 shared Profile 的不可变 pin；仅本次运行使用合并后的 config。
 */
export function mergeOrgAgentBoundRuntimeProfile(
  bound: BoundAgentRuntimeProfile,
  agent: Pick<OrgAgentRecord, 'runtime'>,
): BoundAgentRuntimeProfile {
  if (bound.binding.profileBindingKey !== 'org_agent') return bound;
  return {
    ...bound,
    version: {
      ...bound.version,
      config: mergeOrgAgentFrontRuntimePolicy(bound.version.config, agent.runtime),
    },
  };
}
/** 专职 Agent skill 白名单 filter：固有能力与 MVP knowledge skill 合集（仅按 id 命中，防同名扩权）。 */
export function buildOrgAgentSkillFilter(
  agent: Pick<OrgAgentRecord, 'allowedSkills' | 'allowedKnowledge'>,
): RuntimeSkillFilter {
  const allowed = new Set(resolveOrgAgentRuntimeSkillIds(agent));
  return (skill) => allowed.has(skill.id);
}

export function buildRuntimeSkillFilter(availableHands: HandRecord[]): RuntimeSkillFilter {
  const hasTenantAcsHand = availableHands.some((hand) => (
    typeof hand.metadata?.tenantRemoteHandId === 'string'
    && hand.metadata.tenantRemoteHandId === 'agent-saas-acs'
    && hand.status !== 'destroyed'
  ));
  if (!hasTenantAcsHand) return allowAllRuntimeSkills;

  // 门控判据看 capability 声明而非 status==='ready'：capabilities 是注册时静态写入的
  // 配置事实（tenantRemoteHandCapabilities），不是运行期探测结果。而每轮 dispatch 的
  // ensureRuntimeHandRegistered 都会把 ACS hand upsert 回 'provisioning'，随后毫秒级
  // 内 listBySession 取快照构建本 filter，异步 provision 翻回 'ready' 需要秒级——若
  // 要求 ready，browser skill 会在每一轮 run 的 <available-skills> 里被永久滤掉
  // （2026-07-03 生产实锤）。仅在 hand 明确不健康/已销毁时才视为无 browser 能力。
  const hasBrowserCapability = availableHands.some((hand) => (
    hand.status !== 'unhealthy'
    && hand.status !== 'destroyed'
    && hand.capabilities.some((capability) => (
      capability.name === 'browser'
      || capability.tools.some((tool) => tool.name === 'Browser' || tool.name === 'playwright-cli')
    ))
  ));
  if (hasBrowserCapability) return allowAllRuntimeSkills;

  return (skill) => skill.id !== 'browser' && skill.name !== 'browser';
}
/**
 * `image-gen` 是 GenerateImage 的方法论层，不是独立执行能力。平台工具、引擎或
 * 租户授权任一缺失时从 Skill 清单同步隐藏，避免模型把工具名当 Shell 命令，或
 * 用 WebSearch/browser 截图冒充生成结果。
 */
export function buildImageGenSkillFilter(
  config: Pick<RawRuntimeRunDispatchConfig, 'imageGenTools' | 'toolControls' | 'tenantStore'>,
  tenantId: string | undefined,
): RuntimeSkillFilter {
  let tenantEnabled = false;
  if (tenantId && config.tenantStore) {
    try {
      tenantEnabled = config.tenantStore.getSettings(tenantId)?.features?.imageGenEnabled === true;
    } catch {
      tenantEnabled = false;
    }
  }
  const toolAvailable = isToolEnabled(config.toolControls, 'GenerateImage')
    && listAvailableImageGenEngineIds(config.imageGenTools).length > 0;
  if (tenantEnabled && toolAvailable) return allowAllRuntimeSkills;
  return (skill) => skill.id !== 'image-gen';
}

export function resolveSkillContextUsername(context: ChannelContext | undefined): string | undefined {
  return context?.sessionOwner?.username ?? context?.user?.username;
}
export function resolveSkillContextTenantId(context: ChannelContext | undefined): string | undefined { return context?.sessionOwner?.tenantId ?? context?.user?.tenantId; }
function resolveContextIsPlatformAdmin(context: ChannelContext | undefined): boolean {
  const identity = context?.user ?? context?.sessionOwner;
  return identity?.role === 'admin' && identity.tenantId === DEFAULT_TENANT_ID;
}

function resolveDefaultExecutionTargetForContext(
  executionConfig: ExecutionConfig,
  context: ChannelContext,
): ExecutionTargetKind {
  const identity = context.user ?? context.sessionOwner;
  const decision = resolveExecutionTarget({
    config: executionConfig,
    user: identity ? { role: identity.role, tenantId: identity.tenantId } : null,
  });
  return decision.ok ? decision.target : executionConfig.defaultTarget;
}
function resolveContextTenantId(
  context: ChannelContext,
  existingSession?: RuntimeSessionRecord | null,
): string | undefined {
  return (context.sessionOwner ?? context.user)?.tenantId ?? existingSession?.tenantId;
}

async function authorizeBillingRunStart(
  config: RawRuntimeRunDispatchConfig,
  input: { tenantId?: string; userId?: string; runId: string },
): Promise<void> {
  const billing = config.billingService?.();
  if (!billing || !input.tenantId) return;
  const decision = await billing.authorizeRun({
    tenantId: input.tenantId,
    ...(input.userId ? { userId: input.userId } : {}),
    runId: input.runId,
  });
  if (!decision.ok) throw new Error(`[${decision.code}] ${decision.reason}`);
}

function resolveSessionOwnerRole(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
): 'admin' | 'user' {
  return session.userRole
    ?? config.resolveUserRole?.({ userId: session.userId, username: session.username })
    ?? 'user';
}

/** Rebuild the original account identity for every scheduler wake/resume path. */
export function resolveWakeSessionOwner(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
  fallbackUserId?: string, fallbackTenantId?: string,
): NonNullable<ChannelContext['sessionOwner']> {
  const userId = session.userId || fallbackUserId || '';
  const realName = config.resolveUserRealName?.({
    userId: userId || undefined,
    username: session.username || undefined,
  });
  const dwsServiceIdentity = Boolean(session.orgAgentId && userId.startsWith('adws-')
    && session.username === `agent-dws:${session.orgAgentId}`);
  return {
    id: userId,
    username: session.username || 'unknown',
    role: resolveSessionOwnerRole(config, session),
    tenantId: dwsServiceIdentity ? fallbackTenantId : resolveSessionOwnerTenantId(config, session),
    ...(realName ? { realName } : {}),
  };
}
/**
 * 解析 sessionOwner.tenantId（多组织隔离主防御的 fail-safe baseline）。
 *
 * 设计原则（疑点 3 加固，2026-06-22）：
 *   - resolveUserTenantId 未配置 → 返回 undefined。下游 `isPlatformAdmin` 检查
 *     会因 tenantId !== DEFAULT_TENANT_ID 而 false → Shell gate 把非平台
 *     用户路径拦在 server-local 之外。
 *   - resolveUserTenantId 返回 undefined → 不静默回填默认组织。fail-closed 比
 *     "用户已删 silently fallback to kaiyan = 跨组织读取所有人的工作区" 更安全。
 *   - resolveUserTenantId 抛错 → fail-safe 返回 undefined（同上），并记 warn
 *     日志保留诊断信息。不向上抛 throw，避免一次 UserStore 故障让所有 wake
 *     入口阻塞。
 *
 * 任何对 wake 路径的 tenant 身份补齐改动都应保留这个 fail-safe → undefined
 * 语义，避免与下游 `isPlatformAdmin` 假设解耦。
 */
export function resolveSessionOwnerTenantId(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
): string | undefined {
  if (!config.resolveUserTenantId) return undefined;
  try {
    return config.resolveUserTenantId({ userId: session.userId, username: session.username });
  } catch (err) {
    logger.warn('resolveUserTenantId 抛错（fail-safe 降级为 undefined）', {
      sessionId: session.sessionId,
      userId: session.userId,
      username: session.username,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
// 2026-08-29（TASK-256）：批准策略解析移入 approvalPolicyResolution.ts（ratchet 收缩），
// 此处 re-export 维持既有 import 兼容。
export { resolveEffectiveApprovalPolicy } from './approvalPolicyResolution.js';

/**
 * 加载并组装 system prompt。模板源在 `workspace-shared/prompts/*.md`。
 *
 * Sections 顺序严格按 variability「从低到高」排列，最大化 OpenAI 自动前缀缓存命中：
 *   1. static.md             全局稳定（无变量、跨用户共享）
 *   2. dynamic-shared.md     per-tenant 稳定（COMPANY_INFO，月级不变）
 *   3. runtime-memory.md     全局稳定（固定提示，条件加载）
 *   4. dynamic-personal.md   per-user 变量（身份 + PERSONA + env + 安全块）
 *
 * ── ↑ 段 1 跨用户共享前缀；段 2 起同租户内共享，是 prompt cache 的理想命中区 ──
 *
 * 2026-07-03：原 section 4 `<available-skills>` xml 段已删——skill 清单现由
 * SkillToolProvider 动态注入到 Skill 工具 description 中，避免 xml 注意力弱的
 * 模型（glm-5.2 等）忽略中段 prompt 而幻觉调用不存在的 skill。工具 schema 是
 * 模型注意力最集中的位置，且天然会随 skill 增删刷新，不再需要 system prompt
 * 双写。
 *
 * 2026-07-03：原尾段 `<current-runtime>` 状态 XML（handPrompt.ts）已删——租户
 * hand 每轮 dispatch 被重置为 provisioning 后异步置 ready，dispatch 同步快照
 * 几乎恒为 provisioning（恒错误导）；workspaceId 无消费者（工具不接受执行环境
 * 标识参数）。运行态感知交给 WaitForWorkspaceReady 工具结果（实时真值）+
 * static.md「## 运行态」静态规则。删除后 instructions 无易变尾巴，per-user
 * 段之后逐字节稳定。
 */
export function buildInstructionSections(params: {
  sharedDir: string;
  tenantId?: string;
  agentName: string;
  userName: string;
  persona: string;
  cwd: string;
  executionTarget: ExecutionTargetKind;
  memorySearchEnabled: boolean;
  isPlatformAdmin: boolean;
  /** 记忆写入策略（2026-07-29）：v2 时 platform_rules 用 static-v2 模板。缺省 v1。 */
  memoryPolicyVersion?: MemoryWritePolicyVersion;
  /** 平台系统提示语注册表 getter；缺省走随版本发布的模板。 */
  getSystemPrompt?: (id: SystemPromptId) => string;
  /** 专职 Agent 覆盖：注入 {{ORG_AGENT_INSTRUCTIONS}}，IF_PERSONA/IF_NO_PERSONA 强制 false，AGENT_NAME 用 org 名。 */
  orgAgent?: Pick<OrgAgentRecord, 'name' | 'instructions'> & Pick<Partial<OrgAgentRecord>, 'runtime'>;
  /** Profile 只选择可选上下文模块；main.static 与 dynamic-personal 中的平台安全底座不可移除。 */
  contextModules?: readonly ('company_info' | 'tenant_instructions' | 'runtime_memory' | 'personal_context')[];
  profileSystemInstructions?: string;
  /** 任务看板 Execution 的动态提示语，位于稳定系统前缀之后、首条 user 消息之前。 */
  taskboardExecution?: boolean;
  taskboardBoardPrompt?: string; taskboardStagePrompt?: string;
}): Array<{ key: string; name: string; content: string }> {
  const modules = new Set(params.contextModules
    ?? ['company_info', 'tenant_instructions', 'runtime_memory', 'personal_context']);
  const personaBody = params.orgAgent || !modules.has('personal_context') ? '' : params.persona.trim();
  const hasPersona = personaBody.length > 0;

  const sharedVars: PromptVars = {
    COMPANY_INFO: loadCompanyInfo(params.sharedDir, params.tenantId),
  };
  const visibleCwd = visibleWorkspaceCwd(params.cwd, params.executionTarget);
  const personalVars: PromptVars = {
    CURRENT_USER: params.userName || '当前用户',
    AGENT_NAME: params.orgAgent ? params.orgAgent.name : params.agentName,
    PERSONA: personaBody,
    USER_CWD: visibleCwd,
    IF_PERSONA: !params.orgAgent && hasPersona,
    IF_NO_PERSONA: !params.orgAgent && !hasPersona,
    IF_NOT_ADMIN: !params.isPlatformAdmin,
    IF_ORG_AGENT: !!params.orgAgent,
    ORG_AGENT_INSTRUCTIONS: params.orgAgent?.instructions ?? '',
  };

  const sections: Array<{ key: string; name: string; content: string }> = [{
    key: 'platform_rules',
    name: '平台基础规则',
    content: params.memoryPolicyVersion === 'v2'
      ? (params.getSystemPrompt?.('main.staticV2') ?? loadPrompt(params.sharedDir, 'static-v2'))
      : (params.getSystemPrompt?.('main.static') ?? loadPrompt(params.sharedDir, 'static')),
  }];
  if (params.profileSystemInstructions?.trim()) {
    sections.push({
      key: 'profile_instructions',
      name: 'Agent Profile 指令',
      content: `<agent-profile-instructions>\n${params.profileSystemInstructions.trim()}\n</agent-profile-instructions>`,
    });
  }
  appendDispatcherInstructionSection(sections, params.orgAgent?.runtime?.executionMode);
  if (modules.has('company_info')) {
    sections.push({
      key: 'company_info',
      name: '公司与组织资料',
      content: renderPrompt(
        params.getSystemPrompt?.('main.dynamicShared') ?? loadPrompt(params.sharedDir, 'dynamic-shared'),
        sharedVars,
      ),
    });
  }
  // 组织自定义规则排在 company_info 之后：事实在前（稳定、进 per-tenant 缓存段前部），
  // 行为规则在后（要能覆盖 static 的风格默认）。未配置 instructions.md 的组织整段不注入
  // ——没配置就不该凭空多出一节空标题，这与 company_info 有 fallback 文案的处理刻意不同。
  const tenantInstructions = modules.has('tenant_instructions')
    ? loadTenantInstructions(params.sharedDir, params.tenantId)
    : '';
  if (tenantInstructions) {
    sections.push({
      key: 'tenant_instructions',
      name: '组织自定义规则',
      content: renderPrompt(
        params.getSystemPrompt?.('main.dynamicTenant') ?? loadPrompt(params.sharedDir, 'dynamic-tenant'),
        { TENANT_INSTRUCTIONS: tenantInstructions },
      ),
    });
  }
  if (params.memorySearchEnabled && modules.has('runtime_memory')) {
    sections.push({
      key: 'memory_instructions',
      name: '记忆系统规则',
      content: params.getSystemPrompt?.('main.runtimeMemory') ?? loadPrompt(params.sharedDir, 'runtime-memory'),
    });
  }
  sections.push({
    key: params.orgAgent ? 'org_agent' : 'personal_context',
    name: params.orgAgent ? '专职 Agent 指令' : '人格与个人上下文',
    content: renderPrompt(
      params.getSystemPrompt?.('main.dynamicPersonal') ?? loadPrompt(params.sharedDir, 'dynamic-personal'),
      personalVars,
    ),
  });
  appendTaskboardExecutionInstruction(sections, params.taskboardExecution, { boardPrompt: params.taskboardBoardPrompt, stagePrompt: params.taskboardStagePrompt, fallbackStagePrompt: () => params.getSystemPrompt?.('main.taskboardExecution') || loadPrompt(params.sharedDir, 'taskboard-execution') });
  return sections;
}
export function buildInstructions(params: Parameters<typeof buildInstructionSections>[0]): string {
  return buildInstructionSections(params).map((section) => section.content).join('\n\n');
}
export function visibleWorkspaceCwd(hostCwd: string, executionTarget: ExecutionTargetKind): string {
  if (executionTarget === 'server-remote') return '/workspace';
  if (executionTarget === 'server-container') return '/workspace';
  return hostCwd;
}
/**
 * 未配置 company.md 时的 fallback：不是给人看的占位符，而是给 agent 的行为指令——
 * 如实说明组织资料缺失并引导管理员补充，避免 agent 凭空编造公司信息。
 * 注意：此文本位于 dynamic-shared 共享缓存段，必须保持角色无关（admin/普通用户同文案）。
 */
const COMPANY_INFO_FALLBACK = '（本组织尚未配置组织资料。当用户问及公司业务、产品、团队、制度等信息时，如实说明你还没有组织资料，不要编造；并提示：组织管理员可在管理后台「组织管理 → 公司信息」页补充，补充后新会话自动生效。）';
function loadCompanyInfo(sharedDir: string, tenantId?: string): string {
  if (!tenantId) return COMPANY_INFO_FALLBACK;
  try {
    const content = readTenantCompanyInfoSync(sharedDir, tenantId)?.trim();
    return content || COMPANY_INFO_FALLBACK;
  } catch {
    return COMPANY_INFO_FALLBACK;
  }
}
/**
 * 组织自定义规则正文。无 tenantId、文件缺失、内容为空或读取失败一律返回空串，
 * 由调用方整段跳过——与 company_info 不同，这里没有 fallback 文案：
 * 未配置行为规则时不该给模型多一节空指令。
 */
function loadTenantInstructions(sharedDir: string, tenantId?: string): string {
  if (!tenantId) return '';
  try {
    return readTenantInstructionsSync(sharedDir, tenantId)?.trim() ?? '';
  } catch {
    return '';
  }
}
/**
 * 07-05：给 tenant-remote hand（HttpTransport → acs-orchestrator/hand-server → pod）
 * 现场装配 wire.context.env。envResolver 走 workspace.tenantId + workspace.username
 * 二级查 tokens.json，得到 { AZEROTH_TOKEN, AZEROTH_API_URL } 塞进 wire。
 *
 * 与 dispatch.ts:603 本地 SDK spawn 路径的 AZEROTH_TOKEN 注入并行——两者共用同一份
 * tokens.json 与 resolveAzerothInjection，一份配置同时生效于本地与远端 pod。
 *
 * 未命中（该 (tenantId, username) 没配 PAT）→ 不带 AZEROTH env →
 * pod 内 CLI 报"未授权"，语义与本地 SDK 未配置时一致。
 *
 * wire env **只带 AZEROTH 凭据**：tenantSharedEnv 里的任何变量都不经这条通道下发。
 * 08-03 曾为 dws wrapper 灰度开过一条「平台行为开关」白名单通道，08-04 wrapper 撤销
 * 后一并移除——通道存在本身就是凭据泄漏面（tenantSharedEnv 里有 DASHSCOPE_API_KEY
 * 这类密钥），没有真实使用者时不留。要再开必须重新论证并补白名单与回归。
 */
export function buildTenantRemoteHandWireEnv(workspace: WorkspaceRef): Record<string, string> {
  const tenantId = workspace.tenantId ?? DEFAULT_TENANT_ID;
  const env: Record<string, string> = {};
  const username = workspace.username;
  if (username) {
    const injection = resolveAzerothInjection(tenantId, username);
    if (injection) {
      env.AZEROTH_TOKEN = injection.token;
      if (injection.apiUrl) env.AZEROTH_API_URL = injection.apiUrl;
    }
  }
  return env;
}
export function createRawRuntimeRunDispatch(config: RawRuntimeRunDispatchConfig): AgentRunDispatch {
  const logger = config.logger ?? noopLogger;
  const sessionCatalog = resolveSessionCatalog(config);
  const memoryEnabled = config.memory?.enabled ?? true;
  const memoryMaxLines = config.memory?.maxLines ?? 200;
  const executionTransportRegistry = config.executionTransportRegistry ?? createDefaultExecutionTransportRegistry();
  if (config.serverRemote && !executionTransportRegistry.has('server-remote')) {
    executionTransportRegistry.register(
      'server-remote',
      new HttpTransport({
        baseUrl: config.serverRemote.baseUrl,
        authToken: config.serverRemote.authToken,
        invokeTimeoutMs: config.serverRemote.invokeTimeoutMs,
      }),
    );
  }
  const executionConfig = config.executionConfig
    ?? createExecutionConfig(config.executionTarget ? { defaultTarget: config.executionTarget } : undefined);
  const tenantHandResolver = getTenantRemoteHandResolver(config);
  return async function* rawRuntimeRunDispatch(
    message: InboundMessage,
    context: ChannelContext,
    options: AgentRunOptions = {},
    hooks?: AgentRunHooks,
  ): AsyncGenerator<OutboundEvent> {
    config.refreshSharedConfig?.();
    // cron/dingtalk 触发即跑，无 resume 路径；context.user/cwd/modelConnection 由 channel 注入。
    if (context.channel !== 'web' && context.channel !== 'cron' && context.channel !== 'dingtalk') {
      yield { type: 'error', error: `Raw runtime 暂不支持通道 "${context.channel}"（仅支持 web/cron/dingtalk）` };
      return;
    }
    // PR 2026-06-14 (γ): raw runtime admin-only gate 解除。非 admin 用户可走 raw runtime；
    // 个别危险工具（Shell 等）仍由 WorkspaceToolProvider 内部按角色拦截。
    // δ 阶段加 anonymous 防御：必须有 user 身份（context.user 或 sessionOwner），否则
    // cwd 会落到 agentCwd 根目录，等同于把全用户 workspace 暴露给匿名访问。
    if (!context.user && !context.sessionOwner) {
      yield { type: 'error', error: 'Raw runtime 拒绝匿名访问：缺少 user / sessionOwner（请配置 auth.jwtSecret）' };
      return;
    }
    const resumeSessionId = options.resumeSessionId ?? context.resumeSessionId;
    const existingSession = resumeSessionId ? await sessionCatalog.get(resumeSessionId) : null;
    if (existingSession?.deletedAt) return yield deletedSessionResumeError(resumeSessionId!);
    const identitySource = context.sessionOwner || context.user;
    const replayResolution = await resolveMemoryConsolidationReplaySource(
      sessionCatalog,
      options.memoryConsolidationSourceSessionId,
      identitySource,
    );
    if (replayResolution.error) {
      yield { type: 'error', error: replayResolution.error };
      return;
    }
    const replaySourceSession = replayResolution.session;
    const cwd = options.cwd
      ? resolve(options.cwd)
      : existingSession?.cwd ?? replaySourceSession?.cwd ?? config.agentCwd;
    const tenantId = context.sessionOwner?.tenantId ?? context.user?.tenantId;
    let requestedModel = resolveRuntimeModelRef(config, options.model ?? replaySourceSession?.modelRef,
      tenantId, Boolean(options.modelConnection ?? options.openaiAgentsConnection));
    let { model, modelConnection, modelProviderOptions } = resolveRuntimeModelOptions(
      config,
      requestedModel,
      options.modelConnection ?? options.openaiAgentsConnection,
      options.modelProviderOptions, tenantId,
    );
    let connection = modelConnection;
    let apiKey = connection?.apiKey || process.env.OPENAI_API_KEY;
    let baseUrl = connection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    const executionTarget = options.executionTarget
      ?? replaySourceSession?.executionTarget
      ?? resolveDefaultExecutionTargetForContext(executionConfig, context);
    const sandboxPolicy = buildRawRuntimeSandboxPolicy(config, context, cwd, executionTarget);
    const approvalPolicy = resolveEffectiveApprovalPolicy(config, options.approvalPolicy, {
      userId: identitySource?.id,
      username: identitySource?.username,
    });
    const toolProfile = normalizeToolProfile(options.toolProfile);

    const isResume = !!resumeSessionId;
    const sessionId = resumeSessionId ?? randomUUID();
    const runId = options.runtimeRunId ?? `${Date.now()}-${randomUUID()}`;
    const abortController = options.abortController ?? new AbortController();
    enterSessionContext(sessionId, runId);
    const effectiveTenantId = resolveContextTenantId(context, existingSession);
    const orgAgentId = options.orgAgentId ?? existingSession?.orgAgentId ?? replaySourceSession?.orgAgentId;
    const connectorIdentity = orgAgentId ? { tenantId: effectiveTenantId }
      : existingSession ? {
          userId: existingSession.userId,
          username: existingSession.username,
          tenantId: existingSession.tenantId,
        }
      : {
          userId: identitySource?.id,
          username: identitySource?.username,
          tenantId: identitySource?.tenantId,
        };
    const runtimeEnv = await reconcileConnectorRunEnv(config, {
      identity: connectorIdentity,
      env: options.env,
      resolvedFor: options.connectorEnvResolvedFor,
      injectedKeys: options.connectorEnvKeys,
    });
    stripTaskboardWritableGitCredentials(sessionId, runtimeEnv);
    // BUG FIX 2026-06-23：tenantId 必须与 userId 同源用 identitySource，否则
    // admin 代操作 / cron / 内部触发等 context.user 为空但 sessionOwner 存在的
    // 路径上 hasTranscriptOwnerRef 会返回 false，transcript 会回退到 ownerless
    // dev/test layout，把同一 userId 按 cwd 切碎成多个文件夹。
    const transcriptPath = existingSession?.transcriptPath ?? getTranscriptPath(cwd, sessionId, { userId: identitySource?.id, tenantId: identitySource?.tenantId });
    await mkdir(dirname(transcriptPath), { recursive: true });
    // 专职 Agent 解析（在 session lock / run record 之前 fail-fast）：
    // 新会话由 options.orgAgentId 携带；resume 以 session meta 为准。
    const orgAgentResolution = resolveOrgAgentOverrides(config, orgAgentId, effectiveTenantId);
    if (orgAgentResolution && 'error' in orgAgentResolution) {
      logger.warn(`Org agent fail-closed: session=${sessionId} orgAgentId=${orgAgentId} reason=${orgAgentResolution.error}`);
      yield { type: 'error', error: orgAgentResolution.error };
      return;
    }
    const orgAgent = orgAgentResolution?.agent;
    let boundProfile: BoundAgentRuntimeProfile | undefined;
    if (config.agentRuntimeProfileResolver) {
      try {
        boundProfile = await config.agentRuntimeProfileResolver.resolveForSession({
          existingSession: existingSession ?? replaySourceSession,
          bindingKey: resolveAgentProfileBindingKey({ toolProfile, orgAgentId }),
        });
        if (orgAgent) boundProfile = mergeOrgAgentBoundRuntimeProfile(boundProfile, orgAgent);
        assertAgentProfileExecutionTarget(boundProfile.version.config, executionTarget);
        if (boundProfile.version.config.model.strategy === 'fixed') {
          const fixedRef = boundProfile.version.config.model.modelRef;
          const fixed = config.modelResolver?.(fixedRef, effectiveTenantId);
          if (!fixed) {
            yield { type: 'error', error: `Agent Profile 固定模型不可用或未获当前组织授权：${fixedRef}` };
            return;
          }
          requestedModel = fixedRef;
          model = fixed.model;
          modelConnection = fixed.connection;
          modelProviderOptions = fixed.providerOptions;
          connection = modelConnection;
          apiKey = connection?.apiKey || process.env.OPENAI_API_KEY;
          baseUrl = connection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
        }
      } catch (error) {
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
        return;
      }
    }
    if (!apiKey && modelRequiresApiKey(modelProviderOptions)) {
      yield { type: 'error', error: 'Raw runtime 缺少 OPENAI_API_KEY 或模型组 apiKey' };
      return;
    }

    let resolvedAttachments: ModelAttachmentRef[];
    try {
      resolvedAttachments = await resolveRuntimeInboundAttachments(config, cwd, sessionId, message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: detail };
      return;
    }
    // Session-level lock：尽早占用，失败即退让；resume 路径多 brain 抢同一
    // session 时只让一个进入 dispatch。lock 必须在 try/finally 内 release。
    const sessionLockAcquireOptions: SessionLockAcquireOptions = {
      onLost: (reason) => abortController.abort(reason),
    };
    const lockHandle = config.sessionLock
      ? await config.sessionLock.tryAcquire(sessionId, sessionLockAcquireOptions)
      : null;
    if (config.sessionLock && !lockHandle) {
      yield { type: 'error', error: `Session ${sessionId} 已被另一个 brain 持有，本次 dispatch 退让` };
      return;
    }
    let eventStore: RunStateTrackingEventStore | null = null;
    let eventTenantId: string | undefined;
    let directRuntimeLease: DirectRuntimeLeaseHandle | null = null;
    try {
    const agentProfile = identitySource && config.agentStore
      ? config.agentStore.get(identitySource.username)
      : undefined;
    // 专职 Agent 覆盖：org 名 + 跳过个人 persona / memory 注入，memory search 关闭
    const agentName = orgAgent ? orgAgent.name : (agentProfile?.name || '开开');
    const userName = identitySource ? (identitySource.realName || identitySource.username || '') : '';
    const persona = (orgAgent || options.skipPersona) ? '' : ((await loadPersona(cwd)) || '');

    let memoryContext: string | undefined;
    const profileAllowsRuntimeMemory = boundProfile
      ? (boundProfile.version.config.context.modules.includes('runtime_memory')
        && boundProfile.version.config.memory.scope === 'full')
      : !orgAgent;
    if (memoryEnabled && profileAllowsRuntimeMemory && !isResume && !options.skipMemory) {
      const memory = await loadMemoryContext(cwd, memoryMaxLines);
      if (memory) memoryContext = memory;
    }
    const prompt = buildPrompt(message, context, resolvedAttachments);
    const profileAllowsMemorySearch = boundProfile
      ? boundProfile.version.config.memory.scope !== 'none'
      : !orgAgent;
    const memorySearchEnabled = profileAllowsMemorySearch
      && hasMemorySearchTool(config.memoryIndexService)
      && isToolEnabled(config.toolControls, 'MemorySearch');
    const isPlatformAdmin = resolveContextIsPlatformAdmin(context);
    const sessionModelRef = boundProfile?.version.config.model.strategy === 'fixed'
      ? boundProfile.version.config.model.modelRef
      : orgAgent
        ? requestedModel ?? model
        : existingSession?.modelRef ?? replaySourceSession?.modelRef ?? options.modelRef ?? requestedModel ?? model;
    // 新会话首次落库时定版记忆策略，resume 只读既有 pin；
    // 后台 profile、专职 org Agent 与非用户通道固定 v1，避免与 L2 双写。
    // memory_consolidate 的隐藏来源由 createRuntimeSessionRecord 根据 toolProfile 固化。
    const sandboxWorkloadDescriptor = resolveSandboxWorkloadDescriptor(existingSession?.sandboxWorkloadDescriptor, replaySourceSession?.sandboxWorkloadDescriptor, options.sandboxWorkloadDescriptor, toolProfile, context.channel);
    const isTaskboardExecution = sandboxWorkloadDescriptor.kind === 'taskboard' || existingSession?.sessionSource === 'taskboard_execution';
    const memoryPolicyVersion: MemoryWritePolicyVersion = resolveSessionMemoryPolicy({
      existing: existingSession ?? replaySourceSession,
      delegationEnabled: config.memoryWriteDelegationEnabled?.(effectiveTenantId) === true,
      channel: context.channel,
      ...(toolProfile ? { toolProfile } : {}),
      ...(orgAgentId ? { orgAgentId } : {}),
      ...(isTaskboardExecution ? { sessionSource: 'taskboard_execution' as const, memoryAutomationEligible: false } : {}),
    });
    const workspaceId = deriveRuntimeWorkspaceId({
      existingSession: existingSession ?? replaySourceSession,
      fallbackSessionId: sessionId,
      identity: {
        id: identitySource?.id,
        tenantId: effectiveTenantId,
      },
    });
    // Collection authorization is pinned exactly once for a new org-Agent session.
    // Existing sessions retain their original pin; legacy sessions without one keep
    // the compatibility path (fresh authorization in the recall scope resolver).
    const orgAgentSnapshot = await resolveOrgAgentSessionSnapshot({
      orgAgent,
      existingSession,
      replaySourceSession,
      tenantId: effectiveTenantId,
      userId: identitySource?.id,
      agentId: orgAgentId,
      resolveAssignments: config.resolveOrgAgentCollectionAssignments,
    });
    let sessionRecord: RuntimeSessionRecord = {
      ...(existingSession ?? createRuntimeSessionRecord({
        sessionId,
        userId: identitySource?.id,
        username: identitySource?.username,
        userRole: identitySource?.role,
        tenantId: effectiveTenantId,
        channel: context.channel,
        cwd,
        modelRef: sessionModelRef,
        executionTarget,
        status: 'running', toolProfile, executionRole: orgAgent?.runtime?.executionMode === 'dispatcher' ? 'dispatcher' : undefined, sandboxWorkloadDescriptor,
        ...(replaySourceSession ? {
          sessionSource: 'memory_consolidation' as const,
          memoryAutomationEligible: false,
        } : {}),
        ...(orgAgentId ? { orgAgentId } : {}),
        ...(orgAgentSnapshot ? { orgAgentSnapshot } : {}),
      })),
      sessionId,
      userId: identitySource?.id ?? existingSession?.userId ?? '',
      username: identitySource?.username ?? existingSession?.username ?? '',
      userRole: identitySource?.role
        ?? existingSession?.userRole
        ?? config.resolveUserRole?.({ userId: existingSession?.userId, username: existingSession?.username }),
      tenantId: effectiveTenantId,
      channel: context.channel,
      cwd,
      transcriptPath,
      modelRef: sessionModelRef,
      sandboxProfile: resolveSessionSandboxProfile({ existing: existingSession, requested: replaySourceSession ? 'daily' : message.metadata?.sandboxProfile, forceProfile: isTaskboardExecution ? 'coding' : undefined }),
      executionTarget,
      workspaceId,
      status: 'running', executionRole: orgAgent?.runtime?.executionMode === 'dispatcher' ? 'dispatcher' : undefined,
      ...(orgAgentId ? { orgAgentId } : {}),
      ...(orgAgentSnapshot ? { orgAgentSnapshot } : {}),
      memoryPolicyVersion, sandboxWorkloadDescriptor,
      ...(isTaskboardExecution ? {
        sessionSource: 'taskboard_execution' as const,
        memoryAutomationEligible: false,
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (boundProfile && config.agentRuntimeProfileResolver) {
      sessionRecord = config.agentRuntimeProfileResolver.bindSessionRecord(sessionRecord, boundProfile);
    }
    await sessionCatalog.upsert(sessionRecord);
    const workspaceMountSubPath = deriveWorkspaceMountSubPath({ agentCwd: config.agentCwd, cwd });
    // per-session Sandbox：本路径是已分类的顶层 workload（交互/cron/taskboard/memory），
    // 故顶层组键＝自身 sessionId。子 Agent 与后台任务不走这里，它们继承父值。
    const sandboxScopeId = deriveSandboxScopeId({
      workspaceId: sessionRecord.workspaceId ?? sessionId,
      mountSubPath: workspaceMountSubPath,
      topLevelSessionId: sessionId,
    });
    // 预 provision（2026-08-10，A 方案批次 2）：session record 落库后立即异步拉起
    // Sandbox，让 pod 冷启动与模型首个 token 的思考时间重叠。
    // 为什么不能只依赖「输入框首次有效输入」预热：全新会话在 dispatch 前尚无 sessionId 和
    // sessionCatalog record，输入阶段无法锁定 scope；sandboxWarmup 也会跳过无 record 的会话。
    // 而 per-session Sandbox 下**每个新会话组都是一次冷启动**，
    // 实测新 pod 的 WaitForWorkspaceReady 7 次全部打满 30s——正是要消除的首屏等待。
    // fire-and-forget：内部自带 per-scope 节流与失败静默，不阻塞、不影响本次 run。
    if (typeof message.metadata?.environmentTemplateVersionId !== 'string') config.sandboxWarmup?.(sessionId);
    await hooks?.onSessionStart?.(sessionId, transcriptPath);
    yield { type: 'session_init', sessionId, runId };

    const baseEventStore = createEventStoreForSession(config, sessionRecord);
    await config.runStore?.upsertPending({
      runId,
      sessionId,
      userId: identitySource?.id ?? existingSession?.userId,
      // PR 5 修 P0-4：透传 tenantId 让 runtime_runs 落正确组织
      tenantId: sessionRecord.tenantId,
      model,
      channel: context.channel,
      executionTarget,
      workspaceId: sessionRecord.workspaceId ?? sessionId,
      sandboxScopeId,
      metadata: {
        cwd,
        transcriptPath,
        modelRef: sessionModelRef, username: sessionRecord.username, userRole: sessionRecord.userRole, ...(orgAgentId ? { orgAgentId } : {}), ...(sessionRecord.executionRole ? { executionRole: sessionRecord.executionRole } : {}), ...(orgAgent?.runtime?.executionMode ? { executionMode: orgAgent.runtime.executionMode } : {}), ...(options.dispatcherCompletion ? { dispatcherCompletion: true } : {}),
        outputTransactionMode: resolveModelOutputTransactionMode(context),
        sandboxScopeId, sandboxWorkloadTopLevel: true, sandboxWorkloadDescriptor,
        ...(workspaceMountSubPath ? { mountSubPath: workspaceMountSubPath } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(toolProfile ? { toolProfile } : {}),
        ...(replaySourceSession ? {
          memoryConsolidationSourceSessionId: replaySourceSession.sessionId,
          forceFullContextReplay: true,
        } : {}),
        ...(boundProfile ? profileRunMetadata(boundProfile) : {}),
        wakeMessage: {
          channel: message.channel,
          chatId: message.chatId,
          content: message.content,
          senderId: message.senderId,
          senderName: message.senderName,
          attachments: message.attachments ?? [],
          metadata: message.metadata ?? {},
        },
      },
    });
    const tenantIdForRun = resolveEventTenantId(config, sessionRecord.tenantId, undefined, `run ${runId}`);
    eventTenantId = tenantIdForRun;
    eventStore = new RunStateTrackingEventStore(
      baseEventStore,
      config.runStore,
      tenantIdForRun,
      config.logger ?? logger,
    );
    try {
      directRuntimeLease = await acquireDirectRuntimeRunLease({
        runStore: config.runStore,
        runId,
        runtimeWorkerId: options.runtimeWorkerId,
        logger: config.logger,
        onLeaseLost: error => abortController.abort(error),
      });
    } catch (err) {
      if (err instanceof DirectRuntimeLeaseContendedError) {
        logger.warn(`Raw runtime run 延后：${err.message}`);
        return;
      }
      throw err;
    }
    await markRunState(config.runStore, eventStore, sessionId, runId, 'running', undefined, undefined, { tenantId: tenantIdForRun });
    await reconcileInterruptedForegroundToolCalls({
      eventStore,
      runStore: config.runStore,
      sessionCatalog,
      parentSessionId: sessionId, tenantId: tenantIdForRun,
      logger,
    });
    const runtimeIsolationRequirement = integrationRuntimeIsolationRequirement(options.runtimeIsolationMetadata ?? message.metadata, { tenantId: sessionRecord.tenantId, runId, sessionId, workspaceId: sessionRecord.workspaceId ?? sessionId });
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry,
      executionTarget,
      tenantId: tenantIdForRun,
      sessionId,
      runId,
      workspaceId: sessionRecord.workspaceId ?? sessionId,
      workspaceMountSubPath,
      topLevelSessionId: sessionId,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      sandboxProfile: sessionRecord.sandboxProfile, sandboxWorkloadDescriptor: sessionRecord.sandboxWorkloadDescriptor,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: tenantHandResolver,
      environmentStore: config.environmentStore,
      authorizeEnvironmentTemplate: config.authorizeEnvironmentTemplate,
      agentId: sessionRecord.orgAgentId,
      environmentTemplateVersionId: typeof message.metadata?.environmentTemplateVersionId === 'string'
        ? message.metadata.environmentTemplateVersionId
        : undefined,
      userId: identitySource?.id ?? existingSession?.userId,
      username: identitySource?.username ?? existingSession?.username,
      userTenantId: config.resolveUserTenantId?.({
        userId: identitySource?.id ?? existingSession?.userId,
        username: identitySource?.username ?? existingSession?.username,
      }), runtimeIsolationRequirement,
      logger: config.logger,
    });
    if (typeof message.metadata?.environmentTemplateVersionId === 'string') config.sandboxWarmup?.(sessionId);
    const availableHands = config.handStore ? await config.handStore.listBySession(sessionId) : [];
    await appendResolvedRunSnapshot({
      config,
      runId,
      session: sessionRecord,
      modelRef: sessionModelRef,
      executionTarget,
      hands: availableHands,
    });
    const baseSkillFilter = composeSkillFilters(
      buildRuntimeSkillFilter(availableHands),
      buildImageGenSkillFilter(config, sessionRecord.tenantId), buildAudioTranscribeSkillFilter(config),
    );
    const profileSkillFilter = boundProfile
      ? ((skill: SkillEntry) => filterAgentProfileSkills([skill], boundProfile!.version.config).length === 1)
      : allowAllRuntimeSkills;
    const tooling = await collectRuntimeTooling(
      config,
      orgAgent ? undefined : identitySource?.username,
      // AND 组合：组织 Agent 的 service identity 跳过用户技能/MCP；其技能仍与 org 白名单取交集
      orgAgent
        ? composeSkillFilters(baseSkillFilter, buildOrgAgentSkillFilter(orgAgent), profileSkillFilter)
        : composeSkillFilters(baseSkillFilter, profileSkillFilter),
      orgAgent ? resolveOrgAgentRuntimeSkillIds(orgAgent) : [],
      { executionTransportRegistry, tenantHandResolver, agentModePolicy: resolveAgentModePolicy(orgAgent?.runtime?.executionMode) },
      boundProfile?.version.config.skills.defaultSkillIds ?? [],
      sessionRecord.userId ? { runId, sessionId, userId: sessionRecord.userId } : undefined,
    );
    const instructionSections = options.skipSystemPrompt
      ? [{ key: 'minimal', name: '最小系统提示语', content: config.getSystemPrompt?.('main.minimal') ?? MINIMAL_SYSTEM_PROMPT }]
      : buildInstructionSections({
          sharedDir: config.sharedDir,
          tenantId: sessionRecord.tenantId,
          agentName,
          userName,
          persona,
          cwd,
          executionTarget,
          memorySearchEnabled,
          isPlatformAdmin,
          memoryPolicyVersion,
          getSystemPrompt: config.getSystemPrompt,
          taskboardExecution: isTaskboardExecution, taskboardBoardPrompt: options.taskboardBoardPrompt, taskboardStagePrompt: options.taskboardStagePrompt,
          ...(boundProfile ? { contextModules: boundProfile.version.config.context.modules } : {}),
          ...(boundProfile ? { profileSystemInstructions: boundProfile.version.config.context.systemInstructions } : {}),
          ...(orgAgent ? { orgAgent } : {}),
        });
    const instructions = instructionSections.map((section) => section.content).join('\n\n');
    const approvalStore = createApprovalStoreForSession(config, sessionRecord, eventStore);
    const projection = new LegacyTranscriptProjection(transcriptPath);
    const modelAdapter = (config.modelAdapterFactory ?? createModelAdapterForProtocol)(
      { ...(apiKey ? { apiKey } : {}), baseUrl },
      modelProviderOptions,
    );
    const effectiveToolRuntime = createRuntimeToolRuntime({
      platform: {
        memoryIndexService: config.memoryIndexService,
        executionTransportRegistry,
        handStore: config.handStore,
        resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
        resolveWireEnv: buildTenantRemoteHandWireEnv,
        artifactService: config.artifactService,
        providers: [
          ...tooling.providers,
          ...(config.memoryControlProviders ?? []),
          new SessionToolProvider(new SessionContextService(eventStore, tenantIdForRun)),
        ],
        toolControls: config.toolControls,
        backgroundTasks: config.backgroundTasks,
      },
      toolProfile,
      memoryPolicyVersion,
      boundProfile,
      executionMode: orgAgent?.runtime?.executionMode,
      dispatcherCompletion: options.dispatcherCompletion,
      replaySourceSessionId: replaySourceSession?.sessionId,
    });
    const loop = new RawAgentLoop({
      modelAdapter,
      eventStore,
      approvalStore,
      transcriptProjection: projection,
      toolRuntime: effectiveToolRuntime,
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore, runtimeIsolationRequirement,
      runStore: config.runStore, compactionPrompt: config.getSystemPrompt?.('utility.compaction'),
      mcpLoadingMode: resolveEffectiveMcpLoadingMode(modelProviderOptions),
    });
    // 普通前台 Run 的保守墙钟上限。CAS 只终止当前 running 执行段；
    // waiting_approval / waiting_user 等人工等待态明确不受影响。
    armRuntimeRunWallClock({
      runStore: config.runStore,
      eventStore,
      sessionId,
      runId,
      abortController,
      logger: config.logger ?? logger,
    });
    await authorizeBillingRunStart(config, {
        tenantId: sessionRecord.tenantId,
        userId: sessionRecord.userId,
        runId,
      });
      const runContext: RunContext = {
        runId,
        sessionId,
        modelRef: sessionModelRef,
        model,
        cwd,
        workspaceId: sessionRecord.workspaceId ?? sessionId,
        topLevelSessionId: sessionId,
        sandboxScopeId, sandboxResources: sandboxResourcesForSessionHand(availableHands, sessionId, executionTarget), workload: toAcsSandboxWorkloadDescriptor(sessionRecord.sandboxWorkloadDescriptor),
        mountSubPath: workspaceMountSubPath,
        tenantId: sessionRecord.tenantId,
        executionTarget,
        env: runtimeEnv,
        sandboxPolicy,
        workerId: options.runtimeWorkerId,
        channelContext: context,
        approvalPolicy,
        ...(replaySourceSession ? {
          replaySourceSessionId: replaySourceSession.sessionId,
          disableResponseRelay: true,
          memoryMaintenanceMode: 'consolidation' as const,
        } : {}),
        ...(boundProfile ? {
          profileId: boundProfile.binding.profileId,
          profileVersionId: boundProfile.binding.profileVersionId,
          profileConfigDigest: boundProfile.binding.profileConfigDigest,
        } : {}),
        hooks,
        signal: abortController.signal,
        drainHandoff: options.runtimeDrainHandoff,
        ...buildRuntimeRunContextHooks(config, sessionRecord.tenantId, sessionRecord.userId, runId),
        ...(config.runStore?.listPendingSteeringInputs ? {
          loadQueuedInterjections: async () => {
            const queued = await config.runStore!.listPendingSteeringInputs!(runId);
            const prepared: QueuedInterjection[] = [];
            for (const input of queued) {
              const wakeMessage = input.sourceRun.metadata?.wakeMessage;
              if (!isWakeMessage(wakeMessage)) {
                // 2026-08-04 BUG-8：坏数据不打死健康的目标 run。把坏行标 failed +
                // 回收 steering 行，跳过继续处理其余插话。
                logger.error(`插话消息 ${input.sourceRunId} 缺少 durable wakeMessage，已跳过并标记 failed`);
                await config.runStore?.releasePendingSteeringForSourceRun?.(input.sourceRunId).catch(() => undefined);
                await config.runStore?.markStatus(input.sourceRunId, 'failed', 'missing_wake_message').catch(() => undefined);
                continue;
              }
              const queuedMessage: InboundMessage = {
                channel: (wakeMessage.channel ?? 'web') as InboundMessage['channel'],
                chatId: wakeMessage.chatId ?? sessionId,
                content: wakeMessage.content,
                senderId: wakeMessage.senderId,
                senderName: wakeMessage.senderName,
                attachments: wakeMessage.attachments,
                metadata: wakeMessage.metadata,
              };
              const queuedAttachments = await resolveRuntimeInboundAttachments(config, cwd, sessionId, queuedMessage);
              let queuedVisionAnalysis;
              if (
                queuedAttachments.some((attachment) => attachment.isImage)
                && !modelSupportsImage(modelProviderOptions?.inputModalities)
              ) {
                queuedVisionAnalysis = await analyzeImagesWithFallback(
                  queuedAttachments,
                  config.getImageUnderstandingModelConfigs?.() ?? [],
                  runContext,
                  {
                    timeoutMs: config.getImageUnderstandingTimeoutMs?.(),
                    systemPrompt: config.getSystemPrompt?.('utility.imageUnderstanding'),
                    onAttempt: async (attempt) => {
                      await eventStore!.append({
                        type: 'image_understanding',
                        runId,
                        sessionId,
                        model: attempt.model,
                        attachmentIds: queuedAttachments
                          .filter((attachment) => attachment.isImage)
                          .map((attachment) => attachment.attachmentId),
                        status: attempt.status,
                        ...(attempt.usage ? { usage: attempt.usage } : {}),
                        ...(attempt.error ? { error: attempt.error } : {}),
                      }, { tenantId: tenantIdForRun });
                      if (attempt.usage && identitySource?.username) {
                        config.tokenUsageStore?.()?.recordResult({
                          username: identitySource.username,
                          tenantId: tenantIdForRun,
                          channel: 'vision',
                          modelUsage: { [attempt.model]: attempt.usage },
                          occurredAtMs: Date.now(),
                        });
                      }
                    },
                  },
                );
              }
              prepared.push({
                inputId: input.inputId,
                sourceRunId: input.sourceRunId,
                ...(typeof input.sourceRun.metadata?.clientMsgId === 'string'
                  ? { clientMsgId: input.sourceRun.metadata.clientMsgId }
                  : {}),
                message: queuedMessage,
                prompt: buildPrompt(queuedMessage, context),
                ...(queuedAttachments.length > 0 ? { attachments: queuedAttachments } : {}),
                ...(queuedVisionAnalysis ? { visionAnalysis: queuedVisionAnalysis } : {}),
              });
            }
            return prepared;
          },
        } : {}),
        ...(!isCompactCommand(message.content) && config.autoCompaction ? {
          evaluateAutoCompaction: (events: PlatformEvent[], forceReason?: string) => (
            config.autoCompaction!.evaluate({
              modelRef: sessionModelRef,
              model,
              tenantId: sessionRecord.tenantId,
              events,
              ...(forceReason ? { force: true, forceReason } : {}),
            })
          ),
        } : {}),
      };
      let visionAnalysis;
      if (
        resolvedAttachments.some((attachment) => attachment.isImage)
        && !modelSupportsImage(modelProviderOptions?.inputModalities)
      ) {
        visionAnalysis = await analyzeImagesWithFallback(
          resolvedAttachments,
          config.getImageUnderstandingModelConfigs?.() ?? [],
          runContext,
          {
            timeoutMs: config.getImageUnderstandingTimeoutMs?.(),
            systemPrompt: config.getSystemPrompt?.('utility.imageUnderstanding'),
            onAttempt: async (attempt) => {
              await eventStore!.append({
                type: 'image_understanding',
                runId,
                sessionId,
                model: attempt.model,
                attachmentIds: resolvedAttachments
                  .filter((attachment) => attachment.isImage)
                  .map((attachment) => attachment.attachmentId),
                status: attempt.status,
                ...(attempt.usage ? { usage: attempt.usage } : {}),
                ...(attempt.error ? { error: attempt.error } : {}),
              }, { tenantId: tenantIdForRun });
              if (attempt.usage && identitySource?.username) {
                config.tokenUsageStore?.()?.recordResult({
                  username: identitySource.username,
                  tenantId: tenantIdForRun,
                  channel: 'vision',
                  modelUsage: { [attempt.model]: attempt.usage },
                  occurredAtMs: Date.now(),
                });
              }
            },
          },
        );
      }
      // /compact 平台命令（2026-07-03 真实现）：分流到上下文压缩，不进正常 agent run。
      // web / dingtalk / cron 任何通道发裸 "/compact" 行为一致。
      // instructions 传会话正常 system prompt——压缩请求与正常轮同构以命中 prompt cache。
      let loopError: string | undefined;
      if (isCompactCommand(message.content)) {
        for await (const event of loop.compact({ message, instructions }, runContext)) {
          if (event.type === 'error') loopError = event.error ?? 'context compaction failed';
          yield event;
        }
      } else {
        for await (const event of loop.run(
          {
            message,
            prompt,
            ...(options.runtimeClientMsgId ? { clientMsgId: options.runtimeClientMsgId } : {}),
            attachments: resolvedAttachments,
            ...(visionAnalysis ? { visionAnalysis } : {}),
            recordUserMessage: options.recordUserMessage,
            ...(memoryContext ? { memoryContext } : {}),
            instructions,
            instructionSections,
            maxTurns: replaySourceSession && options.maxTurns ? options.maxTurns
              : boundProfile ? resolveAgentProfileMaxTurns(
                    boundProfile.version.config,
                    resolveEffectiveMaxTurns(config, options.maxTurns, {
                      userId: context.user?.id ?? context.sessionOwner?.id,
                      username: context.user?.username ?? context.sessionOwner?.username,
                    }),
                  )!
                : resolveEffectiveMaxTurns(config, options.maxTurns, {
                    userId: context.user?.id ?? context.sessionOwner?.id,
                    username: context.user?.username ?? context.sessionOwner?.username,
                  }),
            connection: { apiKey: apiKey ?? '', baseUrl },
          },
          runContext,
        )) {
          if (event.type === 'error') loopError = event.error ?? 'raw agent loop failed';
          yield event;
        }
      }
      if (abortController.signal.reason instanceof DirectRuntimeLeaseLostError) {
        throw abortController.signal.reason;
      }
      await sessionCatalog.markStatus(
        sessionId,
        abortController.signal.aborted ? 'idle' : loopError ? 'error' : 'idle',
      );
    } catch (err) {
      const failure = abortController.signal.reason instanceof DirectRuntimeLeaseLostError
        ? abortController.signal.reason
        : err;
      if (failure instanceof DirectRuntimeLeaseLostError) {
        logger.error(`Raw runtime run 中止：${failure.message}`);
        yield { type: 'error', error: `Raw runtime 运行中止: ${failure.message}` };
        return;
      }
      if (abortController.signal.aborted) {
        await sessionCatalog.markStatus(sessionId, 'idle').catch(() => undefined);
        return;
      }
      const msg = failure instanceof Error ? failure.message : String(failure);
      if (eventStore && eventTenantId) await markRunState(config.runStore, eventStore, sessionId, runId, 'failed', msg, undefined, { tenantId: eventTenantId }).catch(() => undefined);
      await sessionCatalog.markStatus(sessionId, 'error');
      logger.error(`Raw runtime run 失败: ${msg}`);
      yield { type: 'error', error: `Raw runtime 运行失败: ${msg}` };
    } finally {
      runtimeRunController.disarmWallClock(runId);
      await directRuntimeLease?.release();
      if (lockHandle) await lockHandle.release().catch(() => undefined);
    }
  };
}

export function createRawApprovalResumeDispatch(config: RawRuntimeRunDispatchConfig) {
  const logger = config.logger ?? noopLogger;
  const sessionCatalog = resolveSessionCatalog(config);
  const executionTransportRegistry = config.executionTransportRegistry ?? createDefaultExecutionTransportRegistry();
  if (config.serverRemote && !executionTransportRegistry.has('server-remote')) {
    executionTransportRegistry.register(
      'server-remote',
      new HttpTransport({
        baseUrl: config.serverRemote.baseUrl,
        authToken: config.serverRemote.authToken,
        invokeTimeoutMs: config.serverRemote.invokeTimeoutMs,
      }),
    );
  }
  const executionConfig = config.executionConfig
    ?? createExecutionConfig(config.executionTarget ? { defaultTarget: config.executionTarget } : undefined);
  const tenantHandResolver = getTenantRemoteHandResolver(config);

  return async function* rawApprovalResumeDispatch(
    request: RawApprovalResumeRequest,
  ): AsyncGenerator<OutboundEvent> {
    config.refreshSharedConfig?.();
    if (request.context.channel !== 'web') {
      yield { type: 'error', error: 'Raw approval resume 当前仅支持 Web 通道' };
      return;
    }
    // approval resume 已解除 admin-only gate，但 user/sessionOwner 仍必须存在。
    if (!request.context.user && !request.context.sessionOwner) {
      yield { type: 'error', error: 'Raw approval resume 拒绝匿名访问：缺少 user / sessionOwner' };
      return;
    }
    const existingSession = await sessionCatalog.get(request.sessionId);
    if (existingSession?.deletedAt) return yield deletedSessionResumeError(request.sessionId);
    const cwd = request.cwd ?? existingSession?.cwd; const transcriptPath = request.transcriptPath ?? existingSession?.transcriptPath;
    if (!cwd || !transcriptPath) {
      yield { type: 'error', error: `Raw approval resume 找不到 session 元数据: ${request.sessionId}` };
      return;
    }

    const tenantId = request.context.sessionOwner?.tenantId ?? request.context.user?.tenantId;
    let requestedModel = resolveRuntimeModelRef(config, request.model || existingSession?.modelRef,
      tenantId, Boolean(request.modelConnection));
    let { model, modelConnection, modelProviderOptions } = resolveRuntimeModelOptions(
      config,
      requestedModel,
      request.modelConnection,
      request.modelProviderOptions, tenantId,
    );
    let apiKey = modelConnection?.apiKey || process.env.OPENAI_API_KEY;
    let baseUrl = modelConnection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    // approval resume 的 executionTarget 由调用方从 approval log / event log 推导（已实现），
    // 调用方应始终传入；缺省时退回 executionConfig.defaultTarget，避免重启场景下"目标漂移"。
    const executionTarget = request.executionTarget
      ?? existingSession?.executionTarget
      ?? resolveDefaultExecutionTargetForContext(executionConfig, request.context);
    const sandboxPolicy = buildRawRuntimeSandboxPolicy(config, request.context, cwd, executionTarget);
    const identitySource = request.context.sessionOwner || request.context.user;
    const approvalPolicy = resolveEffectiveApprovalPolicy(config, request.approvalPolicy, {
      userId: identitySource?.id,
      username: identitySource?.username,
    });
    const resumeToolProfile = normalizeToolProfile(request.toolProfile);
    const abortController = request.abortController ?? new AbortController();

    // Session-level lock：resume 路径上 sessionId 已知，必须早于 catalog upsert
    // 和 loop.resumeApproval 占用，避免两个 brain 同时 wake 同一 session。
    const lockHandle = config.sessionLock
      ? await config.sessionLock.tryAcquire(request.sessionId, {
        onLost: (reason) => abortController.abort(reason),
      })
      : null;
    if (config.sessionLock && !lockHandle) {
      yield { type: 'error', error: `Session ${request.sessionId} 已被另一个 brain 持有，本次 approval resume 退让` };
      return;
    }
    const effectiveTenantId = resolveContextTenantId(request.context, existingSession);
    // 专职 Agent 覆盖（approval resume 同样应用，漏一处 = 审批恢复后越权）。
    // resume 路径 orgAgentId 只信 session meta（existingSession）。
    const orgAgentId = existingSession?.orgAgentId;
    const orgAgentResolution = resolveOrgAgentOverrides(config, orgAgentId, effectiveTenantId);
    if (orgAgentResolution && 'error' in orgAgentResolution) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      logger.warn(`Org agent fail-closed (approval resume): session=${request.sessionId} orgAgentId=${orgAgentId}`);
      yield { type: 'error', error: orgAgentResolution.error };
      return;
    }
    const currentOrgAgent = orgAgentResolution?.agent;
    const orgAgent = currentOrgAgent && existingSession?.orgAgentSnapshot
      ? { ...currentOrgAgent, ...existingSession.orgAgentSnapshot }
      : currentOrgAgent;
    let boundProfile: BoundAgentRuntimeProfile | undefined;
    if (config.agentRuntimeProfileResolver) {
      try {
        boundProfile = await config.agentRuntimeProfileResolver.resolveForSession({
          existingSession,
          bindingKey: existingSession?.profileBindingKey
            ?? resolveAgentProfileBindingKey({ toolProfile: resumeToolProfile, orgAgentId }),
        });
        if (orgAgent) boundProfile = mergeOrgAgentBoundRuntimeProfile(boundProfile, orgAgent);
        assertAgentProfileExecutionTarget(boundProfile.version.config, executionTarget);
        if (boundProfile.version.config.model.strategy === 'fixed') {
          const fixedRef = boundProfile.version.config.model.modelRef;
          const fixed = config.modelResolver?.(fixedRef, effectiveTenantId);
          if (!fixed) {
            if (lockHandle) await lockHandle.release().catch(() => undefined);
            yield { type: 'error', error: `Agent Profile 固定模型不可用或未获当前组织授权：${fixedRef}` };
            return;
          }
          requestedModel = fixedRef;
          model = fixed.model;
          modelConnection = fixed.connection;
          modelProviderOptions = fixed.providerOptions;
          apiKey = modelConnection?.apiKey || process.env.OPENAI_API_KEY;
          baseUrl = modelConnection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
        }
      } catch (error) {
        if (lockHandle) await lockHandle.release().catch(() => undefined);
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
        return;
      }
    }
    if (!apiKey && modelRequiresApiKey(modelProviderOptions)) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      yield { type: 'error', error: 'Raw approval resume 缺少 OPENAI_API_KEY 或模型组 apiKey' };
      return;
    }
    const agentProfile = identitySource && config.agentStore
      ? config.agentStore.get(identitySource.username)
      : undefined;
    const agentName = orgAgent ? orgAgent.name : (agentProfile?.name || '开开');
    const userName = identitySource ? (identitySource.realName || identitySource.username || '') : '';
    const persona = orgAgent ? '' : ((await loadPersona(cwd)) || '');
    const profileAllowsMemorySearch = boundProfile
      ? boundProfile.version.config.memory.scope !== 'none'
      : !orgAgent;
    const memorySearchEnabled = profileAllowsMemorySearch
      && hasMemorySearchTool(config.memoryIndexService)
      && isToolEnabled(config.toolControls, 'MemorySearch');
    // resume 路径 identitySource 优先 sessionRecord.username（dispatch 首跑时已记录），
    // 防止重启 / anonymous 路径上 user.username 缺失导致 skill / MCP 全部消失。
    const resumeUsername = identitySource?.username || existingSession?.username || undefined;
    const resumeIsPlatformAdmin = resolveContextIsPlatformAdmin(request.context);
    const sessionModelRef = boundProfile?.version.config.model.strategy === 'fixed'
      ? boundProfile.version.config.model.modelRef
      : existingSession?.modelRef ?? request.model ?? model;

    const workspaceId = deriveRuntimeWorkspaceId({
      existingSession,
      fallbackSessionId: request.sessionId,
      identity: {
        id: identitySource?.id ?? existingSession?.userId,
        tenantId: effectiveTenantId,
      },
    });
    let sessionRecord: RuntimeSessionRecord = {
      ...(existingSession ?? createRuntimeSessionRecord({
        sessionId: request.sessionId,
        userId: identitySource?.id,
        username: identitySource?.username,
        userRole: identitySource?.role,
        tenantId: effectiveTenantId,
        channel: request.context.channel,
        cwd,
        modelRef: sessionModelRef,
        executionTarget,
        status: 'running',
      })),
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId ?? '',
      username: identitySource?.username ?? existingSession?.username ?? '',
      userRole: identitySource?.role
        ?? existingSession?.userRole
        ?? config.resolveUserRole?.({ userId: existingSession?.userId, username: existingSession?.username }),
      tenantId: effectiveTenantId,
      channel: request.context.channel,
      cwd,
      transcriptPath,
      modelRef: sessionModelRef,
      executionTarget,
      workspaceId,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    if (boundProfile && config.agentRuntimeProfileResolver) {
      sessionRecord = config.agentRuntimeProfileResolver.bindSessionRecord(sessionRecord, boundProfile);
    }
    await sessionCatalog.upsert(sessionRecord);
    const workspaceMountSubPath = deriveWorkspaceMountSubPath({ agentCwd: config.agentCwd, cwd });
    // per-session Sandbox：resume 路径复用原顶层会话 ID，保证 resume 后仍落回同一 pod。
    const sandboxScopeId = deriveSandboxScopeId({
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      mountSubPath: workspaceMountSubPath,
      topLevelSessionId: request.sessionId,
    });
    const baseEventStore = createEventStoreForSession(config, sessionRecord);
    const eventTenantId = resolveEventTenantId(config, sessionRecord.tenantId, undefined, `approval resume ${request.sessionId}`);
    const eventStore = new RunStateTrackingEventStore(baseEventStore, config.runStore, eventTenantId, config.logger ?? logger);
    const approvalStore = createApprovalStoreForSession(config, sessionRecord, eventStore);
    const pendingApproval = await approvalStore.get(request.approvalId);
    const resumeRunId = pendingApproval?.runId ?? `resume-${Date.now()}-${randomUUID()}`;
    const existingResumeRun = await config.runStore?.get(resumeRunId);
    const resumeOutputTransactionMode = existingResumeRun
      ? resolveModelOutputTransactionMode(existingResumeRun.metadata)
      : resolveModelOutputTransactionMode(request.context);
    enterSessionContext(request.sessionId, resumeRunId);
    let directRuntimeLease: DirectRuntimeLeaseHandle | null = null;
    await config.runStore?.upsertPending({
      runId: resumeRunId,
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId,
      // PR 5 修 P0-4：resume approval 路径透传 tenantId
      tenantId: sessionRecord.tenantId,
      model,
      channel: request.context.channel,
      executionTarget,
      workspaceId: sessionRecord.workspaceId,
      sandboxScopeId,
      metadata: { cwd, transcriptPath, modelRef: sessionModelRef, outputTransactionMode: resumeOutputTransactionMode, approvalId: request.approvalId, sandboxScopeId, sandboxWorkloadTopLevel: true, sandboxWorkloadDescriptor: sessionRecord.sandboxWorkloadDescriptor, ...(workspaceMountSubPath ? { mountSubPath: workspaceMountSubPath } : {}), ...(approvalPolicy ? { approvalPolicy } : {}), ...(resumeToolProfile ? { toolProfile: resumeToolProfile } : {}), ...(boundProfile ? profileRunMetadata(boundProfile) : {}) },
    });
    try {
      directRuntimeLease = await acquireDirectRuntimeRunLease({
        runStore: config.runStore,
        runId: resumeRunId,
        runtimeWorkerId: request.runtimeWorkerId,
        logger: config.logger,
        onLeaseLost: (error) => abortController.abort(error),
      });
    } catch (err) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      if (err instanceof DirectRuntimeLeaseContendedError) {
        logger.warn(`Raw approval resume 延后：${err.message}`);
        return;
      }
      throw err;
    }
    await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'running', undefined, undefined, { tenantId: eventTenantId });
    const runtimeIsolationRequirement = integrationRuntimeIsolationRequirement(request.runtimeIsolationMetadata, { tenantId: sessionRecord.tenantId, runId: resumeRunId, sessionId: request.sessionId, workspaceId: sessionRecord.workspaceId ?? request.sessionId });
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry,
      executionTarget,
      tenantId: eventTenantId,
      sessionId: request.sessionId,
      runId: resumeRunId,
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      workspaceMountSubPath,
      topLevelSessionId: request.sessionId,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      sandboxProfile: sessionRecord.sandboxProfile, sandboxWorkloadDescriptor: sessionRecord.sandboxWorkloadDescriptor,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: tenantHandResolver,
      environmentStore: config.environmentStore,
      authorizeEnvironmentTemplate: config.authorizeEnvironmentTemplate,
      agentId: sessionRecord.orgAgentId,
      environmentTemplateVersionId: (request as unknown as {
        metadata?: { environmentTemplateVersionId?: string };
      }).metadata?.environmentTemplateVersionId,
      userId: identitySource?.id ?? existingSession?.userId,
      username: identitySource?.username ?? existingSession?.username,
      userTenantId: config.resolveUserTenantId?.({
        userId: identitySource?.id ?? existingSession?.userId,
        username: identitySource?.username ?? existingSession?.username,
      }), runtimeIsolationRequirement,
      logger: config.logger,
    });
    const availableHands = config.handStore ? await config.handStore.listBySession(request.sessionId) : [];
    await appendResolvedRunSnapshot({
      config,
      runId: resumeRunId,
      session: sessionRecord,
      modelRef: sessionModelRef,
      executionTarget,
      hands: availableHands,
    });
    const resumeBaseSkillFilter = composeSkillFilters(
      buildRuntimeSkillFilter(availableHands),
      buildImageGenSkillFilter(config, sessionRecord.tenantId), buildAudioTranscribeSkillFilter(config),
    );
    const resumeTooling = await collectRuntimeTooling(
      config,
      orgAgent ? undefined : resumeUsername,
      // AND 组合：browser-hand filter 与 org agent 白名单叠加（不是替换）
      orgAgent
        ? composeSkillFilters(
            resumeBaseSkillFilter,
            buildOrgAgentSkillFilter(orgAgent),
            boundProfile ? (skill) => filterAgentProfileSkills([skill], boundProfile!.version.config).length === 1 : allowAllRuntimeSkills,
          )
        : composeSkillFilters(
            resumeBaseSkillFilter,
            boundProfile ? (skill) => filterAgentProfileSkills([skill], boundProfile!.version.config).length === 1 : allowAllRuntimeSkills,
          ),
      orgAgent ? resolveOrgAgentRuntimeSkillIds(orgAgent) : [],
      { executionTransportRegistry, tenantHandResolver, agentModePolicy: resolveAgentModePolicy(orgAgent?.runtime?.executionMode) },
      boundProfile?.version.config.skills.defaultSkillIds ?? [],
      sessionRecord.userId
        ? { runId: resumeRunId, sessionId: request.sessionId, userId: sessionRecord.userId }
        : undefined,
    );
    // 记忆写入策略：resume 只读会话 pin；TaskBoard 固定只读且不进入 L2。
    const isTaskboardExecution = existingSession?.sessionSource === 'taskboard_execution'
      || request.sessionId.startsWith('taskboard-');
    const memoryPolicyVersion: MemoryWritePolicyVersion = resolveSessionMemoryPolicy({
      existing: existingSession,
      delegationEnabled: false,
      channel: sessionRecord.channel,
      ...(resumeToolProfile ? { toolProfile: resumeToolProfile } : {}),
      ...(orgAgentId ? { orgAgentId } : {}),
      ...(isTaskboardExecution ? { sessionSource: 'taskboard_execution' as const, memoryAutomationEligible: false } : {}),
    });
    if (isTaskboardExecution && (
      existingSession?.sessionSource !== 'taskboard_execution'
      || existingSession?.memoryAutomationEligible !== false
      || existingSession?.memoryPolicyVersion !== 'v2'
    )) {
      Object.assign(sessionRecord, {
        sessionSource: 'taskboard_execution' as const,
        memoryAutomationEligible: false,
        memoryPolicyVersion: 'v2' as const,
        updatedAt: new Date().toISOString(),
      });
      await sessionCatalog.upsert(sessionRecord);
    }
    const instructions = buildInstructions({
      sharedDir: config.sharedDir,
      tenantId: sessionRecord.tenantId,
      agentName,
      userName,
      persona,
      cwd,
      executionTarget,
      memorySearchEnabled,
      isPlatformAdmin: resumeIsPlatformAdmin,
      memoryPolicyVersion,
      getSystemPrompt: config.getSystemPrompt,
      taskboardExecution: isTaskboardExecution, taskboardBoardPrompt: request.taskboardBoardPrompt, taskboardStagePrompt: request.taskboardStagePrompt,
      ...(boundProfile ? { contextModules: boundProfile.version.config.context.modules } : {}),
      ...(boundProfile ? { profileSystemInstructions: boundProfile.version.config.context.systemInstructions } : {}),
      ...(orgAgent ? { orgAgent } : {}),
    });
    const projection = new LegacyTranscriptProjection(transcriptPath);
    const modelAdapter = (config.modelAdapterFactory ?? createModelAdapterForProtocol)(
      { ...(apiKey ? { apiKey } : {}), baseUrl },
      modelProviderOptions,
    );
    const loop = new RawAgentLoop({
      modelAdapter,
      eventStore,
      approvalStore,
      transcriptProjection: projection,
      toolRuntime: createRuntimeToolRuntime({
        platform: {
          memoryIndexService: config.memoryIndexService,
          executionTransportRegistry,
          handStore: config.handStore,
          resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
          resolveWireEnv: buildTenantRemoteHandWireEnv,
          artifactService: config.artifactService,
          providers: [...resumeTooling.providers, ...(config.memoryControlProviders ?? []), new SessionToolProvider(new SessionContextService(eventStore, eventTenantId))],
          toolControls: config.toolControls,
          backgroundTasks: config.backgroundTasks,
        },
        toolProfile: resumeToolProfile,
        memoryPolicyVersion,
        boundProfile,
        executionMode: orgAgent?.runtime?.executionMode,
        dispatcherCompletion: request.dispatcherCompletion,
      }),
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore, runtimeIsolationRequirement,
      runStore: config.runStore, compactionPrompt: config.getSystemPrompt?.('utility.compaction'),
      mcpLoadingMode: resolveEffectiveMcpLoadingMode(modelProviderOptions),
    });

    const resumeEnv = await buildConnectorRunEnv(config, {
      userId: orgAgent ? undefined : sessionRecord.userId,
      username: orgAgent ? undefined : resumeUsername,
      tenantId: sessionRecord.tenantId,
    });
    stripTaskboardWritableGitCredentials(request.sessionId, resumeEnv);
    // approval / ask_user 的每个恢复执行段都重新计算完整墙钟预算。
    armRuntimeRunWallClock({
      runStore: config.runStore,
      eventStore,
      sessionId: request.sessionId,
      runId: resumeRunId,
      abortController,
      logger: config.logger ?? logger,
    });
    try {
      await authorizeBillingRunStart(config, {
        tenantId: sessionRecord.tenantId,
        userId: sessionRecord.userId,
        runId: resumeRunId,
      });
      let loopError: string | undefined;
      for await (const event of loop.resumeApproval(
        {
          approvalId: request.approvalId,
          response: request.response,
          instructions,
          maxTurns: boundProfile
            ? resolveAgentProfileMaxTurns(boundProfile.version.config, resolveEffectiveMaxTurns(config, request.maxTurns, {
                userId: request.context.user?.id ?? request.context.sessionOwner?.id,
                username: request.context.user?.username ?? request.context.sessionOwner?.username,
              }))!
            : resolveEffectiveMaxTurns(config, request.maxTurns, {
                userId: request.context.user?.id ?? request.context.sessionOwner?.id,
                username: request.context.user?.username ?? request.context.sessionOwner?.username,
              }),
        },
        {
          runId: resumeRunId,
          sessionId: request.sessionId,
          modelRef: sessionModelRef,
          model,
          cwd,
          workspaceId: sessionRecord.workspaceId ?? request.sessionId,
          topLevelSessionId: request.sessionId,
          sandboxScopeId, sandboxResources: sandboxResourcesForSessionHand(availableHands, request.sessionId, executionTarget), workload: toAcsSandboxWorkloadDescriptor(sessionRecord.sandboxWorkloadDescriptor),
          mountSubPath: workspaceMountSubPath,
          tenantId: sessionRecord.tenantId,
          executionTarget,
          env: resumeEnv,
          sandboxPolicy,
          workerId: request.runtimeWorkerId,
          channelContext: request.context,
          approvalPolicy,
          ...(boundProfile ? {
            profileId: boundProfile.binding.profileId,
            profileVersionId: boundProfile.binding.profileVersionId,
            profileConfigDigest: boundProfile.binding.profileConfigDigest,
          } : {}),
          hooks: request.hooks,
          signal: abortController.signal,
          drainHandoff: request.runtimeDrainHandoff,
          ...buildRuntimeRunContextHooks(config, sessionRecord.tenantId, sessionRecord.userId, resumeRunId),
        },
      )) {
        if (event.type === 'error') loopError = event.error ?? 'approval resume failed';
        yield event;
      }
      if (abortController.signal.reason instanceof DirectRuntimeLeaseLostError) {
        throw abortController.signal.reason;
      }
      await sessionCatalog.markStatus(request.sessionId, loopError ? 'error' : 'idle');
    } catch (err) {
      const failure = abortController.signal.reason instanceof DirectRuntimeLeaseLostError
        ? abortController.signal.reason
        : err;
      if (failure instanceof DirectRuntimeLeaseLostError) {
        logger.error(`Direct runtime resume 中止：${failure.message}`);
        yield { type: 'error', error: `Direct runtime resume 中止: ${failure.message}` };
        return;
      }
      if (abortController.signal.aborted) {
        await sessionCatalog.markStatus(request.sessionId, 'idle').catch(() => undefined);
        return;
      }
      const msg = failure instanceof Error ? failure.message : String(failure);
      await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'failed', msg, undefined, { tenantId: eventTenantId }).catch(() => undefined);
      await sessionCatalog.markStatus(request.sessionId, 'error');
      logger.error(`Raw approval resume 失败: ${msg}`);
      yield { type: 'error', error: `Raw approval resume 失败: ${msg}` };
    } finally {
      runtimeRunController.disarmWallClock(resumeRunId);
      await directRuntimeLease?.release();
      if (lockHandle) await lockHandle.release().catch(() => undefined);
    }
  };
}

export function createRawInteractionResumeDispatch(config: RawRuntimeRunDispatchConfig) {
  const logger = config.logger ?? noopLogger;
  const sessionCatalog = resolveSessionCatalog(config);
  const executionTransportRegistry = config.executionTransportRegistry ?? createDefaultExecutionTransportRegistry();
  if (config.serverRemote && !executionTransportRegistry.has('server-remote')) {
    executionTransportRegistry.register(
      'server-remote',
      new HttpTransport({
        baseUrl: config.serverRemote.baseUrl,
        authToken: config.serverRemote.authToken,
        invokeTimeoutMs: config.serverRemote.invokeTimeoutMs,
      }),
    );
  }
  const executionConfig = config.executionConfig
    ?? createExecutionConfig(config.executionTarget ? { defaultTarget: config.executionTarget } : undefined);
  const tenantHandResolver = getTenantRemoteHandResolver(config);

  return async function* rawInteractionResumeDispatch(
    request: RawInteractionResumeRequest,
  ): AsyncGenerator<OutboundEvent> {
    config.refreshSharedConfig?.();
    if (request.context.channel !== 'web') {
      yield { type: 'error', error: 'Raw interaction resume 当前仅支持 Web 通道' };
      return;
    }
    if (!request.context.user && !request.context.sessionOwner) {
      yield { type: 'error', error: 'Raw interaction resume 拒绝匿名访问：缺少 user / sessionOwner' };
      return;
    }
    const existingSession = await sessionCatalog.get(request.sessionId);
    if (existingSession?.deletedAt) return yield deletedSessionResumeError(request.sessionId);
    const cwd = request.cwd ?? existingSession?.cwd; const transcriptPath = request.transcriptPath ?? existingSession?.transcriptPath;
    if (!cwd || !transcriptPath) {
      yield { type: 'error', error: `Raw interaction resume 找不到 session 元数据: ${request.sessionId}` };
      return;
    }
    const tenantId = request.context.sessionOwner?.tenantId ?? request.context.user?.tenantId;
    let requestedModel = resolveRuntimeModelRef(config, request.model || existingSession?.modelRef,
      tenantId, Boolean(request.modelConnection));
    let { model, modelConnection, modelProviderOptions } = resolveRuntimeModelOptions(
      config,
      requestedModel,
      request.modelConnection,
      request.modelProviderOptions, tenantId,
    );
    let apiKey = modelConnection?.apiKey || process.env.OPENAI_API_KEY;
    let baseUrl = modelConnection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    const executionTarget = request.executionTarget
      ?? existingSession?.executionTarget
      ?? resolveDefaultExecutionTargetForContext(executionConfig, request.context);
    const sandboxPolicy = buildRawRuntimeSandboxPolicy(config, request.context, cwd, executionTarget);
    const identitySource = request.context.sessionOwner || request.context.user;
    const approvalPolicy = resolveEffectiveApprovalPolicy(config, request.approvalPolicy, {
      userId: identitySource?.id,
      username: identitySource?.username,
    });
    const resumeToolProfile = normalizeToolProfile(request.toolProfile);
    const abortController = request.abortController ?? new AbortController();

    const lockHandle = config.sessionLock
      ? await config.sessionLock.tryAcquire(request.sessionId, {
        onLost: (reason) => abortController.abort(reason),
      })
      : null;
    if (config.sessionLock && !lockHandle) {
      yield { type: 'error', error: `Session ${request.sessionId} 已被另一个 brain 持有，本次 interaction resume 退让` };
      return;
    }
    const effectiveTenantId = resolveContextTenantId(request.context, existingSession);
    // interaction resume 也应用专职 Agent 覆盖；orgAgentId 只信 session meta。
    const orgAgentId = existingSession?.orgAgentId;
    const orgAgentResolution = resolveOrgAgentOverrides(config, orgAgentId, effectiveTenantId);
    if (orgAgentResolution && 'error' in orgAgentResolution) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      logger.warn(`Org agent fail-closed (interaction resume): session=${request.sessionId} orgAgentId=${orgAgentId}`);
      yield { type: 'error', error: orgAgentResolution.error };
      return;
    }
    const currentOrgAgent = orgAgentResolution?.agent;
    const orgAgent = currentOrgAgent && existingSession?.orgAgentSnapshot
      ? { ...currentOrgAgent, ...existingSession.orgAgentSnapshot }
      : currentOrgAgent;
    let boundProfile: BoundAgentRuntimeProfile | undefined;
    if (config.agentRuntimeProfileResolver) {
      try {
        boundProfile = await config.agentRuntimeProfileResolver.resolveForSession({
          existingSession,
          bindingKey: existingSession?.profileBindingKey
            ?? resolveAgentProfileBindingKey({ toolProfile: resumeToolProfile, orgAgentId }),
        });
        if (orgAgent) boundProfile = mergeOrgAgentBoundRuntimeProfile(boundProfile, orgAgent);
        assertAgentProfileExecutionTarget(boundProfile.version.config, executionTarget);
        if (boundProfile.version.config.model.strategy === 'fixed') {
          const fixedRef = boundProfile.version.config.model.modelRef;
          const fixed = config.modelResolver?.(fixedRef, effectiveTenantId);
          if (!fixed) {
            if (lockHandle) await lockHandle.release().catch(() => undefined);
            yield { type: 'error', error: `Agent Profile 固定模型不可用或未获当前组织授权：${fixedRef}` };
            return;
          }
          requestedModel = fixedRef;
          model = fixed.model;
          modelConnection = fixed.connection;
          modelProviderOptions = fixed.providerOptions;
          apiKey = modelConnection?.apiKey || process.env.OPENAI_API_KEY;
          baseUrl = modelConnection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
        }
      } catch (error) {
        if (lockHandle) await lockHandle.release().catch(() => undefined);
        yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
        return;
      }
    }
    if (!apiKey && modelRequiresApiKey(modelProviderOptions)) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      yield { type: 'error', error: 'Raw interaction resume 缺少 OPENAI_API_KEY 或模型组 apiKey' };
      return;
    }
    const agentProfile = identitySource && config.agentStore
      ? config.agentStore.get(identitySource.username)
      : undefined;
    const agentName = orgAgent ? orgAgent.name : (agentProfile?.name || '开开');
    const userName = identitySource ? (identitySource.realName || identitySource.username || '') : '';
    const persona = orgAgent ? '' : ((await loadPersona(cwd)) || '');
    const profileAllowsMemorySearch = boundProfile
      ? boundProfile.version.config.memory.scope !== 'none'
      : !orgAgent;
    const memorySearchEnabled = profileAllowsMemorySearch
      && hasMemorySearchTool(config.memoryIndexService)
      && isToolEnabled(config.toolControls, 'MemorySearch');
    const resumeUsername = identitySource?.username || existingSession?.username || undefined;
    const resumeIsPlatformAdmin = resolveContextIsPlatformAdmin(request.context);
    const sessionModelRef = boundProfile?.version.config.model.strategy === 'fixed'
      ? boundProfile.version.config.model.modelRef
      : existingSession?.modelRef ?? request.model ?? model;

    const workspaceId = deriveRuntimeWorkspaceId({
      existingSession,
      fallbackSessionId: request.sessionId,
      identity: {
        id: identitySource?.id ?? existingSession?.userId,
        tenantId: effectiveTenantId,
      },
    });
    let sessionRecord: RuntimeSessionRecord = {
      ...(existingSession ?? createRuntimeSessionRecord({
        sessionId: request.sessionId,
        userId: identitySource?.id,
        username: identitySource?.username,
        userRole: identitySource?.role,
        tenantId: effectiveTenantId,
        channel: request.context.channel,
        cwd,
        modelRef: sessionModelRef,
        executionTarget,
        status: 'running',
      })),
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId ?? '',
      username: identitySource?.username ?? existingSession?.username ?? '',
      userRole: identitySource?.role
        ?? existingSession?.userRole
        ?? config.resolveUserRole?.({ userId: existingSession?.userId, username: existingSession?.username }),
      tenantId: effectiveTenantId,
      channel: request.context.channel,
      cwd,
      transcriptPath,
      modelRef: sessionModelRef,
      executionTarget,
      workspaceId,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    if (boundProfile && config.agentRuntimeProfileResolver) {
      sessionRecord = config.agentRuntimeProfileResolver.bindSessionRecord(sessionRecord, boundProfile);
    }
    await sessionCatalog.upsert(sessionRecord);
    const workspaceMountSubPath = deriveWorkspaceMountSubPath({ agentCwd: config.agentCwd, cwd });
    // per-session Sandbox：resume 路径复用原顶层会话 ID，保证 resume 后仍落回同一 pod。
    const sandboxScopeId = deriveSandboxScopeId({
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      mountSubPath: workspaceMountSubPath,
      topLevelSessionId: request.sessionId,
    });
    const baseEventStore = createEventStoreForSession(config, sessionRecord);
    const eventTenantId = resolveEventTenantId(config, sessionRecord.tenantId, undefined, `interaction resume ${request.sessionId}`);
    const eventStore = new RunStateTrackingEventStore(baseEventStore, config.runStore, eventTenantId, config.logger ?? logger);
    const priorEvents = await eventStore.list(eventTenantId, request.sessionId);
    const requestEvent = [...priorEvents].reverse().find((event): event is Extract<PlatformEvent, { type: 'interaction_requested' }> => (
      event.type === 'interaction_requested'
      && event.sessionId === request.sessionId
      && event.interactionId === request.interactionId
      && event.interactionType === 'ask_user'
    ));
    const resolution = getInteractionResolution(priorEvents, request.sessionId, request.interactionId);
    if (!requestEvent) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      yield { type: 'error', error: `Raw interaction resume 找不到 interaction_requested: ${request.interactionId}` };
      return;
    }
    if (!resolution) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      yield { type: 'error', error: `Raw interaction resume 缺少 durable interaction_resolved: ${request.interactionId}` };
      return;
    }
    const resumeRunId = request.runId ?? requestEvent.runId ?? `resume-${Date.now()}-${randomUUID()}`;
    const existingResumeRun = await config.runStore?.get(resumeRunId);
    const resumeOutputTransactionMode = existingResumeRun
      ? resolveModelOutputTransactionMode(existingResumeRun.metadata)
      : resolveModelOutputTransactionMode(request.context);
    enterSessionContext(request.sessionId, resumeRunId);
    let directRuntimeLease: DirectRuntimeLeaseHandle | null = null;
    await config.runStore?.upsertPending({
      runId: resumeRunId,
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId,
      // PR 5 修 P0-4：resume interaction 路径透传 tenantId
      tenantId: sessionRecord.tenantId,
      model,
      channel: request.context.channel,
      executionTarget,
      workspaceId: sessionRecord.workspaceId,
      sandboxScopeId,
      metadata: { cwd, transcriptPath, modelRef: sessionModelRef, outputTransactionMode: resumeOutputTransactionMode, interactionId: request.interactionId, sandboxScopeId, sandboxWorkloadTopLevel: true, sandboxWorkloadDescriptor: sessionRecord.sandboxWorkloadDescriptor, ...(workspaceMountSubPath ? { mountSubPath: workspaceMountSubPath } : {}), ...(approvalPolicy ? { approvalPolicy } : {}), ...(resumeToolProfile ? { toolProfile: resumeToolProfile } : {}), ...(boundProfile ? profileRunMetadata(boundProfile) : {}) },
    });
    try {
      directRuntimeLease = await acquireDirectRuntimeRunLease({
        runStore: config.runStore,
        runId: resumeRunId,
        runtimeWorkerId: request.runtimeWorkerId,
        logger: config.logger,
        onLeaseLost: (error) => abortController.abort(error),
      });
    } catch (err) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      if (err instanceof DirectRuntimeLeaseContendedError) {
        logger.warn(`Raw interaction resume 延后：${err.message}`);
        return;
      }
      throw err;
    }
    await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'running', undefined, undefined, { tenantId: eventTenantId });
    const runtimeIsolationRequirement = integrationRuntimeIsolationRequirement(request.runtimeIsolationMetadata, { tenantId: sessionRecord.tenantId, runId: resumeRunId, sessionId: request.sessionId, workspaceId: sessionRecord.workspaceId ?? request.sessionId });
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry,
      executionTarget,
      tenantId: eventTenantId,
      sessionId: request.sessionId,
      runId: resumeRunId,
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      workspaceMountSubPath,
      topLevelSessionId: request.sessionId,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      sandboxProfile: sessionRecord.sandboxProfile, sandboxWorkloadDescriptor: sessionRecord.sandboxWorkloadDescriptor,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: tenantHandResolver,
      environmentStore: config.environmentStore,
      authorizeEnvironmentTemplate: config.authorizeEnvironmentTemplate,
      agentId: sessionRecord.orgAgentId,
      environmentTemplateVersionId: (request as unknown as {
        metadata?: { environmentTemplateVersionId?: string };
      }).metadata?.environmentTemplateVersionId,
      userId: identitySource?.id ?? existingSession?.userId,
      username: identitySource?.username ?? existingSession?.username,
      userTenantId: config.resolveUserTenantId?.({
        userId: identitySource?.id ?? existingSession?.userId,
        username: identitySource?.username ?? existingSession?.username,
      }), runtimeIsolationRequirement,
      logger: config.logger,
    });
    const availableHands = config.handStore ? await config.handStore.listBySession(request.sessionId) : [];
    await appendResolvedRunSnapshot({
      config,
      runId: resumeRunId,
      session: sessionRecord,
      modelRef: sessionModelRef,
      executionTarget,
      hands: availableHands,
    });
    const resumeBaseSkillFilter = composeSkillFilters(
      buildRuntimeSkillFilter(availableHands),
      buildImageGenSkillFilter(config, sessionRecord.tenantId), buildAudioTranscribeSkillFilter(config),
    );
    const resumeTooling = await collectRuntimeTooling(
      config,
      orgAgent ? undefined : resumeUsername,
      // AND 组合：browser-hand filter 与 org agent 白名单叠加（不是替换）
      orgAgent
        ? composeSkillFilters(
            resumeBaseSkillFilter,
            buildOrgAgentSkillFilter(orgAgent),
            boundProfile ? (skill) => filterAgentProfileSkills([skill], boundProfile!.version.config).length === 1 : allowAllRuntimeSkills,
          )
        : composeSkillFilters(
            resumeBaseSkillFilter,
            boundProfile ? (skill) => filterAgentProfileSkills([skill], boundProfile!.version.config).length === 1 : allowAllRuntimeSkills,
          ),
      orgAgent ? resolveOrgAgentRuntimeSkillIds(orgAgent) : [],
      { executionTransportRegistry, tenantHandResolver, agentModePolicy: resolveAgentModePolicy(orgAgent?.runtime?.executionMode) },
      boundProfile?.version.config.skills.defaultSkillIds ?? [],
      sessionRecord.userId
        ? { runId: resumeRunId, sessionId: request.sessionId, userId: sessionRecord.userId }
        : undefined,
    );
    // 记忆写入策略：resume 只读会话 pin；TaskBoard 固定只读且不进入 L2。
    const isTaskboardExecution = existingSession?.sessionSource === 'taskboard_execution'
      || request.sessionId.startsWith('taskboard-');
    const memoryPolicyVersion: MemoryWritePolicyVersion = resolveSessionMemoryPolicy({
      existing: existingSession,
      delegationEnabled: false,
      channel: sessionRecord.channel,
      ...(resumeToolProfile ? { toolProfile: resumeToolProfile } : {}),
      ...(orgAgentId ? { orgAgentId } : {}),
      ...(isTaskboardExecution ? { sessionSource: 'taskboard_execution' as const, memoryAutomationEligible: false } : {}),
    });
    if (isTaskboardExecution && (
      existingSession?.sessionSource !== 'taskboard_execution'
      || existingSession?.memoryAutomationEligible !== false
      || existingSession?.memoryPolicyVersion !== 'v2'
    )) {
      Object.assign(sessionRecord, {
        sessionSource: 'taskboard_execution' as const,
        memoryAutomationEligible: false,
        memoryPolicyVersion: 'v2' as const,
        updatedAt: new Date().toISOString(),
      });
      await sessionCatalog.upsert(sessionRecord);
    }
    const instructions = buildInstructions({
      sharedDir: config.sharedDir,
      tenantId: sessionRecord.tenantId,
      agentName,
      userName,
      persona,
      cwd,
      executionTarget,
      memorySearchEnabled,
      isPlatformAdmin: resumeIsPlatformAdmin,
      memoryPolicyVersion,
      getSystemPrompt: config.getSystemPrompt,
      taskboardExecution: isTaskboardExecution, taskboardBoardPrompt: request.taskboardBoardPrompt, taskboardStagePrompt: request.taskboardStagePrompt,
      ...(boundProfile ? { contextModules: boundProfile.version.config.context.modules } : {}),
      ...(boundProfile ? { profileSystemInstructions: boundProfile.version.config.context.systemInstructions } : {}),
      ...(orgAgent ? { orgAgent } : {}),
    });
    const projection = new LegacyTranscriptProjection(transcriptPath);
    const modelAdapter = (config.modelAdapterFactory ?? createModelAdapterForProtocol)(
      { ...(apiKey ? { apiKey } : {}), baseUrl },
      modelProviderOptions,
    );
    const loop = new RawAgentLoop({
      modelAdapter,
      eventStore,
      approvalStore: createApprovalStoreForSession(config, sessionRecord, eventStore),
      transcriptProjection: projection,
      toolRuntime: createRuntimeToolRuntime({
        platform: {
          memoryIndexService: config.memoryIndexService,
          executionTransportRegistry,
          handStore: config.handStore,
          resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
          resolveWireEnv: buildTenantRemoteHandWireEnv,
          artifactService: config.artifactService,
          providers: [...resumeTooling.providers, ...(config.memoryControlProviders ?? []), new SessionToolProvider(new SessionContextService(eventStore, eventTenantId))],
          toolControls: config.toolControls,
          backgroundTasks: config.backgroundTasks,
        },
        toolProfile: resumeToolProfile,
        memoryPolicyVersion,
        boundProfile,
        executionMode: orgAgent?.runtime?.executionMode,
        dispatcherCompletion: request.dispatcherCompletion,
      }),
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore, runtimeIsolationRequirement,
      runStore: config.runStore, compactionPrompt: config.getSystemPrompt?.('utility.compaction'),
      mcpLoadingMode: resolveEffectiveMcpLoadingMode(modelProviderOptions),
    });

    const resumeEnv = await buildConnectorRunEnv(config, {
      userId: orgAgent ? undefined : sessionRecord.userId,
      username: orgAgent ? undefined : resumeUsername,
      tenantId: sessionRecord.tenantId,
    });
    stripTaskboardWritableGitCredentials(request.sessionId, resumeEnv);

    // approval / ask_user 的每个恢复执行段都重新计算完整墙钟预算。
    armRuntimeRunWallClock({
      runStore: config.runStore,
      eventStore,
      sessionId: request.sessionId,
      runId: resumeRunId,
      abortController,
      logger: config.logger ?? logger,
    });
    try {
      await authorizeBillingRunStart(config, {
        tenantId: sessionRecord.tenantId,
        userId: sessionRecord.userId,
        runId: resumeRunId,
      });
      let loopError: string | undefined;
      for await (const event of loop.resumeInteraction(
        {
          interactionId: request.interactionId,
          response: normalizeInteractionResponse(resolution.response ?? request.response),
          instructions,
          maxTurns: boundProfile
            ? resolveAgentProfileMaxTurns(boundProfile.version.config, resolveEffectiveMaxTurns(config, request.maxTurns, {
                userId: request.context.user?.id ?? request.context.sessionOwner?.id,
                username: request.context.user?.username ?? request.context.sessionOwner?.username,
              }))!
            : resolveEffectiveMaxTurns(config, request.maxTurns, {
                userId: request.context.user?.id ?? request.context.sessionOwner?.id,
                username: request.context.user?.username ?? request.context.sessionOwner?.username,
              }),
        },
        {
          runId: resumeRunId,
          sessionId: request.sessionId,
          modelRef: sessionModelRef,
          model,
          cwd,
          workspaceId: sessionRecord.workspaceId ?? request.sessionId,
          topLevelSessionId: request.sessionId,
          sandboxScopeId, sandboxResources: sandboxResourcesForSessionHand(availableHands, request.sessionId, executionTarget), workload: toAcsSandboxWorkloadDescriptor(sessionRecord.sandboxWorkloadDescriptor),
          mountSubPath: workspaceMountSubPath,
          tenantId: sessionRecord.tenantId,
          executionTarget,
          env: resumeEnv,
          sandboxPolicy,
          workerId: request.runtimeWorkerId,
          channelContext: request.context,
          approvalPolicy,
          ...(boundProfile ? {
            profileId: boundProfile.binding.profileId,
            profileVersionId: boundProfile.binding.profileVersionId,
            profileConfigDigest: boundProfile.binding.profileConfigDigest,
          } : {}),
          hooks: request.hooks,
          signal: abortController.signal,
          drainHandoff: request.runtimeDrainHandoff,
          ...buildRuntimeRunContextHooks(config, sessionRecord.tenantId, sessionRecord.userId, resumeRunId),
        },
      )) {
        if (event.type === 'error') loopError = event.error ?? 'interaction resume failed';
        yield event;
      }
      if (abortController.signal.reason instanceof DirectRuntimeLeaseLostError) {
        throw abortController.signal.reason;
      }
      await sessionCatalog.markStatus(request.sessionId, loopError ? 'error' : 'idle');
    } catch (err) {
      const failure = abortController.signal.reason instanceof DirectRuntimeLeaseLostError
        ? abortController.signal.reason
        : err;
      if (failure instanceof DirectRuntimeLeaseLostError) {
        logger.error(`Direct runtime resume 中止：${failure.message}`);
        yield { type: 'error', error: `Direct runtime resume 中止: ${failure.message}` };
        return;
      }
      if (abortController.signal.aborted) {
        await sessionCatalog.markStatus(request.sessionId, 'idle').catch(() => undefined);
        return;
      }
      const msg = failure instanceof Error ? failure.message : String(failure);
      await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'failed', msg, undefined, { tenantId: eventTenantId }).catch(() => undefined);
      await sessionCatalog.markStatus(request.sessionId, 'error');
      logger.error(`Raw interaction resume 失败: ${msg}`);
      yield { type: 'error', error: `Raw interaction resume 失败: ${msg}` };
    } finally {
      runtimeRunController.disarmWallClock(resumeRunId);
      await directRuntimeLease?.release();
      if (lockHandle) await lockHandle.release().catch(() => undefined);
    }
  };
}
export async function loadRawRuntimeWakeState(
  config: RawRuntimeRunDispatchConfig,
  sessionId: string,
): Promise<RawRuntimeWakeState | null> {
  const sessionCatalog = resolveSessionCatalog(config); const session = await sessionCatalog.get(sessionId);
  if (!session) return null;
  const eventStore = createEventStoreForSession(config, session);
  const eventTenantId = resolveEventTenantId(config, session.tenantId, undefined, `wake state ${sessionId}`);
  const approvalStore = createApprovalStoreForSession(config, session, eventStore);
  const events = await eventStore.list(eventTenantId, sessionId, { replayMode: 'bounded' });
  const approvals = await approvalStore.list(sessionId);
  const replayState = buildRuntimeReplayState(events, approvals, sessionId);
  return { session, events, approvals, replayState };
}
export async function wakeRuntimeSession(
  config: RawRuntimeRunDispatchConfig,
  run: RunRecord,
  options: WakeRuntimeSessionOptions = {},
): Promise<void> {
  config.refreshSharedConfig?.();
  const sessionCatalog = resolveSessionCatalog(config);
  const session = await restoreRuntimeSessionForWake(sessionCatalog, run);
  if (!session) throw new Error(`wake context restore failed: session metadata not found for ${run.sessionId}`);
  if (session.deletedAt) return cancelDeletedSessionWake(run, options.lease, config.runStore);
  const eventTenantId = resolveEventTenantId(config, session.tenantId, run.tenantId, `wake run ${run.runId}`);
  // durable 后台 Agent 走独立子 loop；仅 pending 首跑 execute，过期 running 由 scheduler 先冻结。
  if (run.metadata?.backgroundTask === true) {
    if (await cancelDeletedSessionWakeIfPresent(sessionCatalog, run, options.lease, config.runStore)) return;
    if (!config.backgroundTasks) throw new Error('background task runtime is not configured');
    await config.backgroundTasks.execute(run, options.lease);
    return;
  }
  if (session.kind === 'subagent' || run.metadata?.subagent === true) {
    if (await cancelDeletedSessionWakeIfPresent(sessionCatalog, run, options.lease, config.runStore)) return;
    await orphanUnrecoverableSubagentWake({
      runStore: config.runStore,
      eventStore: new RunStateTrackingEventStore(
        createEventStoreForSession(config, session),
        config.runStore,
        eventTenantId,
        config.logger ?? logger,
      ),
      sessionCatalog,
      lease: options.lease,
      sessionId: run.sessionId,
      runId: run.runId,
      tenantId: eventTenantId,
      logger: config.logger ?? logger,
    });
    return;
  }
  const baseEventStore = createEventStoreForSession(config, session);
  const eventStore = new RunStateTrackingEventStore(
    baseEventStore,
    config.runStore,
    eventTenantId,
    config.logger ?? logger,
  );
  const events = await eventStore.list(eventTenantId, run.sessionId, {
    includeTypes: [...WAKE_EVENT_LIST_TYPES],
  });
  const cancelRequested = events.some((event) => (
    event.type === 'run_cancel_requested'
    && (
      event.runId === run.runId
      // legacy 无 runId 的取消事件按 session 匹配，但只对事件发生时已存在的 run 生效
      //（2026-08-04 D-2 修复）：否则一条历史 cancel 会永久毒化该 session 之后的所有
      // wake——包括插话回退 run 和全新消息，全部被静默取消。
      || (
        !event.runId
        && event.sessionId === run.sessionId
        && Date.parse(event.timestamp) > Date.parse(run.requestedAt)
      )
    )
  ));
  if (cancelRequested) {
    await options.lease?.release('cancelled', 'cancel_requested_before_wake');
    await appendRunStateChanged(eventStore, run.sessionId, run.runId, 'cancelled', run.status, 'cancel_requested_before_wake', { tenantId: eventTenantId });
    return;
  }
  // 隐藏记忆审查由 engine 持有写锁与状态；通用 scheduler 不得跨崩溃重放。
  if (await rejectMemoryConsolidationWake({
    run,
    lease: options.lease,
    runStore: config.runStore,
    eventStore,
    sessionCatalog,
  })) return;
  // steering 行回收（2026-08-04 BUG-5 修复）：本 run 是回退执行的插话 source 时，
  // 把它自己的 pending steering 行标 released + 清 metadata。不回收的话：
  // ① 它永远不能成为后续插话的 steering 目标（NOT EXISTS own_input pending 排除），
  //    这条会话的插话功能事实性失效；② 幂等兜底会对早已终态的目标继续谎报 queued。
  if (run.metadata?.steeringState === 'pending' && config.runStore?.releasePendingSteeringForSourceRun) {
    try {
      await config.runStore.releasePendingSteeringForSourceRun(run.runId);
      run = { ...run, metadata: { ...run.metadata, steeringState: 'released' } };
      delete (run.metadata as Record<string, unknown>).steeringTargetRunId;
    } catch (error) {
      logger.warn(
        `steering release failed (degraded): run=${run.runId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const resumeApprovalCandidate = isResumeApprovalMetadata(run.metadata?.resumeApproval) ? run.metadata.resumeApproval : null;
  const resumeApprovalConsumed = resumeApprovalCandidate
    ? isConsumedResume(run.metadata, 'resumeApprovalConsumed', resumeApprovalCandidate.approvalId)
    : false;
  const resumeApproval = resumeApprovalCandidate && !resumeApprovalConsumed ? resumeApprovalCandidate : null;
  const resumeInteractionCandidate = isResumeInteractionMetadata(run.metadata?.resumeInteraction) ? run.metadata.resumeInteraction : null;
  const resumeInteractionConsumed = resumeInteractionCandidate
    ? isConsumedResume(run.metadata, 'resumeInteractionConsumed', resumeInteractionCandidate.interactionId)
    : false;
  const resumeInteraction = resumeInteractionCandidate && !resumeInteractionConsumed ? resumeInteractionCandidate : null;
  const approvalPolicy = resolveEffectiveApprovalPolicy(config, run.metadata?.approvalPolicy, {
    userId: session.userId || undefined,
    username: session.username || undefined,
  });
  const wakeToolProfile = normalizeToolProfile(run.metadata?.toolProfile);
  // 挂起交互门禁按 runId 过滤（2026-08-04 BUG-1 二次伤害修复）：
  // 只有「本 run 自己」的未决 approval/ask_user 才把 wake 降级为 waiting_*。
  // 别的 run 挂着卡片时（用户不答、改发新消息），新 run/插话回退 run 必须照常执行；
  // 原来的 session 级过滤会把它们也降成 waiting_user，而用户回答卡片只会 resume
  // 原 run——被降级的 run 永久卡死，getActiveBySession 还一直把它当活跃 run，
  // UI 永久「正在思考」。
  const pendingApproval = [...events].reverse().find((event): event is Extract<PlatformEvent, { type: 'approval_requested' }> => (
    event.type === 'approval_requested'
    && event.sessionId === run.sessionId
    && event.runId === run.runId
  ));
  const pendingAskUser = buildPendingInteractionsFromEvents(events, run.sessionId)
    .find((interaction) => interaction.type === 'ask_user' && interaction.runId === run.runId);
  if (!resumeApproval && !resumeInteraction && pendingApproval && !events.some((event) => (
    event.type === 'approval_resolved'
    && event.approvalId === pendingApproval.approvalId
  ))) {
    await options.lease?.release('waiting_approval', 'wake_deferred_pending_approval');
    return;
  }
  if (!resumeInteraction && pendingAskUser) {
    await options.lease?.release('waiting_user', 'wake_deferred_pending_ask_user');
    return;
  }
  // Wake-time workspace provisioning. PR 8 enqueue-only 路径绕过了 engine/dispatch.ts
  // 的 ensureUserWorkspace 调用，新 tenant / 新用户首跑必踩 cwd 物理目录不存在
  // 导致 hand-server spawn ENOENT。这里在调 dispatch 之前先 provision，让 PR 4
  // 扁平→tenant 层迁移与首次目录初始化在 wake 时就完成。
  // 早返回分支（cancel / waiting_approval / waiting_user）已经在前面 return，
  // 不会经过这段——只有真要调模型/工具时才付 provisioning 成本。
  if (config.workspaceProvisioner) {
    try {
      await config.workspaceProvisioner({
        userId: session.userId,
        username: session.username,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await options.lease?.release('failed', `workspace_provision_failed:${reason}`);
      await appendRunStateChanged(eventStore, run.sessionId, run.runId, 'failed', run.status, `workspace_provision_failed:${reason}`, { tenantId: eventTenantId });
      return;
    }
  }

  if (resumeApproval) {
    const hasInteractionResolved = events.some((event) => (
      event.type === 'interaction_resolved'
      && event.sessionId === run.sessionId
      && event.interactionId === resumeApproval.approvalId
    ));
    const hasApprovalResolved = events.some((event) => (
      event.type === 'approval_resolved'
      && event.sessionId === run.sessionId
      && event.approvalId === resumeApproval.approvalId
    ));
    if (!hasInteractionResolved || hasApprovalResolved) {
      await options.lease?.release(hasApprovalResolved ? 'completed' : 'failed', hasApprovalResolved ? 'approval_already_resolved' : 'missing_interaction_resolved_command');
      return;
    }
    await config.runStore?.markStatus(run.runId, 'running', 'approval_resume_wake_started', {
      resumeApprovalConsumedAt: new Date().toISOString(),
      resumeApprovalConsumedId: resumeApproval.approvalId,
    });
    const dispatch = createRawApprovalResumeDispatch(config);
    const abortController = new AbortController();
    const drainHandoff: RuntimeDrainHandoffState = { requested: false };
    runtimeRunController.register(run.runId, abortController, {
      userId: session.userId,
      tenantId: run.tenantId,
      drainHandoff,
    });
    const renewTimer = startWakeLeaseRenewal({
      lease: options.lease,
      runStore: config.runStore,
      runId: run.runId,
      abortController,
      intervalMs: options.renewIntervalMs ?? 30_000,
    });
    try {
      let outboundError: string | undefined;
      for await (const event of dispatch({
        approvalId: resumeApproval.approvalId,
        response: resumeApproval.response,
        sessionId: run.sessionId,
        transcriptPath: session.transcriptPath,
        cwd: session.cwd,
        context: {
          channel: 'web',
          outputTransactionMode: resolveModelOutputTransactionMode(run.metadata),
          resumeSessionId: run.sessionId,
          sessionOwner: resolveWakeSessionOwner(config, session, run.userId, run.tenantId),
          targetCwd: session.cwd,
        },
        model: resolveWakeModelRef(run, session),
        executionTarget: run.executionTarget ?? session.executionTarget,
        approvalPolicy,
        ...(wakeToolProfile ? { toolProfile: wakeToolProfile } : {}), ...(run.metadata.dispatcherCompletion === true ? { dispatcherCompletion: true } : {}), ...(typeof run.metadata.taskboardBoardPrompt === 'string' ? { taskboardBoardPrompt: run.metadata.taskboardBoardPrompt } : {}), ...(typeof run.metadata.taskboardStagePrompt === 'string' ? { taskboardStagePrompt: run.metadata.taskboardStagePrompt } : {}), runtimeIsolationMetadata: run.metadata,
        abortController,
        runtimeWorkerId: options.lease?.workerId,
        runtimeDrainHandoff: drainHandoff,
      })) {
        await options.onOutboundEvent?.(event, { runId: run.runId, sessionId: run.sessionId });
        if (event.type === 'error') outboundError = event.error ?? 'approval resume wake failed';
      }
      if (outboundError) throw new Error(outboundError);
      if (drainHandoff.requested && renewTimer) clearInterval(renewTimer);
      if (await releaseWakeLeaseForDrainHandoff({
        config,
        eventStore,
        sessionCatalog,
        run,
        lease: options.lease,
        drainHandoff,
        onOutboundEvent: options.onOutboundEvent,
      })) return;
      const current = await config.runStore?.get(run.runId);
      if (current) {
        await options.lease?.release(current.status, current.statusReason ?? 'approval_resume_wake_completed');
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      runtimeRunController.unregister(run.runId);
    }
    return;
  }

  if (resumeInteraction) {
    const resolution = getInteractionResolution(events, run.sessionId, resumeInteraction.interactionId);
    if (!resolution) {
      await options.lease?.release('failed', 'missing_interaction_resolved_command');
      return;
    }
    await config.runStore?.markStatus(run.runId, 'running', 'interaction_resume_wake_started', {
      resumeInteractionConsumedAt: new Date().toISOString(),
      resumeInteractionConsumedId: resumeInteraction.interactionId,
    });
    const dispatch = createRawInteractionResumeDispatch(config);
    const abortController = new AbortController();
    const drainHandoff: RuntimeDrainHandoffState = { requested: false };
    runtimeRunController.register(run.runId, abortController, {
      userId: session.userId,
      tenantId: run.tenantId,
      drainHandoff,
    });
    const renewTimer = startWakeLeaseRenewal({
      lease: options.lease,
      runStore: config.runStore,
      runId: run.runId,
      abortController,
      intervalMs: options.renewIntervalMs ?? 30_000,
    });
    try {
      let outboundError: string | undefined;
      for await (const event of dispatch({
        runId: run.runId, interactionId: resumeInteraction.interactionId,
        response: normalizeInteractionResponse(resolution.response ?? resumeInteraction.response),
        sessionId: run.sessionId,
        transcriptPath: session.transcriptPath,
        cwd: session.cwd,
        context: {
          channel: 'web',
          outputTransactionMode: resolveModelOutputTransactionMode(run.metadata),
          resumeSessionId: run.sessionId,
          sessionOwner: resolveWakeSessionOwner(config, session, run.userId, run.tenantId),
          targetCwd: session.cwd,
        },
        model: resolveWakeModelRef(run, session),
        executionTarget: run.executionTarget ?? session.executionTarget,
        approvalPolicy,
        ...(wakeToolProfile ? { toolProfile: wakeToolProfile } : {}), ...(run.metadata.dispatcherCompletion === true ? { dispatcherCompletion: true } : {}), ...(typeof run.metadata.taskboardBoardPrompt === 'string' ? { taskboardBoardPrompt: run.metadata.taskboardBoardPrompt } : {}), ...(typeof run.metadata.taskboardStagePrompt === 'string' ? { taskboardStagePrompt: run.metadata.taskboardStagePrompt } : {}), runtimeIsolationMetadata: run.metadata,
        abortController,
        runtimeWorkerId: options.lease?.workerId,
        runtimeDrainHandoff: drainHandoff,
      })) {
        await options.onOutboundEvent?.(event, { runId: run.runId, sessionId: run.sessionId });
        if (event.type === 'error') outboundError = event.error ?? 'interaction resume wake failed';
      }
      if (outboundError) throw new Error(outboundError);
      if (drainHandoff.requested && renewTimer) clearInterval(renewTimer);
      if (await releaseWakeLeaseForDrainHandoff({
        config,
        eventStore,
        sessionCatalog,
        run,
        lease: options.lease,
        drainHandoff,
        onOutboundEvent: options.onOutboundEvent,
      })) return;
      const current = await config.runStore?.get(run.runId);
      if (current) {
        await options.lease?.release(current.status, current.statusReason ?? 'interaction_resume_wake_completed');
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      runtimeRunController.unregister(run.runId);
    }
    return;
  }
  const wakePrompt = resolveWakePrompt(run, events, session);
  const sessionOwner = resolveWakeSessionOwner(config, session, run.userId, run.tenantId);
  const context: ChannelContext = {
    channel: 'web',
    outputTransactionMode: resolveModelOutputTransactionMode(run.metadata),
    resumeSessionId: run.sessionId,
    sessionOwner,
    targetCwd: session.cwd,
  };
  if (await cancelDeletedSessionWakeIfPresent(sessionCatalog, run, options.lease, config.runStore)) return; const dispatch = createRawRuntimeRunDispatch(config);
  const abortController = new AbortController();
  const drainHandoff: RuntimeDrainHandoffState = { requested: false };
  runtimeRunController.register(run.runId, abortController, {
    userId: sessionOwner.id,
    tenantId: run.tenantId,
    drainHandoff,
  });
  const renewTimer = startWakeLeaseRenewal({
    lease: options.lease,
    runStore: config.runStore,
    runId: run.runId,
    abortController,
    intervalMs: options.renewIntervalMs ?? 30_000,
  });
  try {
    let outboundError: string | undefined;
    for await (const event of dispatch(
      wakePrompt.message,
      context,
      {
        runtimeRunId: run.runId, runtimeIsolationMetadata: run.metadata,
        ...(typeof run.metadata?.clientMsgId === 'string' ? { runtimeClientMsgId: run.metadata.clientMsgId } : {}),
        resumeSessionId: run.sessionId,
        cwd: session.cwd,
        model: resolveWakeModelRef(run, session),
        executionTarget: run.executionTarget ?? session.executionTarget,
        approvalPolicy,
        ...(wakeToolProfile ? { toolProfile: wakeToolProfile } : {}), ...(run.metadata.dispatcherCompletion === true ? { dispatcherCompletion: true } : {}), ...(typeof run.metadata.taskboardBoardPrompt === 'string' ? { taskboardBoardPrompt: run.metadata.taskboardBoardPrompt } : {}), ...(typeof run.metadata.taskboardStagePrompt === 'string' ? { taskboardStagePrompt: run.metadata.taskboardStagePrompt } : {}),
        ...(session.orgAgentId ? { orgAgentId: session.orgAgentId } : {}),
        recordUserMessage: wakePrompt.recordUserMessage,
        abortController,
        runtimeWorkerId: options.lease?.workerId,
        runtimeDrainHandoff: drainHandoff,
      },
    )) {
      await options.onOutboundEvent?.(event, { runId: run.runId, sessionId: run.sessionId });
      if (event.type === 'error') outboundError = event.error ?? 'wake dispatch failed';
    }
    if (outboundError) throw new Error(outboundError);
    if (drainHandoff.requested && renewTimer) clearInterval(renewTimer);
    if (await releaseWakeLeaseForDrainHandoff({
      config,
      eventStore,
      sessionCatalog,
      run,
      lease: options.lease,
      drainHandoff,
      onOutboundEvent: options.onOutboundEvent,
    })) return;
    const current = await config.runStore?.get(run.runId);
    if (current) {
      await options.lease?.release(current.status, current.statusReason ?? 'wake_completed');
    }
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    runtimeRunController.unregister(run.runId);
  }
}
export async function releaseWakeLeaseForDrainHandoff(input: {
  config: RawRuntimeRunDispatchConfig;
  eventStore: EventStore;
  sessionCatalog: SessionCatalog;
  run: RunRecord;
  lease?: RuntimeWakeLease;
  drainHandoff: RuntimeDrainHandoffState;
  onOutboundEvent?: WakeRuntimeSessionOptions['onOutboundEvent'];
}): Promise<boolean> {
  if (!input.drainHandoff.requested || !input.config.runStore || !input.lease) return false;

  // renew 是 worker_id CAS：过期 worker 若已被新 worker 接管，会在写 handoff 状态前失败退出。
  await input.lease.renew();
  const current = await input.config.runStore.get(input.run.runId);
  if (
    !current
    || isTerminalRunStatus(current.status)
    || (current.workerId && input.lease.workerId && current.workerId !== input.lease.workerId)
  ) return false;
  const eventTenantId = resolveEventTenantId(
    input.config,
    current.tenantId,
    input.run.tenantId,
    `drain handoff ${input.run.runId}`,
  );
  const reason = input.drainHandoff.reason ?? 'server_drain_handoff';
  const handedOffAt = new Date().toISOString();
  // steering 的 durable user_message 可安全重放，但恢复必须有上限；否则同一故障会让
  // 目标 run 永久 running，并把后续 reserved source 永久挡在 recoverable 集合之外。
  const isSteeringRecovery = reason.startsWith('steering_');
  const previousAttempts = typeof current.metadata?.drainHandoffAttempts === 'number'
    ? current.metadata.drainHandoffAttempts
    : 0;
  const handoffAttempts = isSteeringRecovery ? previousAttempts + 1 : previousAttempts;
  const handedOff = await input.config.runStore.markStatus(input.run.runId, 'running', reason, {
    drainHandoffAt: handedOffAt,
    drainHandoffWorkerId: input.lease.workerId,
    ...(isSteeringRecovery ? { drainHandoffAttempts: handoffAttempts } : {}),
  });
  if (!handedOff || isTerminalRunStatus(handedOff.status)) return false;
  await appendRunStateChanged(
    input.eventStore,
    input.run.sessionId,
    input.run.runId,
    'running',
    current.status,
    reason,
    { tenantId: eventTenantId },
  );

  if (isSteeringRecovery && handoffAttempts >= STEERING_RECOVERY_MAX_HANDOFFS) {
    await input.eventStore.append({
      type: 'run_finished',
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      subtype: 'error',
      numTurns: 0,
      error: STEERING_RECOVERY_FAILURE_MESSAGE,
    }, { tenantId: eventTenantId });
    await input.sessionCatalog.markStatus(input.run.sessionId, 'error');
    await input.onOutboundEvent?.(
      { type: 'error', error: STEERING_RECOVERY_FAILURE_MESSAGE },
      { runId: input.run.runId, sessionId: input.run.sessionId },
    );
    await input.lease.release('failed', STEERING_RECOVERY_FAILURE_MESSAGE);
    input.config.logger?.error(
      `Runtime steering recovery exhausted run=${input.run.runId} session=${input.run.sessionId} reason=${reason} attempts=${handoffAttempts}`,
    );
    return true;
  }

  await input.sessionCatalog.markStatus(input.run.sessionId, 'running');
  await input.lease.release(undefined, reason);
  input.config.logger?.info(
    `Runtime drain handoff released run=${input.run.runId} session=${input.run.sessionId} worker=${input.lease.workerId}`,
  );
  return true;
}
