import { describe, expect, it } from "vitest";
import { projectRuntimePlatformEvent } from "../channels/web/runtimeEventProjection.js";
import type { PlatformEvent } from "../runtime/types.js";

describe("runtimeEventProjection", () => {
  it("user_message 携带 sourceRunId，供前端阻止旧队列状态复活", () => {
    const event: Extract<PlatformEvent, { type: "user_message" }> = {
      id: "event-1",
      timestamp: "2026-08-11T14:00:00.000Z",
      type: "user_message",
      runId: "target-run",
      sessionId: "session-1",
      content: "插话内容",
      interjectionSourceRunId: "source-run",
      clientMsgId: "client-1",
    };

    const projection = projectRuntimePlatformEvent(event);

    expect(projection.events).toEqual([{
      type: "user_message",
      sessionId: "session-1",
      content: "插话内容",
      timestamp: Date.parse(event.timestamp),
      sourceRunId: "source-run",
      client_msg_id: "client-1",
    }]);
  });

  it("assistant_tool_calls 的通用工具块携带 runtime runId", () => {
    const event: Extract<PlatformEvent, { type: "assistant_tool_calls" }> = {
      id: "event-tool-1",
      timestamp: "2026-08-19T12:00:00.000Z",
      type: "assistant_tool_calls",
      sessionId: "session-tool-1",
      runId: "run-tool-1",
      content: "",
      toolCalls: [{ id: "todo-1", name: "TodoWrite", arguments: '{"todos":[]}' }],
    };

    expect(projectRuntimePlatformEvent(event).events[0]).toEqual({
      type: "block_start",
      blockType: "tool_use",
      toolId: "todo-1",
      toolName: "TodoWrite",
      runId: "run-tool-1",
    });
  });

  it("interaction_requested 投影为实时 ask_user 事件", () => {
    const event: Extract<PlatformEvent, { type: "interaction_requested" }> = {
      id: "event-ask-1",
      timestamp: "2026-08-18T08:00:00.000Z",
      type: "interaction_requested",
      sessionId: "session-ask-1",
      runId: "run-ask-1",
      toolCallId: "call-ask-1",
      interactionId: "interaction-ask-1",
      interactionType: "ask_user",
      userId: "user-1",
      toolName: "AskUserQuestion",
      questions: [{
        question: "继续吗？",
        header: "确认",
        options: [{ label: "继续", description: "继续执行" }],
        multiSelect: false,
      }],
    };

    expect(projectRuntimePlatformEvent(event).events).toEqual([{
      type: "ask_user",
      interactionId: "interaction-ask-1",
      runId: "run-ask-1",
      toolCallId: "call-ask-1",
      toolName: "AskUserQuestion",
      questions: event.questions,
    }]);
  });
});
