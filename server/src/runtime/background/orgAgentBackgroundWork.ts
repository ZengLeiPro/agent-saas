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
  type OrgAgentWorkerTaskLineage,
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
import type { OrgAgentWorkerTaskAuthority } from '../orgAgentWorkerCapability.js';
import type { RunRecord, RunStatus } from '../runStore.js';
import {
  createEventStoreForSession,
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord } from '../sessionCatalog.js';
import type { BackgroundAgentRequest } from './backgroundTaskRuntime.js';
import {
  failedBackgroundResult as failedResult,
  parseStoredResult,
  terminalBackgroundResult as terminalResult,
  type StoredBackgroundResult,
} from './backgroundTaskFormatting.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import { markBackgroundTaskTerminal } from './backgroundTaskTerminal.js';
import { withWorkOrderContinuationPrompt } from './orgAgentContinuationPrompt.js';
import { controlCommandCompletionUnsettled, failPreparedOrgAgentControlCommand } from './orgAgentControlCommandSettlement.js';
import {
  buildOrgAgentContinuation,
  buildPausedAttemptContext,
  verifyOrgAgentContinuationArtifacts,
} from './orgAgentContinuation.js';
import {
  createOrgAgentEffectiveExecutionContext,
  parseOrgAgentEffectiveExecutionContext,
  type OrgAgentEffectiveExecutionContext,
} from './orgAgentExecutionContext.js';
import { stopPreparedOrgAgentAttempt } from './orgAgentPreparedAttempt.js';
import type { OrgAgentRecord } from '../../data/orgAgents/types.js';
import type { BoundAgentRuntimeProfile } from '../agentProfiles.js';

function snapshotNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : undefined;
}
function snapshotStrings(value: Record<string, unknown>, key: string): string[] {
  const candidate = value[key];
  if (!Array.isArray(candidate) || candidate.some(item => typeof item !== 'string' || !item.trim())) return [];
  const result = candidate.map(item => (item as string).trim());
  return new Set(result).size === result.length ? result : [];
}
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(value => b.includes(value));
}

export async function prepareOrgAgentBackgroundWork(input: {
  config: RawRuntimeRunDispatchConfig;
  context: ToolCallContext;
  request: BackgroundAgentRequest;
  parentRunId: string;
  toolCallId: string;
  taskId: string;
  agent: OrgAgentRecord;
  modelRef: string;
  profile?: BoundAgentRuntimeProfile;
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
            executionContext: createOrgAgentEffectiveExecutionContext({
              agent: input.agent,
              binding: bindingSnapshot!,
              channel: orgChannel,
              systemContext: input.context.channelContext.systemContext,
              modelRef: input.modelRef,
              profile: input.profile,
              goal: input.request.prompt,
              acceptance: [input.request.description, '产出须满足组织群任务结果与工件契约'],
            }),
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

  async markRunning(record: RunRecord): Promise<OrgAgentWorkerTaskLineage | undefined> {
    const metadata = parseBackgroundTaskMetadata(record);
    if (!metadata?.orgAgentChannel) return undefined;
    if (!metadata.workOrderId || !this.config.orgGroupAgentStore)
      throw new Error('ORG_AGENT_CONTEXT_LINEAGE_INCOMPLETE');
    const queuedLineage = await this.resolveTaskLineage(record, metadata, false);
    await this.loadExecutionContext(queuedLineage);
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
    return this.resolveTaskLineage(record, metadata, true);
  }

  createLiveTaskAuthority(
    lineage: OrgAgentWorkerTaskLineage,
    channel?: NonNullable<ToolCallContext['channelContext']['orgAgentChannel']>,
  ): OrgAgentWorkerTaskAuthority {
    const store = this.config.orgGroupAgentStore;
    if (!store) throw new Error('ORG_AGENT_CONTEXT_LINEAGE_STORE_UNAVAILABLE');
    return { taskRunId: lineage.taskRunId, taskSessionId: lineage.taskSessionId,
      attemptId: lineage.attemptId, assertCurrent: async (toolName?: string) => {
        if (!this.config.orgAgentChannelPolicyEvaluator
          || !this.config.authorizeOrgAgentRequesterLive
          || !this.config.resolveOrgAgentRequesterById)
          throw new Error('ORG_AGENT_WORKER_LIVE_AUTHORITY_DEPENDENCY_MISSING');
        const work = await store.getWorkOrder(lineage.tenantId, lineage.workOrderId);
        const attempt = (await store.listWorkAttempts(lineage.tenantId, lineage.workOrderId))
          .find(item => item.attemptNo === work?.currentAttemptNo);
        const binding = await store.getBindingById(lineage.tenantId, lineage.bindingId);
        const agent = this.config.orgAgentStore?.get(lineage.agentId);
        if (!work || !attempt || work.state !== 'running' || attempt.status !== 'running'
          || work.tenantId !== lineage.tenantId || work.agentId !== lineage.agentId
          || work.bindingId !== lineage.bindingId || work.workConversationId !== lineage.workConversationId
          || work.currentAttemptNo !== lineage.attemptNo || attempt.attemptNo !== lineage.attemptNo
          || attempt.attemptId !== lineage.attemptId || attempt.runtimeRunId !== lineage.taskRunId
          || attempt.taskWorkspaceId !== lineage.taskWorkspaceId
          || attempt.sandboxScopeId !== lineage.sandboxScopeId
          || !agent || !agent.enabled || agent.tenantId !== lineage.tenantId
          || !binding || !binding.enabled || binding.activationState !== 'active'
          || !binding.policy.enabled || binding.policy.liveDeny
          || binding.accountId !== lineage.accountId || binding.agentId !== lineage.agentId)
          throw new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_STALE');
        {
          const decision = await this.config.orgAgentChannelPolicyEvaluator({ tenantId: lineage.tenantId,
            bindingId: lineage.bindingId, accountId: lineage.accountId, agentId: lineage.agentId,
            conversationId: lineage.channelConversationId, toolName: toolName ?? 'OrgAgentWorker' });
          if (!decision.allowed) throw new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_REVOKED');
        }
        if (channel?.externalActor.kind === 'external_user' && channel.externalActor.mappedUserId) {
          const requester = this.config.resolveOrgAgentRequesterById(channel.externalActor.mappedUserId);
          if (!requester || requester.id !== channel.externalActor.mappedUserId
            || requester.tenantId !== lineage.tenantId)
            throw new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_REVOKED');
          const decision = await this.config.authorizeOrgAgentRequesterLive({ channel,
            requester });
          if (!decision.allowed) throw new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_REVOKED');
        } else throw new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_REVOKED');
      } };
  }

  async loadExecutionContext(
    lineage: OrgAgentWorkerTaskLineage,
  ): Promise<OrgAgentEffectiveExecutionContext> {
    const work = await this.config.orgGroupAgentStore?.getWorkOrder(lineage.tenantId, lineage.workOrderId);
    if (!work || work.currentAttemptNo !== lineage.attemptNo) {
      throw new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_STALE');
    }
    return parseOrgAgentEffectiveExecutionContext(work.policySnapshot);
  }

  private async resolveTaskLineage(record: RunRecord, metadata: NonNullable<ReturnType<typeof parseBackgroundTaskMetadata>>,
    requireRunning: boolean): Promise<OrgAgentWorkerTaskLineage> {
    const store = this.config.orgGroupAgentStore, channel = metadata.orgAgentChannel;
    if (!store || !channel || !metadata.workOrderId || !metadata.attemptId || !metadata.attemptNo
      || !metadata.sandboxScopeId || !metadata.sharedReadOnlySubPath || !metadata.runtimeIsolationRequirement)
      throw new Error('ORG_AGENT_CONTEXT_LINEAGE_INCOMPLETE');
    const tenantId = channel.agentPrincipal.tenantId, requirement = metadata.runtimeIsolationRequirement;
    if (record.tenantId !== tenantId || record.workspaceId !== metadata.workspaceId
      || requirement.tenantId !== tenantId || requirement.taskId !== metadata.workOrderId
      || requirement.runId !== record.runId || requirement.sessionId !== record.sessionId
      || requirement.workspaceId !== metadata.workspaceId
      || requirement.policyDigest !== RUNTIME_ISOLATION_POLICY_DIGEST)
      throw new Error('ORG_AGENT_CONTEXT_LINEAGE_RUNTIME_MISMATCH');
    const work = await store.getWorkOrder(tenantId, metadata.workOrderId);
    const attempt = (await store.listWorkAttempts(tenantId, metadata.workOrderId))
      .find(item => item.attemptNo === work?.currentAttemptNo);
    const validWork = requireRunning ? work?.state === 'running' : work?.state === 'queued' || work?.state === 'running';
    const validAttempt = requireRunning ? attempt?.status === 'running' : attempt?.status === 'queued' || attempt?.status === 'running';
    if (!work || !attempt || !validWork || !validAttempt || attempt.runtimeRunId !== record.runId
      || attempt.attemptId !== metadata.attemptId || attempt.attemptNo !== metadata.attemptNo
      || work.currentAttemptNo !== metadata.attemptNo || work.tenantId !== tenantId
      || work.agentId !== channel.agentId || work.bindingId !== channel.bindingId
      || work.workConversationId !== channel.workConversationId)
      throw new Error('ORG_AGENT_CONTEXT_LINEAGE_ATTEMPT_MISMATCH');
    const [binding, conversation] = await Promise.all([
      store.getBindingById(tenantId, work.bindingId), store.getWorkConversation(tenantId, work.workConversationId),
    ]);
    if (!binding || !conversation || binding.tenantId !== tenantId || binding.agentId !== work.agentId
      || binding.accountId !== channel.accountId || binding.workspaceId !== channel.agentPrincipal.workspaceId
      || binding.conversationSpaceId !== channel.conversationSpaceId
      || binding.conversationId !== channel.channelPrincipal.conversationId
      || conversation.tenantId !== tenantId || conversation.bindingId !== binding.bindingId
      || conversation.workConversationId !== work.workConversationId)
      throw new Error('ORG_AGENT_CONTEXT_LINEAGE_CHANNEL_MISMATCH');
    const policyRevision = snapshotNumber(work.policySnapshot, 'revision');
    const allowedSourceIds = snapshotStrings(work.policySnapshot, 'allowedSourceIds');
    if (policyRevision !== channel.policyRevision || !sameStrings(allowedSourceIds, channel.allowedSourceIds))
      throw new Error('ORG_AGENT_CONTEXT_LINEAGE_POLICY_MISMATCH');
    const agentRoot = resolveAgentCwd(this.config.agentCwd, tenantId, work.agentId);
    const agentMountSubPath = resolveAgentMountSubPath(this.config.agentCwd, tenantId, work.agentId);
    const shared = deriveOrgAgentSharedView({ agentRoot, agentMountSubPath,
      bindingId: binding.bindingId, workConversationId: conversation.workConversationId });
    const expected = deriveOrgAgentTaskWorkspace({ agentWorkspaceId: binding.workspaceId, agentRoot,
      agentMountSubPath, sharedReadOnlySubPath: attempt.sharedReadOnlySubPath,
      taskId: attempt.runtimeRunId, attemptNo: attempt.attemptNo });
    if (metadata.workspaceId !== expected.taskWorkspaceId || metadata.cwd !== expected.taskRoot
      || metadata.sandboxScopeId !== expected.sandboxScopeId || metadata.sharedReadOnlySubPath !== shared.mountSubPath
      || attempt.taskWorkspaceId !== expected.taskWorkspaceId || attempt.sandboxScopeId !== expected.sandboxScopeId
      || attempt.mountSubPath !== expected.mountSubPath || attempt.sharedReadOnlySubPath !== shared.mountSubPath
      || attempt.attemptId !== expected.attemptId)
      throw new Error('ORG_AGENT_CONTEXT_LINEAGE_WORKSPACE_MISMATCH');
    return { kind: 'org_agent_task', tenantId, agentId: work.agentId, accountId: binding.accountId,
      ownerWorkspaceId: binding.workspaceId, bindingId: binding.bindingId,
      conversationSpaceId: binding.conversationSpaceId, workConversationId: conversation.workConversationId,
      channelConversationId: binding.conversationId, policyRevision, workOrderId: work.workOrderId,
      taskRunId: record.runId, taskSessionId: record.sessionId, attemptId: attempt.attemptId,
      attemptNo: attempt.attemptNo, currentAttemptNo: work.currentAttemptNo,
      taskWorkspaceId: attempt.taskWorkspaceId, sandboxScopeId: attempt.sandboxScopeId, allowedSourceIds };
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
      supersedeActiveAttempt?: boolean;
      inboxReceipt?: import('../../data/orgGroupAgents/index.js').OrgAgentControlInboxReceipt;
    } = {},
  ): Promise<RunRecord> {
    const store = this.config.orgGroupAgentStore;
    const runStore = this.config.runStore;
    if (!store || !runStore?.upsertPending)
      throw new Error('ORG_AGENT_WORK_ORDER_STORE_UNAVAILABLE');
    const work = await store.getWorkOrder(tenantId, workOrderId);
    if (!work) throw new Error('ORG_AGENT_WORK_ORDER_MISSING');
    const attempts = await store.listWorkAttempts(tenantId, workOrderId);
    const command = options.inboxReceipt
      && work.control.command?.inboxId === options.inboxReceipt.inboxId
      && work.control.command.phase === 'prepared'
      ? work.control.command
      : undefined;
    const sourceAttemptNo = command?.sourceAttemptNo ?? work.currentAttemptNo;
    const previousAttempt = attempts.find(item => item.attemptNo === sourceAttemptNo);
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
    const nextAttemptNo = command?.targetAttemptNo ?? work.currentAttemptNo + 1;
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
    const queuedWork = command ? work : await store.queueWorkOrderAttempt({
      tenantId, workOrderId, expectedVersion,
      ...(options.control ? { control: options.control } : {}),
      ...(options.supersedePendingCompletion ? { supersedePendingCompletion: true } : {}),
      ...(options.supersedeActiveAttempt ? { supersedeActiveAttempt: true } : {}),
      ...(options.supersedeActiveAttempt ? {
        supersedeContext: buildPausedAttemptContext(previous.runId, metadata.cwd),
      } : {}),
      ...(options.inboxReceipt ? { controlLease: options.inboxReceipt } : {}),
    });
    let currentRun: RunRecord;
    try {
      if (options.supersedeActiveAttempt || (command && sourceAttemptNo < nextAttemptNo))
        await stopPreparedOrgAgentAttempt(this.config, tenantId, workOrderId, sourceAttemptNo);
      const continuationAttempt = (options.supersedeActiveAttempt || command)
        ? (await store.listWorkAttempts(tenantId, workOrderId))
          .find(item => item.attemptNo === sourceAttemptNo)
        : previousAttempt;
      const continuation = buildOrgAgentContinuation({
        work: queuedWork,
        attempt: continuationAttempt,
        allowPendingArtifacts: options.allowPendingArtifacts === true,
      });
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
      const loadedTarget = await runStore.get(taskId);
      const existingTarget = loadedTarget?.runId === taskId ? loadedTarget : null;
      const existingMetadata = existingTarget ? parseBackgroundTaskMetadata(existingTarget) : null;
      if (existingTarget && (
        existingMetadata?.workOrderId !== workOrderId
        || existingMetadata.attemptNo !== nextAttemptNo
        || existingMetadata.attemptId !== layout.attemptId
      )) throw new Error('ORG_AGENT_WORK_ORDER_RETRY_RUN_IDEMPOTENCY_CONFLICT');
      if (existingTarget?.metadata.backgroundTaskReady === true || (
        existingTarget && existingTarget.status !== 'pending'
      )) {
        currentRun = existingTarget;
      } else {
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
        const activeRun = activated ?? await runStore.get(taskId);
        if (!activeRun?.metadata.backgroundTaskReady)
          throw new Error('ORG_AGENT_WORK_ORDER_RETRY_ACTIVATION_FAILED');
        currentRun = activeRun;
      }
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.failSetup(tenantId, workOrderId, taskId, layout.taskRoot, error, nextAttemptNo);
      } catch (failedCleanup) { cleanupError = failedCleanup; }
      if (options.inboxReceipt)
        await failPreparedOrgAgentControlCommand({
          store, tenantId, workOrderId, inboxReceipt: options.inboxReceipt, operationError: cleanupError ?? error,
        });
      throw error;
    }
    if (options.inboxReceipt)
      await store.completeControlCommand({ tenantId, workOrderId, inboxReceipt: options.inboxReceipt }).catch(error => { throw controlCommandCompletionUnsettled(error); });
    return currentRun;
  }

  async pause(
    tenantId: string,
    workOrderId: string,
    expectedVersion: number,
    inboxReceipt?: import('../../data/orgGroupAgents/index.js').OrgAgentControlInboxReceipt,
  ): Promise<RunRecord | null> {
    const store = this.config.orgGroupAgentStore;
    const runStore = this.config.runStore;
    if (!store || !runStore) throw new Error('ORG_AGENT_WORK_ORDER_STORE_UNAVAILABLE');
    const work = await store.getWorkOrder(tenantId, workOrderId);
    if (!work) throw new Error('ORG_AGENT_WORK_ORDER_MISSING');
    const prepared = inboxReceipt
      && work.control.command?.inboxId === inboxReceipt.inboxId
      && work.control.command.action === 'pause'
      && work.control.command.phase === 'prepared'
      ? work.control.command
      : undefined;
    if (inboxReceipt && work.control.command?.inboxId === inboxReceipt.inboxId
      && work.control.command.phase === 'failed')
      throw new Error(work.control.command.error ?? 'ORG_AGENT_CONTROL_COMMAND_FAILED');
    const attempt = (await store.listWorkAttempts(tenantId, workOrderId))
      .find(item => item.attemptNo === (prepared?.sourceAttemptNo ?? work.currentAttemptNo));
    const task = attempt ? await runStore.get(attempt.runtimeRunId) : null;
    if (task && isRunTerminal(task.status)
      && !(prepared && task.status === 'cancelled'
        && task.metadata.orgAgentAttemptSuperseded === true)) {
      const state = task.status === 'completed' ? 'completed'
        : task.status === 'cancelled' ? 'cancelled' : 'failed';
      await this.syncTerminal(
        task, state,
        parseStoredResult(task.metadata.backgroundResult) ?? terminalResult(state, task.statusReason ?? state),
        task.statusReason,
      );
      throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_TERMINAL_RACE');
    }
    const taskMetadata = task && !isRunTerminal(task.status)
      ? parseBackgroundTaskMetadata(task)
      : null;
    if (task && !isRunTerminal(task.status)
      && (!taskMetadata?.workOrderId || taskMetadata.workOrderId !== workOrderId))
      throw new Error('ORG_AGENT_WORK_ORDER_PAUSE_SCOPE_INVALID');
    if (!prepared) {
      const control = inboxReceipt ? {
        ...work.control,
        command: {
          inboxId: inboxReceipt.inboxId,
          action: 'pause' as const,
          phase: 'prepared' as const,
          sourceAttemptNo: work.currentAttemptNo,
        },
      } : undefined;
      if (!inboxReceipt && task && !isRunTerminal(task.status))
        await stopPreparedOrgAgentAttempt(this.config, tenantId, workOrderId, work.currentAttemptNo);
      await store.pauseWorkOrder({
        tenantId, workOrderId, expectedVersion, ...(control ? { control } : {}),
        ...(task && taskMetadata
          ? { pauseContext: buildPausedAttemptContext(task.runId, taskMetadata.cwd) } : {}),
        ...(inboxReceipt ? { controlLease: inboxReceipt } : {}),
      });
    }
    if (inboxReceipt) {
      try {
        await stopPreparedOrgAgentAttempt(
          this.config, tenantId, workOrderId,
          prepared?.sourceAttemptNo ?? work.currentAttemptNo,
        );
      } catch (error) {
        await failPreparedOrgAgentControlCommand({
          store, tenantId, workOrderId, inboxReceipt, operationError: error,
        });
        throw error;
      }
      await store.completeControlCommand({ tenantId, workOrderId, inboxReceipt })
        .catch(error => { throw controlCommandCompletionUnsettled(error); });
    }
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

function isRunTerminal(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned'
  );
}

function isWorkTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
