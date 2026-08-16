import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PlatformToolRuntime, type ToolCallContext, type ToolProvider } from '../../agent/toolRuntime.js';
import { readSessionMeta } from '../../data/transcripts/meta.js';
import {
  mergeOrgAgentWorkerRuntimePolicy,
  resolveOrgAgentRuntimeSkillIds,
} from '../../data/orgAgents/runtimePolicy.js';
import type { ChannelContext, UserIdentity } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import { buildConnectorRunEnv } from '../connectorRunEnv.js';
import { runtimeRunController } from '../runController.js';
import { resolveModelOutputTransactionMode } from '../modelOutputTransaction.js';
import type { RunRecord, RunStatus, RunStore } from '../runStore.js';
import {
  buildOrgAgentSkillFilter,
  collectRuntimeTooling,
  composeSkillFilters,
  createEventStoreForSession,
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord } from '../sessionCatalog.js';
import { getSubagentType } from '../subagent/agentTypes.js';
import {
  SUBAGENT_PER_RUN_MAX_CONCURRENCY,
  SUBAGENT_RESULT_MAX_CHARS,
} from '../subagent/subagentLimits.js';
import { runSubagent, type SubagentOutcome } from '../subagent/subagentRunner.js';
import { BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON } from './backgroundTaskRuntime.js';
import {
  metadataString,
  parseBackgroundTaskMetadata,
  type BackgroundCommandTaskMetadata,
} from './backgroundTaskMetadata.js';
import { deliverDwsBackgroundCompletion, resolveDwsCompletionRoute } from './backgroundTaskDwsCompletion.js';
import { markBackgroundTaskTerminal } from './backgroundTaskTerminal.js';
import { findBackgroundTasksByIdentifier } from './backgroundTaskLookup.js';
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
} from './backgroundTaskRuntime.js';
import {
  buildTaskNotification,
  compactCommandPreview,
  formatBackgroundShellResult,
  parseBackgroundShellView,
  parseStoredResult,
  truncateResult,
  type BackgroundShellView,
  type StoredBackgroundResult,
} from './backgroundTaskFormatting.js';

export type { BackgroundTaskMetadata } from './backgroundTaskMetadata.js';

// 结果模型与格式化函数已迁至 ./backgroundTaskFormatting.ts，这里按既有 import 路径继续对外转发。
export { escapeXml } from './backgroundTaskFormatting.js';

const logger = createLogger('BackgroundTaskService');
const WAKE_CLAIM_STALE_MS = 60_000;
const WAKE_BATCH_SIZE = 50;
const CANCEL_POLL_MS = 2_000;

export class DurableBackgroundTaskService implements BackgroundTaskRuntime {
  private readonly runSubagentImpl: typeof runSubagent;

  constructor(
    private readonly config: RawRuntimeRunDispatchConfig,
    options: { runSubagentImpl?: typeof runSubagent } = {},
  ) {
    this.runSubagentImpl = options.runSubagentImpl ?? runSubagent;
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
    const executionTarget = context.workspace.executionTarget;
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
      if (!resolved && (request.model
        || boundProfile?.version.config.model.strategy === 'fixed'
        || configuredWorkerModel?.strategy === 'fixed')) {
        throw new Error(`后台 Agent 模型 "${modelRef}" 不在当前组织可用模型白名单内。`);
      }
      model = resolved?.model;
    }
    model ??= modelRef ?? parentRun?.model;
    if (!model || !modelRef) throw new Error('无法确定后台 Agent 模型。');

    const taskUuid = randomUUID();
    const taskId = `bg-${Date.now()}-${taskUuid}`;
    const shortTaskId = `T-${taskUuid.replaceAll('-', '').slice(0, 24).toUpperCase()}`;
    const taskSessionId = `sub-${randomUUID()}`;
    const toolCallId = context.toolCallId ?? `agent-${randomUUID()}`;
    let taskSession = createRuntimeSessionRecord({
      sessionId: taskSessionId,
      userId,
      username,
      userRole: parentSession.userRole ?? identity?.role,
      tenantId,
      channel: context.channelContext.channel,
      cwd: context.workspace.root,
      modelRef,
      executionTarget,
      workspaceId: context.workspace.id ?? taskSessionId,
      status: 'idle',
      kind: 'subagent',
      executionRole: 'worker',
      ...(parentSession.orgAgentId ? { orgAgentId: parentSession.orgAgentId } : {}),
      ...(parentSession.orgAgentSnapshot ? { orgAgentSnapshot: parentSession.orgAgentSnapshot } : {}),
    });
    if (boundProfile && this.config.agentRuntimeProfileResolver) {
      taskSession = this.config.agentRuntimeProfileResolver.bindSessionRecord(taskSession, boundProfile);
    }
    await sessionCatalog.upsert(taskSession);

    const taskRun = await runStore.enqueueBackgroundTask!({
      runId: taskId,
      sessionId: taskSessionId,
      userId,
      tenantId,
      model,
      channel: 'background_task',
      idempotencyKey: `background-task:${taskId}`,
      executionTarget,
      workspaceId: context.workspace.id ?? taskSessionId,
      sandboxScopeId: context.workspace.sandboxScopeId,
      metadata: {
        subagent: true,
        backgroundTask: true,
        backgroundTaskType: 'agent',
        backgroundTaskReady: true,
        backgroundTaskVersion: 1,
        outputTransactionMode: 'terminal_buffered',
        parentRunId,
        parentSessionId,
        topLevelSessionId: context.workspace.topLevelSessionId ?? parentSessionId,
        parentToolCallId: toolCallId,
        shortTaskId,
        description: request.description,
        prompt: request.prompt,
        executionRole: 'worker',
        ...(parentSession.orgAgentId ? { orgAgentId: parentSession.orgAgentId } : {}),
        ...(parentSession.orgAgentSnapshot?.runtime.executionMode
          ? { executionMode: parentSession.orgAgentSnapshot.runtime.executionMode }
          : {}),
        ...(dwsCompletionRoute ? { dwsCompletionRoute } : {}),
        agentType: request.agentType,
        modelRef,
        includeCompanyInfo: request.includeCompanyInfo
          || boundProfile?.version.config.context.modules?.includes('company_info') === true,
        ...(boundProfile ? profileRunMetadata(boundProfile) : {}),
        cwd: context.workspace.root,
        workspaceId: context.workspace.id ?? taskSessionId,
        ...(context.workspace.mountSubPath ? { mountSubPath: context.workspace.mountSubPath } : {}),
        ...(context.workspace.sandboxScopeId ? { sandboxScopeId: context.workspace.sandboxScopeId } : {}),
        ...(context.workspace.sandboxPolicy ? { sandboxPolicy: context.workspace.sandboxPolicy } : {}),
        ...(context.channelContext.timezone ? { timezone: context.channelContext.timezone } : {}),
        parentChannel: context.channelContext.channel,
        parentOutputTransactionMode: resolveModelOutputTransactionMode(context.channelContext),
        wakeState: 'none',
      },
    }, {
      perParentActive: SUBAGENT_PER_RUN_MAX_CONCURRENCY,
      perTenantActive: SUBAGENT_PER_RUN_MAX_CONCURRENCY,
    });

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
    const taskId = `shell-bg-${Date.now()}-${randomUUID()}`;
    const taskSessionId = `sub-${randomUUID()}`;
    const toolCallId = context.toolCallId ?? `shell-${randomUUID()}`;
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
      executionTarget,
      workspaceId: context.workspace.id ?? taskSessionId,
      status: 'idle',
      kind: 'subagent',
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
        idempotencyKey: `background-task:${taskId}`,
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
          ...(context.workspace.sandboxPolicy ? { sandboxPolicy: context.workspace.sandboxPolicy } : {}),
          ...(context.channelContext.timezone ? { timezone: context.channelContext.timezone } : {}),
          parentChannel: context.channelContext.channel,
          parentOutputTransactionMode: resolveModelOutputTransactionMode(context.channelContext),
          wakeState: 'none',
        },
      }, {
        perParentActive: SUBAGENT_PER_RUN_MAX_CONCURRENCY,
        perTenantActive: SUBAGENT_PER_RUN_MAX_CONCURRENCY,
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
    await this.config.runStore!.markStatus(taskId, 'failed', 'background_command_start_failed', {
      backgroundResult: failureResult('failed', message),
      wakeState: 'discarded',
      backgroundFinishedAt: new Date().toISOString(),
    });
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

    try {
      await sessionCatalog.markStatus(record.sessionId, 'running');
      const orgAgentSnapshot = taskSession.orgAgentSnapshot;
      const tooling = await collectRuntimeTooling(
        this.config,
        taskSession.username,
        orgAgentSnapshot
          ? composeSkillFilters(buildOrgAgentSkillFilter(orgAgentSnapshot))
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
      };
      const parentContext: ToolCallContext = {
        channelContext,
        env: connectorRunEnv,
        workspace: {
          id: metadata.workspaceId,
          root: metadata.cwd,
          userId: taskSession.userId,
          username: taskSession.username,
          tenantId: taskSession.tenantId,
          sessionId: record.sessionId,
          // ⚠️ 三层套娃的关键修正：此处 record.sessionId 是 bg task 自己的 `sub-` 会话，
          // 下游 runSubagent 会用 `parentWorkspace.topLevelSessionId ?? parentSessionId`，
          // 若不显式带上顶层组键就会取到中间层，导致后台任务另开一个 pod。
          topLevelSessionId: metadata.topLevelSessionId ?? metadata.parentSessionId,
          executionTarget: record.executionTarget ?? taskSession.executionTarget ?? 'server-container',
          ...(metadata.mountSubPath ? { mountSubPath: metadata.mountSubPath } : {}),
          ...(metadata.sandboxScopeId ? { sandboxScopeId: metadata.sandboxScopeId } : {}),
          ...(metadata.sandboxPolicy ? { sandboxPolicy: metadata.sandboxPolicy } : {}),
        },
        sessionId: record.sessionId,
        runId: record.runId,
        toolCallId: metadata.parentToolCallId,
        signal: abortController.signal,
      };
      const agentType = getSubagentType(metadata.agentType);
      if (!agentType) throw new Error(`未知后台 agent_type：${metadata.agentType}`);
      const outcome = await this.runSubagentImpl({
        config: this.config,
        executionTransportRegistry: executionRegistry,
        tenantHandResolver,
        parentProviders: tooling.providers as ToolProvider[],
        parentContext,
        agentType,
        profileSourceSession: taskSession,
        request: {
          description: metadata.description,
          prompt: metadata.prompt,
          model: metadata.modelRef,
          includeCompanyInfo: metadata.includeCompanyInfo,
        },
        onChildRunCreated: async ({ childSessionId, childRunId }) => {
          await this.config.runStore?.markStatus(record.runId, 'running', 'background_task_started', {
            executionChildSessionId: childSessionId,
            executionChildRunId: childRunId,
          });
        },
      });
      await this.freezeOutcome(record, outcome);
      const current = await this.config.runStore?.get(record.runId);
      const finalStatus = current?.status ?? outcomeToRunStatus(outcome.status);
      await lease?.release(finalStatus, current?.statusReason ?? `background_${outcome.status}`);
    } catch (err) {
      const current = await this.config.runStore?.get(record.runId);
      if (current?.status === 'cancelled') {
        await this.config.runStore?.markStatus(record.runId, 'cancelled', current.statusReason, {
          backgroundResult: failureResult('cancelled', '后台任务已取消'),
          wakeState: 'pending',
          backgroundFinishedAt: new Date().toISOString(),
        });
        await sessionCatalog.markStatus(record.sessionId, 'error').catch(() => undefined);
        await lease?.release('cancelled', current.statusReason ?? 'background_task_cancelled');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await this.freezeFailure(record, message, 'failed');
        await lease?.release('failed', message);
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      clearInterval(cancelTimer);
      runtimeRunController.unregister(record.runId);
    }
  }

  async failInterrupted(record: RunRecord): Promise<void> {
    const metadata = parseBackgroundTaskMetadata(record);
    if (metadata?.taskType === 'command') {
      await this.invokeCommandControl(record, metadata, 'KillBash', { task_id: record.runId }).catch(() => undefined);
    }
    await this.freezeFailure(
      record,
      '后台任务执行进程中断；为避免重复副作用，本任务不会自动重放',
      'failed',
      'background_task_interrupted_no_replay',
    );
  }

  async fail(record: RunRecord, message: string, reason = 'background_task_start_failed'): Promise<void> {
    const metadata = parseBackgroundTaskMetadata(record);
    if (metadata?.taskType === 'command') {
      await this.invokeCommandControl(record, metadata, 'KillBash', { task_id: record.runId }).catch(() => undefined);
    }
    await this.freezeFailure(record, message, 'failed', reason);
  }

  async reconcileWakeDeliveries(): Promise<void> {
    const runStore = this.config.runStore;
    if (!runStore?.listPendingBackgroundTaskWakes
      || !runStore.claimBackgroundTaskWake
      || !runStore.finishBackgroundTaskWake) return;
    const staleBefore = new Date(Date.now() - WAKE_CLAIM_STALE_MS);
    const pending = await runStore.listPendingBackgroundTaskWakes(staleBefore, WAKE_BATCH_SIZE);
    for (const candidate of pending) {
      const claimToken = randomUUID();
      const task = await runStore.claimBackgroundTaskWake(candidate.runId, claimToken, staleBefore);
      if (!task) continue;
      const metadata = parseBackgroundTaskMetadata(task);
      if (!metadata) {
        await runStore.finishBackgroundTaskWake(task.runId, claimToken, 'discarded', {
          wakeDiscardReason: 'invalid_background_metadata',
        });
        continue;
      }
      const parentSession = await resolveSessionCatalog(this.config).get(metadata.parentSessionId);
      const parentMeta = parentSession ? await readSessionMeta(parentSession.transcriptPath) : null;
      if (!parentSession || parentMeta?.deletedAt) {
        await runStore.finishBackgroundTaskWake(task.runId, claimToken, 'discarded', {
          wakeDiscardReason: parentMeta?.deletedAt ? 'parent_session_deleted' : 'parent_session_missing',
        });
        continue;
      }
      const activeParentRun = await runStore.getActiveBySession?.(metadata.parentSessionId);
      if (activeParentRun) {
        await runStore.finishBackgroundTaskWake(task.runId, claimToken, 'pending', {
          wakeDeferredReason: 'parent_session_active',
        });
        continue;
      }

      const storedResult = parseStoredResult(task.metadata.backgroundResult);
      const fallbackStatus = task.status === 'cancelled'
        ? 'cancelled'
        : task.status === 'completed'
          ? 'completed'
          : 'failed';
      if (typeof task.metadata.lifecycleFinishedAt !== 'string') {
        await this.appendParentLifecycleEvent(parentSession, task.tenantId, {
          type: 'background_task_finished',
          runId: metadata.parentRunId,
          sessionId: metadata.parentSessionId,
          taskId: task.runId,
          taskSessionId: task.sessionId,
          toolCallId: metadata.parentToolCallId,
          agentType: metadata.taskType === 'agent' ? metadata.agentType : 'command',
          description: metadata.description,
          status: storedResult?.status ?? fallbackStatus,
          totalTokens: storedResult?.totalTokens ?? 0,
          durationMs: storedResult?.durationMs ?? 0,
          ...(storedResult?.errorMessage ? { errorMessage: storedResult.errorMessage } : {}),
          ...(storedResult?.text ? { resultPreview: storedResult.text.slice(0, 2_000) } : {}),
        });
        await runStore.markStatus(task.runId, task.status, task.statusReason, {
          lifecycleFinishedAt: new Date().toISOString(),
        });
      }

      if (await deliverDwsBackgroundCompletion({
        config: this.config, runStore, task, metadata, claimToken,
      })) continue;

      const wakeRunId = `bg-wake-${task.runId}`;
      const wake = await runStore.upsertPending({
        runId: wakeRunId,
        sessionId: metadata.parentSessionId,
        userId: task.userId,
        tenantId: task.tenantId,
        model: parentSession.modelRef,
        channel: 'background_task',
        idempotencyKey: `background-task-wake:${task.runId}`,
        executionTarget: parentSession.executionTarget,
        workspaceId: parentSession.workspaceId,
        metadata: {
          backgroundTaskWake: true,
          outputTransactionMode: metadata.parentOutputTransactionMode,
          backgroundTaskId: task.runId,
          wakeMessage: {
            channel: 'web',
            chatId: metadata.parentSessionId,
            content: buildTaskNotification(task, metadata),
            senderId: parentSession.userId,
            senderName: parentSession.username,
            metadata: { backgroundTaskWake: true, backgroundTaskId: task.runId },
          },
        },
      });
      await runStore.finishBackgroundTaskWake(task.runId, claimToken, 'queued', {
        wakeRunId: wake.runId,
        wakeDeferredReason: null,
        lifecycleFinishedAt: new Date().toISOString(),
      });
    }
  }

  async list(context: ToolCallContext, limit = 20): Promise<RunRecord[]> {
    const runStore = requireBackgroundRunStore(this.config.runStore);
    const parentSessionId = context.sessionId ?? context.workspace.sessionId;
    if (!parentSessionId) throw new Error('缺少当前 sessionId。');
    const identity = context.channelContext.sessionOwner ?? context.channelContext.user;
    return runStore.listBackgroundTasks!(parentSessionId, {
      userId: identity?.id ?? context.workspace.userId,
      tenantId: identity?.tenantId ?? context.workspace.tenantId,
      limit,
    });
  }

  async get(context: ToolCallContext, taskId: string): Promise<RunRecord | null> {
    const matches = await findBackgroundTasksByIdentifier(
      requireBackgroundRunStore(this.config.runStore), context, taskId,
    );
    if (matches.length > 1) throw new Error(`后台任务 ID ${taskId} 存在歧义，拒绝操作。`);
    return matches[0] ?? null;
  }

  async readCommandOutput(
    context: ToolCallContext,
    request: import('./backgroundTaskRuntime.js').BackgroundCommandOutputRequest,
  ): Promise<{ content: string }> {
    const task = await this.get(context, request.taskId);
    if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
    const metadata = parseBackgroundTaskMetadata(task);
    if (metadata?.taskType !== 'command') {
      throw new Error('该任务不是后台命令任务；后台 Agent 任务请用 BackgroundTask(action="status") 查看结果。');
    }
    if (isTerminal(task.status)) {
      throw new Error(`后台命令已进入终态（${task.status}）；用 BackgroundTask(action="status") 查看结果摘要与完整输出文件位置。`);
    }
    return await this.invokeCommandControl(task, metadata, 'BashOutput', {
      task_id: request.taskId,
      stdout_offset: request.stdoutOffset ?? 0,
      stderr_offset: request.stderrOffset ?? 0,
      limit_bytes: request.limitBytes ?? 20_000,
      wait_ms: request.waitMs ?? 0,
    });
  }

  async cancel(context: ToolCallContext, taskId: string): Promise<RunRecord> {
    const task = await this.get(context, taskId);
    if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
    if (isTerminal(task.status)) return task;
    const metadata = parseBackgroundTaskMetadata(task);
    const message = '后台任务由父会话请求取消';
    const updated = await markBackgroundTaskTerminal(this.config.runStore!, task.runId, 'cancelled', message, {
      backgroundResult: failureResult('cancelled', message),
      wakeState: 'pending',
      backgroundFinishedAt: new Date().toISOString(),
    });
    if (!updated) {
      const current = await this.config.runStore!.get(task.runId);
      if (current && isTerminal(current.status)) return current;
      throw new Error('后台任务取消失败。');
    }
    if (metadata?.taskType === 'command') {
      await this.invokeCommandControl(task, metadata, 'KillBash', { task_id: task.runId }).catch(() => undefined);
    }
    runtimeRunController.abort(task.runId);
    await resolveSessionCatalog(this.config).markStatus(task.sessionId, 'error').catch(() => undefined);
    return updated;
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
          const result = await this.invokeCommandControl(record, metadata, 'BashOutput', {
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
        const updated = await markBackgroundTaskTerminal(this.config.runStore!, record.runId, runStatus, statusReason, {
          backgroundResult: result,
          wakeState: 'pending',
          backgroundFinishedAt: new Date().toISOString(),
        });
        if (updated) await sessionCatalog.markStatus(record.sessionId, runStatus === 'completed' ? 'finished' : 'error').catch(() => undefined);
        const finalStatus = updated?.status ?? (await this.config.runStore?.get(record.runId))?.status;
        await lease?.release(finalStatus, updated?.statusReason ?? statusReason);
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON) {
        await lease?.release(undefined, BACKGROUND_COMMAND_MONITOR_HANDOFF_REASON).catch(() => undefined);
        return;
      }
      const current = await this.config.runStore?.get(record.runId);
      if (current?.status !== 'cancelled') {
        await this.invokeCommandControl(record, metadata, 'KillBash', { task_id: record.runId }).catch(() => undefined);
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

  private async invokeCommandControl(
    record: RunRecord,
    metadata: BackgroundCommandTaskMetadata,
    toolId: 'BashOutput' | 'KillBash',
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: string }> {
    const executionRegistry = this.config.executionTransportRegistry;
    const tenantHandResolver = this.config.tenantRemoteHandResolver;
    if (!executionRegistry || !tenantHandResolver) throw new Error(
      '后台命令缺少 executionTransportRegistry/tenantHandResolver 装配。',
    );
    const sessionCatalog = resolveSessionCatalog(this.config);
    const taskSession = await sessionCatalog.get(record.sessionId);
    const parentSession = await sessionCatalog.get(metadata.parentSessionId); // durable 子任务无 hand，恢复父 hand
    if (!taskSession) throw new Error(`后台命令 session 不存在：${record.sessionId}`);
    if (!parentSession) throw new Error(`后台命令父 session 不存在：${metadata.parentSessionId}`);
    const identity = sessionIdentity(parentSession);
    const runtime = new PlatformToolRuntime({
      executionTransportRegistry: executionRegistry,
      handStore: this.config.handStore,
      resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
    });
    return await runtime.invoke({
      toolId,
      input,
      authorization: { approved: true, source: 'legacy_adapter' },
    }, {
      channelContext: {
        channel: metadata.parentChannel,
        resumeSessionId: metadata.parentSessionId,
        sessionOwner: identity,
        targetCwd: metadata.cwd,
        ...(metadata.timezone ? { timezone: metadata.timezone } : {}),
      },
      workspace: {
        id: metadata.workspaceId,
        root: metadata.cwd,
        userId: parentSession.userId,
        username: parentSession.username,
        tenantId: parentSession.tenantId,
        sessionId: metadata.parentSessionId,
        topLevelSessionId: metadata.topLevelSessionId ?? metadata.parentSessionId,
        executionTarget: record.executionTarget ?? taskSession.executionTarget ?? 'server-remote',
        ...(metadata.mountSubPath ? { mountSubPath: metadata.mountSubPath } : {}),
        ...(metadata.sandboxScopeId ? { sandboxScopeId: metadata.sandboxScopeId } : {}),
        ...(metadata.sandboxPolicy ? { sandboxPolicy: metadata.sandboxPolicy } : {}),
      },
      sessionId: metadata.parentSessionId, runId: record.runId,
      toolCallId: `${toolId}-${record.runId}`,
      signal,
    });
  }

  private async requireOwnedTask(context: ToolCallContext, taskId: string): Promise<RunRecord> {
    const task = await this.get(context, taskId);
    if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
    return task;
  }

  private async freezeOutcome(record: RunRecord, outcome: SubagentOutcome): Promise<void> {
    const current = await this.config.runStore?.get(record.runId);
    if (current?.status === 'cancelled') {
      await this.config.runStore?.markStatus(record.runId, 'cancelled', current.statusReason, {
        backgroundResult: failureResult('cancelled', '后台任务已取消'),
        wakeState: 'pending',
        backgroundFinishedAt: new Date().toISOString(),
      });
      await resolveSessionCatalog(this.config).markStatus(record.sessionId, 'error').catch(() => undefined);
      return;
    }
    const stored = await persistResultText(record, outcome.text, outcome.childRunId);
    const result: StoredBackgroundResult = {
      status: outcome.status,
      text: stored.text,
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      ...(stored.spillPath ? { spillPath: stored.spillPath } : {}),
      childSessionId: outcome.childSessionId,
      childRunId: outcome.childRunId,
      totalTokens: outcome.totalTokens,
      toolUseCount: outcome.toolUseCount,
      turnCount: outcome.turnCount,
      durationMs: outcome.durationMs,
    };
    const status = outcomeToRunStatus(outcome.status);
    const statusReason = status === 'completed' ? undefined : outcome.errorMessage ?? `background_${outcome.status}`;
    const updated = await markBackgroundTaskTerminal(this.config.runStore!, record.runId, status, statusReason, {
      backgroundResult: result,
      wakeState: 'pending',
      backgroundFinishedAt: new Date().toISOString(),
    });
    if (updated) await resolveSessionCatalog(this.config)
      .markStatus(record.sessionId, status === 'completed' ? 'finished' : 'error')
      .catch(() => undefined);
  }

  private async freezeFailure(
    record: RunRecord,
    message: string,
    status: 'failed' | 'cancelled',
    reason = message,
  ): Promise<void> {
    const updated = await markBackgroundTaskTerminal(this.config.runStore!, record.runId, status, reason, {
      backgroundResult: failureResult(status, message),
      wakeState: 'pending',
      backgroundFinishedAt: new Date().toISOString(),
    });
    if (updated) await resolveSessionCatalog(this.config).markStatus(record.sessionId, 'error').catch(() => undefined);
  }

  private async appendParentLifecycleEvent(
    parentSession: import('../sessionCatalog.js').RuntimeSessionRecord,
    tenantId: string | undefined,
    event: Parameters<ReturnType<typeof createEventStoreForSession>['append']>[0],
  ): Promise<void> {
    try {
      await createEventStoreForSession(this.config, parentSession)
        .append(event, tenantId ? { tenantId } : undefined);
    } catch (err) {
      logger.warn(`后台任务生命周期事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function requireBackgroundRunStore(runStore: RunStore | undefined): RunStore {
  if (!runStore?.enqueueBackgroundTask || !runStore.listBackgroundTasks) {
    throw new Error('后台 Agent/命令需要 PG durable runtime，当前后端不支持。');
  }
  return runStore;
}

function sessionIdentity(session: {
  userId: string;
  username: string;
  userRole?: 'admin' | 'user';
  tenantId?: string;
}): UserIdentity {
  return {
    id: session.userId,
    username: session.username,
    role: session.userRole ?? 'user',
    ...(session.tenantId ? { tenantId: session.tenantId } : {}),
  };
}

function outcomeToRunStatus(
  status: SubagentOutcome['status'],
): Extract<RunStatus, 'completed' | 'failed' | 'cancelled'> {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned';
}

function failureResult(status: 'failed' | 'cancelled', message: string): StoredBackgroundResult {
  return {
    status,
    text: '',
    errorMessage: message,
    totalTokens: 0,
    toolUseCount: 0,
    turnCount: 0,
    durationMs: 0,
  };
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function persistResultText(
  record: RunRecord,
  text: string,
  childRunId: string,
): Promise<{ text: string; spillPath?: string }> {
  if (text.length <= SUBAGENT_RESULT_MAX_CHARS) return { text };
  const cwd = metadataString(record.metadata, 'cwd');
  if (!cwd) return { text: truncateResult(text) };
  const spillPath = join('assets', 'background-tasks', `${childRunId}.md`);
  try {
    const fullPath = join(cwd, spillPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, text, 'utf-8');
    return { text: truncateResult(text), spillPath };
  } catch (err) {
    logger.warn(`后台任务结果 spill 失败 task=${record.runId}: ${err instanceof Error ? err.message : String(err)}`);
    return { text: truncateResult(text) };
  }
}
