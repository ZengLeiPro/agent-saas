import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskBoardExecution, TaskBoardTask } from "@agent/shared";
import { canManuallyCompleteTask } from "./TaskCompletionButton";
import { TaskDetail } from "./TaskDetail";

const mocks = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  executions: [] as TaskBoardExecution[],
  executionsLoading: false,
  executionsError: null as string | null,
  executionsReady: true,
}));
vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  fetchTask: mocks.fetchTask,
  fetchIntegrationSources: vi.fn(async () => []),
}));
vi.mock("./hooks", () => ({
  useTaskComments: () => ({ comments: [], loading: false, error: null, ready: true, refresh: vi.fn(), addComment: vi.fn() }),
  useTaskExecutions: () => ({
    executions: mocks.executions,
    loading: mocks.executionsLoading,
    error: mocks.executionsError,
    ready: mocks.executionsReady,
    refresh: vi.fn(),
  }),
}));

const advisoryTask: TaskBoardTask = {
  id: "task-1", boardId: "board-1", identifier: "TASK-1", kind: "advisory",
  title: "答复事项", description: "", status: "todo", priority: "none", labels: [],
  sortOrder: 1024, commentCount: 0, version: 3,
  createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z",
};

function props(overrides: Partial<ComponentProps<typeof TaskDetail>> = {}): ComponentProps<typeof TaskDetail> {
  return {
    open: true,
    task: advisoryTask,
    boardReadOnly: false,
    canTransitionTask: true,
    onOpenChange: vi.fn(),
    onTaskLoaded: vi.fn(),
    onUpdate: vi.fn(async (task) => task),
    onMove: vi.fn(async (task) => task),
    onCompleteTask: vi.fn(async (task) => task),
    onSetArchived: vi.fn(async (task) => task),
    onExecute: vi.fn(),
    onCommentsChanged: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("TaskDetail 人工完成", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executions = [];
    mocks.executionsLoading = false;
    mocks.executionsError = null;
    mocks.executionsReady = true;
    mocks.fetchTask.mockResolvedValue(advisoryTask);
  });

  it("确认后直接完成普通任务并同步详情", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const completedTask = {
      ...advisoryTask,
      status: "done" as const,
      version: advisoryTask.version + 1,
      completedAt: advisoryTask.updatedAt,
    };
    const onCompleteTask = vi.fn(async () => completedTask);
    const onTaskLoaded = vi.fn();
    render(<TaskDetail {...props({ onCompleteTask, onTaskLoaded })} />);

    await user.click(await screen.findByRole("tab", { name: "详细信息" }));
    await user.click(await screen.findByRole("button", { name: "完成任务" }));
    await waitFor(() => expect(onCompleteTask).toHaveBeenCalledWith(advisoryTask));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("结束当前任务工作流"));
    expect(onTaskLoaded).toHaveBeenCalledWith(completedTask);
    expect(screen.queryByRole("button", { name: "完成任务" })).toBeNull();
    confirmSpy.mockRestore();
  });

  it("活动 Agent 执行期间不提供人工完成入口", async () => {
    const runningTask = { ...advisoryTask, status: "in_progress" as const };
    mocks.fetchTask.mockResolvedValue(runningTask);
    mocks.executions = [{
      id: "execution-active", taskId: runningTask.id, runId: "run-active", sessionId: "session-active",
      status: "running", purpose: "work", requestedBy: "user-1",
      createdAt: runningTask.createdAt, updatedAt: runningTask.updatedAt,
    }];

    render(<TaskDetail {...props({ task: runningTask })} />);
    expect(screen.queryByRole("button", { name: "完成任务" })).toBeNull();
  });

  it.each([
    ["执行记录仍在加载", true, null, true],
    ["执行记录加载失败", false, "加载失败", true],
    ["执行记录尚未首次成功加载", false, null, false],
  ])("%s时不提供人工完成入口", (_label, loading, error, ready) => {
    mocks.executionsLoading = loading;
    mocks.executionsError = error;
    mocks.executionsReady = ready;
    render(<TaskDetail {...props()} />);
    expect(screen.queryByRole("button", { name: "完成任务" })).toBeNull();
  });

  it.each([
    ["只读任务", advisoryTask, true, true],
    ["无迁移权限", advisoryTask, false, false],
    ["集成任务", { ...advisoryTask, kind: "integration" as const }, false, true],
    ["修复任务", { ...advisoryTask, kind: "remediation" as const }, false, true],
    ["已完成任务", { ...advisoryTask, status: "done" as const }, false, true],
    ["已取消任务", { ...advisoryTask, status: "canceled" as const }, false, true],
    ["待集成 Delivery", { ...advisoryTask, kind: "delivery" as const, mergeEligibility: "eligible" as const }, false, true],
    ["被集成占用", { ...advisoryTask, kind: "delivery" as const, mergeEligibility: "claimed" as const }, false, true],
    ["带未合并 PR", {
      ...advisoryTask, kind: "delivery" as const, providerPullRequestId: "235", pullRequestNumber: 235,
    }, false, true],
  ])("%s不满足人工完成条件", (_label, candidate, readOnly, canTransition) => {
    expect(canManuallyCompleteTask(candidate, readOnly, canTransition, false, true)).toBe(false);
  });
});
