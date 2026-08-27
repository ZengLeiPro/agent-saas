import { describe, expect, it } from "vitest";
import type { TaskBoardTask } from "@agent/shared";
import { canUserTransitionTask } from "./constants";

function task(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
  return {
    id: "task-1",
    boardId: "board-1",
    identifier: "TASK-1",
    kind: "delivery",
    title: "恢复任务",
    description: "",
    status: "ready_to_merge",
    priority: "none",
    labels: [],
    sortOrder: 1024,
    commentCount: 0,
    version: 1,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("canUserTransitionTask", () => {
  it.each(["ready_to_merge", "done", "canceled"] as const)("允许将 %s 手动恢复到待推进", (status) => {
    expect(canUserTransitionTask(task({ status, mergeEligibility: "not_applicable" }), status, "todo")).toBe(true);
  });

  it("不允许恢复已被集成认领或已经合并的交付任务", () => {
    expect(canUserTransitionTask(task({ mergeEligibility: "claimed" }), "ready_to_merge", "todo")).toBe(false);
    expect(canUserTransitionTask(task({ status: "done", mergeEligibility: "merged" }), "done", "todo")).toBe(false);
  });

  it("继续保护工作流中间状态和 Integration 任务", () => {
    expect(canUserTransitionTask(task({ status: "in_review" }), "in_review", "todo")).toBe(false);
    expect(canUserTransitionTask(task({ kind: "integration", status: "canceled" }), "canceled", "todo")).toBe(false);
  });
});
