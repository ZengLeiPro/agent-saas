import type { ParsedTranscript, TranscriptBlock, TranscriptSubagentActivity } from "./parse.js";
import type { EventStore, PlatformEvent } from "../../runtime/types.js";

type ToolExecutionStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface ActivityMetadata {
  thinkingDurations: number[];
  toolDurationById: Map<string, number>;
  toolStatusById: Map<string, ToolExecutionStatus>;
  subagentByToolId: Map<string, TranscriptSubagentActivity>;
}

function toTimestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isActivityEvent(event: PlatformEvent): boolean {
  return (
    event.type === "assistant_thinking"
    || event.type === "assistant_stream_event"
    || event.type === "tool_invocation_started"
    || event.type === "tool_invocation_completed"
    || event.type === "run_state_changed"
    || event.type === "subagent_started"
    || event.type === "subagent_finished"
  );
}

async function listEventsByType(
  eventStore: EventStore,
  sessionId: string,
  type: PlatformEvent["type"],
): Promise<PlatformEvent[]> {
  if (!eventStore.listPage) {
    return (await eventStore.list(sessionId)).filter((event) => event.type === type);
  }

  const events: PlatformEvent[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await eventStore.listPage(sessionId, {
      type,
      limit: 500,
      afterCursor: cursor,
    });
    events.push(...page.events);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return events;
}

export async function listActivityDurationEvents(
  eventStore: EventStore,
  sessionId: string,
): Promise<PlatformEvent[]> {
  if (!eventStore.listPage) {
    return (await eventStore.list(sessionId)).filter(isActivityEvent);
  }

  const [thinkingEvents, streamEvents, toolStartEvents, toolCompletionEvents, runStateEvents, subagentStartEvents, subagentFinishEvents] = await Promise.all([
    listEventsByType(eventStore, sessionId, "assistant_thinking"),
    // 存量 fallback：2026-07-03 前的历史数据无 durationMs，靠 delta start/end 配对
    listEventsByType(eventStore, sessionId, "assistant_stream_event"),
    listEventsByType(eventStore, sessionId, "tool_invocation_started"),
    listEventsByType(eventStore, sessionId, "tool_invocation_completed"),
    listEventsByType(eventStore, sessionId, "run_state_changed"),
    listEventsByType(eventStore, sessionId, "subagent_started"),
    listEventsByType(eventStore, sessionId, "subagent_finished"),
  ]);
  return [...thinkingEvents, ...streamEvents, ...toolStartEvents, ...toolCompletionEvents, ...runStateEvents, ...subagentStartEvents, ...subagentFinishEvents].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}

export function buildActivityMetadataFromEvents(
  events: PlatformEvent[],
  sessionId: string,
): ActivityMetadata {
  const thinkingDurations: number[] = [];
  const toolDurationById = new Map<string, number>();
  const toolStatusById = new Map<string, ToolExecutionStatus>();
  const subagentByToolId = new Map<string, TranscriptSubagentActivity>();
  const toolRunById = new Map<string, string>();
  const runStatusById = new Map<string, string>();
  let thinkingStartedAt: number | undefined;

  for (const event of events) {
    if ("sessionId" in event && event.sessionId !== sessionId) continue;

    // 新路径（2026-07-03+）：assistant_thinking 聚合行直接携带本轮 thinking 总时长。
    // 旧数据的聚合行无 durationMs，不会双计——那些轮由下方 delta 配对产出。
    if (event.type === "assistant_thinking") {
      if (isValidDuration(event.durationMs)) {
        thinkingDurations.push(event.durationMs);
      }
      continue;
    }

    if (event.type === "assistant_stream_event" && event.blockType === "thinking") {
      const tsMs = toTimestampMs(event.timestamp);
      if (tsMs === undefined) continue;

      if (event.phase === "start") {
        thinkingStartedAt = tsMs;
      } else if (event.phase === "end" && thinkingStartedAt !== undefined) {
        thinkingDurations.push(Math.max(0, tsMs - thinkingStartedAt));
        thinkingStartedAt = undefined;
      }
      continue;
    }

    if (event.type === "tool_invocation_started") {
      toolRunById.set(event.toolCallId, event.runId);
      toolStatusById.set(event.toolCallId, "running");
      continue;
    }

    if (event.type === "subagent_started") {
      subagentByToolId.set(event.toolCallId, {
        agentType: event.agentType,
        description: event.description,
        childSessionId: event.childSessionId,
        childRunId: event.childRunId,
        model: event.model,
        status: "running",
      });
      continue;
    }

    if (event.type === "subagent_finished") {
      subagentByToolId.set(event.toolCallId, {
        agentType: event.agentType,
        description: event.description,
        childSessionId: event.childSessionId,
        childRunId: event.childRunId,
        ...(event.model ? { model: event.model } : {}),
        status: event.status,
        durationMs: event.durationMs,
        totalTokens: event.totalTokens,
        toolUseCount: event.toolUseCount,
        turnCount: event.turnCount,
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        ...(event.resultPreview ? { resultPreview: event.resultPreview } : {}),
      });
      continue;
    }

    if (event.type === "tool_invocation_completed") {
      toolRunById.set(event.toolCallId, event.runId);
      toolStatusById.set(
        event.toolCallId,
        event.status === "success"
          ? "completed"
          : event.status === "cancelled"
            ? "cancelled"
            : "failed",
      );
      if (isValidDuration(event.durationMs)) {
        toolDurationById.set(event.toolCallId, event.durationMs);
      }
      continue;
    }

    if (event.type === "run_state_changed") {
      runStatusById.set(event.runId, event.status);
    }
  }

  // 工具 start 后若进程在 completed 事件前终止，不能在刷新后永久显示“执行中”。
  for (const [toolCallId, status] of toolStatusById) {
    if (status !== "running") continue;
    const runId = toolRunById.get(toolCallId);
    const runStatus = runId ? runStatusById.get(runId) : undefined;
    if (runStatus === "completed") toolStatusById.set(toolCallId, "completed");
    else if (runStatus === "cancelled") toolStatusById.set(toolCallId, "cancelled");
    else if (runStatus === "failed" || runStatus === "orphaned") toolStatusById.set(toolCallId, "failed");
  }

  return { thinkingDurations, toolDurationById, toolStatusById, subagentByToolId };
}

export function enrichTranscriptActivityDurations(
  parsed: ParsedTranscript,
  events: PlatformEvent[],
  sessionId: string,
): ParsedTranscript {
  if (!parsed.blocks.some((block) => block.kind === "thinking" || block.kind === "tool_use")) {
    return parsed;
  }

  const metadata = buildActivityMetadataFromEvents(events, sessionId);
  if (
    metadata.thinkingDurations.length === 0
    && metadata.toolDurationById.size === 0
    && metadata.toolStatusById.size === 0
    && metadata.subagentByToolId.size === 0
  ) {
    return parsed;
  }

  let changed = false;
  let thinkingIndex = 0;
  const blocks = parsed.blocks.map((block): TranscriptBlock => {
    if (block.kind === "thinking") {
      const durationMs = metadata.thinkingDurations[thinkingIndex++];
      if (isValidDuration(durationMs) && block.durationMs !== durationMs) {
        changed = true;
        return { ...block, durationMs };
      }
      return block;
    }

    if (block.kind === "tool_use" && block.toolId) {
      const durationMs = metadata.toolDurationById.get(block.toolId);
      const executionStatus = metadata.toolStatusById.get(block.toolId);
      const subagent = metadata.subagentByToolId.get(block.toolId);
      const durationChanged = isValidDuration(durationMs) && block.durationMs !== durationMs;
      const statusChanged = executionStatus !== undefined && block.executionStatus !== executionStatus;
      const subagentChanged = subagent !== undefined;
      if (!durationChanged && !statusChanged && !subagentChanged) return block;
      changed = true;
      return {
        ...block,
        ...(isValidDuration(durationMs) ? { durationMs } : {}),
        ...(executionStatus ? { executionStatus } : {}),
        ...(subagent ? { subagent } : {}),
      };
    }

    return block;
  });

  return changed ? { ...parsed, blocks } : parsed;
}
