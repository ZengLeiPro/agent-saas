import { describe, expect, it } from "vitest";
import { projectRuntimePlatformEvent } from "../channels/web/runtimeEventProjection.js";
import type { PlatformEvent } from "../runtime/types.js";

describe("runtimeEventProjection 插话投影", () => {
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
});
