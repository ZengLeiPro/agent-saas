import { describe, expect, it } from "vitest";

import { businessStepMainItems } from "./BusinessStepTimeline";
import type { RenderItem } from "./types";

const plan = {
  type: "business_step",
  id: "plan-1",
  anchorMessageId: "todo-1",
  kind: "plan",
  todos: [],
} as RenderItem;

const start = {
  type: "business_step",
  id: "start-1",
  anchorMessageId: "todo-1",
  kind: "start",
} as Extract<RenderItem, { type: "business_step" }>;

describe("businessStepMainItems 主区投影", () => {
  it("主区隐藏步骤过程，但保留真实人工门禁与排队中的用户插话", () => {
    const queuedUser = { id: "queued-user", type: "user", content: "补充一条", status: "queued" } as RenderItem;
    const permission = {
      id: "permission",
      type: "permission_request",
      interactionId: "interaction-1",
      toolName: "Write",
      toolInput: "{}",
      status: "pending",
    } as RenderItem;
    const processText = { id: "process", type: "text", content: "处理中" } as RenderItem;
    const outsideText = { id: "outside", type: "text", content: "最终回复" } as RenderItem;
    const section = {
      type: "business_step_section",
      id: "section-1",
      start,
      items: [processText, queuedUser, permission],
      isActive: true,
    } as RenderItem;

    expect(businessStepMainItems([plan, section, outsideText]).map((item) => item.id)).toEqual([
      "plan-1",
      "queued-user",
      "permission",
      "outside",
    ]);
  });
});
