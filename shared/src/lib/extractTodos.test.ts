import { describe, expect, it } from "vitest";

import {
  extractLatestTodos,
  extractTodoToolActivities,
  projectBusinessTodoGroups,
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

describe("extractTodoToolActivities", () => {
  it("groups ordinary tools under the active stable business step", () => {
    const result = extractTodoToolActivities([
      todo("start", todos([
        { id: "verify", kind: "business", content: "核验订单", status: "in_progress" },
        { id: "write", kind: "business", content: "写入结果", status: "pending" },
      ])),
      {
        id: "read-1",
        type: "tool_use",
        toolName: "Read",
        toolId: "read-1",
        toolInput: "{}",
        executionStatus: "completed",
        presentation: { title: "读取订单", status: "ok" },
      },
      todo("next", todos([
        { id: "verify", kind: "business", content: "核验订单", status: "completed" },
        { id: "write", kind: "business", content: "写入结果", status: "in_progress" },
      ])),
      {
        id: "shell-1",
        type: "tool_use",
        toolName: "Shell",
        toolId: "shell-1",
        toolInput: "{}",
        executionStatus: "running",
      },
    ]);

    expect(result).toEqual({
      "id:verify": [
        { id: "read-1", toolName: "Read", label: "读取订单", status: "completed" },
      ],
      "id:write": [
        { id: "shell-1", toolName: "Shell", label: "Shell", status: "running" },
      ],
    });
  });

  it("clears previous activity when TodoWrite explicitly resets the list", () => {
    const result = extractTodoToolActivities([
      todo("start", todos([
        { id: "verify", kind: "business", content: "核验订单", status: "in_progress" },
      ])),
      {
        id: "read-old",
        type: "tool_use",
        toolName: "Read",
        toolId: "read-old",
        toolInput: "{}",
        executionStatus: "completed",
      },
      todo("clear", todos([])),
      todo("restart", todos([
        { id: "verify", kind: "business", content: "核验订单", status: "in_progress" },
      ])),
      {
        id: "read-new",
        type: "tool_use",
        toolName: "Read",
        toolId: "read-new",
        toolInput: "{}",
        executionStatus: "running",
      },
    ]);

    expect(result["id:verify"]).toEqual([
      { id: "read-new", toolName: "Read", label: "Read", status: "running" },
    ]);
  });
});

describe("projectBusinessTodoGroups", () => {
  it("keeps one stable card per user turn and updates it with the latest snapshot", () => {
    const result = projectBusinessTodoGroups([
      user("user-1"),
      todo("todo-start", todos([
        { id: "verify", kind: "business", content: "核验订单", status: "in_progress" },
        { id: "write", kind: "business", content: "写入结果", status: "pending" },
      ])),
      {
        id: "read-1",
        type: "tool_use",
        toolName: "Read",
        toolId: "read-1",
        toolInput: "{}",
        executionStatus: "completed",
        presentation: { title: "读取订单" },
      },
      todo("todo-adjust", todos([
        { id: "verify", kind: "business", content: "核验订单", status: "completed" },
        { id: "write-domestic", kind: "business", content: "写入国内系统", status: "in_progress" },
        { id: "write-overseas", kind: "business", content: "同步海外系统", status: "pending" },
      ])),
      {
        id: "shell-1",
        type: "tool_use",
        toolName: "Shell",
        toolId: "shell-1",
        toolInput: "{}",
        executionStatus: "running",
      },
    ], true);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      id: "business-todo-todo-start",
      turnId: "user-1",
      anchorMessageId: "todo-start",
      isActive: true,
      todos: [
        { id: "verify", status: "completed" },
        { id: "write-domestic", status: "in_progress" },
        { id: "write-overseas", status: "pending" },
      ],
      activitiesByTodo: {
        "id:verify": [{ id: "read-1", toolName: "Read", label: "读取订单", status: "completed" }],
        "id:write-domestic": [{ id: "shell-1", toolName: "Shell", label: "Shell", status: "running" }],
      },
    });
    expect([...result.hiddenSourceMessageIds]).toEqual([
      "todo-start",
      "read-1",
      "todo-adjust",
      "shell-1",
    ]);
  });

  it("creates a new persistent card for each later user turn", () => {
    const result = projectBusinessTodoGroups([
      user("user-1"),
      todo("todo-1", todos([
        { id: "first", kind: "business", content: "第一轮", status: "completed" },
      ])),
      { id: "answer-1", type: "text", content: "done" },
      user("user-2"),
      todo("todo-2", todos([
        { id: "second", kind: "business", content: "第二轮", status: "in_progress" },
      ])),
    ], true);

    expect(result.groups.map((group) => ({ id: group.id, active: group.isActive }))).toEqual([
      { id: "business-todo-todo-1", active: false },
      { id: "business-todo-todo-2", active: true },
    ]);
  });

  it("does not project ordinary task todos into the main conversation", () => {
    const result = projectBusinessTodoGroups([
      user("user-1"),
      todo("todo-task", todos([
        { id: "task", kind: "task", content: "普通任务", status: "in_progress" },
      ])),
    ], true);

    expect(result.groups).toEqual([]);
    expect(result.hiddenSourceMessageIds.size).toBe(0);
  });
});
