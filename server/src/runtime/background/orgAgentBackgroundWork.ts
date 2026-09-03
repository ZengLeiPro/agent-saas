import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import type { ToolCallContext } from '../../agent/toolRuntime.js';
import type { OrgAgentResultEnvelope, OrgAgentWorkOrder } from '../../data/orgGroupAgents/index.js';
import { resolveAgentCwd } from '../../workspace/resolver.js';
import {
  agentMountSubPathFromSharedView,
  deriveOrgAgentSharedView,
  deriveOrgAgentTaskWorkspace,
  type OrgAgentTaskWorkspaceLayout,
} from '../orgAgentTaskWorkspace.js';
import { runtimeRunController } from '../runController.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from '../runtimeIsolationEvidence.js';
import type { RunRecord, RunStatus } from '../runStore.js';
import {
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import { createRuntimeSessionRecord } from '../sessionCatalog.js';
import type { BackgroundAgentRequest } from './backgroundTaskRuntime.js';
import { type StoredBackgroundResult } from './backgroundTaskFormatting.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import { markBackgroundTaskTerminal } from './backgroundTaskTerminal.js';

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
  const agentMountSubPath = input.context.workspace.mountSubPath ?? (() => {
    throw new Error('组织群后台任务缺少 Agent workspace mount');
  })();
  const sharedView = deriveOrgAgentSharedView({
    agentRoot,
    agentMountSubPath,
    bindingId: orgChannel.bindingId,
    workConversationId: orgChannel.workConversationId,
  });
  const taskLayout = deriveOrgAgentTaskWorkspace({
    agentWorkspaceId: orgChannel.agentPrincipal.workspaceId,
    agentRoot,
    agentMountSubPath,
    sharedReadOnlySubPath: sharedView.mountSubPath,
    taskId: input.taskId,
    attemptNo: 1,
  });
  await mkdir(taskLayout.taskRoot, { recursive: true });
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
            contextEnabled: orgChannel.contextEnabled,
          },
          cancelPolicy: {
            mode: orgChannel.taskVisibility === 'conversation' && orgChannel.externalActorAssurance === 'mapped'
              ? 'conversation' : 'creator_only',
          },
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
      if (!work || work.state !== 'running')
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
    const envelope: OrgAgentResultEnvelope = {
      status: state,
      summary: (result.text || result.errorMessage || failure || state).slice(0, 4_000),
      facts: [
        { key: 'runtimeRunId', value: record.runId },
        { key: 'status', value: state },
      ],
      artifacts: [],
      writeScope: [metadata.cwd],
    };
    const transitionedAttempt = await this.config.orgGroupAgentStore.transitionWorkAttempt({
      tenantId,
      runtimeRunId: record.runId,
      status: state,
      resultEnvelope: envelope,
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
    if (task && !isRunTerminal(task.status)) {
      const updated = await markBackgroundTaskTerminal(
        this.config.runStore!,
        task.runId,
        'cancelled',
        message,
        {
          backgroundResult: failedResult('cancelled', message),
          wakeState: 'pending',
          backgroundFinishedAt: new Date().toISOString(),
        },
      );
      runtimeRunController.abort(task.runId);
      if (updated) {
        await resolveSessionCatalog(this.config)
          .markStatus(task.sessionId, 'error')
          .catch(() => undefined);
        await this.syncTerminal(updated, 'cancelled', failedResult('cancelled', message), message);
      }
      return updated ?? task;
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

  async retry(tenantId: string, workOrderId: string, expectedVersion: number): Promise<RunRecord> {
    const store = this.config.orgGroupAgentStore;
    const runStore = this.config.runStore;
    if (!store || !runStore?.upsertPending)
      throw new Error('ORG_AGENT_WORK_ORDER_STORE_UNAVAILABLE');
    const work = await store.getWorkOrder(tenantId, workOrderId);
    if (!work) throw new Error('ORG_AGENT_WORK_ORDER_MISSING');
    const previousAttempt = (await store.listWorkAttempts(tenantId, workOrderId)).at(-1);
    const previous = previousAttempt ? await runStore.get(previousAttempt.runtimeRunId) : null;
    const metadata = previous ? parseBackgroundTaskMetadata(previous) : null;
    if (!previous || !metadata || metadata.taskType !== 'agent' || !metadata.orgAgentChannel) {
      throw new Error('ORG_AGENT_WORK_ORDER_NOT_RETRYABLE');
    }
    if (!metadata.sharedReadOnlySubPath)
      throw new Error('ORG_AGENT_WORK_ORDER_SHARED_ROOT_MISSING');
    const catalog = resolveSessionCatalog(this.config);
    const previousSession = await catalog.get(previous.sessionId);
    if (!previousSession) throw new Error('ORG_AGENT_WORK_ORDER_SESSION_MISSING');
    const nextAttemptNo = work.currentAttemptNo + 1;
    const digest = createHash('sha256').update(`${workOrderId}:${nextAttemptNo}`).digest('hex');
    const taskId = `bg-retry-${digest.slice(0, 32)}`;
    const sessionId = `sub-bg-retry-${digest.slice(0, 32)}`;
    const layout = deriveOrgAgentTaskWorkspace({
      agentWorkspaceId: metadata.orgAgentChannel.agentPrincipal.workspaceId,
      agentRoot: resolveAgentCwd(this.config.agentCwd, tenantId, work.agentId),
      agentMountSubPath: agentMountSubPathFromSharedView(metadata.sharedReadOnlySubPath),
      sharedReadOnlySubPath: metadata.sharedReadOnlySubPath,
      taskId,
      attemptNo: nextAttemptNo,
    });
    await mkdir(layout.taskRoot, { recursive: true });
    await store.reopenWorkOrder({ tenantId, workOrderId, expectedVersion });
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
          workOrderId,
          attemptId: layout.attemptId,
          attemptNo: nextAttemptNo,
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
      const activated = await runStore.markStatus(taskId, 'pending', 'background_agent_retry_started', {
        backgroundTaskReady: true, backgroundStartedAt: new Date().toISOString(),
      });
      if (!activated) throw new Error('ORG_AGENT_WORK_ORDER_RETRY_ACTIVATION_FAILED');
      return activated;
    } catch (error) {
      await this.failSetup(tenantId, workOrderId, taskId, layout.taskRoot, error);
      throw error;
    }
  }

  async failSetup(
    tenantId: string,
    workOrderId: string,
    taskId: string,
    taskRoot: string,
    error: unknown,
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
    await store.transitionWorkAttempt({
      tenantId,
      runtimeRunId: taskId,
      status: 'failed',
      resultEnvelope: envelope,
      failure: message,
    });
    const current = await store.getWorkOrder(tenantId, workOrderId);
    if (current && !isWorkTerminal(current.state))
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

function isRunTerminal(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned'
  );
}

function isWorkTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
