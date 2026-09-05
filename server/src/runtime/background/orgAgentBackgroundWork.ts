import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolCallContext } from '../../agent/toolRuntime.js';
import type {
  OrgAgentResultEnvelope,
  OrgAgentWorkOrder,
  OrgAgentWorkOrderControl,
} from '../../data/orgGroupAgents/index.js';
import { atomicWriteTrustedFile } from '../../security/trustedFile.js';
import { resolveAgentCwd, resolveAgentMountSubPath } from '../../workspace/resolver.js';
import {
  deriveOrgAgentSharedView,
  deriveOrgAgentTaskWorkspace,
  type OrgAgentTaskWorkspaceLayout,
} from '../orgAgentTaskWorkspace.js';
import {
  collectOrgAgentArtifactManifest,
  parseOrgAgentArtifactManifest,
  publishOrgAgentArtifacts,
  serializeOrgAgentArtifactManifest,
} from '../orgAgentArtifactPublisher.js';
import { runtimeRunController } from '../runController.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from '../runtimeIsolationEvidence.js';
import type { RunRecord, RunStatus } from '../runStore.js';
import {
  createEventStoreForSession,
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord } from '../sessionCatalog.js';
import type { BackgroundAgentRequest } from './backgroundTaskRuntime.js';
import { parseStoredResult, type StoredBackgroundResult } from './backgroundTaskFormatting.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import { markBackgroundTaskTerminal } from './backgroundTaskTerminal.js';
import {
  buildOrgAgentContinuation,
  buildPausedAttemptContext,
  verifyOrgAgentContinuationArtifacts,
} from './orgAgentContinuation.js';

export async function prepareOrgAgentBackgroundWork(input: {
  config: RawRuntimeRunDispatchConfig;
  context: ToolCallContext;
  request: BackgroundAgentRequest;
  parentRunId: string;
  toolCallId: string;
  taskId: string;
}): Promise<{ taskLayout?: OrgAgentTaskWorkspaceLayout; workOrder?: OrgAgentWorkOrder }> {
  const orgChannel = input.context.channelContext.orgAgentChannel;
  if (!orgChannel) return {};
  const agentRoot = resolveAgentCwd(
    input.config.agentCwd,
    orgChannel.agentPrincipal.tenantId,
    orgChannel.agentId,
  );
  const sharedReadOnlySubPath =
    input.context.workspace.mountSubPath ??
    (() => {
      throw new Error('组织群后台任务缺少 Agent workspace mount');
    })();
  const agentMountSubPath = resolveAgentMountSubPath(
    input.config.agentCwd,
    orgChannel.agentPrincipal.tenantId,
    orgChannel.agentId,
  );
  const sharedView = deriveOrgAgentSharedView({
    agentRoot,
    agentMountSubPath,
    bindingId: orgChannel.bindingId,
    workConversationId: orgChannel.workConversationId,
  });
  if (sharedView.mountSubPath !== sharedReadOnlySubPath)
    throw new Error('组织群后台任务 shared workspace 与话题身份不匹配');
  const taskLayout = deriveOrgAgentTaskWorkspace({
    agentWorkspaceId: orgChannel.agentPrincipal.workspaceId,
    agentRoot,
    agentMountSubPath,
    sharedReadOnlySubPath,
    taskId: input.taskId,
    attemptNo: 1,
  });
  await mkdir(join(taskLayout.taskRoot, 'artifacts'), { recursive: true });
  const bindingSnapshot =
    orgChannel.externalActor.kind === 'external_user'
      ? await input.config.orgGroupAgentStore?.getBindingById(
          orgChannel.agentPrincipal.tenantId,
          orgChannel.bindingId,
        )
      : undefined;
  if (
    orgChannel.externalActor.kind === 'external_user' &&
    (!bindingSnapshot || bindingSnapshot.revision !== orgChannel.policyRevision)
  ) {
    throw new Error('组织群后台任务无法固化当前群配置');
  }
  const workOrder =
    orgChannel.externalActor.kind === 'external_user'
      ? await input.config.orgGroupAgentStore?.createWorkOrder({
          tenantId: orgChannel.agentPrincipal.tenantId,
          agentId: orgChannel.agentId,
          bindingId: orgChannel.bindingId,
          workConversationId: orgChannel.workConversationId,
          idempotencyKey: `work-order:${input.parentRunId}:${input.toolCallId}`,
          title: input.request.description,
          visibility:
            orgChannel.taskVisibility === 'conversation' && orgChannel.externalActorAssurance === 'mapped'
              ? 'conversation' : 'requester_only',
          createdByActor: orgChannel.externalActor,
          policySnapshot: {
            revision: orgChannel.policyRevision,
            allowedToolNames: orgChannel.allowedToolNames,
            allowedSkillIds: orgChannel.allowedSkillIds,
            allowedSourceIds: orgChannel.allowedSourceIds,
            dwsResourceIds: orgChannel.dwsResourceIds,
            contextEnabled: orgChannel.contextEnabled,
            effectiveConfig: bindingSnapshot!.effectiveConfig,
          },
          cancelPolicy: {
            mode: orgChannel.taskVisibility === 'conversation' && orgChannel.externalActorAssurance === 'mapped'
              ? 'conversation' : 'creator_only',
          },
          workerType: input.request.agentType,
        })
      : undefined;
  if (!workOrder) throw new Error('组织群后台任务 WorkOrder store 不可用');
  return { taskLayout, workOrder };
}

export class OrgAgentBackgroundWorkCoordinator {
  constructor(private readonly config: RawRuntimeRunDispatchConfig) {}

  async markRunning(record: RunRecord): Promise<void> {
    const metadata = parseBackgroundTaskMetadata(record);
    if (!metadata?.workOrderId || !metadata.orgAgentChannel || !this.config.orgGroupAgentStore)
      return;
    const tenantId = metadata.orgAgentChannel.agentPrincipal.tenantId;
    const attempt = await this.config.orgGroupAgentStore.transitionWorkAttempt({
      tenantId,
      runtimeRunId: record.runId,
      status: 'running',
    });
    if (!attempt) {
      const work = await this.config.orgGroupAgentStore.getWorkOrder(
        tenantId,
        metadata.workOrderId,
      );
      const existingAttempt = (
        await this.config.orgGroupAgentStore.listWorkAttempts(tenantId, metadata.workOrderId)
      ).find((item) => item.runtimeRunId === record.runId);
      if (
        !work ||
        !existingAttempt ||
        existingAttempt.status !== 'running' ||
        existingAttempt.attemptNo !== work.currentAttemptNo ||
        work.state !== 'running'
      )
        throw new Error('ORG_AGENT_WORK_ATTEMPT_START_CONFLICT');
    }
  }

  async syncTerminal(
    record: RunRecord,
    state: 'completed' | 'failed' | 'cancelled',
    result: StoredBackgroundResult,
    failure?: string,
  ): Promise<void> {
    const metadata = parseBackgroundTaskMetadata(record);
    if (!metadata?.workOrderId || !metadata.orgAgentChannel || !this.config.orgGroupAgentStore)
      return;
    const tenantId = metadata.orgAgentChannel.agentPrincipal.tenantId;
    let manifest: Awaited<ReturnType<typeof collectOrgAgentArtifactManifest>> | undefined;
    let manifestFailure: string | undefined;
    try {
      manifest = await collectOrgAgentArtifactManifest(join(metadata.cwd, 'artifacts'));
      const checkpoint = { runtimeRunId: record.runId, status: state, finishedAt: record.updatedAt };
      await atomicWriteTrustedFile(metadata.cwd, 'checkpoint.json', JSON.stringify(checkpoint, null, 2));
      await atomicWriteTrustedFile(metadata.cwd, 'manifest.json', JSON.stringify(manifest, null, 2));
    } catch (error) {
      manifestFailure = error instanceof Error ? error.message : String(error);
    }
    const envelope: OrgAgentResultEnvelope = {
      status: state,
      summary: (result.text || result.errorMessage || failure || state).slice(0, 4_000),
      facts: [
        { key: 'runtimeRunId', value: record.runId },
        { key: 'status', value: state },
      ],
      artifacts: manifest?.files ?? [],
      writeScope: [metadata.cwd],
    };
    const transitionedAttempt = await this.config.orgGroupAgentStore.transitionWorkAttempt({
      tenantId,
      runtimeRunId: record.runId,
      status: state,
      resultEnvelope: envelope,
      checkpoint: {
        runtimeRunId: record.runId,
        status: state,
        finishedAt: record.updatedAt,
        ...(manifestFailure ? { artifactCaptureError: manifestFailure } : {}),
      },
      ...(manifest ? { artifactManifest: serializeOrgAgentArtifactManifest(manifest) } : {}),
      publishState: state === 'completed' && manifest ? 'pending' : 'rejected',
      ...(failure ? { failure } : {}),
    });
    const attempt = transitionedAttempt ?? (await this.config.orgGroupAgentStore.listWorkAttempts(
      tenantId, metadata.workOrderId,
    )).find(item => item.runtimeRunId === record.runId);
    if (!attempt || attempt.workOrderId !== metadata.workOrderId) return;
    if (attempt.status !== state) throw new Error('ORG_AGENT_WORK_ATTEMPT_TERMINAL_CONFLICT');
    const work = await this.config.orgGroupAgentStore.getWorkOrder(tenantId, metadata.workOrderId);
    if (!work) throw new Error('ORG_AGENT_WORK_ORDER_MISSING');
    if (attempt.attemptNo !== work.currentAttemptNo) return;
    if (isWorkTerminal(work.state)) {
      if (work.state !== state) throw new Error('ORG_AGENT_WORK_ORDER_TERMINAL_CONFLICT');
      return;
    }
    await this.config.orgGroupAgentStore.transitionWorkOrder({
      tenantId,
      workOrderId: work.workOrderId,
      expectedVersion: work.version,
      state,
      resultEnvelope: envelope,
    });
  }

  async publish(
    tenantId: string,
    workOrderId: string,
    expectedVersion: number,
  ): Promise<import('../../data/orgGroupAgents/index.js').OrgAgentWorkAttempt> {
    const store = this.config.orgGroupAgentStore;
    if (!store) throw new Error('ORG_AGENT_WORK_ORDER_STORE_UNAVAILABLE');
    const work = await store.getWorkOrder(tenantId, workOrderId);
    if (!work) throw new Error('ORG_AGENT_WORK_ORDER_MISSING');
    if (work.version !== expectedVersion) throw new Error('ORG_AGENT_WORK_ORDER_VERSION_CONFLICT');
    if (work.state !== 'completed') throw new Error('ORG_AGENT_ARTIFACT_WORK_NOT_COMPLETED');
    const attempt = (await store.listWorkAttempts(tenantId, workOrderId))
      .find(item => item.attemptNo === work.currentAttemptNo);
    if (!attempt || attempt.status !== 'completed')
      throw new Error('ORG_AGENT_ARTIFACT_ATTEMPT_NOT_COMPLETED');
    if (attempt.publishState === 'published') return attempt;
    if (attempt.publishState !== 'pending') throw new Error('ORG_AGENT_ARTIFACT_NOT_PUBLISHABLE');
    const [binding, conversation] = await Promise.all([
      store.getBindingById(tenantId, work.bindingId),
      store.getWorkConversation(tenantId, work.workConversationId),
    ]);
    if (!binding || binding.agentId !== work.agentId || !conversation
      || conversation.bindingId !== binding.bindingId)
      throw new Error('ORG_AGENT_ARTIFACT_SCOPE_INVALID');
    const agentRoot = resolveAgentCwd(this.config.agentCwd, tenantId, work.agentId);
    const agentMountSubPath = resolveAgentMountSubPath(
      this.config.agentCwd,
      tenantId,
      work.agentId,
    );
    const shared = deriveOrgAgentSharedView({
      agentRoot,
      agentMountSubPath,
      bindingId: binding.bindingId,
      workConversationId: conversation.workConversationId,
    });
    const expectedLayout = deriveOrgAgentTaskWorkspace({
      agentWorkspaceId: binding.workspaceId,
      agentRoot,
      agentMountSubPath,
      sharedReadOnlySubPath: attempt.sharedReadOnlySubPath,
      taskId: attempt.runtimeRunId,
      attemptNo: attempt.attemptNo,
    });
    if (shared.mountSubPath !== attempt.sharedReadOnlySubPath
      || attempt.mountSubPath !== expectedLayout.mountSubPath
      || attempt.attemptId !== expectedLayout.attemptId
      || attempt.taskWorkspaceId !== expectedLayout.taskWorkspaceId
      || attempt.sandboxScopeId !== expectedLayout.sandboxScopeId)
      throw new Error('ORG_AGENT_ARTIFACT_SCOPE_INVALID');
    const publishedRoot = `published/${work.workOrderId}/${attempt.attemptId}`;
    let publishedManifest: Awaited<ReturnType<typeof publishOrgAgentArtifacts>>;
    try {
      publishedManifest = await publishOrgAgentArtifacts({
        taskRoot: join(expectedLayout.taskRoot, 'artifacts'),
        stagingRoot: join(agentRoot, '.artifact-publish-staging'),
        sharedRoot: shared.root,
        publishedRoot,
        manifest: parseOrgAgentArtifactManifest(attempt.artifactManifest),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const state = code.includes('CONFLICT') || code.includes('INTEGRITY') ? 'conflict' : 'rejected';
      await store.transitionWorkAttemptPublishState({
        tenantId, attemptId: attempt.attemptId, expectedState: 'pending', state,
      }).catch(() => undefined);
      throw error;
    }
    try {
      return await store.transitionWorkAttemptPublishState({
        tenantId,
        attemptId: attempt.attemptId,
        expectedState: 'pending',
        state: 'published',
        artifactManifest: serializeOrgAgentArtifactManifest(publishedManifest),
      });
    } catch (error) {
      const current = (await store.listWorkAttempts(tenantId, workOrderId))
        .find(item => item.attemptId === attempt.attemptId);
      if (current?.publishState === 'published') return current;
      throw error;
    }
  }

  async cancel(
    tenantId: string,
    workOrderId: string,
    expectedVersion: number,
  ): Promise<RunRecord | null> {
    const store = this.config.orgGroupAgentStore;
    if (!store) throw new Error('ORG_AGENT_WORK_ORDER_STORE_UNAVAILABLE');
    const work = await store.getWorkOrder(tenantId, workOrderId);
    if (!work) return null;
    if (work.version !== expectedVersion) throw new Error('ORG_AGENT_WORK_ORDER_VERSION_CONFLICT');
    const attempt = (await store.listWorkAttempts(tenantId, workOrderId)).at(-1);
    const task = attempt ? await this.config.runStore?.get(attempt.runtimeRunId) : null;
    const message = '组织管理员取消任务';
    if (task && isRunTerminal(task.status)) {
      const state = task.status === 'completed'
        ? 'completed'
        : task.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
      const result = parseStoredResult(task.metadata.backgroundResult)
        ?? terminalResult(state, task.statusReason ?? state);
      await this.syncTerminal(task, state, result, task.statusReason);
      return task;
    }
    if (task && !isRunTerminal(task.status)) {
      const taskSession = await resolveSessionCatalog(this.config).get(task.sessionId);
      if (!taskSession) throw new Error(`后台任务 session 不存在：${task.sessionId}`);
      const updated = await markBackgroundTaskTerminal(
        this.config.runStore!,
        createEventStoreForSession(this.config, taskSession),
        task,
        'cancelled',
        message,
        {
          backgroundResult: failedResult('cancelled', message),
          wakeState: 'pending',
          backgroundFinishedAt: new Date().toISOString(),
        },
      );
      if (updated) {
        runtimeRunController.abort(task.runId);
        await resolveSessionCatalog(this.config)
          .markStatus(task.sessionId, 'error')
          .catch(() => undefined);
        await this.syncTerminal(updated, 'cancelled', failedResult('cancelled', message), message);
        return updated;
      }
      const settled = await this.config.runStore!.get(task.runId);
      if (settled && isRunTerminal(settled.status)) {
        const settledState = settled.status === 'completed'
          ? 'completed'
          : settled.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
        await this.syncTerminal(
          settled,
          settledState,
          parseStoredResult(settled.metadata.backgroundResult)
            ?? terminalResult(settledState, settled.statusReason ?? settledState),
          settled.statusReason,
        );
        return settled;
      }
      throw new Error('ORG_AGENT_WORK_ORDER_CANCEL_CONFLICT');
    }
    if (!isWorkTerminal(work.state)) {
      const envelope: OrgAgentResultEnvelope = {
        status: 'cancelled',
        summary: message,
        facts: [{ key: 'workOrderId', value: workOrderId }],
        artifacts: [],
        writeScope: [],
      };
      if (attempt)
        await store.transitionWorkAttempt({
          tenantId,
          runtimeRunId: attempt.runtimeRunId,
          status: 'cancelled',
          resultEnvelope: envelope,
          failure: message,
        });
      await store.transitionWorkOrder({
        tenantId,
        workOrderId,
        expectedVersion: work.version,
        state: 'cancelled',
        resultEnvelope: envelope,
      });
    }
    return task ?? null;
  }

  async retry(
    tenantId: string,
    workOrderId: string,
    expectedVersion: number,
    options: {
      allowPendingArtifacts?: boolean;
      control?: OrgAgentWorkOrderControl;
      supersedePendingCompletion?: boolean;
    } = {},
  ): Promise<RunRecord> {
    const store = this.config.orgGroupAgentStore;
    const runStore = this.config.runStore;
    if (!store || !runStore?.upsertPending)
      throw new Error('ORG_AGENT_WORK_ORDER_STORE_UNAVAILABLE');
    const work = await store.getWorkOrder(tenantId, workOrderId);
    if (!work) throw new Error('ORG_AGENT_WORK_ORDER_MISSING');
    const attempts = await store.listWorkAttempts(tenantId, workOrderId);
    const previousAttempt = attempts.at(-1);
    if (previousAttempt?.status === 'completed' && previousAttempt.publishState === 'pending'
      && options.allowPendingArtifacts !== true)
      throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_REQUIRED_BEFORE_RETRY');
    const previous = previousAttempt ? await runStore.get(previousAttempt.runtimeRunId) : null;
    const metadata = previous ? parseBackgroundTaskMetadata(previous) : null;
    if (!previous || !metadata || metadata.taskType !== 'agent' || !metadata.orgAgentChannel) {
      throw new Error('ORG_AGENT_WORK_ORDER_NOT_RETRYABLE');
    }
    if (!metadata.sharedReadOnlySubPath)
      throw new Error('ORG_AGENT_WORK_ORDER_SHARED_ROOT_MISSING');
    const earliestAttempt = attempts[0];
    const earliestRun =
      earliestAttempt?.runtimeRunId === previous.runId
        ? previous
        : earliestAttempt
          ? await runStore.get(earliestAttempt.runtimeRunId)
          : null;
    const earliestBasePrompt =
      earliestRun &&
      typeof earliestRun.metadata.basePrompt === 'string' &&
      earliestRun.metadata.basePrompt.length > 0
        ? earliestRun.metadata.basePrompt
        : undefined;
    const earliestPrompt =
      earliestRun &&
      typeof earliestRun.metadata.prompt === 'string' &&
      earliestRun.metadata.prompt.length > 0
        ? earliestRun.metadata.prompt
        : undefined;
    const basePrompt =
      earliestBasePrompt ?? earliestPrompt ?? metadata.basePrompt ?? metadata.prompt;
    const continuation = buildOrgAgentContinuation({
      work,
      attempt: previousAttempt,
      allowPendingArtifacts: options.allowPendingArtifacts === true,
    });
    const catalog = resolveSessionCatalog(this.config);
    const previousSession = await catalog.get(previous.sessionId);
    if (!previousSession) throw new Error('ORG_AGENT_WORK_ORDER_SESSION_MISSING');
    const binding = await store.getBindingById(tenantId, work.bindingId);
    const principal = metadata.orgAgentChannel.agentPrincipal;
    if (
      !binding ||
      binding.agentId !== work.agentId ||
      principal.tenantId !== tenantId ||
      principal.agentId !== work.agentId ||
      metadata.orgAgentChannel.bindingId !== work.bindingId ||
      principal.accountId !== binding.accountId ||
      principal.workspaceId !== binding.workspaceId ||
      previous.tenantId !== tenantId ||
      previousSession.tenantId !== tenantId ||
      previousSession.orgAgentId !== work.agentId ||
      !previousSession.orgAgentSnapshot ||
      previousSession.principal?.kind !== 'org_agent' ||
      previousSession.principal.tenantId !== tenantId ||
      previousSession.principal.agentId !== work.agentId ||
      previousSession.principal.accountId !== binding.accountId ||
      previousSession.principal.workspaceId !== binding.workspaceId
    ) {
      throw new Error('ORG_AGENT_WORK_ORDER_IDENTITY_MISMATCH');
    }
    const nextAttemptNo = work.currentAttemptNo + 1;
    const digest = createHash('sha256').update(`${workOrderId}:${nextAttemptNo}`).digest('hex');
    const taskId = `bg-retry-${digest.slice(0, 32)}`;
    const sessionId = `sub-bg-retry-${digest.slice(0, 32)}`;
    const agentRoot = resolveAgentCwd(this.config.agentCwd, tenantId, work.agentId);
    const agentMountSubPath = resolveAgentMountSubPath(
      this.config.agentCwd,
      tenantId,
      work.agentId,
    );
    const sharedView = deriveOrgAgentSharedView({
      agentRoot,
      agentMountSubPath,
      bindingId: work.bindingId,
      workConversationId: work.workConversationId,
    });
    if (sharedView.mountSubPath !== metadata.sharedReadOnlySubPath)
      throw new Error('ORG_AGENT_WORK_ORDER_SHARED_ROOT_MISMATCH');
    await verifyOrgAgentContinuationArtifacts({
      work,
      attempt: previousAttempt!,
      sharedRoot: sharedView.root,
    });
    const layout = deriveOrgAgentTaskWorkspace({
      agentWorkspaceId: metadata.orgAgentChannel.agentPrincipal.workspaceId,
      agentRoot,
      agentMountSubPath,
      sharedReadOnlySubPath: metadata.sharedReadOnlySubPath,
      taskId,
      attemptNo: nextAttemptNo,
    });
      await mkdir(join(layout.taskRoot, 'artifacts'), { recursive: true });
    const queuedWork = await store.queueWorkOrderAttempt({
      tenantId, workOrderId, expectedVersion,
      ...(options.control ? { control: options.control } : {}),
      ...(options.supersedePendingCompletion ? { supersedePendingCompletion: true } : {}),
    });
    try {
      await catalog.upsert(
        createRuntimeSessionRecord({
          sessionId,
          userId: previousSession.userId,
          username: previousSession.username,
          userRole: previousSession.userRole,
          tenantId,
          channel: previousSession.channel,
          cwd: layout.taskRoot,
          modelRef: previousSession.modelRef,
          sandboxProfile: previousSession.sandboxProfile,
          executionTarget: 'server-remote',
          workspaceId: layout.taskWorkspaceId,
          status: 'idle',
          kind: 'subagent',
          executionRole: 'worker',
          sandboxWorkloadDescriptor: previousSession.sandboxWorkloadDescriptor,
          ...(previousSession.orgAgentId ? { orgAgentId: previousSession.orgAgentId } : {}),
          ...(previousSession.orgAgentSnapshot
            ? { orgAgentSnapshot: previousSession.orgAgentSnapshot }
            : {}),
          ...(previousSession.principal ? { principal: previousSession.principal } : {}),
        }),
      );
      await store.createWorkAttempt({
        tenantId,
        workOrderId,
        runtimeRunId: taskId,
        attemptId: layout.attemptId,
        parentAttemptId: previousAttempt?.attemptId,
        taskWorkspaceId: layout.taskWorkspaceId,
        sandboxScopeId: layout.sandboxScopeId,
        mountSubPath: layout.mountSubPath,
        sharedReadOnlySubPath: layout.sharedReadOnlySubPath,
      });
      await runStore.upsertPending({
        runId: taskId,
        sessionId,
        userId: previous.userId,
        tenantId,
        model: previous.model,
        channel: 'background_task',
        executionTarget: 'server-remote',
        workspaceId: layout.taskWorkspaceId,
        sandboxScopeId: layout.sandboxScopeId,
        idempotencyKey: `work-order-retry:${workOrderId}:${nextAttemptNo}`,
        metadata: {
          ...previous.metadata,
          backgroundTaskReady: false,
          backgroundTaskVersion: 2,
          description: queuedWork.title,
          basePrompt,
          prompt: withWorkOrderContinuationPrompt(basePrompt, queuedWork, continuation.prompt),
          agentType: queuedWork.control.workerType,
          workOrderShortId: queuedWork.shortId,
          workOrderControlRevision: queuedWork.control.revision,
          workOrderId,
          attemptId: layout.attemptId,
          attemptNo: nextAttemptNo,
          ...(previousAttempt ? { parentAttemptId: previousAttempt.attemptId } : {}),
          continuationSource: continuation.metadata,
          cwd: layout.taskRoot,
          workspaceId: layout.taskWorkspaceId,
          mountSubPath: layout.mountSubPath,
          sandboxScopeId: layout.sandboxScopeId,
          sharedReadOnlySubPath: layout.sharedReadOnlySubPath,
          runtimeIsolationRequirement: {
            tenantId, taskId: workOrderId, runId: taskId, sessionId,
            workspaceId: layout.taskWorkspaceId, policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
          },
          wakeState: 'none',
          backgroundResult: null,
          backgroundFinishedAt: null,
          lifecycleFinishedAt: null,
        },
      });
      const activate = runStore.activateStagedOrgAgentBackgroundTask;
      if (!activate) throw new Error('ORG_AGENT_STAGED_ACTIVATION_UNAVAILABLE');
      const activated = await activate.call(runStore, taskId, 'background_agent_retry_started', {
        backgroundTaskReady: true, backgroundStartedAt: new Date().toISOString(),
      });
      if (!activated) throw new Error('ORG_AGENT_WORK_ORDER_RETRY_ACTIVATION_FAILED');
      return activated;
    } catch (error) {
      await this.failSetup(
        tenantId,
        workOrderId,
        taskId,
        layout.taskRoot,
        error,
        nextAttemptNo,
      );
      throw error;
    }
  }

  async pause(
    tenantId: string,
    workOrderId: string,
    expectedVersion: number,
  ): Promise<RunRecord | null> {
    const store = this.config.orgGroupAgentStore;
    const runStore = this.config.runStore;
    if (!store || !runStore) throw new Error('ORG_AGENT_WORK_ORDER_STORE_UNAVAILABLE');
    const work = await store.getWorkOrder(tenantId, workOrderId);
    if (!work) throw new Error('ORG_AGENT_WORK_ORDER_MISSING');
    const attempt = (await store.listWorkAttempts(tenantId, workOrderId))
      .find(item => item.attemptNo === work.currentAttemptNo);
    const task = attempt ? await runStore.get(attempt.runtimeRunId) : null;
    if (task && isRunTerminal(task.status)) {
      const state = task.status === 'completed' ? 'completed'
        : task.status === 'cancelled' ? 'cancelled' : 'failed';
      await this.syncTerminal(
        task, state,
        parseStoredResult(task.metadata.backgroundResult) ?? terminalResult(state, task.statusReason ?? state),
        task.statusReason,
      );
      throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_TERMINAL_RACE');
    }
    if (task && !isRunTerminal(task.status)) {
      const taskMetadata = parseBackgroundTaskMetadata(task);
      if (!taskMetadata?.workOrderId || taskMetadata.workOrderId !== workOrderId)
        throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_SCOPE_INVALID');
      const taskSession = await resolveSessionCatalog(this.config).get(task.sessionId);
      if (!taskSession) throw new Error(`后台任务 session 不存在：${task.sessionId}`);
      const stopped = await markBackgroundTaskTerminal(
        runStore,
        createEventStoreForSession(this.config, taskSession),
        task,
        'cancelled',
        '组织群任务已暂停',
        {
          backgroundResult: failedResult('cancelled', '组织群任务已暂停，恢复时会创建新 attempt'),
          wakeState: 'pending',
          backgroundFinishedAt: new Date().toISOString(),
          orgAgentAttemptSuperseded: true,
          orgAgentPauseAttemptNo: work.currentAttemptNo,
        },
      );
      if (!stopped) {
        const current = await runStore.get(task.runId);
        if (!current || current.status !== 'cancelled' || current.metadata.orgAgentAttemptSuperseded !== true)
          throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_RUN_CONFLICT');
      }
      const pausedContext = buildPausedAttemptContext(task.runId, taskMetadata.cwd);
      const pausedAttempt = await store.transitionWorkAttempt({
        tenantId,
        runtimeRunId: task.runId,
        status: 'cancelled',
        resultEnvelope: pausedContext.resultEnvelope,
        checkpoint: pausedContext.checkpoint,
        publishState: 'rejected',
        failure: 'superseded_by_work_order_pause',
      });
      if (!pausedAttempt || pausedAttempt.workOrderId !== workOrderId)
        throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_CHECKPOINT_FAILED');
      runtimeRunController.abort(task.runId);
      await resolveSessionCatalog(this.config).markStatus(task.sessionId, 'error').catch(() => undefined);
    }
    await store.pauseWorkOrder({ tenantId, workOrderId, expectedVersion });
    return task;
  }

  async reconcileSuperseded(record: RunRecord): Promise<boolean> {
    const metadata = parseBackgroundTaskMetadata(record);
    const store = this.config.orgGroupAgentStore;
    if (!store || !metadata?.workOrderId || !metadata.orgAgentChannel
      || record.metadata.orgAgentAttemptSuperseded !== true) return true;
    const tenantId = metadata.orgAgentChannel.agentPrincipal.tenantId;
    const [work, attempts] = await Promise.all([
      store.getWorkOrder(tenantId, metadata.workOrderId),
      store.listWorkAttempts(tenantId, metadata.workOrderId),
    ]);
    const attempt = attempts.find(item => item.runtimeRunId === record.runId);
    if (!work || !attempt || attempt.attemptNo !== work.currentAttemptNo) return true;
    if (work.state === 'paused' && attempt.status === 'cancelled') return true;
    if (['completed', 'failed', 'cancelled'].includes(work.state)) return true;
    if (record.status !== 'cancelled' || !['queued', 'running', 'waiting_input'].includes(work.state))
      return false;
    await store.pauseWorkOrder({ tenantId, workOrderId: work.workOrderId, expectedVersion: work.version });
    return true;
  }

  async failSetup(
    tenantId: string,
    workOrderId: string,
    taskId: string,
    taskRoot: string,
    error: unknown,
    expectedAttemptNo?: number,
  ): Promise<void> {
    const store = this.config.orgGroupAgentStore!;
    const message = error instanceof Error ? error.message : String(error);
    const envelope: OrgAgentResultEnvelope = {
      status: 'failed',
      summary: message,
      facts: [{ key: 'retrySetup', value: 'failed' }],
      artifacts: [],
      writeScope: [taskRoot],
    };
    const failedAttempt = await store.transitionWorkAttempt({
      tenantId,
      runtimeRunId: taskId,
      status: 'failed',
      resultEnvelope: envelope,
      failure: message,
    });
    const current = await store.getWorkOrder(tenantId, workOrderId);
    const ownsCurrentAttempt = expectedAttemptNo === undefined
      ? failedAttempt?.attemptNo === current?.currentAttemptNo
      : failedAttempt
        ? failedAttempt.attemptNo === expectedAttemptNo && current?.currentAttemptNo === expectedAttemptNo
        : current?.state === 'queued' && current.currentAttemptNo === expectedAttemptNo - 1;
    if (current && ownsCurrentAttempt && !isWorkTerminal(current.state))
      await store.transitionWorkOrder({
        tenantId,
        workOrderId,
        expectedVersion: current.version,
        state: 'failed',
        resultEnvelope: envelope,
      });
  }
}

function withWorkOrderContinuationPrompt(
  basePrompt: string,
  work: OrgAgentWorkOrder,
  previousAttemptPrompt: string,
): string {
  const controlPrompt = withWorkOrderControlPrompt(work);
  return `${basePrompt}\n\n${previousAttemptPrompt}${controlPrompt}`;
}

function withWorkOrderControlPrompt(work: OrgAgentWorkOrder): string {
  if (work.control.supplements.length === 0) return '';
  const additions = work.control.supplements
    .map(
      (item, index) =>
        `${index + 1}. [${item.kind === 'review' ? '复核要求' : '补充要求'}] ${item.text}`,
    )
    .join('\n');
  return `\n\n<work-order-continuation revision="${work.control.revision}">\n${additions}\n</work-order-continuation>`;
}

export function isOrgTaskVisible(task: RunRecord, context: ToolCallContext): boolean {
  const caller = context.channelContext.orgAgentChannel;
  const owner = parseBackgroundTaskMetadata(task)?.orgAgentChannel;
  if (!caller && !owner) return true;
  if (
    !caller ||
    !owner ||
    caller.agentPrincipal.tenantId !== owner.agentPrincipal.tenantId ||
    caller.agentId !== owner.agentId ||
    caller.bindingId !== owner.bindingId ||
    caller.workConversationId !== owner.workConversationId
  )
    return false;
  const creator = owner.externalActor;
  if (creator.kind !== 'external_user') return false;
  const visibility = typeof task.metadata.visibility === 'string'
    ? task.metadata.visibility
    : owner.taskVisibility;
  if (owner.externalActorAssurance === 'mapped' && visibility === 'conversation') {
    return (
      caller.externalActor.kind === 'external_user' && caller.externalActorAssurance === 'mapped'
    );
  }
  return (
    caller.externalActor.kind === 'external_user' &&
    caller.externalActor.provider === creator.provider &&
    caller.externalActor.corpId === creator.corpId &&
    caller.externalActor.openId === creator.openId
  );
}

function failedResult(status: 'failed' | 'cancelled', message: string): StoredBackgroundResult {
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

function terminalResult(
  status: 'completed' | 'failed' | 'cancelled',
  message: string,
): StoredBackgroundResult {
  return {
    status,
    text: status === 'completed' ? message : '',
    ...(status === 'completed' ? {} : { errorMessage: message }),
    totalTokens: 0,
    toolUseCount: 0,
    turnCount: 0,
    durationMs: 0,
  };
}

function isRunTerminal(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned'
  );
}

function isWorkTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
