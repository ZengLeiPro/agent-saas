import { describe, expect, it } from "vitest";

import { extractLatestTodos } from "./extractTodos";
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
});
