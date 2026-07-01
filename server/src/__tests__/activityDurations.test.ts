import { describe, expect, it } from "vitest";

import {
  enrichTranscriptActivityDurations,
} from "../data/transcripts/activityDurations.js";
import type { ParsedTranscript } from "../data/transcripts/parse.js";
import type { PlatformEvent } from "../runtime/types.js";
import { mapSessionDetailToMessages } from "../../../shared/src/lib/sessionsApi.js";
import type { ApiSessionDetail } from "../../../shared/src/types/session.js";

describe("transcript activity durations", () => {
  it("enriches thinking and tool blocks from runtime events", () => {
    const parsed: ParsedTranscript = {
      sessionId: "session-1",
      blocks: [
        {
          id: "thinking-1",
          kind: "thinking",
          title: "思考",
          defaultOpen: true,
          content: "先看代码。",
        },
        {
          id: "tool-1",
          kind: "tool_use",
          title: "工具调用: Shell",
          defaultOpen: false,
          content: "{\"cmd\":\"pnpm test\"}",
          toolName: "Shell",
          toolId: "call-shell",
        },
      ],
      stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
    };
    const events: PlatformEvent[] = [
      {
        id: "e-other-start",
        timestamp: "2026-07-01T14:00:00.000Z",
        type: "assistant_stream_event",
        runId: "run-other",
        sessionId: "other-session",
        blockType: "thinking",
        phase: "start",
      },
      {
        id: "e-thinking-start",
        timestamp: "2026-07-01T14:00:01.000Z",
        type: "assistant_stream_event",
        runId: "run-1",
        sessionId: "session-1",
        blockType: "thinking",
        phase: "start",
      },
      {
        id: "e-thinking-end",
        timestamp: "2026-07-01T14:00:02.750Z",
        type: "assistant_stream_event",
        runId: "run-1",
        sessionId: "session-1",
        blockType: "thinking",
        phase: "end",
      },
      {
        id: "e-tool-completed",
        timestamp: "2026-07-01T14:00:05.000Z",
        type: "tool_invocation_completed",
        runId: "run-1",
        sessionId: "session-1",
        invocationId: "run-1:call-shell",
        toolCallId: "call-shell",
        toolName: "Shell",
        status: "success",
        durationMs: 3210,
      },
    ];

    const enriched = enrichTranscriptActivityDurations(parsed, events, "session-1");

    expect(enriched.blocks[0]).toMatchObject({ kind: "thinking", durationMs: 1750 });
    expect(enriched.blocks[1]).toMatchObject({ kind: "tool_use", durationMs: 3210 });
  });

  it("preserves API block durations when mapping session details to messages", () => {
    const detail: ApiSessionDetail = {
      sessionId: "session-1",
      stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
      blocks: [
        {
          id: "thinking-1",
          kind: "thinking",
          title: "思考",
          defaultOpen: true,
          content: "先判断。",
          durationMs: 1200,
        },
        {
          id: "tool-1",
          kind: "tool_use",
          title: "工具调用: Read",
          defaultOpen: false,
          content: "{\"file_path\":\"README.md\"}",
          toolName: "Read",
          toolId: "call-read",
          durationMs: 850,
        },
      ],
    };

    const messages = mapSessionDetailToMessages(detail);

    expect(messages[0]).toMatchObject({ type: "thinking", durationMs: 1200 });
    expect(messages[1]).toMatchObject({ type: "tool_use", durationMs: 850 });
  });
});
