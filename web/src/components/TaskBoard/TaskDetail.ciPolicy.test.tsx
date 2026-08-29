import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard, TaskBoardExecution, TaskBoardTask } from "@agent/shared";

import { TaskDetail } from "./TaskDetail";

const mocks = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  resumeTask: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  fetchTask: mocks.fetchTask,
  resumeTask: mocks.resumeTask,
  fetchIntegrationSources: vi.fn(async () => []),
}));
vi.mock("./hooks", () => ({
  useTaskComments: () => ({ comments: [], loading: false, error: null, refresh: vi.fn(), addComment: vi.fn() }),
  useTaskExecutions: () => ({ executions: [], loading: false, error: null, refresh: vi.fn() }),
}));

const blockedTask: TaskBoardTask = {
  id: "task-1", boardId: "board-1", identifier: "TASK-1", title: "CI 门禁任务", description: "",
  status: "blocked", priority: "none", labels: [], sortOrder: 1_000, commentCount: 0, version: 3,
  providerCiStatus: "unconfigured", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
};
const editableBoard: TaskBoard = {
  id: "board-1", name: "Board", visibility: "personal", ownerUserId: "user-1", canManage: true,
  allowedActions: ["board.read", "board.policy.update", "task.transition"], prompt: "", version: 1,
  createdAt: blockedTask.createdAt, updatedAt: blockedTask.updatedAt,
};

function props(overrides: Partial<ComponentProps<typeof TaskDetail>> = {}): ComponentProps<typeof TaskDetail> {
  return {
    open: true, task: blockedTask, board: editableBoard, boardReadOnly: false, canTransitionTask: true,
    onOpenChange: vi.fn(), onTaskLoaded: vi.fn(), onUpdate: vi.fn(async (task) => task),
    onMove: vi.fn(async (task) => task), onCompleteTask: vi.fn(async (task) => task),
    onSetArchived: vi.fn(async (task) => task),
    onExecute: vi.fn(), onCommentsChanged: vi.fn(async () => undefined), ...overrides,
  };
}

describe("TaskDetail CI 未配置闭环", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchTask.mockResolvedValue(blockedTask);
  });

  it("展示配置入口，并恢复后立即启动当前 PR head 重检", async () => {
    const user = userEvent.setup();
    const resumedTask = { ...blockedTask, status: "todo" as const, version: 4 };
    const runningTask = { ...resumedTask, status: "in_progress" as const, version: 5 };
    const execution: TaskBoardExecution = {
      id: "execution-recheck", taskId: blockedTask.id, runId: "run-recheck", sessionId: "session-recheck",
      status: "queued", purpose: "work", requestedBy: "user-1", createdAt: blockedTask.createdAt, updatedAt: blockedTask.updatedAt,
    };
    mocks.resumeTask.mockResolvedValue(resumedTask);
    const onConfigureCiPolicy = vi.fn();
    const onExecute = vi.fn(async () => ({ task: runningTask, execution }));
    const onTaskLoaded = vi.fn();
    render(<TaskDetail {...props({ onConfigureCiPolicy, onExecute, onTaskLoaded })} />);

    const compactStatus = await screen.findByRole("region", { name: "任务关键状态" });
    expect(compactStatus.textContent).toContain("任务已阻塞");
    expect(compactStatus.textContent).toContain("CI 门禁未配置");
    expect(screen.getByTestId("task-detail-information").getAttribute("aria-hidden")).toBe("true");
    await user.click(screen.getByRole("button", { name: "展开任务详情" }));
    expect(await screen.findByLabelText("CI 门禁未配置")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "前往配置" }));
    expect(onConfigureCiPolicy).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "恢复任务并重新检查" }));
    await waitFor(() => expect(mocks.resumeTask).toHaveBeenCalledWith(
      blockedTask.id, blockedTask.version, "CI 门禁已配置，恢复实施并重新检查当前精确 PR head",
    ));
    expect(onExecute).toHaveBeenCalledWith(resumedTask, "work");
    expect(onTaskLoaded).toHaveBeenLastCalledWith(runningTask);
  });

  it("无策略或恢复权限时明确提示联系看板所有者", async () => {
    const user = userEvent.setup();
    const readOnlyBoard: TaskBoard = {
      ...editableBoard, visibility: "organization", ownerUserId: "owner-1", canManage: false,
      allowedActions: ["board.read"],
    };
    render(<TaskDetail {...props({ board: readOnlyBoard, canTransitionTask: false, onConfigureCiPolicy: undefined })} />);

    await user.click(await screen.findByRole("button", { name: "展开任务详情" }));
    expect(await screen.findByText(/请联系看板所有者配置/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "前往配置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复任务并重新检查" })).toBeNull();
  });
});
