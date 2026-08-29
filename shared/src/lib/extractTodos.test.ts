import { describe, expect, it } from "vitest";

import {
  projectBusinessStepEvents,
} from "./extractTodos";
import type { MessageItem } from "../types/message";

function user(id: string): MessageItem {
  return { id, type: "user", content: "next task" };
}

function todo(id: string, toolInput: string, runId?: string): MessageItem {
  return {
    id,
    type: "tool_use",
    toolName: "TodoWrite",
    toolId: id,
    toolInput,
    ...(runId ? { runId } : {}),
  };
}

function todos(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ todos: items });
}

function step(id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: "business", content: `步骤 ${id}`, status, ...extra };
}

describe("projectBusinessStepEvents 纯函数投影", () => {
  it("emits plan followed by start for the first complete business snapshot", () => {
    const result = projectBusinessStepEvents([
      user("user-1"),
      todo("t1", todos([step("verify", "in_progress"), step("write", "pending")])),
    ], false);

    // 首快照有 in_progress 项：plan 亮相后紧跟该步骤的 start（章节化需要每步都有节标题）。
    expect(result.events.map((event) => event.kind)).toEqual(["plan", "start"]);
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
    expect(result.events[1]).toMatchObject({
      id: "bs-t1-id:verify-start",
      kind: "start",
      stepIndex: 1,
      stepCount: 2,
    });
    expect(result.hiddenMessageIds.has("t1")).toBe(true);
    expect(result.eventsByAnchor.get("t1")).toHaveLength(2);
  });

  it("carries runId on plan and step events for stable UI ownership", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress"), step("write", "pending")]), "run-42"),
      todo("t2", todos([step("verify", "completed"), step("write", "in_progress")]), "run-42"),
    ], false);

    expect(result.events.map((event) => event.runId)).toEqual([
      "run-42",
      "run-42",
      "run-42",
      "run-42",
    ]);
  });

  it("emits only plan when the first snapshot has no in-progress step", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "pending"), step("b", "pending")])),
    ], false);

    expect(result.events.map((event) => event.kind)).toEqual(["plan"]);
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

  it("keeps one plan instance and refreshes it to the latest step statuses", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress"), step("write", "pending")])),
      todo("t2", todos([
        step("verify", "completed", { outcome: { text: "核对完成" } }),
        step("write", "in_progress"),
      ])),
    ], false);

    const plans = result.events.filter((event) => event.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.todos).toMatchObject([
      { id: "verify", status: "completed", outcome: { text: "核对完成" } },
      { id: "write", status: "in_progress" },
    ]);
  });

  it("keeps legacy display readable while stripping gate/actions and ignoring extension type", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress")])),
      todo("t2", todos([
        step("verify", "failed", {
          detail: [{ verdict: "fail", text: "税号校验失败" }],
          display: [
            {
              kind: "callout",
              type: "facts",
              tone: "warn",
              body: ["需要人工复核"],
              actions: [{ kind: "copy", label: "复制", copyText: "不应保留" }],
            },
            {
              kind: "records",
              layout: "rows",
              title: "核对订单状态",
              items: [{ label: "订单", value: "SO-1001" }],
              actions: [{ kind: "link", label: "查看", href: "https://example.com" }],
            },
            {
              kind: "gate",
              title: "伪审批",
              actions: [{ kind: "primary", label: "批准", interactionId: "fake" }],
            },
          ],
          evidenceRefs: ["SO-1001"],
        }),
      ])),
    ], false);

    const failEvent = result.events.find((event) => event.kind === "fail");
    expect(failEvent?.todo).toMatchObject({
      detail: [{ verdict: "fail", text: "税号校验失败" }],
      display: [
        { kind: "callout", tone: "warn", body: ["需要人工复核"] },
        {
          kind: "records",
          layout: "rows",
          title: "核对订单状态",
          items: [{ label: "订单", value: "SO-1001" }],
        },
      ],
      evidenceRefs: ["SO-1001"],
    });
  });

  it("normalizes semantic display blocks into deterministic records layouts", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress")])),
      todo("t2", todos([step("verify", "completed", {
        display: [
          {
            type: "facts",
            title: "订单字段",
            items: [
              { label: "订单", value: "SO-1001" },
              { label: "客户", value: "开沿科技" },
              { label: "阶段", value: "已核验" },
            ],
          },
          {
            type: "list",
            title: "提交记录",
            items: [{ label: "提交", value: "abc123" }],
          },
          {
            type: "comparison",
            title: "核对版本",
            items: [
              { label: "接口版本", baseline: "v1", current: "v2", delta: "升级 1 个主版本", status: "warn" },
              { label: "数据版本", baseline: "v2", current: "v2", delta: "一致", status: "pass" },
            ],
          },
          {
            type: "checklist",
            title: "验收清单",
            items: [
              { label: "字段完整", status: "pass" },
              { label: "税号有效", status: "fail", note: "已过期" },
              { label: "资料风险", status: "warn" },
              { label: "人工复核", status: "pending" },
            ],
          },
        ],
      })])),
    ], false);

    const display = result.events.find((event) => event.kind === "complete")?.todo?.display;
    expect(display).toEqual([
      {
        kind: "records",
        layout: "grid",
        title: "订单字段",
        items: [
          { label: "订单", value: "SO-1001" },
          { label: "客户", value: "开沿科技" },
          { label: "阶段", value: "已核验" },
        ],
      },
      {
        kind: "records",
        layout: "rows",
        title: "提交记录",
        items: [{ label: "提交", value: "abc123" }],
      },
      {
        kind: "records",
        layout: "comparison",
        title: "核对版本",
        items: [
          { label: "接口版本", baseline: "v1", current: "v2", delta: "升级 1 个主版本", tone: "warn" },
          { label: "数据版本", baseline: "v2", current: "v2", delta: "一致", tone: "success" },
        ],
      },
      {
        kind: "records",
        layout: "checklist",
        title: "验收清单",
        items: [
          { label: "字段完整", tone: "success" },
          { label: "税号有效", tone: "danger", note: "已过期" },
          { label: "资料风险", tone: "warn" },
          { label: "人工复核", tone: "muted" },
        ],
      },
    ]);
  });

  it("falls facts back to rows when fields are too sparse or too long", () => {
    const longValue = "超长业务字段".repeat(10);
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress")])),
      todo("t2", todos([step("verify", "completed", {
        display: [
          { type: "facts", title: "字段过少", items: [{ label: "订单", value: "SO-1001" }] },
          {
            type: "facts",
            title: "字段过长",
            items: [
              { label: "订单", value: "SO-1001" },
              { label: "客户", value: "开沿科技" },
              { label: "说明", value: longValue },
            ],
          },
        ],
      })])),
    ], false);

    const display = result.events.find((event) => event.kind === "complete")?.todo?.display;
    expect(display?.map((block) => block.kind === "records" ? block.layout : block.kind)).toEqual(["rows", "rows"]);
  });

  it("uses the documented 3-12 item facts grid boundary", () => {
    const factItems = (count: number) => Array.from({ length: count }, (_, index) => ({
      label: `字段${index + 1}`,
      value: `值${index + 1}`,
    }));
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress")])),
      todo("t2", todos([step("verify", "completed", {
        display: [
          { type: "facts", title: "十二项字段", items: factItems(12) },
          { type: "facts", title: "十三项字段", items: factItems(13) },
        ],
      })])),
    ], false);

    const display = result.events.find((event) => event.kind === "complete")?.todo?.display;
    expect(display?.map((block) => block.kind === "records" ? block.layout : block.kind)).toEqual(["grid", "rows"]);
  });

  it("keeps legacy key-value detail cards readable for historical transcripts", () => {
    const legacyDetail = [
      { k: "工作树", v: "干净" },
      { tree: "└", k: "远端", v: "已同步" },
      { fields: [{ k: "提交", v: "2" }] },
    ];
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("verify", "in_progress")])),
      todo("t2", todos([step("verify", "completed", { detail: legacyDetail })])),
    ], false);

    const completeEvent = result.events.find((event) => event.kind === "complete");
    expect(completeEvent?.todo?.detail).toEqual(legacyDetail);
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
    // 跨 Turn 首快照：plan 重新亮相 + 当前 in_progress 步骤的 start，不回放已完成步骤。
    expect(t3Events.map((event) => event.kind)).toEqual(["plan", "start"]);
    expect(result.events.filter((event) => event.kind === "complete")).toHaveLength(1);
  });

  it("keeps one plan across user prompts that belong to the same business run", () => {
    const result = projectBusinessStepEvents([
      user("user-1"),
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")]), "run-1"),
      todo("t2", todos([step("a", "completed"), step("b", "pending")]), "run-1"),
      user("approval-reply"),
      todo("t3", todos([step("a", "completed"), step("b", "in_progress")]), "run-1"),
      todo("t4", todos([step("a", "completed"), step("b", "completed")]), "run-1"),
    ], false);

    expect(result.events.filter((event) => event.kind === "plan")).toHaveLength(1);
    expect(result.events[0].todos?.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect((result.eventsByAnchor.get("t3") ?? []).map((event) => event.kind)).toEqual(["start"]);
  });

  it("re-plans when an explicit run id changes without a user message", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")]), "run-1"),
      todo("t2", todos([step("a", "completed")]), "run-1"),
      todo("t3", todos([step("b", "in_progress")]), "run-2"),
    ], false);

    expect(result.events.filter((event) => event.kind === "plan")).toHaveLength(2);
    expect((result.eventsByAnchor.get("t3") ?? []).map((event) => event.kind)).toEqual(["plan", "start"]);
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

    expect((result.eventsByAnchor.get("t2") ?? []).map((event) => event.kind)).toEqual(["plan", "start"]);
    expect(result.hiddenMessageIds.has("clear")).toBe(true);
  });

  it("marks only the latest start event as current while the run is active", () => {
    const messages = [
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
      todo("t2", todos([step("a", "completed"), step("b", "in_progress")])),
    ];

    const active = projectBusinessStepEvents(messages, true);
    const startEvents = active.events.filter((event) => event.kind === "start");
    expect(startEvents).toHaveLength(2);
    expect(startEvents[0].isCurrent).toBeUndefined();
    expect(startEvents[1].isCurrent).toBe(true);

    const idle = projectBusinessStepEvents(messages, false);
    expect(idle.events.every((event) => event.isCurrent !== true)).toBe(true);
  });

  it("marks the first snapshot's start as current when it is still the latest", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress"), step("b", "pending")])),
    ], true);

    expect(result.events[1]).toMatchObject({ kind: "start", isCurrent: true });
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

    expect(result.events.map((event) => event.kind)).toEqual(["plan", "start", "wait", "start"]);
  });

  it("normalizes outcome and drops malformed entries", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")])),
      todo("t2", todos([
        step("a", "completed", {
          outcome: {
            text: "17/18 张通过，1 张税号过期退回",
            tone: "warn",
            stat: [
              { label: "通过", value: "17" },
              { label: "退回", value: "1" },
              { label: "", value: "无效项被丢弃" },
            ],
            extra: "unknown field ignored",
          },
        }),
      ])),
    ], false);

    const completeEvent = result.events.find((event) => event.kind === "complete");
    expect(completeEvent?.todo?.outcome).toEqual({
      text: "17/18 张通过，1 张税号过期退回",
      tone: "warn",
      stat: [
        { label: "通过", value: "17" },
        { label: "退回", value: "1" },
      ],
    });
  });

  it("drops outcome without text and invalid tone", () => {
    const result = projectBusinessStepEvents([
      todo("t1", todos([step("a", "in_progress")])),
      todo("t2", todos([
        step("a", "completed", { outcome: { tone: "warn" } }),
      ])),
      todo("t3", todos([
        step("a", "in_progress"),
        step("b", "waiting", { outcome: { text: "等待审批", tone: "purple" } }),
      ])),
    ], false);

    const completeEvent = result.events.find((event) => event.kind === "complete");
    expect(completeEvent?.todo?.outcome).toBeUndefined();
    const waitEvent = result.events.find((event) => event.kind === "wait");
    expect(waitEvent?.todo?.outcome).toEqual({ text: "等待审批" });
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
