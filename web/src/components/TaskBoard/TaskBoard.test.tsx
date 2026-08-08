import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard, TaskBoardTask } from "@agent/shared";
import { TaskBoardConflictError } from "./api";
import { TaskBoardView } from "./index";

const mocks = vi.hoisted(() => ({
  boards: [] as TaskBoard[],
  tasks: [] as TaskBoardTask[],
  refreshBoards: vi.fn(async () => undefined),
  addBoard: vi.fn(),
  updateBoard: vi.fn(),
  archiveBoard: vi.fn(),
  restoreBoard: vi.fn(),
  refreshTasks: vi.fn(async () => undefined),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  setArchived: vi.fn(),
  executeTask: vi.fn(),
  optimisticMove: vi.fn(),
  syncTask: vi.fn(),
  addComment: vi.fn(async () => undefined),
  fetchTask: vi.fn(),
}));

vi.mock("./hooks", () => ({
  useTaskBoards: () => ({
    boards: mocks.boards,
    loading: false,
    error: null,
    refresh: mocks.refreshBoards,
    addBoard: mocks.addBoard,
    updateBoard: mocks.updateBoard,
    archive: mocks.archiveBoard,
    restore: mocks.restoreBoard,
  }),
  useBoardTasks: () => ({
    tasks: mocks.tasks,
    loading: false,
    error: null,
    refresh: mocks.refreshTasks,
    addTask: mocks.addTask,
    updateTask: mocks.updateTask,
    setArchived: mocks.setArchived,
    executeTask: mocks.executeTask,
    optimisticMove: mocks.optimisticMove,
    syncTask: mocks.syncTask,
  }),
  useTaskComments: () => ({
    comments: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    addComment: mocks.addComment,
  }),
  useTaskExecutions: () => ({
    executions: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchTask: mocks.fetchTask };
});

function board(id: string, name: string, archived = false): TaskBoard {
  return {
    id,
    name,
    description: `${name}说明`,
    version: 2,
    ...(archived ? { archivedAt: "2026-08-01T00:00:00.000Z" } : {}),
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function task(
  id: string,
  identifier: string,
  title: string,
  status: TaskBoardTask["status"],
  priority: TaskBoardTask["priority"],
): TaskBoardTask {
  return {
    id,
    boardId: "board-1",
    identifier,
    title,
    description: `${title}正文`,
    status,
    priority,
    labels: id === "task-1" ? ["前端", "首期"] : ["后端"],
    sortOrder: id === "task-1" ? 1_000 : 2_000,
    dueAt: "2026-08-10T23:59:59.000Z",
    commentCount: id === "task-1" ? 2 : 0,
    version: id === "task-1" ? 3 : 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

const taskOne = task("task-1", "TASK-1", "实现任务看板", "backlog", "urgent");
const taskTwo = task("task-2", "TASK-2", "联调接口", "todo", "low");

describe("TaskBoardView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boards = [board("board-1", "产品研发"), board("board-2", "市场事项")];
    mocks.tasks = [taskOne, taskTwo];
    mocks.fetchTask.mockImplementation(async (id: string) => {
      const found = mocks.tasks.find((item) => item.id === id);
      if (!found) throw new Error("任务不存在");
      return found;
    });
    mocks.optimisticMove.mockImplementation(async (moved: TaskBoardTask) => moved);
    mocks.updateTask.mockImplementation(async (moved: TaskBoardTask) => moved);
    mocks.setArchived.mockImplementation(async (moved: TaskBoardTask) => moved);
  });

  it("无看板时显示创建 CTA", () => {
    mocks.boards = [];
    mocks.tasks = [];
    render(<TaskBoardView />);

    expect(screen.getByText("还没有任务看板")).toBeTruthy();
    expect(screen.getByRole("button", { name: /创建看板/ })).toBeTruthy();
  });

  it("支持多看板、固定七列、关键词与优先级筛选", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择看板" })).toBeTruthy());
    expect(screen.getAllByRole("region", { name: /列$/ })).toHaveLength(7);

    await user.click(screen.getByRole("combobox", { name: "选择看板" }));
    expect(screen.getByRole("option", { name: "产品研发" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "市场事项" })).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.type(screen.getByRole("textbox", { name: "搜索任务" }), "前端");
    expect(screen.getAllByRole("button", { name: /TASK-1/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /TASK-2/ })).toBeNull();

    await user.clear(screen.getByRole("textbox", { name: "搜索任务" }));
    await user.click(screen.getByRole("combobox", { name: "优先级筛选" }));
    await user.click(screen.getByRole("option", { name: "紧急" }));
    expect(screen.getAllByRole("button", { name: /TASK-1/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /TASK-2/ })).toBeNull();
  }, 15_000);

  it("移动端状态 Select 只展示所选状态的单列任务", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    const mobileList = await screen.findByTestId("taskboard-mobile-list");
    expect(mobileList.getAttribute("aria-label")).toBe("需求池任务列表");
    expect(within(mobileList).getByRole("button", { name: /打开任务 TASK-1/ })).toBeTruthy();
    expect(within(mobileList).queryByRole("button", { name: /打开任务 TASK-2/ })).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "移动端状态" }));
    await user.click(screen.getByRole("option", { name: "待处理" }));
    expect(mobileList.getAttribute("aria-label")).toBe("待处理任务列表");
    expect(within(mobileList).getByRole("button", { name: /打开任务 TASK-2/ })).toBeTruthy();
    expect(within(mobileList).queryByRole("button", { name: /打开任务 TASK-1/ })).toBeNull();
  });

  it("每个状态列可快捷新建并预选该状态", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    const inProgressColumn = await screen.findByRole("region", { name: "进行中列" });
    await user.click(within(inProgressColumn).getByRole("button", { name: "在进行中新建任务" }));

    expect(screen.getByRole("heading", { name: "新建任务" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "新任务状态" }).textContent).toContain("进行中");

    await user.type(screen.getByLabelText("标题"), "补充进行中任务");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(mocks.addTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "补充进行中任务",
      status: "in_progress",
    })));
  });

  it("移动端与键盘可用上移下移调整列内顺序", async () => {
    mocks.tasks = [
      taskOne,
      { ...taskTwo, status: "backlog", sortOrder: 2_000 },
    ];
    render(<TaskBoardView />);

    const mobileList = await screen.findByTestId("taskboard-mobile-list");
    const moveUp = within(mobileList).getByRole("button", { name: "上移 TASK-2" });
    expect((moveUp as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(moveUp);

    await waitFor(() => expect(mocks.optimisticMove).toHaveBeenCalled());
    expect(mocks.optimisticMove.mock.calls[0]?.[1]).toEqual({
      status: "backlog",
      previousTaskId: undefined,
      nextTaskId: "task-1",
    });
    expect(within(mobileList).getByRole("button", { name: "下移 TASK-1" })).toBeTruthy();
  });

  it("从看板菜单关闭创建弹窗后，其他按钮仍可立即交互", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    await user.click(await screen.findByRole("button", { name: "看板管理" }));
    await user.click(screen.getByRole("menuitem", { name: "创建看板" }));
    expect(screen.getByRole("heading", { name: "创建看板" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "创建看板" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "新建任务" }));
    expect(screen.getByRole("heading", { name: "新建任务" })).toBeTruthy();
  });

  it("归档看板只读，关键写操作禁用且卡片不可拖拽", async () => {
    mocks.boards = [board("board-1", "已结束项目", true)];
    render(<TaskBoardView />);

    expect(await screen.findByText(/此看板已归档，当前只读/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "新建任务" }) as HTMLButtonElement).disabled).toBe(true);
    for (const card of screen.getAllByTestId("task-card-task-1")) {
      expect(card.getAttribute("draggable")).toBe("false");
    }
  });

  it("任务详情可以发表评论", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    const openButtons = await screen.findAllByRole("button", { name: /打开任务 TASK-1/ });
    await user.click(openButtons[0]);
    const comment = await screen.findByRole("textbox", { name: "发表评论" });
    await user.type(comment, "已完成首轮验证");
    await user.click(screen.getByRole("button", { name: "发表" }));

    await waitFor(() => expect(mocks.addComment).toHaveBeenCalledWith({ body: "已完成首轮验证" }));
    expect(mocks.refreshTasks).toHaveBeenCalled();
  }, 15_000);

  it("拖拽时传相邻任务，409 后显示回滚重拉提示", async () => {
    mocks.tasks = [
      taskOne,
      { ...taskTwo, status: "backlog", sortOrder: 2_000 },
    ];
    mocks.optimisticMove.mockRejectedValueOnce(new TaskBoardConflictError());
    render(<TaskBoardView />);

    const source = (await screen.findAllByTestId("task-card-task-1"))[0];
    const target = screen.getAllByTestId("task-card-task-2")[0];
    const dataTransfer = {
      effectAllowed: "move",
      setData: vi.fn(),
      getData: vi.fn(() => "task-1"),
    };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => expect(mocks.optimisticMove).toHaveBeenCalled());
    expect(mocks.optimisticMove.mock.calls[0]?.[1]).toEqual({
      status: "backlog",
      previousTaskId: undefined,
      nextTaskId: "task-2",
    });
    expect((await screen.findByRole("alert")).textContent).toContain("任务版本已冲突，已回滚并重新加载最新数据");
    expect(screen.getAllByRole("button", { name: /TASK-1/ }).length).toBeGreaterThan(0);
  });

  it("拖拽取消会清除源任务，后续外部拖入不会误移动旧任务", async () => {
    mocks.tasks = [
      taskOne,
      { ...taskTwo, status: "backlog", sortOrder: 2_000 },
    ];
    render(<TaskBoardView />);

    const source = (await screen.findAllByTestId("task-card-task-1"))[0];
    const target = screen.getAllByTestId("task-card-task-2")[0];
    fireEvent.dragStart(source, {
      dataTransfer: { effectAllowed: "move", setData: vi.fn(), getData: vi.fn(() => "task-1") },
    });
    fireEvent.dragEnd(source);
    fireEvent.drop(target, {
      dataTransfer: { getData: vi.fn(() => "external-task") },
    });

    expect(mocks.optimisticMove).not.toHaveBeenCalled();
  });
});
