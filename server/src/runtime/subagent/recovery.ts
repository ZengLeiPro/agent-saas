import { buildRuntimeReplayState } from '../replay.js';
import type { RunStatus, RunStore } from '../runStore.js';
import type { SessionCatalog } from '../sessionCatalog.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../types.js';
import { loadRuntimeReplayEvents } from '../replayEventWindow.js';

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  'pending',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
]);

const RECOVERY_REASON = 'subagent_parent_recovered_after_interruption';

export interface ForegroundToolRecoveryOptions {
  eventStore: EventStore;
  runStore?: RunStore;
  sessionCatalog: SessionCatalog;
  parentSessionId: string;
  tenantId?: string;
  logger?: { warn(message: string): void };
}

/**
 * 会话锁已由当前 dispatch 独占后，对账崩溃前未闭合的前台工具调用。
 *
 * 进程若在工具执行中被 SIGKILL，新进程不能盲目重放（会造成双份副作用/计费），
 * 也不能继续把父会话阻塞到 zombie timeout。这里补齐失败终态；Agent 工具还会把
 * 残留 child run/session 一并收口。RawAgentLoop 随后基于
 * tool_invocation_completed 合成标准 tool_result，让父会话立即可继续。
 *
 * active run 的 pending approval / ask_user 没有开始真实执行，保留给既有恢复路径；
 * terminal run 遗留的 pending approval 已不可能恢复，自动拒绝，避免永久阻塞会话。
 */
export async function reconcileInterruptedForegroundToolCalls(
  options: ForegroundToolRecoveryOptions,
): Promise<number> {
  const parentSession = await options.sessionCatalog.get(options.parentSessionId);
  const requestedTenantId = options.tenantId?.trim();
  const catalogTenantId = parentSession?.tenantId?.trim();
  if (requestedTenantId && catalogTenantId && requestedTenantId !== catalogTenantId) {
    throw new Error(`Foreground tool recovery tenant mismatch for session ${options.parentSessionId}`);
  }
  const tenantId = requestedTenantId ?? catalogTenantId;
  if (!tenantId) {
    throw new Error(`Foreground tool recovery tenant is missing for session ${options.parentSessionId}`);
  }
  const eventContext = { tenantId };
  const events = (await loadRuntimeReplayEvents(
    options.eventStore,
    tenantId,
    options.parentSessionId,
  )).events;
  const replay = buildRuntimeReplayState(events, [], options.parentSessionId);
  let recovered = 0;

  for (const state of replay.unclosedToolCalls) {
    if (state.status === 'pending_approval' && options.runStore) {
      const sourceRun = await options.runStore.get(state.runId).catch(() => null);
      const approvalId = state.approvalRequest?.approvalId ?? state.approval?.id;
      if (sourceRun && !ACTIVE_RUN_STATUSES.has(sourceRun.status) && approvalId) {
        await options.eventStore.append({
          type: 'approval_resolved',
          runId: state.runId,
          sessionId: state.sessionId,
          approvalId,
          decision: 'rejected',
          message: `源 run 已终止（${sourceRun.status}），自动拒绝遗留审批`,
        }, eventContext);
        options.logger?.warn(`Rejected stale approval ${approvalId} from terminal run ${state.runId}`);
        recovered += 1;
        continue;
      }
    }
    if (
      !state.invocationStarted
      || state.invocationCompleted
      || state.cancelRequested
      || state.status === 'pending_approval'
      || (state.interactionRequest && !state.interactionResolution)
    ) {
      continue;
    }

    const started = state.toolName === 'Agent'
      ? findSubagentStarted(events, state.runId, state.toolCallId)
      : undefined;
    const finished = started
      ? events.some((event) => (
          event.type === 'subagent_finished'
          && event.runId === state.runId
          && event.toolCallId === state.toolCallId
          && event.childRunId === started.childRunId
        ))
      : false;
    const error = state.toolName !== 'Agent'
      ? `父 run 在 ${state.toolName} 执行完成前中断；本次工具调用未完成`
      : started
        ? '父 run 在子 Agent 提交结果前中断；本次工具调用未完成'
        : '父 run 在子 Agent 建立完成记录前中断；本次工具调用未完成';

    let childStatus: RunStatus | undefined;
    if (started && !finished) {
      const child = await options.runStore?.get(started.childRunId).catch(() => null);
      childStatus = child?.status;
      if (child && ACTIVE_RUN_STATUSES.has(child.status)) {
        await options.runStore?.markStatus(started.childRunId, 'orphaned', RECOVERY_REASON, {
          recoveredByParentSessionId: options.parentSessionId,
          recoveredByParentRunId: state.runId,
          recoveredByParentToolCallId: state.toolCallId,
        }).catch((err) => {
          options.logger?.warn(
            `Failed to orphan interrupted subagent run ${started.childRunId}: ${errorMessage(err)}`,
          );
        });
        childStatus = 'orphaned';
      }
      await options.sessionCatalog.markStatus(started.childSessionId, childStatus === 'completed' ? 'finished' : 'error')
        .catch((err) => {
          options.logger?.warn(
            `Failed to close interrupted subagent session ${started.childSessionId}: ${errorMessage(err)}`,
          );
        });
    }

    const terminalEvents: PlatformEventInput[] = [];
    if (started && !finished) {
      terminalEvents.push({
        type: 'subagent_finished',
        runId: state.runId,
        sessionId: state.sessionId,
        toolCallId: state.toolCallId,
        agentType: started.agentType,
        description: started.description,
        childSessionId: started.childSessionId,
        childRunId: started.childRunId,
        model: started.model,
        status: childStatus === 'completed' || childStatus === 'failed' ? 'failed' : 'cancelled',
        totalTokens: 0,
        toolUseCount: 0,
        turnCount: 0,
        durationMs: elapsedMs(started.timestamp),
        errorMessage: error,
      });
    }
    terminalEvents.push({
      type: 'tool_invocation_completed',
      runId: state.runId,
      sessionId: state.sessionId,
      invocationId: state.invocationStarted.invocationId,
      toolCallId: state.toolCallId,
      toolName: state.toolName,
      status: 'cancelled',
      durationMs: elapsedMs(state.invocationStarted.timestamp),
      error,
    });

    if (options.eventStore.appendBatch) {
      await options.eventStore.appendBatch(terminalEvents, eventContext);
    } else {
      for (const event of terminalEvents) await options.eventStore.append(event, eventContext);
    }
    options.logger?.warn(
      `Recovered interrupted foreground ${state.toolName} call ${state.toolCallId}`
      + (started
        ? `; child=${started.childRunId} status=${childStatus ?? 'missing'}`
        : state.toolName === 'Agent' ? '; child link missing' : ''),
    );
    recovered += 1;
  }

  return recovered;
}

function findSubagentStarted(
  events: PlatformEvent[],
  parentRunId: string,
  toolCallId: string,
): Extract<PlatformEvent, { type: 'subagent_started' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type === 'subagent_started'
      && event.runId === parentRunId
      && event.toolCallId === toolCallId
    ) {
      return event;
    }
  }
  return undefined;
}

function elapsedMs(timestamp: string): number {
  const startedAt = Date.parse(timestamp);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
