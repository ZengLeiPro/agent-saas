import { describe, expect, it } from "vitest";

import {
  extractLatestTodos,
  projectBusinessStepEvents,
} from "./extractTodos";
import type { MessageItem } from "../types/message";

function user(id: string): MessageItem {
  return { id, type: "user", content: "next task" };
}

function todo(id: string, toolInput: string): MessageItem {
  return {
    id,
    type: "tool_use",
    toolName: "TodoWrite",
    toolId: id,
    toolInput,
  };
}

function todos(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ todos: items });
}

function step(id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: "business", content: `步骤 ${id}`, status, ...extra };
}

describe("extractLatestTodos", () => {
  it("returns the latest complete TodoWrite snapshot", () => {
    const result = extractLatestTodos([
      todo("old", todos([{ content: "旧任务", status: "pending" }])),
      todo("new", todos([
        { content: "读取代码", status: "completed" },
        { content: "接入面板", status: "in_progress", activeForm: "正在接入面板" },
      ])),
    ]);

    expect(result).toEqual([
      { content: "读取代码", status: "completed" },
      { content: "接入面板", status: "in_progress", activeForm: "正在接入面板" },
    ]);
  });

  it("falls back to the previous complete snapshot while streaming JSON is incomplete", () => {
    const result = extractLatestTodos([
      todo("complete", todos([{ content: "读取代码", status: "in_progress" }])),
      todo("streaming", "{\"todos\":[{\"content\":\"新"),
    ]);

    expect(result).toEqual([{ content: "读取代码", status: "in_progress" }]);
  });

  it("hides the panel when TodoWrite explicitly writes an empty list", () => {
    const result = extractLatestTodos([
      todo("old", todos([{ content: "旧任务", status: "pending" }])),
      todo("clear", JSON.stringify({ todos: [] })),
    ]);

    expect(result).toBeNull();
  });

  it("hides an all-completed snapshot after the user sends a new message", () => {
    const result = extractLatestTodos([
      todo("done", todos([{ content: "收尾", status: "completed" }])),
      user("user-2"),
    ]);

    expect(result).toBeNull();
  });

  it("keeps an unfinished snapshot after a later user message", () => {
    const result = extractLatestTodos([
      todo("active", todos([{ content: "继续处理", status: "in_progress" }])),
      user("user-2"),
    ]);

    expect(result).toEqual([{ content: "继续处理", status: "in_progress" }]);
  });

  it("ignores non-TodoWrite tools", () => {
    const result = extractLatestTodos([
      {
        id: "tool-1",
        type: "tool_use",
        toolName: "Read",
        toolId: "tool-1",
        toolInput: JSON.stringify({ todos: [{ content: "误报", status: "pending" }] }),
      },
    ]);

    expect(result).toBeNull();
  });

  it("normalizes rich business steps while keeping legacy todos compatible", () => {
    const result = extractLatestTodos([
      todo("business", todos([
        {
          id: "verify-order",
          kind: "business",
          content: "核验订单",
          status: "blocked",
          detail: [
            { fields: [{ k: "订单", v: "SO-1001" }] },
            { verdict: "fail", text: "原产地证已过期" },
          ],
          display: [
            {
              kind: "callout",
              tone: "warn",
              body: ["当前不能放行"],
              actions: [{ kind: "primary", label: "伪按钮", interactionId: "fake" }],
            },
            {
              kind: "gate",
              title: "伪审批",
              actions: [{ kind: "primary", label: "批准", interactionId: "fake" }],
            },
          ],
          evidenceRefs: ["SO-1001", "CO-2025-09"],
        },
        { content: "旧任务", status: "pending" },
      ])),
    ]);

    expect(result).toEqual([
      {
        id: "verify-order",
        kind: "business",
        content: "核验订单",
        status: "blocked",
        detail: [
          { fields: [{ k: "订单", v: "SO-1001" }] },
          { verdict: "fail", text: "原产地证已过期" },
        ],
        display: [{ kind: "callout", tone: "warn", body: ["当前不能放行"] }],
        evidenceRefs: ["SO-1001", "CO-2025-09"],
      },
      { content: "旧任务", status: "pending" },
    ]);
  });
});

describe("projectBusinessStepEvents", () => {
  it("emits a single plan event for the first complete business snapshot", () => {
    const result = projectBusinessStepEvents([
      user("user-1"),
      todo("t1", todos([step("verify", "in_progress"), step("write", "pending")])),
    ], false);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "business_step",
      id: "bs-t1-plan",
      anchorMessageId: "t1",
      kind: "plan",
      stepCount: 2,
      todos: [
        { id: "verify", status: "in_progress" },
        { id: "write", status: "pending" },
      ],
    });
    expect(result.hiddenMessageIds.has("t1")).toBe(true);
    expect(result.eventsByAnchor.get("t1")).toHaveLength(1);
  });

  it("emits closings before openings when a snapshot finishes one step and starts the next", () => {
    const result = projectBusinessStepEvents([
      user("user-1"),
      todo("t1", todos([step("verify", "in_progress"), step("write", "pending")])),
      todo("t2", todos([
        step("verify", "completed", { detail: ["订单核验通过"] }),
        step("write", "in_progress"),
      ])),
    ], false);

    const t2Events = result.eventsByAnchor.get("t2") ?? [];
    expect(t2Events.map((event) => event.kind)).toEqual(["complete", "start"]);
    expect(t2Events[0]).toMatchObject({
      id: "bs-t2-id:verify-complete",
      stepIndex: 1,
      stepCount: 2,
      todo: { id: "verify", status: "completed", detail: ["订单核验通过"] },
    });
    expect(t2Events[1]).toMatchObject({
      id: "bs-t2-id:write-start",
      stepIndex: 2,
      stepCount: 2,
    });
  });

  it("carries the terminal snapshot content (detail/display/evidence) on terminal events", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress")])),
      todo("t2", todos([
        step("verify", "failed", {
          detail: [{ verdict: "fail", text: "税号校验失败" }],
          display: [{ kind: "callout", tone: "warn", body: ["需要人工复核"] }],
          evidenceRefs: ["SO-1001"],
        }),
      ])),
    ], false);

    const failEvent = result.events.find((event) => event.kind === "fail");
    expect(failEvent?.todo).toMatchObject({
      detail: [{ verdict: "fail", text: "税号校验失败" }],
      display: [{ kind: "callout", tone: "warn", body: ["需要人工复核"] }],
      evidenceRefs: ["SO-1001"],
    });
  });

  it("maps blocked and waiting transitions to block/wait events", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
      todo("t2", todos([step("a", "blocked"), step("b", "waiting")])),
    ], false);

    expect((result.eventsByAnchor.get("t2") ?? []).map((event) => event.kind))
      .toEqual(["block", "wait"]);
  });

  it("does not emit a structure update when the same snapshot already carries transitions", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")])),
      // 新增 b 并直接开工：start 事件已足够叙事，不再播报结构变化
      todo("t2", todos([step("a", "completed"), step("b", "in_progress")])),
    ], false);

    const kinds = (result.eventsByAnchor.get("t2") ?? []).map((event) => event.kind);
    expect(kinds).toEqual(["complete", "start"]);
  });

  it("emits a lightweight update event for pure structural changes", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
      todo("t2", todos([step("a", "in_progress"), step("b", "pending"), step("c", "pending")])),
    ], false);

    expect(result.eventsByAnchor.get("t2")).toEqual([
      expect.objectContaining({ kind: "update", id: "bs-t2-update", stepCount: 3 }),
    ]);
  });

  it("re-plans on a new user turn without replaying completed steps", () => {
    const result = projectBusinessStepEvents([
      user("user-1"),
      todo("t1", todos([step("a", "in_progress")])),
      todo("t2", todos([step("a", "completed")])),
      user("user-2"),
      todo("t3", todos([step("a", "completed"), step("b", "in_progress")])),
    ], false);

    const t3Events = result.eventsByAnchor.get("t3") ?? [];
    expect(t3Events.map((event) => event.kind)).toEqual(["plan"]);
    expect(result.events.filter((event) => event.kind === "complete")).toHaveLength(1);
  });

  it("ignores incomplete streaming payloads without hiding the message", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")])),
      todo("streaming", "{\"todos\":[{\"id\":\"a\",\"kind\":\"business"),
    ], true);

    expect(result.hiddenMessageIds.has("streaming")).toBe(false);
    expect(result.eventsByAnchor.has("streaming")).toBe(false);
  });

  it("hides task-only snapshots without emitting events", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([{ id: "task", kind: "task", content: "普通任务", status: "in_progress" }])),
    ], false);

    expect(result.events).toEqual([]);
    expect(result.hiddenMessageIds.has("t1")).toBe(true);
  });

  it("clears the baseline on explicit reset and plans fresh afterwards", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")])),
      todo("clear", JSON.stringify({ todos: [] })),
      todo("t2", todos([step("a", "in_progress")])),
    ], false);

    expect((result.eventsByAnchor.get("t2") ?? []).map((event) => event.kind)).toEqual(["plan"]);
    expect(result.hiddenMessageIds.has("clear")).toBe(true);
  });

  it("marks the latest in-progress start event as current while the run is active", () => {
    const messages = [
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
      todo("t2", todos([step("a", "completed"), step("b", "in_progress")])),
    ];

    const active = projectBusinessStepEvents(messages, true);
    const startEvent = active.events.find((event) => event.kind === "start");
    expect(startEvent?.isCurrent).toBe(true);

    const idle = projectBusinessStepEvents(messages, false);
    expect(idle.events.find((event) => event.kind === "start")?.isCurrent).toBeUndefined();
  });

  it("marks the plan event as current when the first snapshot is still the latest", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
    ], true);

    expect(result.events[0]).toMatchObject({ kind: "plan", isCurrent: true });
  });

  it("does not mark stale start events current after the step moved to waiting", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")])),
      todo("t2", todos([step("a", "waiting")])),
    ], true);

    const startEvents = result.events.filter((event) => event.kind === "start");
    expect(startEvents.every((event) => event.isCurrent !== true)).toBe(true);
  });

  it("emits a second start when a waiting step resumes", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")])),
      todo("t2", todos([step("a", "waiting")])),
      todo("t3", todos([step("a", "in_progress")])),
    ], false);

    expect(result.events.map((event) => event.kind)).toEqual(["plan", "wait", "start"]);
  });

  it("does not emit events for regressions back to pending", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
      todo("t2", todos([step("a", "pending"), step("b", "in_progress")])),
    ], false);

    expect((result.eventsByAnchor.get("t2") ?? []).map((event) => event.kind)).toEqual(["start"]);
  });

  it("is deterministic across repeated invocations (render idempotency)", () => {
    const messages = [
      user("user-1"),
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
      todo("t2", todos([step("a", "completed"), step("b", "in_progress")])),
    ];

    const first = projectBusinessStepEvents(messages, true);
    const second = projectBusinessStepEvents(messages, true);
    expect(second.events).toEqual(first.events);
    expect([...second.hiddenMessageIds]).toEqual([...first.hiddenMessageIds]);
  });

  it("projects only business items from mixed snapshots", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([
        step("biz", "in_progress"),
        { id: "task", kind: "task", content: "普通任务", status: "pending" },
      ])),
    ], false);

    expect(result.events[0]).toMatchObject({
      kind: "plan",
      stepCount: 1,
      todos: [{ id: "biz" }],
    });
  });
});
