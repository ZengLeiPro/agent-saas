import type { ParsedTranscript, TranscriptBlock } from "./parse.js";
import type { EventStore, PlatformEvent } from "../../runtime/types.js";

interface ActivityDurations {
  thinkingDurations: number[];
  toolDurationById: Map<string, number>;
}

function toTimestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDurationEvent(event: PlatformEvent): boolean {
  return (
    event.type === "assistant_thinking"
    || event.type === "assistant_stream_event"
    || event.type === "tool_invocation_completed"
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
    return (await eventStore.list(sessionId)).filter(isDurationEvent);
  }

  const [thinkingEvents, streamEvents, toolCompletionEvents] = await Promise.all([
    listEventsByType(eventStore, sessionId, "assistant_thinking"),
    // 存量 fallback：2026-07-03 前的历史数据无 durationMs，靠 delta start/end 配对
    listEventsByType(eventStore, sessionId, "assistant_stream_event"),
    listEventsByType(eventStore, sessionId, "tool_invocation_completed"),
  ]);
  return [...thinkingEvents, ...streamEvents, ...toolCompletionEvents].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}

export function buildActivityDurationsFromEvents(
  events: PlatformEvent[],
  sessionId: string,
): ActivityDurations {
  const thinkingDurations: number[] = [];
  const toolDurationById = new Map<string, number>();
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

    if (event.type === "tool_invocation_completed" && isValidDuration(event.durationMs)) {
      toolDurationById.set(event.toolCallId, event.durationMs);
    }
  }

  return { thinkingDurations, toolDurationById };
}

export function enrichTranscriptActivityDurations(
  parsed: ParsedTranscript,
  events: PlatformEvent[],
  sessionId: string,
): ParsedTranscript {
  if (!parsed.blocks.some((block) => block.kind === "thinking" || block.kind === "tool_use")) {
    return parsed;
  }

  const durations = buildActivityDurationsFromEvents(events, sessionId);
  if (durations.thinkingDurations.length === 0 && durations.toolDurationById.size === 0) {
    return parsed;
  }

  let changed = false;
  let thinkingIndex = 0;
  const blocks = parsed.blocks.map((block): TranscriptBlock => {
    if (block.kind === "thinking") {
      const durationMs = durations.thinkingDurations[thinkingIndex++];
      if (isValidDuration(durationMs) && block.durationMs !== durationMs) {
        changed = true;
        return { ...block, durationMs };
      }
      return block;
    }

    if (block.kind === "tool_use" && block.toolId) {
      const durationMs = durations.toolDurationById.get(block.toolId);
      if (isValidDuration(durationMs) && block.durationMs !== durationMs) {
        changed = true;
        return { ...block, durationMs };
      }
    }

    return block;
  });

  return changed ? { ...parsed, blocks } : parsed;
}
