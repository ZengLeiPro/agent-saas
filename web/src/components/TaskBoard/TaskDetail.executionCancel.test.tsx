import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardExecution, TaskBoardTask } from "@agent/shared";
import { TaskDetail } from "./TaskDetail";

const mocks = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  cancelExecution: vi.fn(),
  executions: [] as TaskBoardExecution[],
  refreshExecutions: vi.fn(async () => undefined),
}));

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  fetchTask: mocks.fetchTask,
  cancelExecution: mocks.cancelExecution,
}));

vi.mock("./hooks", () => ({
  useTaskComments: () => ({
    comments: [], loading: false, error: null,
    refresh: vi.fn(async () => undefined), addComment: vi.fn(),
  }),
  useTaskExecutions: () => ({
    executions: mocks.executions, loading: false, error: null, refresh: mocks.refreshExecutions,
  }),
}));

const runningTask: TaskBoardTask = {
  id: "task-1",
  boardId: "board-1",
  identifier: "TASK-1",
  kind: "delivery",
  title: "终止卡死执行",
  description: "卡死执行",
  status: "in_progress",
  priority: "none",
  labels: [],
  sortOrder: 1_000,
  commentCount: 0,
  version: 3,
  createdAt: "2026-08-26T05:00:00.000Z",
  updatedAt: "2026-08-26T05:00:00.000Z",
};

const execution: TaskBoardExecution = {
  id: "execution-running",
  taskId: runningTask.id,
  runId: "run-running",
  sessionId: "session-running",
  status: "running",
  purpose: "work",
  requestedBy: "user-1",
  createdAt: runningTask.createdAt,
  updatedAt: runningTask.updatedAt,
};

describe("TaskDetail 终止执行", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executions = [execution];
    mocks.fetchTask.mockResolvedValue(runningTask);
  });

  it("维护者可从任务详情终止活跃 Execution", async () => {
    const user = userEvent.setup();
    const cancelledTask = { ...runningTask, status: "todo" as const, version: runningTask.version + 1 };
    mocks.cancelExecution.mockResolvedValue({
      task: cancelledTask,
      execution: { ...execution, status: "cancelled" },
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onTaskLoaded = vi.fn();

    render(<TaskDetail
      open
      task={runningTask}
      boardReadOnly={false}
      canCancelExecution
      onOpenChange={vi.fn()}
      onTaskLoaded={onTaskLoaded}
      onUpdate={vi.fn(async (task) => task)}
      onMove={vi.fn(async (task) => task)}
      onSetArchived={vi.fn(async (task) => task)}
      onExecute={vi.fn()}
      onCommentsChanged={vi.fn(async () => undefined)}
    />);

    await user.click(await screen.findByRole("button", { name: "终止执行" }));

    await waitFor(() => expect(mocks.cancelExecution).toHaveBeenCalledWith(
      runningTask.id,
      execution.id,
      { expectedVersion: runningTask.version, reason: "看板维护者从任务详情终止执行" },
    ));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("当前运行会被取消"));
    expect(onTaskLoaded).toHaveBeenCalledWith(cancelledTask);
    expect(mocks.refreshExecutions).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
