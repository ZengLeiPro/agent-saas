import { randomUUID } from 'node:crypto';

import { readSessionMeta } from '../../data/transcripts/meta.js';
import {
  createEventStoreForSession,
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import type { RuntimeSessionRecord } from '../sessionCatalog.js';
import { deliverDwsBackgroundCompletion } from './backgroundTaskDwsCompletion.js';
import { buildTaskNotification, parseStoredResult } from './backgroundTaskFormatting.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import type { OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';

const WAKE_CLAIM_STALE_MS = 60_000;
const WAKE_BATCH_SIZE = 50;

type ParentLifecycleEvent = Parameters<ReturnType<typeof createEventStoreForSession>['append']>[0];

export async function reconcileBackgroundWakeDeliveries(
  config: RawRuntimeRunDispatchConfig,
  orgWork: OrgAgentBackgroundWorkCoordinator,
  appendParentLifecycleEvent: (
    parentSession: RuntimeSessionRecord,
    tenantId: string | undefined,
    event: ParentLifecycleEvent,
  ) => Promise<void>,
): Promise<void> {
  const runStore = config.runStore;
  if (
    !runStore?.listPendingBackgroundTaskWakes ||
    !runStore.claimBackgroundTaskWake ||
    !runStore.finishBackgroundTaskWake
  )
    return;
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
    if (task.metadata.orgAgentAttemptSuperseded === true) {
      const reconciled = await orgWork.reconcileSuperseded(task).catch(() => false);
      await runStore.finishBackgroundTaskWake(
        task.runId,
        claimToken,
        reconciled ? 'discarded' : 'pending',
        {
          wakeDiscardReason: reconciled ? 'org_agent_attempt_superseded' : null,
          wakeDeferredReason: reconciled ? null : 'org_agent_pause_reconcile_pending',
        },
      );
      continue;
    }
    const storedResult = parseStoredResult(task.metadata.backgroundResult);
    const fallbackStatus =
      task.status === 'cancelled'
        ? 'cancelled'
        : task.status === 'completed'
          ? 'completed'
          : 'failed';
    if (storedResult)
      await orgWork.syncTerminal(task, fallbackStatus, storedResult, storedResult.errorMessage);
    if (await deliverDwsBackgroundCompletion({ config, runStore, task, metadata, claimToken }))
      continue;

    const parentSession = await resolveSessionCatalog(config).get(metadata.parentSessionId);
    const parentMeta = parentSession ? await readSessionMeta(parentSession.transcriptPath) : null;
    if (!parentSession || parentMeta?.deletedAt) {
      await runStore.finishBackgroundTaskWake(task.runId, claimToken, 'discarded', {
        wakeDiscardReason: parentMeta?.deletedAt
          ? 'parent_session_deleted'
          : 'parent_session_missing',
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
    if (typeof task.metadata.lifecycleFinishedAt !== 'string') {
      await appendParentLifecycleEvent(parentSession, task.tenantId, {
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
        ...(storedResult?.failureKind ? { failureKind: storedResult.failureKind } : {}),
        ...(storedResult?.recoveryAction ? { recoveryAction: storedResult.recoveryAction } : {}),
        ...(storedResult?.text ? { resultPreview: storedResult.text.slice(0, 2_000) } : {}),
      });
      await runStore.markStatus(task.runId, task.status, task.statusReason, {
        lifecycleFinishedAt: new Date().toISOString(),
      });
    }

    const wakeRunId = `bg-wake-${task.runId}`;
    const sandboxScopeId = metadata.sandboxScopeId ?? task.sandboxScopeId;
    const topLevelSessionId = metadata.topLevelSessionId ?? metadata.parentSessionId;
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
      sandboxScopeId,
      metadata: {
        backgroundTaskWake: true,
        topLevelSessionId,
        ...(sandboxScopeId ? { sandboxScopeId } : {}),
        dispatcherCompletion: metadata.executionMode === 'dispatcher',
        outputTransactionMode: metadata.parentOutputTransactionMode,
        backgroundTaskId: task.runId,
        wakeMessage: {
          channel: 'web',
          chatId: metadata.parentSessionId,
          content: buildTaskNotification(task, metadata),
          senderId: parentSession.userId,
          senderName: parentSession.username,
          metadata: { backgroundTaskWake: true, backgroundTaskId: task.runId, topLevelSessionId },
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
