import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  completeTask: vi.fn(),
  setArchived: vi.fn(),
  executeTask: vi.fn(),
  optimisticMove: vi.fn(),
  syncTask: vi.fn(),
  addComment: vi.fn(async () => undefined),
  fetchTask: vi.fn(),
  createIntegrationBatch: vi.fn(),
}));

vi.mock("./hooks", () => ({
  useTaskboardModelList: () => null,
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
    completeTask: mocks.completeTask,
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
  return {
    ...actual,
    fetchTask: mocks.fetchTask,
    createIntegrationBatch: mocks.createIntegrationBatch,
  };
});

function board(id: string, name: string, archived = false): TaskBoard {
  return {
    id,
    name,
    description: `${name}说明`,
    visibility: "personal",
    ownerUserId: "user-1",
    canManage: true,
    prompt: `${name}提示语`,
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
    window.localStorage.clear();
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

  it("切回任务看板时重新加载看板和任务", async () => {
    const { rerender } = render(<TaskBoardView active={false} />);
    expect(mocks.refreshBoards).not.toHaveBeenCalled();
    expect(mocks.refreshTasks).not.toHaveBeenCalled();

    rerender(<TaskBoardView active />);

    await waitFor(() => expect(mocks.refreshBoards).toHaveBeenCalledOnce());
    expect(mocks.refreshTasks).toHaveBeenCalledOnce();
  });

  it("停留在任务看板时持续刷新任务，离开后停止", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<TaskBoardView active />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(mocks.refreshTasks).toHaveBeenCalledOnce();
      expect(mocks.refreshBoards).not.toHaveBeenCalled();

      rerender(<TaskBoardView active={false} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(mocks.refreshTasks).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("支持多看板、固定八列、关键词与优先级筛选", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择看板" })).toBeTruthy());
    expect(screen.getAllByRole("region", { name: /列$/ }).map((column) => column.getAttribute("aria-label"))).toEqual([
      "需求池列",
      "待推进列",
      "实施中列",
      "复核中列",
      "待合并列",
      "已阻塞列",
      "已取消列",
      "已完成列",
    ]);

    await user.click(screen.getByRole("combobox", { name: "选择看板" }));
    expect(screen.getByRole("option", { name: "产品研发（个人）" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "市场事项（个人）" })).toBeTruthy();
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

  it("可以将看板下拉选项向上拖动，并将顺序保存在浏览器本地", async () => {
    const user = userEvent.setup();
    const view = render(<TaskBoardView />);
    const trigger = screen.getByRole("combobox", { name: "选择看板" });
    await user.click(trigger);

    const source = screen.getByRole("option", { name: "市场事项（个人）" });
    const target = screen.getByRole("option", { name: "产品研发（个人）" });
    const sourceHandle = within(source).getByTitle("拖动调整看板顺序（仅保存在本浏览器）");
    expect(source.getAttribute("draggable")).toBeNull();
    expect(sourceHandle.getAttribute("draggable")).toBe("true");
    const indicator = source.querySelector("[data-select-item-indicator]");
    expect(source.querySelector("[data-board-drag-handle]")).toBe(sourceHandle);
    expect(indicator?.classList.contains("right-2")).toBe(true);

    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => "board-2"),
    };
    fireEvent.dragStart(sourceHandle, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "市场事项（个人）",
      "产品研发（个人）",
    ]);
    expect(window.localStorage.getItem("taskboard:board-order")).toBe('["board-2","board-1"]');

    view.unmount();
    render(<TaskBoardView />);
    await user.click(screen.getByRole("combobox", { name: "选择看板" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "市场事项（个人）",
      "产品研发（个人）",
    ]);
  });

  it("可以将看板下拉选项向下拖动，并将顺序保存在浏览器本地", async () => {
    const user = userEvent.setup();
    const view = render(<TaskBoardView />);
    await user.click(screen.getByRole("combobox", { name: "选择看板" }));

    const source = screen.getByRole("option", { name: "产品研发（个人）" });
    const target = screen.getByRole("option", { name: "市场事项（个人）" });
    const sourceHandle = within(source).getByTitle("拖动调整看板顺序（仅保存在本浏览器）");
    const dataTransfer = {
      effectAllowed: "move",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => "board-1"),
    };
    fireEvent.dragStart(sourceHandle, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "市场事项（个人）",
      "产品研发（个人）",
    ]);
    expect(window.localStorage.getItem("taskboard:board-order")).toBe('["board-2","board-1"]');

    view.unmount();
    render(<TaskBoardView />);
    await user.click(screen.getByRole("combobox", { name: "选择看板" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "市场事项（个人）",
      "产品研发（个人）",
    ]);
  });

  it("筛选栏移除状态筛选并支持按提交人筛选", async () => {
    const user = userEvent.setup();
    mocks.tasks = [
      { ...taskOne, creatorUserId: "user-a", creatorName: "甲 @jia" },
      { ...taskTwo, creatorUserId: "user-b", creatorName: "乙 @yi" },
    ];
    render(<TaskBoardView />);

    expect(await screen.findByRole("combobox", { name: "提交人筛选" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "状态筛选" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "提交人筛选" }));
    await user.click(screen.getByRole("option", { name: "甲 @jia" }));

    expect(screen.getAllByRole("button", { name: /TASK-1/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /TASK-2/ })).toBeNull();
  });

  it("工作流状态和已取消状态按更新时间倒序展示", async () => {
    const user = userEvent.setup();
    const olderDone = {
      ...taskOne,
      id: "older-done",
      identifier: "TASK-OLDER-DONE",
      title: "较早完成",
      status: "done" as const,
      updatedAt: "2026-08-18T10:00:00.000Z",
    };
    const newerDone = {
      ...taskTwo,
      id: "newer-done",
      identifier: "TASK-NEWER-DONE",
      title: "较新完成",
      status: "done" as const,
      updatedAt: "2026-08-19T10:00:00.000Z",
    };
    const olderCanceled = {
      ...taskOne,
      id: "older-canceled",
      identifier: "TASK-OLDER-CANCELED",
      title: "较早取消",
      status: "canceled" as const,
      updatedAt: "2026-08-18T10:00:00.000Z",
    };
    const newerCanceled = {
      ...taskTwo,
      id: "newer-canceled",
      identifier: "TASK-NEWER-CANCELED",
      title: "较新取消",
      status: "canceled" as const,
      updatedAt: "2026-08-19T10:00:00.000Z",
    };
    mocks.tasks = [olderDone, newerDone, olderCanceled, newerCanceled];
    render(<TaskBoardView />);

    expect(screen.getByTestId("task-card-older-done").getAttribute("draggable")).toBe("false");
    expect(screen.getByTestId("task-card-older-canceled").getAttribute("draggable")).toBe("true");

    const doneColumn = await screen.findByTestId("taskboard-done-column");
    await user.click(screen.getByTitle("展开已完成列"));
    expect(within(doneColumn).getAllByRole("button", { name: /打开任务/ }).map((button) => button.textContent)).toEqual([
      expect.stringContaining("TASK-NEWER-DONE"),
      expect.stringContaining("TASK-OLDER-DONE"),
    ]);

    const canceledColumn = screen.getByRole("region", { name: "已取消列" });
    expect(within(canceledColumn).getAllByRole("button", { name: /打开任务/ }).map((button) => button.textContent)).toEqual([
      expect.stringContaining("TASK-NEWER-CANCELED"),
      expect.stringContaining("TASK-OLDER-CANCELED"),
    ]);
  });

  it("自动排序列允许跨阶段拖拽，但禁止同列重排", async () => {
    const canceledTask = {
      ...taskOne,
      id: "canceled-task",
      identifier: "TASK-CANCELED",
      status: "canceled" as const,
      updatedAt: "2026-08-19T10:00:00.000Z",
    };
    const backlogTask = {
      ...taskTwo,
      id: "backlog-task",
      identifier: "TASK-BACKLOG",
      status: "backlog" as const,
    };
    mocks.tasks = [canceledTask, backlogTask];
    const firstView = render(<TaskBoardView />);

    const source = screen.getByTestId("task-card-canceled-task");
    const target = screen.getAllByTestId("task-card-backlog-task")[0];
    expect(source.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(source, {
      dataTransfer: { effectAllowed: "move", setData: vi.fn(), getData: vi.fn(() => source.dataset.testid) },
    });
    fireEvent.drop(target, {
      dataTransfer: { getData: vi.fn(() => canceledTask.id) },
    });

    await waitFor(() => expect(mocks.optimisticMove).toHaveBeenCalled());
    expect(mocks.optimisticMove.mock.calls[0]?.[1]).toEqual({
      status: "backlog",
      previousTaskId: undefined,
      nextTaskId: backlogTask.id,
    });

    firstView.unmount();
    mocks.optimisticMove.mockClear();
    const reverseBacklogTask = { ...backlogTask, id: "reverse-backlog-task", identifier: "TASK-REVERSE-BACKLOG" };
    const reverseCanceledTask = { ...canceledTask, id: "reverse-canceled-task", identifier: "TASK-REVERSE-CANCELED" };
    mocks.tasks = [reverseBacklogTask, reverseCanceledTask];
    const reverseView = render(<TaskBoardView />);
    fireEvent.dragStart(screen.getAllByTestId("task-card-reverse-backlog-task")[0], {
      dataTransfer: { effectAllowed: "move", setData: vi.fn(), getData: vi.fn(() => reverseBacklogTask.id) },
    });
    fireEvent.drop(screen.getByTestId("task-card-reverse-canceled-task"), {
      dataTransfer: { getData: vi.fn(() => reverseBacklogTask.id) },
    });
    await waitFor(() => expect(mocks.optimisticMove).toHaveBeenCalled());
    expect(mocks.optimisticMove.mock.calls[0]?.[1]).toEqual({
      status: "canceled",
      previousTaskId: undefined,
      nextTaskId: undefined,
    });

    reverseView.unmount();
    mocks.optimisticMove.mockClear();
    const secondCanceledTask = {
      ...canceledTask,
      id: "canceled-task-2",
      identifier: "TASK-CANCELED-2",
      updatedAt: "2026-08-18T10:00:00.000Z",
    };
    mocks.tasks = [canceledTask, secondCanceledTask];
    render(<TaskBoardView />);
    fireEvent.dragStart(screen.getByTestId("task-card-canceled-task"), {
      dataTransfer: { effectAllowed: "move", setData: vi.fn(), getData: vi.fn(() => canceledTask.id) },
    });
    fireEvent.drop(screen.getByTestId("task-card-canceled-task-2"), {
      dataTransfer: { getData: vi.fn(() => canceledTask.id) },
    });

    expect(mocks.optimisticMove).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain("按更新时间排序，不能手动重排");
  });

  it("已完成列默认显示为竖排窄轨，展开状态按看板记忆", async () => {
    const user = userEvent.setup();
    const doneTask = {
      ...taskOne,
      id: "done-task",
      identifier: "TASK-DONE",
      status: "done" as const,
    };
    mocks.tasks = [doneTask];
    const view = render(<TaskBoardView />);

    const doneColumn = await screen.findByTestId("taskboard-done-column");
    expect(doneColumn.hasAttribute("open")).toBe(false);
    expect(doneColumn.className).toContain("w-10");
    expect(doneColumn.className).not.toContain("absolute");
    expect(within(doneColumn).getByText("已完成").className).toContain("writing-mode:vertical-rl");

    await user.click(screen.getByTitle("展开已完成列"));
    await waitFor(() => expect(doneColumn.hasAttribute("open")).toBe(true));
    expect(doneColumn.className).toContain("w-72");
    expect(within(doneColumn).getByTestId("task-card-done-task")).toBeTruthy();
    expect(window.localStorage.getItem("taskboard:board-1:done-collapsed")).toBe("false");

    view.unmount();
    render(<TaskBoardView />);
    const restoredDoneColumn = await screen.findByTestId("taskboard-done-column");
    expect(restoredDoneColumn.hasAttribute("open")).toBe(true);

    await user.click(screen.getByTitle("折叠已完成列"));
    await waitFor(() => expect(restoredDoneColumn.hasAttribute("open")).toBe(false));
    expect(restoredDoneColumn.className).toContain("w-10");
  });

  it("已取消列默认显示为竖排窄轨，展开状态按看板记忆", async () => {
    const user = userEvent.setup();
    const canceledTask = {
      ...taskOne,
      id: "canceled-task",
      identifier: "TASK-CANCELED",
      status: "canceled" as const,
    };
    mocks.tasks = [canceledTask];
    const view = render(<TaskBoardView />);

    const canceledColumn = await screen.findByTestId("taskboard-canceled-column");
    expect(canceledColumn.hasAttribute("open")).toBe(false);
    expect(canceledColumn.className).toContain("w-10");
    expect(canceledColumn.className).not.toContain("absolute");
    expect(within(canceledColumn).getByText("已取消").className).toContain("writing-mode:vertical-rl");

    await user.click(screen.getByTitle("展开已取消列"));
    await waitFor(() => expect(canceledColumn.hasAttribute("open")).toBe(true));
    expect(canceledColumn.className).toContain("w-72");
    expect(within(canceledColumn).getByTestId("task-card-canceled-task")).toBeTruthy();
    expect(window.localStorage.getItem("taskboard:board-1:canceled-collapsed")).toBe("false");

    view.unmount();
    render(<TaskBoardView />);
    const restoredCanceledColumn = await screen.findByTestId("taskboard-canceled-column");
    expect(restoredCanceledColumn.hasAttribute("open")).toBe(true);

    await user.click(screen.getByTitle("折叠已取消列"));
    await waitFor(() => expect(restoredCanceledColumn.hasAttribute("open")).toBe(false));
    expect(restoredCanceledColumn.className).toContain("w-10");
  });

  it("移动端状态 Select 只展示所选状态的单列任务", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    const mobileList = await screen.findByTestId("taskboard-mobile-list");
    expect(mobileList.getAttribute("aria-label")).toBe("需求池任务列表");
    expect(within(mobileList).getByRole("button", { name: /打开任务 TASK-1/ })).toBeTruthy();
    expect(within(mobileList).queryByRole("button", { name: /打开任务 TASK-2/ })).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "移动端状态" }));
    await user.click(screen.getByRole("option", { name: "待推进" }));
    expect(mobileList.getAttribute("aria-label")).toBe("待推进任务列表");
    expect(within(mobileList).getByRole("button", { name: /打开任务 TASK-2/ })).toBeTruthy();
    expect(within(mobileList).queryByRole("button", { name: /打开任务 TASK-1/ })).toBeNull();
  });

  it("仅需求池和待推进列可快捷新建，工作流状态禁止直接创建", async () => {
    const user = userEvent.setup();
    render(<TaskBoardView />);

    const inProgressColumn = await screen.findByRole("region", { name: "实施中列" });
    expect(within(inProgressColumn).queryByRole("button", { name: "在实施中新建任务" })).toBeNull();

    const backlogColumn = screen.getByRole("region", { name: "需求池列" });
    await user.click(within(backlogColumn).getByRole("button", { name: "在需求池新建任务" }));

    expect(screen.getByRole("heading", { name: "新建任务" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "新任务状态" }).textContent).toContain("需求池");

    await user.type(screen.getByRole("textbox", { name: "正文" }), "补充需求池任务");
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(mocks.addTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "补充需求池任务",
      status: "backlog",
    })));
  });

  it("卡片不展示上移下移排序操作区", async () => {
    mocks.tasks = [
      taskOne,
      { ...taskTwo, status: "backlog", sortOrder: 2_000 },
    ];
    render(<TaskBoardView />);

    await screen.findByTestId("taskboard-mobile-list");
    expect(screen.queryByRole("button", { name: /上移 TASK-/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /下移 TASK-/ })).toBeNull();
    expect(screen.queryByLabelText(/TASK-\d+ 排序操作/)).toBeNull();
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

  it("旧组织看板缺少 capabilities 时非 owner 默认只读", async () => {
    const user = userEvent.setup();
    mocks.boards = [{
      ...board("board-1", "组织协作"),
      visibility: "organization",
      canManage: false,
      ownerUserId: "owner-1",
    }];
    render(<TaskBoardView />);

    expect(screen.queryByText(/组织看板 · 当前角色：编辑者/)).toBeNull();
    expect((screen.getByRole("button", { name: "新建任务" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "看板管理" }));
    expect(screen.getByRole("menuitem", { name: "看板设置与成员" }).getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "归档看板" }).getAttribute("data-disabled")).not.toBeNull();
  });

  it("维护者可多选已复核的待合并交付任务并创建人工集成批次", async () => {
    const user = userEvent.setup();
    const integrationBoard: TaskBoard = {
      ...board("board-1", "自动集成"),
      role: "maintainer",
      canManage: false,
      allowedActions: ["board.read", "integration.create"],
      repository: {
        provider: "github",
        repositoryId: "repo-1",
        owner: "kaiyan",
        name: "agent-saas",
        baseBranch: "main",
        allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1,
        enabled: true,
        revision: "r1",
        trigger: { mode: "manual", allowedRoles: ["maintainer", "owner"] },
        batch: { maxTasks: 2, selection: "priority_then_ready_at" },
        execution: {
          mergeMethod: "squash",
          continueIndependentSources: true,
          autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 2,
          maxTransientRetries: 3,
          requireGreenChecks: true,
          deleteRemoteBranch: false,
          deploy: false,
        },
      },
    };
    const readyTask = {
      ...taskOne,
      kind: "delivery" as const,
      status: "ready_to_merge" as const,
      providerPullRequestId: "pr-1",
      pullRequestNumber: 88,
      reviewedSubjectDigest: "sha256:reviewed",
      mergeEligibility: "eligible" as const,
    };
    const integrationTask = {
      ...taskTwo,
      id: "integration-1",
      identifier: "TASK-9",
      kind: "integration" as const,
      status: "todo" as const,
    };
    mocks.boards = [integrationBoard];
    mocks.tasks = [readyTask];
    mocks.createIntegrationBatch.mockResolvedValue({
      task: integrationTask,
      execution: {
        id: "execution-1",
        taskId: integrationTask.id,
        runId: "run-1",
        sessionId: "session-1",
        status: "queued",
        purpose: "merge",
        requestedBy: "user-1",
        createdAt: taskOne.createdAt,
        updatedAt: taskOne.updatedAt,
      },
    });
    render(<TaskBoardView />);
    const integrationButton = await screen.findByRole("button", { name: "创建集成批次（0）" });
    const readyToMergeColumn = screen.getByRole("region", { name: "待合并列" });
    expect(readyToMergeColumn.contains(integrationButton)).toBe(true);
    expect((integrationButton as HTMLButtonElement).disabled).toBe(true);
    expect(integrationButton.className).not.toContain("bg-emerald-600");
    expect(screen.queryByText(/在“待合并”列勾选已复核且已绑定 PR 的交付任务/)).toBeNull();
    const choices = await screen.findAllByRole("checkbox", { name: "选择 TASK-1 加入人工集成批次" });
    await user.click(choices[0]);
    const activeIntegrationButton = screen.getByRole("button", { name: "创建集成批次（1）" });
    expect((activeIntegrationButton as HTMLButtonElement).disabled).toBe(false);
    expect(activeIntegrationButton.className).toContain("bg-emerald-600");
    await user.click(activeIntegrationButton);
    await waitFor(() => expect(mocks.createIntegrationBatch).toHaveBeenCalledWith("board-1", {
      deliveryTaskIds: [readyTask.id],
      expectedBoardVersion: integrationBoard.version,
    }));
    expect(mocks.syncTask).toHaveBeenCalledWith(integrationTask);
    expect(mocks.refreshBoards).toHaveBeenCalled();
    expect(mocks.refreshTasks).toHaveBeenCalled();
  });

  it("归档入口默认显示为终态列旁的竖排窄轨，点击后打开独立抽屉", async () => {
    const user = userEvent.setup();
    const archivedTask = {
      ...taskTwo,
      id: "archived-task",
      identifier: "TASK-ARCHIVED",
      title: "",
      archivedAt: "2026-08-18T00:00:00.000Z",
    };
    mocks.tasks = [taskOne, archivedTask];
    render(<TaskBoardView />);
    const archivedColumn = await screen.findByTestId("taskboard-archived-column");
    expect(archivedColumn.className).toContain("w-10");
    expect(within(archivedColumn).getByText("归档").className).toContain("writing-mode:vertical-rl");
    await user.click(screen.getByRole("button", { name: "查看已归档任务（1）" }));
    expect(screen.getByRole("heading", { name: "已归档任务（1）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开已归档任务 TASK-ARCHIVED" })).toBeTruthy();
    expect(screen.getAllByText("TASK-ARCHIVED")).toHaveLength(1);

    await user.type(screen.getByRole("textbox", { name: "搜索已归档任务" }), "不存在");
    expect(screen.getByText("没有符合筛选条件的归档任务")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "搜索已归档任务" }));
    await user.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => expect(mocks.setArchived).toHaveBeenCalledWith(archivedTask, false));
  });

  it("allowedActions 将查看者的任务写按钮和拖拽全部门禁", async () => {
    mocks.boards = [{
      ...board("board-1", "只读协作"),
      role: "viewer",
      canManage: false,
      allowedActions: ["board.read"],
    }];
    render(<TaskBoardView />);

    expect((await screen.findByRole("button", { name: "新建任务" }) as HTMLButtonElement).disabled).toBe(true);
    for (const card of screen.getAllByTestId("task-card-task-1")) {
      expect(card.getAttribute("draggable")).toBe("false");
    }
    expect(screen.queryByRole("button", { name: /创建集成批次/ })).toBeNull();
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

    await waitFor(() => {
      expect(mocks.addComment).toHaveBeenCalledWith({ body: "已完成首轮验证" });
      expect(mocks.refreshTasks).toHaveBeenCalled();
    });
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

  it("邻居校验失败时显示中文重试提示", async () => {
    mocks.tasks = [taskOne];
    mocks.optimisticMove.mockRejectedValueOnce(new Error("Move neighbors are stale or not adjacent"));
    render(<TaskBoardView />);

    const source = (await screen.findAllByTestId("task-card-task-1"))[0];
    const todoColumn = screen.getByRole("region", { name: "待推进列" });
    const dataTransfer = {
      effectAllowed: "move",
      setData: vi.fn(),
      getData: vi.fn(() => "task-1"),
    };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.drop(within(todoColumn).getByText("暂无任务"), { dataTransfer });

    expect((await screen.findByRole("alert")).textContent).toContain("移动任务失败，已回滚并重新加载最新数据，请刷新后重试。");
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
