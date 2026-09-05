import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard, TaskBoardTask } from "@agent/shared";
import { parseUrl } from "@/lib/urlSync";
import { TaskBoardView } from "./index";

const mocks = vi.hoisted(() => ({
  tasksLoading: true,
  requestedBoardId: null as string | null,
  emptyTasks: [] as TaskBoardTask[],
  tasks: [] as TaskBoardTask[],
  noopAsync: vi.fn(async () => undefined),
}));

const boards: TaskBoard[] = ["board-1", "board-2"].map((id) => ({
  id,
  name: id,
  description: "",
  prompt: "",
  visibility: "personal",
  ownerUserId: "user-1",
  canManage: true,
  version: 1,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
}));
const targetTask: TaskBoardTask = {
  id: "task-2",
  boardId: "board-2",
  identifier: "TASK-2",
  title: "通知目标任务",
  description: "",
  kind: "delivery",
  status: "todo",
  priority: "medium",
  labels: [],
  sortOrder: 1_000,
  commentCount: 0,
  version: 1,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};
vi.mock("./hooks", () => ({
  useTaskboardModelList: () => null,
  useTaskBoards: () => ({
    boards,
    loading: false,
    error: null,
    refresh: mocks.noopAsync,
    addBoard: mocks.noopAsync,
    updateBoard: mocks.noopAsync,
    archive: mocks.noopAsync,
    restore: mocks.noopAsync,
  }),
  useBoardTasks: (boardId: string | null) => {
    mocks.requestedBoardId = boardId;
    return {
      tasks: boardId === "board-2" && !mocks.tasksLoading ? mocks.tasks : mocks.emptyTasks,
      loading: boardId === "board-2" && mocks.tasksLoading,
      error: null,
      refresh: mocks.noopAsync,
      addTask: mocks.noopAsync,
      updateTask: mocks.noopAsync,
      completeTask: mocks.noopAsync,
      setArchived: mocks.noopAsync,
      removeTask: mocks.noopAsync,
      executeTask: mocks.noopAsync,
      optimisticMove: mocks.noopAsync,
      syncTask: mocks.noopAsync,
    };
  },
}));
vi.mock("./BoardToolbar", () => ({ BoardToolbar: ({ board }: { board: TaskBoard }) => <div data-testid="selected-board">{board.id}</div> }));
vi.mock("./TaskColumns", () => ({ TaskColumns: () => null }));
vi.mock("./TaskDetail", () => ({
  TaskDetail: ({ open, task }: { open: boolean; task: TaskBoardTask | null }) => open && task
    ? <div role="dialog">{task.id}</div>
    : null,
}));
vi.mock("./ArchivedTasksSheet", () => ({ ArchivedTasksSheet: () => null }));
vi.mock("./BoardDialog", () => ({ BoardDialog: () => null }));
vi.mock("./TaskDialog", () => ({ TaskDialog: () => null }));

beforeEach(() => {
  mocks.tasksLoading = true;
  mocks.requestedBoardId = null;
  mocks.tasks = [targetTask];
  window.localStorage.clear();
  window.history.replaceState({}, "", "/cron?view=board&boardId=board-2&taskId=task-2");
});

describe("任务看板旧通知深链", () => {
  it("旧 URL canonical 后延迟挂载仍选择目标看板并打开任务详情", async () => {
    const canonicalPath = parseUrl().canonicalPath;
    expect(canonicalPath).toBe("/taskboard?boardId=board-2&taskId=task-2");
    window.history.replaceState({}, "", canonicalPath!);

    const view = render(<TaskBoardView />);
    expect((await screen.findByTestId("selected-board")).textContent).toBe("board-2");
    expect(mocks.requestedBoardId).toBe("board-2");

    mocks.tasksLoading = false;
    view.rerender(<TaskBoardView />);

    await waitFor(() => expect(screen.getByRole("dialog").textContent).toBe("task-2"));
  });
});
