import { createHash, randomUUID } from 'node:crypto';

import { type ToolCallContext, type ToolProvider } from '../../agent/toolRuntime.js';
import { readSessionMeta } from '../../data/transcripts/meta.js';
import {
  mergeOrgAgentWorkerRuntimePolicy,
  resolveOrgAgentRuntimeSkillIds,
} from '../../data/orgAgents/runtimePolicy.js';
import type { ChannelContext } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import { buildConnectorRunEnv } from '../connectorRunEnv.js';
import { runtimeRunController } from '../runController.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from '../runtimeIsolationEvidence.js';
import { customerSafeRuntimeError, SessionAutomationBackgroundResource } from '../runtimeFailure.js';
import { resolveModelOutputTransactionMode } from '../modelOutputTransaction.js';
import type { RunRecord, RunStatus, RunStore } from '../runStore.js';
import {
  buildOrgAgentSkillFilter,
  buildOrgAgentChannelSkillFilter,
  collectRuntimeTooling,
  composeSkillFilters,
  createEventStoreForSession,
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord, type RuntimeSessionRecord } from '../sessionCatalog.js';
import { withOrgAgentArtifactContract } from '../orgAgentArtifactPublisher.js';
import { getSubagentType } from '../subagent/agentTypes.js';
import {
  SUBAGENT_PER_RUN_MAX_CONCURRENCY,
  SUBAGENT_PER_TENANT_MAX_ACTIVE,
} from '../subagent/subagentLimits.js';
import { runSubagent, type SubagentOutcome } from '../subagent/subagentRunner.js';
import {
  buildBackgroundTaskAutomationContext,
  buildBackgroundTaskParentContext,
  deriveBackgroundTaskAutomationFence,
} from './backgroundTaskAutomationContext.js';
import { BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON } from './backgroundTaskRuntime.js';
import { assertBackgroundRemoteDispatchBarrier } from './backgroundRemoteDispatchBarrier.js';
import { invokeBackgroundCommandControl } from './backgroundTaskCommandControl.js';
import { readBackgroundCommandOutput } from './backgroundCommandOutput.js';
import { cancelBackgroundTask } from './backgroundTaskCancellation.js';
import { reconcileBackgroundWakeDeliveries } from './backgroundWakeDeliveryReconciler.js';
import { controlOrgAgentWorkOrder } from './backgroundWorkOrderControl.js';
import {
  deriveBackgroundRuntimeIsolationRequirement,
  parseBackgroundTaskMetadata,
  resolvePreparedChildIdentity,
  type BackgroundCommandTaskMetadata,
} from './backgroundTaskMetadata.js';
import { resolveDwsCompletionRoute } from './backgroundTaskDwsCompletion.js';
import { markBackgroundTaskTerminal } from './backgroundTaskTerminal.js';
import { isBackgroundAgentIdempotentReplay } from './backgroundAgentIdempotency.js';
import { findBackgroundTasksByIdentifier } from './backgroundTaskLookup.js';
import { sleepAbortable } from './backgroundTaskTiming.js';
import { reconcileStagedOrgWork as reconcileOrgAgentStage } from './orgAgentStageReconciler.js';
import {
  isOrgTaskVisible,
  OrgAgentBackgroundWorkCoordinator,
  prepareOrgAgentBackgroundWork,
} from './orgAgentBackgroundWork.js';
import {
  assertAgentProfileExecutionTarget,
  profileRunMetadata,
  type BoundAgentRuntimeProfile,
} from '../agentProfiles.js';
import type {
  BackgroundAgentRequest,
  BackgroundCommandRequest,
  BackgroundCommandReservation,
  BackgroundTaskLease,
  BackgroundTaskRuntime,
  BackgroundTaskStartResult,
  OrgAgentWorkOrderControlRequest,
} from './backgroundTaskRuntime.js';
import {
  compactCommandPreview,
  formatBackgroundShellResult,
  parseBackgroundShellView,
  type BackgroundShellView,
  type StoredBackgroundResult,
} from './backgroundTaskFormatting.js';
import {
  failureResult,
  isTerminal,
  outcomeToRunStatus,
  persistResultText,
  requireBackgroundRunStore,
  sessionIdentity,
} from './backgroundTaskServiceSupport.js';
export type { BackgroundTaskMetadata } from './backgroundTaskMetadata.js';
// 结果模型与格式化函数已迁至 ./backgroundTaskFormatting.ts，这里按既有 import 路径继续对外转发。
export { escapeXml } from './backgroundTaskFormatting.js';
const logger = createLogger('BackgroundTaskService');
const CANCEL_POLL_MS = 2_000;
export function resolveBackgroundSkillUsername(session: Pick<RuntimeSessionRecord, 'username' | 'orgAgentSnapshot'>): string | undefined {
  return session.orgAgentSnapshot ? undefined : session.username;
}
export class DurableBackgroundTaskService implements BackgroundTaskRuntime {
  private readonly runSubagentImpl: typeof runSubagent;
  private readonly orgWork: OrgAgentBackgroundWorkCoordinator;

  constructor(
    private readonly config: RawRuntimeRunDispatchConfig,
    options: { runSubagentImpl?: typeof runSubagent } = {},
  ) {
    this.runSubagentImpl = options.runSubagentImpl ?? runSubagent;
    this.orgWork = new OrgAgentBackgroundWorkCoordinator(config);
  }
  async enqueue(context: ToolCallContext, request: BackgroundAgentRequest): Promise<BackgroundTaskStartResult> {
    const runStore = requireBackgroundRunStore(this.config.runStore);
    const parentSessionId = context.sessionId ?? context.workspace.sessionId;
    const parentRunId = context.runId;
    if (!parentSessionId || !parentRunId) {
      throw new Error('Agent(mode=background) 需要父 session/run 上下文。');
    }
    const sessionCatalog = resolveSessionCatalog(this.config);
    const parentSession = await sessionCatalog.get(parentSessionId);
    if (!parentSession) throw new Error(`父会话不存在：${parentSessionId}`);
    const identity = context.channelContext.sessionOwner ?? context.channelContext.user;
    const tenantId = parentSession.tenantId ?? identity?.tenantId ?? context.workspace.tenantId;
    const username = parentSession.username || identity?.username || context.workspace.username;
    const userId = parentSession.userId || identity?.id || context.workspace.userId;
    const parentRun = await runStore.get(parentRunId);
    const dwsCompletionRoute = resolveDwsCompletionRoute(parentRun, context.channelContext.channel);
    // 真正执行模型的是后续 child run；由 runSubagent 在拿到 childRunId 后原子预占。
    // 此处不能用旧余额快照门禁，否则父 run 自己的 reservation 会误拒绝派生。
    const executionTarget = context.channelContext.orgAgentChannel
      ? 'server-remote' as const : context.workspace.executionTarget;
    let boundProfile: BoundAgentRuntimeProfile | undefined;
    if (this.config.agentRuntimeProfileResolver) {
      boundProfile = await this.config.agentRuntimeProfileResolver.resolveForSession({
        existingSession: null,
        bindingKey: request.agentType === 'explore' ? 'background_explore' : 'background_general',
      });
      if (parentSession.orgAgentSnapshot) {
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
    const configuredWorkerModel = parentSession.orgAgentSnapshot?.runtime.workerModel;
    const modelRef = boundProfile?.version.config.model.strategy === 'fixed'
      ? boundProfile.version.config.model.modelRef
      : configuredWorkerModel?.strategy === 'fixed'
        ? configuredWorkerModel.modelRef
        : request.model?.trim() || parentSession.modelRef;
    let model: string | undefined;
    if (modelRef && this.config.modelResolver) {
      const resolved = this.config.modelResolver(modelRef, tenantId);
      if (!resolved) {
        throw new Error(`后台 Agent 模型 "${modelRef}" 配置刷新失败或不在当前组织可用模型白名单内。`);
      }
      model = resolved.model;
    }
    // 仅未装配 resolver 的 file/test backend 可继承原始 ref；resolver 返回 null 必须拒绝。
    model ??= modelRef ?? parentRun?.model;
    if (!model || !modelRef) throw new Error('无法确定后台 Agent 模型。');

    const toolCallId = context.toolCallId ?? `agent-${randomUUID()}`;
    const taskDigest = createHash('sha256').update(`${parentRunId}:${toolCallId}`).digest('hex');
    const taskId = `bg-${taskDigest.slice(0, 32)}`;
    const shortTaskId = `T-${taskDigest.slice(0, 24).toUpperCase()}`;
    const taskSessionId = `sub-bg-${taskDigest.slice(0, 32)}`;
    const executionChildSessionId = `sub-exec-${taskDigest.slice(0, 32)}`;
    const executionChildRunId = `bg-child-${taskDigest.slice(0, 32)}`;
    const automationFence = deriveBackgroundTaskAutomationFence(
      context.automationFence, taskId, { sessionId: parentSessionId, runId: parentRunId },
    );
    const existingTask = await runStore.get(taskId);
    if (existingTask) {
      if (!isBackgroundAgentIdempotentReplay(existingTask, {
        parentRunId, parentSessionId, toolCallId, taskSessionId, tenantId, model, request,
        ...(context.channelContext.orgAgentChannel
          ? { orgChannel: context.channelContext.orgAgentChannel } : {}),
      })) throw new Error('BACKGROUND_AGENT_IDEMPOTENCY_CONFLICT');
      return { taskId, shortTaskId, status: 'pending', description: request.description, model };
    }
    const { taskLayout, workOrder } = await prepareOrgAgentBackgroundWork({
      config: this.config, context, request, parentRunId, toolCallId, taskId,
    });
    const runtimeIsolationRequirement = taskLayout && workOrder ? {
      tenantId: workOrder.tenantId,
      taskId: workOrder.workOrderId,
      runId: taskId,
      sessionId: taskSessionId,
      workspaceId: taskLayout.taskWorkspaceId,
      policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
    } : context.runtimeIsolationRequirement;
    let taskSession = createRuntimeSessionRecord({
      sessionId: taskSessionId,
      userId,
      username,
      userRole: parentSession.userRole ?? identity?.role,
      tenantId,
      channel: context.channelContext.channel,
      cwd: taskLayout?.taskRoot ?? context.workspace.root,
      modelRef,
      sandboxProfile: parentSession.sandboxProfile,
      executionTarget,
      workspaceId: taskLayout?.taskWorkspaceId ?? context.workspace.id ?? taskSessionId,
      status: 'idle',
      kind: 'subagent',
      executionRole: 'worker', sandboxWorkloadDescriptor: parentSession.sandboxWorkloadDescriptor,
      ...(parentSession.orgAgentId ? { orgAgentId: parentSession.orgAgentId } : {}),
      ...(parentSession.orgAgentSnapshot ? { orgAgentSnapshot: parentSession.orgAgentSnapshot } : {}),
      ...(parentSession.principal ? { principal: parentSession.principal } : {}),
    });
    if (boundProfile && this.config.agentRuntimeProfileResolver) {
      taskSession = this.config.agentRuntimeProfileResolver.bindSessionRecord(taskSession, boundProfile);
    }
    await sessionCatalog.upsert(taskSession);
    const automationResource = new SessionAutomationBackgroundResource(
      this.config.sessionAutomationRuntimeGuard,
      automationFence ? { tenantId, sessionId: taskSessionId, runId: taskId, automationFence } : undefined,
      taskId,
      { childSessionId: executionChildSessionId, childRunId: executionChildRunId },
    );
    let taskRun: RunRecord;
    try {
      if (workOrder && taskLayout) {
        await this.config.orgGroupAgentStore!.createWorkAttempt({
          tenantId: workOrder.tenantId,
          workOrderId: workOrder.workOrderId,
          runtimeRunId: taskId,
          attemptId: taskLayout.attemptId,
          taskWorkspaceId: taskLayout.taskWorkspaceId,
          sandboxScopeId: taskLayout.sandboxScopeId,
          mountSubPath: taskLayout.mountSubPath,
          sharedReadOnlySubPath: taskLayout.sharedReadOnlySubPath,
        });
      }
      taskRun = await automationResource.enqueuePrepared(() => runStore.enqueueBackgroundTask!({
      runId: taskId,
      sessionId: taskSessionId,
      userId,
      tenantId,
      model,
      channel: 'background_task',
      idempotencyKey: `background-task:${parentRunId}:${toolCallId}`,
      executionTarget,
      workspaceId: taskLayout?.taskWorkspaceId ?? context.workspace.id ?? taskSessionId,
      sandboxScopeId: taskLayout?.sandboxScopeId ?? context.workspace.sandboxScopeId,
      metadata: {
        subagent: true,
        backgroundTask: true,
        backgroundTaskType: 'agent',
        backgroundTaskReady: false,
        backgroundTaskVersion: 2,
        executionChildSessionId,
        executionChildRunId,
        outputTransactionMode: 'terminal_buffered',
        parentRunId,
        parentSessionId,
        ...(automationFence ? { automationFence } : {}),
        topLevelSessionId: context.workspace.topLevelSessionId ?? parentSessionId,
        parentToolCallId: toolCallId,
        shortTaskId,
        ...(workOrder ? { workOrderId: workOrder.workOrderId } : {}),
        ...(workOrder ? { workOrderShortId: workOrder.shortId, workOrderControlRevision: workOrder.control.revision } : {}),
        ...(taskLayout ? { attemptId: taskLayout.attemptId, attemptNo: 1,
          sharedReadOnlySubPath: taskLayout.sharedReadOnlySubPath } : {}),
        description: request.description,
        basePrompt: request.prompt,
        prompt: request.prompt,
        executionRole: 'worker',
        ...(parentSession.orgAgentId ? { orgAgentId: parentSession.orgAgentId } : {}),
        ...(parentSession.orgAgentSnapshot?.runtime.executionMode
          ? { executionMode: parentSession.orgAgentSnapshot.runtime.executionMode }
          : {}),
        ...(dwsCompletionRoute.version === 'exact' ? { dwsCompletionRoute: dwsCompletionRoute.route } : {}),
        ...(dwsCompletionRoute.version === 'invalid' ? { dwsCompletionRouteVersion: 'invalid' } : {}),
        agentType: request.agentType,
        modelRef,
        includeCompanyInfo: request.includeCompanyInfo
          || boundProfile?.version.config.context.modules?.includes('company_info') === true,
        ...(boundProfile ? profileRunMetadata(boundProfile) : {}),
        cwd: taskLayout?.taskRoot ?? context.workspace.root,
        workspaceId: taskLayout?.taskWorkspaceId ?? context.workspace.id ?? taskSessionId,
        ...(taskLayout?.mountSubPath ?? context.workspace.mountSubPath
          ? { mountSubPath: taskLayout?.mountSubPath ?? context.workspace.mountSubPath } : {}),
        ...(taskLayout?.sandboxScopeId ?? context.workspace.sandboxScopeId
          ? { sandboxScopeId: taskLayout?.sandboxScopeId ?? context.workspace.sandboxScopeId } : {}),
        ...(context.workspace.sandboxResources ? { sandboxResources: context.workspace.sandboxResources } : {}), ...(context.workspace.workload ? { workload: context.workspace.workload } : {}),
        ...(context.workspace.sandboxPolicy ? { sandboxPolicy: context.workspace.sandboxPolicy } : {}),
        ...(runtimeIsolationRequirement ? { runtimeIsolationRequirement } : {}),
        ...(context.channelContext.timezone ? { timezone: context.channelContext.timezone } : {}),
        parentChannel: context.channelContext.channel,
        parentOutputTransactionMode: resolveModelOutputTransactionMode(context.channelContext),
        ...(context.channelContext.orgAgentChannel ? { orgAgentChannel: context.channelContext.orgAgentChannel } : {}),
        wakeState: 'none',
      },
    }, {
      perParentActive: SUBAGENT_PER_RUN_MAX_CONCURRENCY,
      perTenantActive: SUBAGENT_PER_TENANT_MAX_ACTIVE,
    }), async () => {
        const activationPatch = {
          backgroundTaskReady: true, backgroundStartedAt: new Date().toISOString(),
        };
        return workOrder
          ? runStore.activateStagedOrgAgentBackgroundTask
            ? await runStore.activateStagedOrgAgentBackgroundTask(
                taskId, 'background_agent_started', activationPatch,
              )
            : (() => { throw new Error('组织群后台任务不支持原子激活。'); })()
          : await runStore.markStatus(taskId, 'pending', 'background_agent_started', activationPatch);
      }, () => runStore.get(taskId),
      () => runStore.markStatus(taskId, 'cancelled', 'background_task_intent_failed'));
    } catch (error) {
      const concurrentTask = await runStore.get(taskId).catch(() => null);
      if (isBackgroundAgentIdempotentReplay(concurrentTask, {
        parentRunId, parentSessionId, toolCallId, taskSessionId, tenantId, model, request,
        ...(context.channelContext.orgAgentChannel
          ? { orgChannel: context.channelContext.orgAgentChannel } : {}),
      })) {
        return { taskId, shortTaskId, status: 'pending', description: request.description, model };
      }
      await sessionCatalog.markStatus(taskSessionId, 'error').catch(() => undefined);
      if (workOrder && taskLayout) {
        await this.orgWork.failSetup(workOrder.tenantId, workOrder.workOrderId,
          taskId, taskLayout.taskRoot, error, 1).catch(() => undefined);
      }
      throw error;
    }
    await this.appendParentLifecycleEvent(parentSession, tenantId, {
      type: 'background_task_started',
      runId: parentRunId,
      sessionId: parentSessionId,
      taskId,
      taskSessionId,
      toolCallId,
      agentType: request.agentType,
      description: request.description,
      model: taskRun.model ?? model,
    });
    return { taskId, shortTaskId, status: 'pending', description: request.description, model };
  }
  async reserveCommand(context: ToolCallContext, request: BackgroundCommandRequest): Promise<BackgroundCommandReservation> {
    const runStore = requireBackgroundRunStore(this.config.runStore);
    const parentSessionId = context.sessionId ?? context.workspace.sessionId;
    const parentRunId = context.runId;
    if (!parentSessionId || !parentRunId) throw new Error('Shell(mode=background) 需要父 session/run 上下文。');
    const sessionCatalog = resolveSessionCatalog(this.config);
    const parentSession = await sessionCatalog.get(parentSessionId);
    if (!parentSession) throw new Error(`父会话不存在：${parentSessionId}`);
    const identity = context.channelContext.sessionOwner ?? context.channelContext.user;
    const tenantId = parentSession.tenantId ?? identity?.tenantId ?? context.workspace.tenantId;
    const username = parentSession.username || identity?.username || context.workspace.username;
    const userId = parentSession.userId || identity?.id || context.workspace.userId;
    const parentRun = await runStore.get(parentRunId);
    const modelRef = parentSession.modelRef ?? parentRun?.model;
    if (!modelRef) throw new Error('无法确定后台命令的父会话模型。');
    const toolCallId = context.toolCallId ?? `shell-${randomUUID()}`;
    const taskDigest = createHash('sha256').update(`${parentRunId}:${toolCallId}`).digest('hex');
    const taskId = `shell-bg-${taskDigest.slice(0, 32)}`;
    const taskSessionId = `sub-shell-${taskDigest.slice(0, 32)}`;
    const automationFence = deriveBackgroundTaskAutomationFence(
      context.automationFence, taskId, { sessionId: parentSessionId, runId: parentRunId },
    );
    const executionTarget = context.workspace.executionTarget;
    const commandPreview = compactCommandPreview(request.command);
    const taskSession = createRuntimeSessionRecord({
      sessionId: taskSessionId,
      userId,
      username,
      userRole: parentSession.userRole ?? identity?.role,
      tenantId,
      channel: context.channelContext.channel,
      cwd: context.workspace.root,
      modelRef,
      sandboxProfile: parentSession.sandboxProfile,
      executionTarget,
      workspaceId: context.workspace.id ?? taskSessionId,
      status: 'idle',
      kind: 'subagent', sandboxWorkloadDescriptor: parentSession.sandboxWorkloadDescriptor,
    });
    await sessionCatalog.upsert(taskSession);
    try {
      await runStore.enqueueBackgroundTask!({
        runId: taskId,
        sessionId: taskSessionId,
        userId,
        tenantId,
        model: parentRun?.model ?? modelRef,
        channel: 'background_task',
        idempotencyKey: `background-task:${parentRunId}:${toolCallId}`,
        executionTarget,
        workspaceId: context.workspace.id ?? taskSessionId,
        sandboxScopeId: context.workspace.sandboxScopeId,
        metadata: {
          backgroundTask: true,
          backgroundTaskType: 'command',
          backgroundTaskReady: false,
          backgroundTaskVersion: 2,
          parentRunId,
          parentSessionId,
          ...(automationFence ? { automationFence } : {}),
          topLevelSessionId: context.workspace.topLevelSessionId ?? parentSessionId,
          parentToolCallId: toolCallId,
          description: `后台命令：${commandPreview}`,
          commandHash: createHash('sha256').update(request.command).digest('hex'),
          commandPreview,
          timeoutMs: request.timeoutMs,
          modelRef,
          cwd: context.workspace.root,
          workspaceId: context.workspace.id ?? taskSessionId,
          ...(context.workspace.mountSubPath ? { mountSubPath: context.workspace.mountSubPath } : {}),
          ...(context.workspace.sandboxScopeId ? { sandboxScopeId: context.workspace.sandboxScopeId } : {}),
          ...(context.workspace.sandboxResources ? { sandboxResources: context.workspace.sandboxResources } : {}), ...(context.workspace.workload ? { workload: context.workspace.workload } : {}),
          ...(context.workspace.sandboxPolicy ? { sandboxPolicy: context.workspace.sandboxPolicy } : {}),
          ...(context.channelContext.timezone ? { timezone: context.channelContext.timezone } : {}),
          parentChannel: context.channelContext.channel,
          parentOutputTransactionMode: resolveModelOutputTransactionMode(context.channelContext),
          ...(context.channelContext.orgAgentChannel ? { orgAgentChannel: context.channelContext.orgAgentChannel } : {}),
          wakeState: 'none',
        },
      }, {
        perParentActive: SUBAGENT_PER_RUN_MAX_CONCURRENCY,
        perTenantActive: SUBAGENT_PER_TENANT_MAX_ACTIVE,
      });
    } catch (err) {
      await sessionCatalog.markStatus(taskSessionId, 'error').catch(() => undefined);
      throw err;
    }
    return { taskId, status: 'starting' };
  }
  async activateCommand(context: ToolCallContext, taskId: string): Promise<void> {
    const task = await this.requireOwnedTask(context, taskId);
    const metadata = parseBackgroundTaskMetadata(task);
    if (!metadata || metadata.taskType !== 'command') throw new Error('后台命令任务 metadata 不完整。');
    if (task.status !== 'pending') throw new Error(`后台命令无法激活：${task.status}`);
    const activated = await this.config.runStore!.markStatus(taskId, 'pending', 'background_command_started', {
      backgroundTaskReady: true,
      backgroundStartedAt: new Date().toISOString(),
    });
    if (!activated || activated.metadata.backgroundTaskReady !== true) {
      throw new Error('后台命令激活状态未持久化。');
    }
    const parentSession = await resolveSessionCatalog(this.config).get(metadata.parentSessionId);
    if (parentSession) {
      await this.appendParentLifecycleEvent(parentSession, task.tenantId, {
        type: 'background_task_started',
        runId: metadata.parentRunId,
        sessionId: metadata.parentSessionId,
        taskId,
        taskSessionId: task.sessionId,
        toolCallId: metadata.parentToolCallId,
        agentType: 'command',
        description: metadata.description,
        model: task.model ?? metadata.modelRef,
      });
    }
  }
  async failCommandStart(context: ToolCallContext, taskId: string, message: string): Promise<void> {
    const task = await this.requireOwnedTask(context, taskId);
    await markBackgroundTaskTerminal(this.config.runStore!, await this.backgroundTaskEventStore(task), task,
      'failed', 'background_command_start_failed', { backgroundResult: failureResult('failed', message),
        wakeState: 'discarded', backgroundFinishedAt: new Date().toISOString() });
    await resolveSessionCatalog(this.config).markStatus(task.sessionId, 'error').catch(() => undefined);
  }
  handoffCommandMonitor(record: RunRecord): void {
    const metadata = parseBackgroundTaskMetadata(record);
    if (metadata?.taskType !== 'command') return;
    runtimeRunController.abort(record.runId, BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON);
  }
  async execute(record: RunRecord, lease?: BackgroundTaskLease): Promise<void> {
    const metadata = parseBackgroundTaskMetadata(record);
    if (!metadata) throw new Error(`后台任务 metadata 不完整：${record.runId}`);
    await this.orgWork.markRunning(record);
    const sessionCatalog = resolveSessionCatalog(this.config);
    const taskSession = await sessionCatalog.get(record.sessionId);
    if (!taskSession) throw new Error(`后台任务 session 不存在：${record.sessionId}`);
    const parentSession = await sessionCatalog.get(metadata.parentSessionId);
    if (!parentSession || (await readSessionMeta(parentSession.transcriptPath))?.deletedAt) {
      await this.freezeFailure(record, '父会话不存在或已删除，后台任务不再执行', 'failed');
      await lease?.release('failed', 'background_parent_session_unavailable');
      return;
    }
    if (metadata.taskType === 'command') {
      await this.executeCommand(record, metadata, taskSession, lease);
      return;
    }
    const executionRegistry = this.config.executionTransportRegistry;
    const tenantHandResolver = this.config.tenantRemoteHandResolver;
    if (!executionRegistry || !tenantHandResolver) {
      throw new Error('后台 Agent 缺少 executionTransportRegistry/tenantHandResolver 装配。');
    }
    const abortController = new AbortController();
    runtimeRunController.register(record.runId, abortController, {
      abortOnDrain: false,
      userId: taskSession.userId,
      tenantId: record.tenantId,
    });
    const renewTimer = lease ? setInterval(() => {
      void lease.renew().catch((err) => {
        logger.warn(`后台命令监控 lease 续约失败 task=${record.runId}: ${err instanceof Error ? err.message : String(err)}`);
        abortController.abort(new Error(BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON));
      });
    }, 30_000) : null;
    renewTimer?.unref?.();
    const cancelTimer = setInterval(() => {
      void this.config.runStore?.get(record.runId).then((current) => {
        if (current?.status === 'cancelled' && !abortController.signal.aborted) {
          abortController.abort(new Error('background task cancelled'));
        }
      }).catch(() => undefined);
    }, CANCEL_POLL_MS);
    cancelTimer.unref?.();
    const automationContext = buildBackgroundTaskAutomationContext(record, metadata), preparedIdentity = resolvePreparedChildIdentity(record, metadata);
    const leaseAuthority = lease?.workerId && lease.leaseToken ? { workerId: lease.workerId, leaseToken: lease.leaseToken } : undefined;
    const automationResource = new SessionAutomationBackgroundResource(this.config.sessionAutomationRuntimeGuard,
      automationContext, record.runId, preparedIdentity, leaseAuthority);
    try {
      await this.config.runStore?.markStatus(record.runId, record.status, record.statusReason, {
        executionChildSessionId: preparedIdentity.childSessionId, executionChildRunId: preparedIdentity.childRunId,
      });
      await automationResource.prepared();
      await sessionCatalog.markStatus(record.sessionId, 'running');
      const orgAgentSnapshot = taskSession.orgAgentSnapshot;
      const tooling = await collectRuntimeTooling(
        this.config,
        resolveBackgroundSkillUsername(taskSession),
        orgAgentSnapshot
          ? composeSkillFilters(buildOrgAgentSkillFilter(orgAgentSnapshot),
              buildOrgAgentChannelSkillFilter(metadata.orgAgentChannel))
          : () => true,
        orgAgentSnapshot ? resolveOrgAgentRuntimeSkillIds(orgAgentSnapshot) : [],
        undefined,
        [],
        { runId: record.runId, sessionId: taskSession.sessionId, userId: taskSession.userId },
      );
      const identity = sessionIdentity(taskSession);
      const connectorRunEnv = await buildConnectorRunEnv(this.config, identity);
      const channelContext: ChannelContext = {
        channel: metadata.parentChannel,
        outputTransactionMode: metadata.outputTransactionMode,
        resumeSessionId: record.sessionId,
        sessionOwner: identity,
        targetCwd: metadata.cwd,
        ...(metadata.timezone ? { timezone: metadata.timezone } : {}),
        ...(metadata.orgAgentChannel ? { orgAgentChannel: metadata.orgAgentChannel } : {}),
      };
      const runtimeIsolationRequirement = deriveBackgroundRuntimeIsolationRequirement(
        metadata, { runId: record.runId, sessionId: record.sessionId, workspaceId: metadata.workspaceId },
      );
      const baseParentContext = buildBackgroundTaskParentContext({
        record, metadata, taskSession, channelContext, env: connectorRunEnv,
        runtimeIsolationRequirement, signal: abortController.signal,
      });
      const parentContext: ToolCallContext = metadata.workload
        ? { ...baseParentContext, workspace: { ...baseParentContext.workspace, workload: metadata.workload } }
        : baseParentContext;
      const agentType = getSubagentType(metadata.agentType);
      if (!agentType) throw new Error(`未知后台 agent_type：${metadata.agentType}`);
      const outcome = await this.runSubagentImpl({ // authority callbacks must precede external side effects
        config: this.config,
        executionTransportRegistry: executionRegistry,
        tenantHandResolver,
        parentProviders: tooling.providers as ToolProvider[],
        parentContext,
        agentType,
        profileSourceSession: taskSession,
        request: {
          description: metadata.description,
          prompt: withOrgAgentArtifactContract(metadata.prompt, Boolean(metadata.orgAgentChannel)),
          model: metadata.modelRef,
          includeCompanyInfo: metadata.includeCompanyInfo,
        },
        preparedChildIdentity: preparedIdentity,
        acquireChildLaunchAuthority: identity => automationResource.launching(identity), beforeChildSideEffects: identity => automationResource.assertPrepared(identity),
        beforeTenantRemoteProvision: identity => assertBackgroundRemoteDispatchBarrier(this.config.runStore,
          record.runId, abortController.signal, identity, () => automationResource.active(identity)),
        onChildLaunchError: async () => undefined, onChildRunCreated: async (identity) => { await automationResource.active(identity);
          await this.config.runStore?.markStatus(record.runId, 'running', 'background_task_started', {
            executionChildSessionId: identity.childSessionId, executionChildRunId: identity.childRunId,
          }); },
      });
      if (outcome.childSessionId !== preparedIdentity.childSessionId || outcome.childRunId !== preparedIdentity.childRunId)
        throw new Error('subagent outcome identity does not match prepared background child');
      if (!await this.freezeOutcome(record, outcome, leaseAuthority)) return;
      const resolution = await automationResource.resolveFromAuthoritativeChild(); if (resolution !== 'released') throw new Error('background child terminal state is unknown; reconciliation required');
      const current = await this.config.runStore?.get(record.runId); await lease?.release(current?.status, current?.statusReason ?? `background_${outcome.status}`);
    } catch (err) { const current = await this.config.runStore?.get(record.runId);
      if (current?.status === 'cancelled') {
        await this.config.runStore?.markStatus(record.runId, 'cancelled', current.statusReason, {
          backgroundResult: failureResult('cancelled', '后台任务已取消'),
          wakeState: 'pending',
          backgroundFinishedAt: new Date().toISOString(),
        });
        await sessionCatalog.markStatus(record.sessionId, 'error').catch(() => undefined); await automationResource.resolveFromAuthoritativeChild(true).catch((resolutionError) => logger.warn(`后台子任务取消后资源结算失败 task=${record.runId}: ${resolutionError instanceof Error ? resolutionError.message : String(resolutionError)}`));
        await lease?.release('cancelled', current.statusReason ?? 'background_task_cancelled');
      } else { const message = err instanceof Error ? err.message : String(err);
        if (await this.freezeFailure(record, message, 'failed', message, leaseAuthority)) await automationResource.resolveFromAuthoritativeChild(true)
          .catch((resolutionError) => logger.warn(`后台子任务资源权威结算失败 task=${record.runId}: ${resolutionError instanceof Error ? resolutionError.message : String(resolutionError)}`));
        await lease?.release('failed', message);
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      clearInterval(cancelTimer);
      runtimeRunController.unregister(record.runId);
    }
  }
  async failInterrupted(record: RunRecord): Promise<void> { const metadata = parseBackgroundTaskMetadata(record);
    const fixedChild = metadata?.taskType === 'agent' && metadata.automationFence && metadata.executionChildSessionId && metadata.executionChildRunId;
    if (fixedChild && this.config.sessionAutomationRuntimeGuard) {
      const recovery = await this.config.sessionAutomationRuntimeGuard.recoverInterruptedBackgroundChild(buildBackgroundTaskAutomationContext(record, metadata)!,
        record.runId, { childSessionId: metadata.executionChildSessionId!, childRunId: metadata.executionChildRunId! });
      if (recovery === 'requeued') return;
      if (recovery === 'terminal_preserved') { await this.freezeFailure(record,
        '后台子任务已终结；父后台任务同步冻结且不会自动重放', 'failed', 'background_task_interrupted_child_terminal'); return; }
      await this.freezeFailure(record, '后台任务中断时已进入副作用边界；需要人工核对，绝不会自动重放', 'failed', 'background_task_interrupted_reconcile_required'); return;
    }
    if (metadata?.taskType === 'command') await invokeBackgroundCommandControl(this.config, record, metadata, 'KillBash', { task_id: record.runId }).catch(() => undefined);
    await this.freezeFailure(record, '后台任务执行进程中断；为避免重复副作用，本任务不会自动重放', 'failed', 'background_task_interrupted_no_replay');
  }
  async fail(record: RunRecord, message: string, reason = 'background_task_start_failed'): Promise<void> {
    const metadata = parseBackgroundTaskMetadata(record);
    if (metadata?.taskType === 'command') {
      await invokeBackgroundCommandControl(this.config, record, metadata, 'KillBash', { task_id: record.runId }).catch(() => undefined);
    }
    await this.freezeFailure(record, message, 'failed', reason);
    if (metadata?.taskType === 'agent' && metadata.executionChildSessionId && metadata.executionChildRunId && this.config.sessionAutomationRuntimeGuard) {
      const context=buildBackgroundTaskAutomationContext(record,metadata);if(context)await new SessionAutomationBackgroundResource(this.config.sessionAutomationRuntimeGuard,context,record.runId,{childSessionId:metadata.executionChildSessionId,childRunId:metadata.executionChildRunId}).resolveFromAuthoritativeChild(true).catch(()=>undefined);
    }
  }

  async reconcileStagedOrgWork(): Promise<void> {
    await reconcileOrgAgentStage(this.config, this.orgWork);
  }

  async reconcileWakeDeliveries(): Promise<void> {
    await reconcileBackgroundWakeDeliveries(
      this.config,
      this.orgWork,
      (parentSession, tenantId, event) => this.appendParentLifecycleEvent(parentSession, tenantId, event),
    );
  }
  async list(context: ToolCallContext, limit = 20): Promise<RunRecord[]> {
    const runStore = requireBackgroundRunStore(this.config.runStore);
    const parentSessionId = context.sessionId ?? context.workspace.sessionId;
    if (!parentSessionId) throw new Error('缺少当前 sessionId。');
    const identity = context.channelContext.sessionOwner ?? context.channelContext.user;
    const tasks = await runStore.listBackgroundTasks!(parentSessionId, {
      userId: identity?.id ?? context.workspace.userId,
      tenantId: identity?.tenantId ?? context.workspace.tenantId,
      limit,
    });
    return tasks.filter(task => isOrgTaskVisible(task, context));
  }

  async get(context: ToolCallContext, taskId: string): Promise<RunRecord | null> {
    let matches = await findBackgroundTasksByIdentifier(
      requireBackgroundRunStore(this.config.runStore), context, taskId,
    );
    if (matches.length === 0 && /^W-[A-F0-9]{12}$/i.test(taskId)) {
      const caller = context.channelContext.orgAgentChannel;
      const work = caller && this.config.orgGroupAgentStore
        ? await this.config.orgGroupAgentStore.getWorkOrderByShortId(
            caller.agentPrincipal.tenantId, caller.agentId, taskId,
          ) : null;
      if (work && work.bindingId === caller?.bindingId
        && work.workConversationId === caller.workConversationId) {
        const attempt = (await this.config.orgGroupAgentStore!.listWorkAttempts(work.tenantId, work.workOrderId)).at(-1);
        const run = attempt ? await this.config.runStore!.get(attempt.runtimeRunId) : null;
        matches = run ? [run] : [];
      }
    }
    if (matches.length > 1) throw new Error(`后台任务 ID ${taskId} 存在歧义，拒绝操作。`);
    const task = matches[0] ?? null;
    return task && isOrgTaskVisible(task, context) ? task : null;
  }

  async readCommandOutput(
    context: ToolCallContext,
    request: import('./backgroundTaskRuntime.js').BackgroundCommandOutputRequest,
  ): Promise<{ content: string }> {
    const task = await this.get(context, request.taskId);
    if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
    return await readBackgroundCommandOutput(this.config, task, request);
  }

  async cancel(context: ToolCallContext, taskId: string): Promise<RunRecord> {
    const task = await this.get(context, taskId);
    if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
    return await cancelBackgroundTask(this.config, this.orgWork, context, task);
  }

  async controlWorkOrder(
    context: ToolCallContext,
    request: OrgAgentWorkOrderControlRequest,
  ): Promise<{ task: RunRecord | null; workOrder: import('../../data/orgGroupAgents/index.js').OrgAgentWorkOrder }> {
    const task = await this.get(context, request.taskId);
    return await controlOrgAgentWorkOrder(this.config, this.orgWork, context, request, task);
  }

  async cancelWorkOrder(tenantId: string, workOrderId: string, expectedVersion: number): Promise<RunRecord | null> {
    return await this.orgWork.cancel(tenantId, workOrderId, expectedVersion);
  }

  async pauseWorkOrder(tenantId: string, workOrderId: string, expectedVersion: number): Promise<RunRecord | null> {
    return await this.orgWork.pause(tenantId, workOrderId, expectedVersion);
  }

  async retryWorkOrder(
    tenantId: string,
    workOrderId: string,
    expectedVersion: number,
    options?: {
      allowPendingArtifacts?: boolean;
      control?: import('../../data/orgGroupAgents/index.js').OrgAgentWorkOrderControl;
      supersedePendingCompletion?: boolean;
    },
  ): Promise<RunRecord> {
    return await this.orgWork.retry(tenantId, workOrderId, expectedVersion, options);
  }

  async publishWorkOrderArtifacts(tenantId: string, workOrderId: string, expectedVersion: number):
  Promise<import('../../data/orgGroupAgents/index.js').OrgAgentWorkAttempt> {
    return await this.orgWork.publish(tenantId, workOrderId, expectedVersion);
  }

  private async executeCommand(
    record: RunRecord,
    metadata: BackgroundCommandTaskMetadata,
    taskSession: import('../sessionCatalog.js').RuntimeSessionRecord,
    lease?: BackgroundTaskLease,
  ): Promise<void> {
    const sessionCatalog = resolveSessionCatalog(this.config);
    const abortController = new AbortController();
    runtimeRunController.register(record.runId, abortController, {
      abortOnDrain: false,
      userId: taskSession.userId,
      tenantId: record.tenantId,
    });
    const renewTimer = lease ? setInterval(() => {
      void lease.renew().catch((err) => abortController.abort(err instanceof Error ? err : new Error(String(err))));
    }, 30_000) : null;
    renewTimer?.unref?.();
    let consecutiveErrors = 0;
    const startedAt = Date.now();
    try {
      await sessionCatalog.markStatus(record.sessionId, 'running');
      while (true) {
        const current = await this.config.runStore?.get(record.runId);
        if (current?.status === 'cancelled') {
          await lease?.release('cancelled', current.statusReason ?? 'background_command_cancelled');
          return;
        }
        if (abortController.signal.aborted) throw abortController.signal.reason ?? new Error('background command monitor aborted');
        let view: BackgroundShellView;
        try {
          const result = await invokeBackgroundCommandControl(this.config, record, metadata, 'BashOutput', {
            task_id: record.runId,
            stdout_offset: 0,
            stderr_offset: 0,
            limit_bytes: 64 * 1024,
            wait_ms: 30_000,
          }, abortController.signal);
          view = parseBackgroundShellView(result.content);
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors += 1;
          if (consecutiveErrors < 3) {
            await sleepAbortable(2_000 * consecutiveErrors, abortController.signal);
            continue;
          }
          throw err;
        }
        if (view.status === 'starting' || view.status === 'running' || view.status === 'cancelling') continue;
        const text = formatBackgroundShellResult(view);
        const stored = await persistResultText(record, text, record.runId);
        const outcomeStatus: StoredBackgroundResult['status'] = view.status === 'completed'
          ? 'completed'
          : view.status === 'cancelled'
            ? 'cancelled'
            : view.status === 'timed_out'
              ? 'timeout'
              : 'failed';
        const result: StoredBackgroundResult = {
          status: outcomeStatus,
          text: stored.text,
          ...(view.error ? { errorMessage: view.error } : {}),
          ...(stored.spillPath ? { spillPath: stored.spillPath } : {}),
          totalTokens: 0,
          toolUseCount: 1,
          turnCount: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
        };
        const runStatus: RunStatus = outcomeStatus === 'completed'
          ? 'completed'
          : outcomeStatus === 'cancelled'
            ? 'cancelled'
            : 'failed';
        const statusReason = runStatus === 'completed' ? undefined : view.error ?? `background_command_${view.status}`;
        const updated = await markBackgroundTaskTerminal(this.config.runStore!,
          await this.backgroundTaskEventStore(record), record, runStatus, statusReason, {
          backgroundResult: result,
          wakeState: 'pending',
          backgroundFinishedAt: new Date().toISOString(),
        });
        if (updated) {
          await sessionCatalog.markStatus(record.sessionId, runStatus === 'completed' ? 'finished' : 'error').catch(() => undefined);
          await this.orgWork.syncTerminal(updated, runStatus === 'completed' ? 'completed' : runStatus === 'cancelled' ? 'cancelled' : 'failed', result, statusReason)
            .catch(error => logger.error(`组织群命令任务状态同步失败 task=${record.runId}: ${String(error)}`));
        }
        const finalStatus = updated?.status ?? (await this.config.runStore?.get(record.runId))?.status;
        await lease?.release(finalStatus, updated?.statusReason ?? statusReason);
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON) {
        if (lease?.handoff) await lease.handoff(BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON);
        return;
      }
      const current = await this.config.runStore?.get(record.runId);
      if (current?.status !== 'cancelled') {
        await invokeBackgroundCommandControl(this.config, record, metadata, 'KillBash', { task_id: record.runId }).catch(() => undefined);
        await this.freezeFailure(record, message, 'failed', 'background_command_monitor_failed');
        await lease?.release('failed', message);
      } else {
        await lease?.release('cancelled', current.statusReason ?? 'background_command_cancelled');
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      runtimeRunController.unregister(record.runId);
    }
  }

  private async requireOwnedTask(context: ToolCallContext, taskId: string): Promise<RunRecord> {
    const task = await this.get(context, taskId);
    if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
    return task;
  }
  private async freezeOutcome(record: RunRecord, outcome: SubagentOutcome, leaseAuthority?: import('../runStore.js').RunLeaseAuthority): Promise<boolean> {
    const current = await this.config.runStore?.get(record.runId);
    if (current?.status === 'cancelled') {
      await this.config.runStore?.markStatus(record.runId, 'cancelled', current.statusReason, {
        backgroundResult: failureResult('cancelled', '后台任务已取消'),
        wakeState: 'pending',
        backgroundFinishedAt: new Date().toISOString(),
      });
      await resolveSessionCatalog(this.config).markStatus(record.sessionId, 'error').catch(() => undefined);
      return false;
    }
    const stored = await persistResultText(record, outcome.text, outcome.childRunId);
    const safeErrorMessage = customerSafeRuntimeError(outcome.errorMessage, outcome.failureKind);
    const result: StoredBackgroundResult = {
      status: outcome.status,
      text: stored.text,
      ...(safeErrorMessage ? { errorMessage: safeErrorMessage } : {}), ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}), ...(outcome.recoveryAction ? { recoveryAction: outcome.recoveryAction } : {}),
      ...(stored.spillPath ? { spillPath: stored.spillPath } : {}),
      childSessionId: outcome.childSessionId,
      childRunId: outcome.childRunId,
      totalTokens: outcome.totalTokens,
      toolUseCount: outcome.toolUseCount,
      turnCount: outcome.turnCount,
      durationMs: outcome.durationMs,
    };
    const status = outcomeToRunStatus(outcome.status);
    const statusReason = status === 'completed' ? undefined : safeErrorMessage ?? `background_${outcome.status}`;
    const updated = await markBackgroundTaskTerminal(this.config.runStore!,
      await this.backgroundTaskEventStore(record), record, status, statusReason, {
      backgroundResult: result,
      wakeState: 'pending',
      backgroundFinishedAt: new Date().toISOString(),
    }, leaseAuthority);
    if (updated) await resolveSessionCatalog(this.config)
      .markStatus(record.sessionId, status === 'completed' ? 'finished' : 'error')
      .catch(() => undefined);
    if (updated) await this.orgWork.syncTerminal(updated, status === 'completed' ? 'completed'
      : status === 'cancelled' ? 'cancelled' : 'failed', result, statusReason)
      .catch(error => logger.error(`组织群后台任务状态同步失败 task=${record.runId}: ${String(error)}`));
    return Boolean(updated);
  }

  private async freezeFailure(
    record: RunRecord,
    message: string,
    status: 'failed' | 'cancelled',
    reason = message,
    leaseAuthority?: import('../runStore.js').RunLeaseAuthority,
  ): Promise<boolean> {
    const updated = await markBackgroundTaskTerminal(this.config.runStore!, await this.backgroundTaskEventStore(record),
      record, status, reason, {
      backgroundResult: failureResult(status, message), wakeState: 'pending',
      backgroundFinishedAt: new Date().toISOString(),
    }, leaseAuthority);
    if (updated) {
      await resolveSessionCatalog(this.config).markStatus(record.sessionId, 'error').catch(() => undefined);
      await this.orgWork.syncTerminal(updated, status, failureResult(status, message), reason)
        .catch(error => logger.error(`组织群后台失败状态同步失败 task=${record.runId}: ${String(error)}`));
    }
    return Boolean(updated);
  }
  private async backgroundTaskEventStore(record: RunRecord) { const taskSession = await resolveSessionCatalog(this.config).get(record.sessionId); if (!taskSession) throw new Error(`后台任务 session 不存在：${record.sessionId}`); return createEventStoreForSession(this.config, taskSession); }

  private async appendParentLifecycleEvent(
    parentSession: import('../sessionCatalog.js').RuntimeSessionRecord,
    tenantId: string | undefined,
    event: Parameters<ReturnType<typeof createEventStoreForSession>['append']>[0],
  ): Promise<void> {
    try {
      const sessionTenantId = parentSession.tenantId?.trim();
      const runTenantId = tenantId?.trim();
      if (sessionTenantId && runTenantId && sessionTenantId !== runTenantId) {
        throw new Error(`Background task parent tenant mismatch for session ${parentSession.sessionId}`);
      }
      const eventTenantId = sessionTenantId ?? runTenantId;
      if (!eventTenantId) throw new Error(`Background task parent tenant is missing for session ${parentSession.sessionId}`);
      await createEventStoreForSession(this.config, parentSession)
        .append(event, { tenantId: eventTenantId });
    } catch (err) {
      logger.warn(`后台任务生命周期事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
