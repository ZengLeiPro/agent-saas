import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardExecution, TaskBoardTask } from "@agent/shared";
import { TaskDetail } from "./TaskDetail";

const mocks = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  fetchIntegrationSources: vi.fn(),
  authFetch: vi.fn(),
  executions: [] as TaskBoardExecution[],
  refreshComments: vi.fn(async () => undefined),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchTask: mocks.fetchTask,
    fetchIntegrationSources: mocks.fetchIntegrationSources,
  };
});
vi.mock("./hooks", () => ({
  useTaskComments: () => ({
    comments: [], loading: false, error: null, refresh: mocks.refreshComments, addComment: vi.fn(),
  }),
  useTaskExecutions: () => ({
    executions: mocks.executions, loading: false, error: null, refresh: vi.fn(),
  }),
}));

const runningTask: TaskBoardTask = {
  id: "task-1",
  boardId: "board-1",
  identifier: "TASK-1",
  title: "后台实施",
  description: "验证 Session 活跃投影",
  status: "in_progress",
  priority: "high",
  labels: [],
  sortOrder: 1_000,
  commentCount: 0,
  version: 4,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function props(): ComponentProps<typeof TaskDetail> {
  return {
    open: true,
    task: runningTask,
    boardReadOnly: false,
    onOpenChange: vi.fn(),
    onTaskLoaded: vi.fn(),
    onUpdate: vi.fn(async (task) => task),
    onMove: vi.fn(async (task) => task),
    onCompleteTask: vi.fn(async (task) => task),
    onSetArchived: vi.fn(async (task) => task),
    onExecute: vi.fn(),
    onCommentsChanged: vi.fn(async () => undefined),
  };
}

describe("TaskDetail Session 活跃态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchTask.mockResolvedValue(runningTask);
    mocks.fetchIntegrationSources.mockResolvedValue([]);
    mocks.executions = [{
      id: "execution-terminal",
      taskId: runningTask.id,
      runId: "run-terminal",
      sessionId: "session-terminal",
      status: "succeeded",
      purpose: "work",
      requestedBy: "user-1",
      sessionActivityActive: true,
      createdAt: runningTask.createdAt,
      updatedAt: runningTask.updatedAt,
    }];
  });

  it("顶层 Run 已终态但 Session 后台活跃时保持会话入口并禁止恢复", async () => {
    render(<TaskDetail {...props()} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(runningTask.id));

    expect(screen.getByText("主 Run 已结束 · 后台仍在执行")).toBeTruthy();
    expect(screen.getByRole("link", { name: "打开当前执行会话" }).getAttribute("href"))
      .toBe("/chat/session-terminal");
    expect(screen.queryByRole("button", { name: "恢复实施" })).toBeNull();
    expect(mocks.refreshComments).not.toHaveBeenCalled();
  });
});
