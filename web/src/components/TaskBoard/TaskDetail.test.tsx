import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelList, TaskBoardExecution, TaskBoardTask } from "@agent/shared";
import { TaskBoardConflictError } from "./api";
import { TaskDetail } from "./TaskDetail";

const mocks = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  addComment: vi.fn(),
  executions: [] as TaskBoardExecution[],
  refreshExecutions: vi.fn(async () => undefined),
  authFetch: vi.fn(),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchTask: mocks.fetchTask };
});

vi.mock("./hooks", () => ({
  useTaskComments: () => ({
    comments: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    addComment: mocks.addComment,
  }),
  useTaskExecutions: () => ({
    executions: mocks.executions,
    loading: false,
    error: null,
    refresh: mocks.refreshExecutions,
  }),
}));

function task(id: string, title: string, version = 3): TaskBoardTask {
  return {
    id,
    boardId: "board-1",
    identifier: id === "task-1" ? "TASK-1" : "TASK-2",
    title,
    description: `${title}正文`,
    status: "backlog",
    priority: "none",
    labels: [],
    sortOrder: id === "task-1" ? 1_000 : 2_000,
    commentCount: 0,
    version,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

const taskOne = task("task-1", "任务一");
const taskTwo = task("task-2", "任务二");
const modelList: ModelList = {
  groups: [{ id: "group-a", name: "模型组", models: [{ id: "model-c", name: "模型 C" }] }],
  default: "group-a/model-c",
  allowCrossGroupSwitch: true,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function props(overrides: Partial<ComponentProps<typeof TaskDetail>> = {}) {
  return {
    open: true,
    task: taskOne,
    boardReadOnly: false,
    onOpenChange: vi.fn(),
    onTaskLoaded: vi.fn(),
    onUpdate: vi.fn(async (current: TaskBoardTask) => current),
    onMove: vi.fn(async (current: TaskBoardTask, status: TaskBoardTask["status"]) => ({
      ...current,
      status,
      version: current.version + 1,
    })),
    onSetArchived: vi.fn(async (current: TaskBoardTask) => current),
    onExecute: vi.fn(),
    onCommentsChanged: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("TaskDetail 草稿隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executions = [];
    mocks.fetchTask.mockImplementation(async (id: string) => id === taskOne.id ? taskOne : taskTwo);
    mocks.addComment.mockResolvedValue(undefined);
  });

  it("改变状态不会重置未保存字段，切换任务会清空评论草稿", async () => {
    const user = userEvent.setup();
    const initialProps = props();
    const { rerender } = render(<TaskDetail {...initialProps} />);
    await waitFor(() => expect(initialProps.onTaskLoaded).toHaveBeenCalledWith(taskOne));

    const title = screen.getByRole("textbox", { name: "标题" }) as HTMLInputElement;
    const comment = screen.getByRole("textbox", { name: "发表评论" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "未保存的新标题" } });
    fireEvent.change(comment, { target: { value: "任务一评论草稿" } });

    await user.click(screen.getByRole("combobox", { name: "任务状态" }));
    await user.click(screen.getByRole("option", { name: "待处理" }));
    await waitFor(() => expect(initialProps.onMove).toHaveBeenCalled());
    expect(title.value).toBe("未保存的新标题");
    expect(comment.value).toBe("任务一评论草稿");

    rerender(<TaskDetail {...initialProps} active={false} />);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "标题" })).toBeNull());
    rerender(<TaskDetail {...initialProps} active />);
    expect((await screen.findByRole("textbox", { name: "标题" }) as HTMLInputElement).value).toBe("未保存的新标题");
    expect((screen.getByRole("textbox", { name: "发表评论" }) as HTMLTextAreaElement).value).toBe("任务一评论草稿");

    rerender(<TaskDetail {...initialProps} task={taskTwo} />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "标题" }) as HTMLInputElement).value).toBe("任务二"));
    expect((screen.getByRole("textbox", { name: "发表评论" }) as HTMLTextAreaElement).value).toBe("");
  }, 10_000);

  it("旧任务保存返回时不会覆盖刚切换的新任务", async () => {
    const user = userEvent.setup();
    const pending = deferred<TaskBoardTask>();
    const onUpdate = vi.fn(() => pending.promise);
    const initialProps = props({ onUpdate });
    const { rerender } = render(<TaskDetail {...initialProps} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    const title = screen.getByRole("textbox", { name: "标题" }) as HTMLInputElement;
    await user.clear(title);
    await user.type(title, "任务一待保存标题");
    await user.click(screen.getByRole("button", { name: "保存任务" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));

    rerender(<TaskDetail {...initialProps} task={taskTwo} />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "标题" }) as HTMLInputElement).value).toBe("任务二"));
    await act(async () => {
      pending.resolve({ ...taskOne, title: "任务一已保存", version: 4 });
      await pending.promise;
    });

    expect((screen.getByRole("textbox", { name: "标题" }) as HTMLInputElement).value).toBe("任务二");
  });

  it("409 后采用服务端 current 版本，但保留用户草稿供再次提交", async () => {
    const user = userEvent.setup();
    const current = {
      ...taskOne,
      title: "其他窗口标题",
      description: "其他窗口新正文",
      priority: "high" as const,
      version: 8,
    };
    const saved = { ...current, title: "我的最终标题", version: 9 };
    const onUpdate = vi.fn()
      .mockRejectedValueOnce(new TaskBoardConflictError("版本冲突", current))
      .mockResolvedValueOnce(saved);
    render(<TaskDetail {...props({ onUpdate })} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    const title = screen.getByRole("textbox", { name: "标题" }) as HTMLInputElement;
    await user.clear(title);
    await user.type(title, saved.title);
    await user.click(screen.getByRole("button", { name: "保存任务" }));
    expect((await screen.findByRole("alert")).textContent).toContain("版本冲突");
    expect(title.value).toBe(saved.title);
    expect((screen.getByRole("textbox", { name: "正文" }) as HTMLTextAreaElement).value).toBe("其他窗口新正文");
    expect(screen.getByRole("combobox", { name: "任务优先级" }).textContent).toContain("高");

    await user.click(screen.getByRole("button", { name: "保存任务" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]?.[0]).toMatchObject({ id: taskOne.id, version: 8 });
    expect(onUpdate.mock.calls[1]?.[1]).toEqual({ title: saved.title });
  });

  it("任务详情可指定模型并保存任务级覆盖", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async (current: TaskBoardTask) => ({
      ...current,
      model: "group-a/model-c",
      version: current.version + 1,
    }));
    render(<TaskDetail {...props({ onUpdate })} modelList={modelList} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    await user.click(screen.getByRole("combobox", { name: "任务运行模型" }));
    await user.click(screen.getByRole("option", { name: "模型 C" }));
    await user.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(taskOne, {
      model: "group-a/model-c",
    }));
  });

  it("工作分支可在任务详情中填写并保存", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async (current: TaskBoardTask) => ({
      ...current,
      branch: "task/TASK-1-feature",
      version: current.version + 1,
    }));
    render(<TaskDetail {...props({ onUpdate })} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    await user.type(screen.getByRole("textbox", { name: "工作分支" }), "task/TASK-1-feature");
    await user.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(taskOne, {
      branch: "task/TASK-1-feature",
    }));
  });

  it("评论可只上传附件后发表", async () => {
    const user = userEvent.setup();
    const uploaded = {
      attachmentId: "44444444-4444-4444-8444-444444444444",
      originalName: "复核记录.pdf",
      relativePath: "uploads/复核记录.pdf",
      size: 6,
      mimeType: "application/pdf",
      isImage: false,
    };
    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({ success: true, files: [uploaded] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    render(<TaskDetail {...props()} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    const pickers = screen.getAllByLabelText("选择附件");
    fireEvent.change(pickers[1], {
      target: { files: [new File(["record"], uploaded.originalName, { type: uploaded.mimeType })] },
    });
    await waitFor(() => expect(screen.getByText(uploaded.originalName)).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "发表" }));

    await waitFor(() => expect(mocks.addComment).toHaveBeenCalledWith({
      body: "",
      attachments: [uploaded],
    }));
  });

  it("待处理任务可以显式交给 Agent，并展示执行会话入口", async () => {
    const user = userEvent.setup();
    const todoTask = { ...taskOne, status: "todo" as const };
    const runningTask = { ...todoTask, status: "in_progress" as const, version: todoTask.version + 1 };
    const execution: TaskBoardExecution = {
      id: "execution-1",
      taskId: todoTask.id,
      runId: "run-1",
      sessionId: "session-1",
      status: "queued",
      purpose: "work",
      requestedBy: "user-1",
      createdAt: todoTask.createdAt,
      updatedAt: todoTask.updatedAt,
    };
    mocks.fetchTask.mockResolvedValue(todoTask);
    const onExecute = vi.fn(async () => ({ task: runningTask, execution }));
    const onTaskLoaded = vi.fn();
    const detailProps = props({ task: todoTask, onExecute, onTaskLoaded });
    const { rerender } = render(<TaskDetail {...detailProps} />);
    await waitFor(() => expect(onTaskLoaded).toHaveBeenCalledWith(todoTask));

    await user.click(screen.getByRole("button", { name: "交给 Agent" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(todoTask, "work"));
    expect(onTaskLoaded).toHaveBeenCalledWith(runningTask);
    expect(mocks.refreshExecutions).toHaveBeenCalled();

    mocks.executions = [execution];
    const manuallyReturnedToTodo = { ...todoTask, version: runningTask.version + 1 };
    rerender(<TaskDetail {...detailProps} task={manuallyReturnedToTodo} />);
    expect(screen.getByRole("button", { name: "排队中" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("link", { name: "打开执行会话" }).getAttribute("href"))
      .toBe("/chat/session-1");
  });

  it("待复核任务可以启动独立 review Agent", async () => {
    const user = userEvent.setup();
    const reviewTask = { ...taskOne, status: "in_review" as const, branch: "task/TASK-1-feature" };
    const runningTask = { ...reviewTask, status: "in_progress" as const, version: reviewTask.version + 1 };
    const execution: TaskBoardExecution = {
      id: "execution-review",
      taskId: reviewTask.id,
      runId: "run-review",
      sessionId: "session-review",
      status: "queued",
      purpose: "review",
      requestedBy: "user-1",
      createdAt: reviewTask.createdAt,
      updatedAt: reviewTask.updatedAt,
    };
    mocks.fetchTask.mockResolvedValue(reviewTask);
    const onExecute = vi.fn(async () => ({ task: runningTask, execution }));
    render(<TaskDetail {...props({ task: reviewTask, onExecute })} />);

    await user.click(await screen.findByRole("button", { name: "独立复核" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(reviewTask, "review"));
  });
});
