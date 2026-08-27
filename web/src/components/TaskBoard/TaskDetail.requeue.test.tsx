import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardTask } from "@agent/shared";
import { TaskDetail } from "./TaskDetail";

const mocks = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  fetchIntegrationSources: vi.fn(async () => []),
}));

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  fetchTask: mocks.fetchTask,
  fetchIntegrationSources: mocks.fetchIntegrationSources,
}));

vi.mock("./hooks", () => ({
  useTaskComments: () => ({
    comments: [], loading: false, error: null,
    refresh: vi.fn(async () => undefined), addComment: vi.fn(),
  }),
  useTaskExecutions: () => ({
    executions: [], loading: false, error: null, ready: true,
    refresh: vi.fn(async () => undefined),
  }),
}));

function task(status: TaskBoardTask["status"], mergeEligibility: TaskBoardTask["mergeEligibility"]): TaskBoardTask {
  return {
    id: "task-1", boardId: "board-1", identifier: "TASK-1", kind: "delivery",
    title: "恢复任务", description: "任务正文", status, priority: "none", labels: [],
    sortOrder: 1024, mergeEligibility, commentCount: 0, version: 3,
    createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function props(current: TaskBoardTask, onMove = vi.fn()) {
  return {
    open: true,
    task: current,
    boardReadOnly: false,
    onOpenChange: vi.fn(),
    onTaskLoaded: vi.fn(),
    onUpdate: vi.fn(async (value: TaskBoardTask) => value),
    onMove,
    onCompleteTask: vi.fn(async (value: TaskBoardTask) => value),
    onSetArchived: vi.fn(async (value: TaskBoardTask) => value),
    onExecute: vi.fn(),
    onCommentsChanged: vi.fn(async () => undefined),
  };
}

describe("TaskDetail 恢复待推进", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["ready_to_merge", "done", "canceled"] as const)("%s 可恢复到待推进，但不会自动开始实施", async (status) => {
    const user = userEvent.setup();
    const current = task(status, status === "ready_to_merge" ? "eligible" : "not_applicable");
    const requeued = { ...current, status: "todo" as const, version: current.version + 1, mergeEligibility: "not_applicable" as const };
    mocks.fetchTask.mockResolvedValue(current);
    const onMove = vi.fn(async () => requeued);
    const componentProps = props(current, onMove);
    render(<TaskDetail {...componentProps} />);

    await user.click(await screen.findByRole("combobox", { name: "任务状态" }));
    await user.click(screen.getByRole("option", { name: "待推进" }));

    await waitFor(() => expect(onMove).toHaveBeenCalledWith(current, "todo"));
    expect(componentProps.onExecute).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "开始实施" })).toBeTruthy();
  });

  it("已被集成认领的待合并任务不能恢复", async () => {
    const current = task("ready_to_merge", "claimed");
    mocks.fetchTask.mockResolvedValue(current);
    render(<TaskDetail {...props(current)} />);

    expect((await screen.findByRole("combobox", { name: "任务状态" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
