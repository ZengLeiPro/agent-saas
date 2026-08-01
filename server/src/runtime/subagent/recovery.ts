import { buildRuntimeReplayState } from '../replay.js';
import type { RunStatus, RunStore } from '../runStore.js';
import type { SessionCatalog } from '../sessionCatalog.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../types.js';

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  'pending',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
]);

const RECOVERY_REASON = 'subagent_parent_recovered_after_interruption';

export interface ForegroundSubagentRecoveryOptions {
  eventStore: EventStore;
  runStore?: RunStore;
  sessionCatalog: SessionCatalog;
  parentSessionId: string;
  logger?: { warn(message: string): void };
}

/**
 * 会话锁已由当前 dispatch 独占后，对账崩溃前未闭合的前台 Agent 调用。
 *
 * 正常父 run 会在子 run 返回后依次写 subagent_finished、
 * tool_invocation_completed、tool_result。进程若在中间被 SIGKILL，新进程不能重放
 * 子 Agent（会造成双份执行/计费），但也不能继续把父会话阻塞到 zombie timeout。
 * 这里把残留子 run 终止为 orphaned，并补齐父调用的失败终态；RawAgentLoop 随后会
 * 基于 tool_invocation_completed 合成标准 tool_result，让父会话立即可继续。
 */
export async function reconcileInterruptedForegroundSubagents(
  options: ForegroundSubagentRecoveryOptions,
): Promise<number> {
  const events = await options.eventStore.list(options.parentSessionId);
  const replay = buildRuntimeReplayState(events, [], options.parentSessionId);
  let recovered = 0;

  for (const state of replay.unclosedToolCalls) {
    if (
      state.toolName !== 'Agent'
      || !state.invocationStarted
      || state.invocationCompleted
      || state.cancelRequested
    ) {
      continue;
    }

    const started = findSubagentStarted(events, state.runId, state.toolCallId);
    const finished = started
      ? events.some((event) => (
          event.type === 'subagent_finished'
          && event.runId === state.runId
          && event.toolCallId === state.toolCallId
          && event.childRunId === started.childRunId
        ))
      : false;
    const error = started
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
      await options.eventStore.appendBatch(terminalEvents);
    } else {
      for (const event of terminalEvents) await options.eventStore.append(event);
    }
    options.logger?.warn(
      `Recovered interrupted foreground Agent call ${state.toolCallId}`
      + `${started ? `; child=${started.childRunId} status=${childStatus ?? 'missing'}` : '; child link missing'}`,
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
