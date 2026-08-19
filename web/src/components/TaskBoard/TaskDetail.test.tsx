import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelList, TaskBoardComment, TaskBoardExecution, TaskBoardTask } from "@agent/shared";
import { TaskBoardConflictError } from "./api";
import { TaskDetail } from "./TaskDetail";

const mocks = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  continueTaskExecution: vi.fn(),
  resumeTask: vi.fn(),
  fetchIntegrationSources: vi.fn(),
  addComment: vi.fn(),
  refreshComments: vi.fn(async () => undefined),
  comments: [] as TaskBoardComment[],
  executions: [] as TaskBoardExecution[],
  refreshExecutions: vi.fn(async () => undefined),
  authFetch: vi.fn(),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchTask: mocks.fetchTask,
    fetchIntegrationSources: mocks.fetchIntegrationSources,
    continueTaskExecution: mocks.continueTaskExecution,
    resumeTask: mocks.resumeTask,
  };
});

vi.mock("./hooks", () => ({
  useTaskComments: () => ({
    comments: mocks.comments,
    loading: false,
    error: null,
    refresh: mocks.refreshComments,
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
    mocks.comments = [];
    mocks.executions = [];
    mocks.fetchTask.mockImplementation(async (id: string) => id === taskOne.id ? taskOne : taskTwo);
    mocks.fetchIntegrationSources.mockResolvedValue([]);
    mocks.addComment.mockResolvedValue(undefined);
  });

  it("桌面任务详情使用等宽双栏并保持两栏独立滚动", async () => {
    render(<TaskDetail {...props()} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    expect(screen.getByRole("dialog").className).toContain("sm:max-w-[95vw]");
    expect(screen.getByTestId("task-detail-columns").className).toContain("lg:grid-cols-2");
    expect(screen.getByTestId("task-detail-information").className).toContain("overflow-y-auto");
    expect(screen.getByRole("region", { name: "任务评论" }).className).toContain("flex-col");
  });

  it("评论按 Markdown 渲染并安全打开外部链接", async () => {
    mocks.comments = [{
      id: "comment-markdown",
      taskId: taskOne.id,
      body: "## 进展\n\n已完成 **双栏布局**，详见 [说明](https://example.com/docs)。",
      authorType: "agent",
      authorId: "agent-1",
      authorName: "麦迪文",
      version: 1,
      createdAt: "2026-08-19T00:30:00.000Z",
      updatedAt: "2026-08-19T00:30:00.000Z",
    }];

    render(<TaskDetail {...props()} />);

    expect(await screen.findByRole("heading", { name: "进展" })).toBeTruthy();
    expect(screen.getByText("双栏布局").tagName).toBe("STRONG");
    const link = screen.getByRole("link", { name: "说明" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("评论展示 Agent 阶段胶囊、关联会话，并用用户消息色区分用户评论", async () => {
    mocks.comments = [
      {
        id: "comment-agent",
        taskId: taskOne.id,
        body: "Agent 已完成实施。",
        authorType: "agent",
        authorId: "run-work",
        authorName: "旧显示名",
        sessionId: "session-work",
        executionId: "execution-work",
        executionPurpose: "work",
        version: 1,
        createdAt: "2026-08-19T01:00:00.000Z",
        updatedAt: "2026-08-19T01:00:00.000Z",
      },
      {
        id: "comment-user",
        taskId: taskOne.id,
        body: "用户补充意见",
        authorType: "user",
        authorId: "user-1",
        authorName: "曾磊",
        sessionId: "session-work",
        executionPurpose: "work",
        version: 1,
        createdAt: "2026-08-19T01:01:00.000Z",
        updatedAt: "2026-08-19T01:01:00.000Z",
      },
    ];
    const { container } = render(<TaskDetail {...props()} />);

    expect(await screen.findAllByText("实施阶段")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "打开会话" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "打开会话" })[0]?.getAttribute("href")).toBe("/chat/session-work");
    expect(screen.queryByText("支持 Markdown 格式")).toBeNull();
    expect(screen.getByText("用户补充意见").closest("[class*='bg-user-bubble']")).toBeTruthy();
    expect(container.querySelector("[aria-label='任务评论'] .size-8")).toBeNull();
  });

  it("执行开始后锁定标题和正文，但保留评论入口", async () => {
    const runningTask = { ...taskOne, status: "in_progress" as const };
    const execution: TaskBoardExecution = {
      id: "execution-lock",
      taskId: runningTask.id,
      runId: "run-lock",
      sessionId: "session-lock",
      status: "running",
      purpose: "work",
      requestedBy: "user-1",
      createdAt: runningTask.createdAt,
      updatedAt: runningTask.updatedAt,
    };
    mocks.executions = [execution];
    mocks.fetchTask.mockResolvedValue(runningTask);
    render(<TaskDetail {...props({ task: runningTask })} />);

    expect((await screen.findByRole("textbox", { name: "标题" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "正文" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "发表评论" }) as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByText("任务首次执行后，标题和正文已锁定；后续变更请通过评论补充。")).toBeTruthy();
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
    await user.click(screen.getByRole("option", { name: "待实施" }));
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

  it("任务详情可按阶段指定模型并保存任务级覆盖", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async (current: TaskBoardTask) => ({
      ...current,
      stageModels: { work: "group-a/model-c" },
      version: current.version + 1,
    }));
    render(<TaskDetail {...props({ onUpdate })} modelList={modelList} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    await user.click(screen.getByRole("combobox", { name: "实施阶段运行模型" }));
    await user.click(screen.getByRole("option", { name: "模型 C" }));
    await user.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(taskOne, {
      stageModels: { work: "group-a/model-c" },
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

  it("advisory 可确认后单向升级为 delivery", async () => {
    const user = userEvent.setup();
    const advisory = { ...taskOne, kind: "advisory" as const, status: "blocked" as const };
    const promoted = { ...advisory, kind: "delivery" as const, status: "todo" as const, version: advisory.version + 1 };
    mocks.fetchTask.mockResolvedValue(advisory);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onUpdate = vi.fn(async () => promoted);
    render(<TaskDetail {...props({ task: advisory, onUpdate })} />);

    await user.click(await screen.findByRole("button", { name: "升级为交付任务" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(advisory, { kind: "delivery" }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("不能改回 advisory"));
    expect(await screen.findByText("交付任务")).toBeTruthy();
    expect(screen.getAllByText("待实施").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "升级为交付任务" })).toBeNull();
    confirmSpy.mockRestore();
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

  it("发表评论后可复用任务会话继续执行", async () => {
    const user = userEvent.setup();
    const published = {
      id: "comment-continue",
      taskId: taskOne.id,
      body: "按新验收条件继续",
      authorType: "user" as const,
      authorId: "user-1",
      authorName: "Alice",
      version: 1,
      createdAt: taskOne.createdAt,
      updatedAt: taskOne.updatedAt,
    };
    const todoTask = { ...taskOne, status: "todo" as const };
    const runningTask = { ...todoTask, status: "in_progress" as const, version: 4 };
    const execution: TaskBoardExecution = {
      id: "execution-1",
      taskId: taskOne.id,
      runId: "run-1",
      sessionId: "session-1",
      status: "running",
      purpose: "work",
      requestedBy: "user-1",
      createdAt: taskOne.createdAt,
      updatedAt: taskOne.updatedAt,
    };
    mocks.addComment.mockResolvedValue(published);
    mocks.continueTaskExecution.mockResolvedValue({ task: runningTask, execution });
    mocks.fetchTask.mockResolvedValue(todoTask);
    const onTaskLoaded = vi.fn();
    render(<TaskDetail {...props({ task: todoTask, onTaskLoaded })} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    await user.type(screen.getByRole("textbox", { name: "发表评论" }), published.body);
    await user.click(screen.getByRole("checkbox", { name: "发表后继续实施" }));
    await user.click(screen.getByRole("button", { name: "发表" }));

    await waitFor(() => expect(mocks.continueTaskExecution).toHaveBeenCalledWith(taskOne.id, published.id));
    expect(onTaskLoaded).toHaveBeenCalledWith(runningTask);
    expect(mocks.refreshExecutions).toHaveBeenCalled();
  });

  it("实施中且存在 active execution 时评论可继续实施", async () => {
    const user = userEvent.setup();
    const current = { ...taskOne, status: "in_progress" as const };
    const published = {
      id: "comment-active-in-progress",
      taskId: current.id,
      body: "继续当前实施",
      authorType: "user" as const,
      authorId: "user-1",
      authorName: "Alice",
      version: 1,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    };
    const execution: TaskBoardExecution = {
      id: "execution-active-in-progress",
      taskId: current.id,
      runId: "run-active-in-progress",
      sessionId: "session-active-in-progress",
      status: "running",
      purpose: "work",
      requestedBy: "user-1",
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    };
    mocks.fetchTask.mockResolvedValue(current);
    mocks.executions = [execution];
    mocks.addComment.mockResolvedValue(published);
    mocks.continueTaskExecution.mockResolvedValue({ task: current, execution });
    render(<TaskDetail {...props({ task: current })} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(current.id));

    await user.type(screen.getByRole("textbox", { name: "发表评论" }), published.body);
    await user.click(screen.getByRole("checkbox", { name: "发表后继续实施" }));
    await user.click(screen.getByRole("button", { name: "发表" }));

    await waitFor(() => expect(mocks.addComment).toHaveBeenCalledWith({ body: published.body }));
    expect(mocks.continueTaskExecution).toHaveBeenCalledWith(current.id, published.id);
  });

  it("评论已发表但续跑失败时使用原 commentId 幂等重试", async () => {
    const user = userEvent.setup();
    const published = {
      id: "comment-retry",
      taskId: taskOne.id,
      body: "保留这条评论重试",
      authorType: "user" as const,
      authorId: "user-1",
      authorName: "Alice",
      version: 1,
      createdAt: taskOne.createdAt,
      updatedAt: taskOne.updatedAt,
    };
    const execution: TaskBoardExecution = {
      id: "execution-retry",
      taskId: taskOne.id,
      runId: "run-retry",
      sessionId: "session-retry",
      status: "running",
      purpose: "work",
      requestedBy: "user-1",
      createdAt: taskOne.createdAt,
      updatedAt: taskOne.updatedAt,
    };
    mocks.addComment.mockResolvedValue(published);
    mocks.continueTaskExecution
      .mockRejectedValueOnce(new Error("临时派发失败"))
      .mockResolvedValueOnce({ task: { ...taskOne, status: "in_progress" }, execution });
    const todoTask = { ...taskOne, status: "todo" as const };
    mocks.fetchTask.mockResolvedValue(todoTask);
    render(<TaskDetail {...props({ task: todoTask })} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));

    await user.type(screen.getByRole("textbox", { name: "发表评论" }), published.body);
    await user.click(screen.getByRole("checkbox", { name: "发表后继续实施" }));
    await user.click(screen.getByRole("button", { name: "发表" }));
    await screen.findByText(/评论已发表，但继续执行失败，可重试/);

    await user.click(screen.getByRole("button", { name: "重试继续执行" }));
    await waitFor(() => expect(mocks.continueTaskExecution).toHaveBeenCalledTimes(2));
    expect(mocks.continueTaskExecution).toHaveBeenNthCalledWith(2, taskOne.id, published.id);
    expect(mocks.addComment).toHaveBeenCalledTimes(1);
  });

  it.each(["ready_to_merge", "done", "canceled"] as const)(
    "不可创建 Execution 的 %s 任务仍可单独发表评论",
    async (status) => {
      const user = userEvent.setup();
      const current = { ...taskOne, status };
      const body = `状态 ${status} 的普通评论`;
      mocks.fetchTask.mockResolvedValue(current);
      render(<TaskDetail {...props({ task: current })} />);
      await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(current.id));

      expect(screen.queryByRole("checkbox", { name: /发表后继续/ })).toBeNull();
      await user.type(screen.getByRole("textbox", { name: "发表评论" }), body);
      await user.click(screen.getByRole("button", { name: "发表" }));

      await waitFor(() => expect(mocks.addComment).toHaveBeenCalledWith({ body }));
      expect(mocks.continueTaskExecution).not.toHaveBeenCalled();
    },
  );

  it("正式 Execution 已终态时持续等待独立续跑，并在完成后刷新任务与评论", async () => {
    const runningTask = { ...taskOne, status: "in_progress" as const, version: 4 };
    const finalTask = { ...runningTask, status: "in_review" as const, version: 5 };
    const terminalExecution: TaskBoardExecution = {
      id: "execution-terminal",
      taskId: taskOne.id,
      runId: "run-terminal",
      sessionId: "session-terminal",
      status: "succeeded",
      purpose: "work",
      requestedBy: "user-1",
      continuationActive: true,
      createdAt: taskOne.createdAt,
      updatedAt: taskOne.updatedAt,
    };
    mocks.executions = [terminalExecution];
    mocks.fetchTask.mockResolvedValue(runningTask);
    const onTaskLoaded = vi.fn();
    const detailProps = props({ task: runningTask, onTaskLoaded });
    const { rerender } = render(<TaskDetail {...detailProps} />);
    await waitFor(() => expect(onTaskLoaded).toHaveBeenCalledWith(runningTask));

    mocks.fetchTask.mockClear();
    mocks.refreshComments.mockClear();
    onTaskLoaded.mockClear();
    mocks.fetchTask.mockResolvedValue(finalTask);
    mocks.executions = [{ ...terminalExecution, continuationActive: false }];
    rerender(<TaskDetail {...detailProps} />);

    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(taskOne.id));
    expect(mocks.refreshComments).toHaveBeenCalled();
    expect(onTaskLoaded).toHaveBeenCalledWith(finalTask);
  });

  it("待实施任务可以显式交给 Agent，并展示执行会话入口", async () => {
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

    await user.click(screen.getByRole("button", { name: "开始实施" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(todoTask, "work"));
    expect(onTaskLoaded).toHaveBeenCalledWith(runningTask);
    expect(mocks.refreshExecutions).toHaveBeenCalled();

    mocks.executions = [execution];
    const manuallyReturnedToTodo = { ...todoTask, version: runningTask.version + 1 };
    rerender(<TaskDetail {...detailProps} task={manuallyReturnedToTodo} />);
    expect(screen.getByRole("button", { name: "排队中" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("link", { name: "打开当前执行会话" }).getAttribute("href"))
      .toBe("/chat/session-1");
  });

  it("无活跃 Execution 的实施中任务可以恢复实施", async () => {
    const user = userEvent.setup();
    const stuckTask = { ...taskOne, status: "in_progress" as const, version: 8 };
    const cancelledExecution: TaskBoardExecution = {
      id: "execution-cancelled",
      taskId: stuckTask.id,
      runId: "run-cancelled",
      sessionId: "session-cancelled",
      status: "cancelled",
      purpose: "work",
      requestedBy: "user-1",
      error: "aborted",
      createdAt: stuckTask.createdAt,
      updatedAt: stuckTask.updatedAt,
    };
    const runningTask = { ...stuckTask, version: 9 };
    const runningExecution = { ...cancelledExecution, id: "execution-retry", status: "queued" as const };
    mocks.executions = [cancelledExecution];
    mocks.fetchTask.mockResolvedValue(stuckTask);
    const onExecute = vi.fn(async () => ({ task: runningTask, execution: runningExecution }));
    render(<TaskDetail {...props({ task: stuckTask, onExecute })} />);
    await waitFor(() => expect(mocks.fetchTask).toHaveBeenCalledWith(stuckTask.id));

    expect(screen.queryByRole("checkbox", { name: /发表后继续/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "恢复实施" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(stuckTask, "work"));
  });

  it("集成任务详情区分任务类型并展示来源进度、错误和 merged commit", async () => {
    const integrationTask = {
      ...taskOne,
      id: "integration-1",
      identifier: "TASK-9",
      kind: "integration" as const,
      status: "blocked" as const,
    };
    mocks.fetchTask.mockResolvedValue(integrationTask);
    mocks.fetchIntegrationSources.mockResolvedValue([
      {
        id: "source-1",
        integrationTaskId: integrationTask.id,
        deliveryTaskId: "task-delivery-1",
        repositoryId: "repo-1",
        providerPullRequestId: "pr-101",
        reviewedSubjectDigest: "sha256:subject-1",
        order: 0,
        state: "merged",
        attemptCount: 1,
        mergedCommitOid: "abc123",
        updatedAt: taskOne.updatedAt,
      },
      {
        id: "source-2",
        integrationTaskId: integrationTask.id,
        deliveryTaskId: "task-delivery-2",
        repositoryId: "repo-1",
        providerPullRequestId: "pr-102",
        reviewedSubjectDigest: "sha256:subject-2",
        order: 1,
        state: "waiting_remediation",
        attemptCount: 2,
        lastError: "合并冲突需要自动修复",
        updatedAt: taskOne.updatedAt,
      },
    ]);
    render(<TaskDetail {...props({ task: integrationTask })} />);

    expect(await screen.findByText("集成批次")).toBeTruthy();
    expect(await screen.findByText("1/2 已合并")).toBeTruthy();
    expect(screen.getByText("等待修复")).toBeTruthy();
    expect(screen.getByText(/merged commit abc123/)).toBeTruthy();
    expect(screen.getByText(/合并冲突需要自动修复/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存任务" })).toBeNull();
    expect(screen.queryByRole("button", { name: "交给 Agent" })).toBeNull();
  });

  it("集成阻塞恢复仅提交用户显式勾选的来源", async () => {
    const user = userEvent.setup();
    const integrationTask = {
      ...taskOne, id: "integration-select", identifier: "TASK-10",
      kind: "integration" as const, status: "blocked" as const,
    };
    const resumedTask = { ...integrationTask, status: "todo" as const, version: integrationTask.version + 1 };
    mocks.fetchTask.mockResolvedValue(integrationTask);
    mocks.fetchIntegrationSources.mockResolvedValue([
      {
        id: "source-a", integrationTaskId: integrationTask.id, deliveryTaskId: "delivery-a",
        deliveryTaskIdentifier: "TASK-1", repositoryId: "repo-1", providerPullRequestId: "pr-a",
        reviewedSubjectDigest: "digest-a", order: 0, state: "needs_human", attemptCount: 1,
        lastError: "需要确认 A", updatedAt: taskOne.updatedAt,
      },
      {
        id: "source-b", integrationTaskId: integrationTask.id, deliveryTaskId: "delivery-b",
        deliveryTaskIdentifier: "TASK-2", repositoryId: "repo-1", providerPullRequestId: "pr-b",
        reviewedSubjectDigest: "digest-b", order: 1, state: "needs_human", attemptCount: 1,
        lastError: "需要确认 B", updatedAt: taskOne.updatedAt,
      },
      {
        id: "source-c", integrationTaskId: integrationTask.id, deliveryTaskId: "delivery-c",
        repositoryId: "repo-1", providerPullRequestId: "pr-c", reviewedSubjectDigest: "digest-c",
        order: 2, state: "merged", attemptCount: 1, updatedAt: taskOne.updatedAt,
      },
    ]);
    mocks.resumeTask.mockResolvedValue(resumedTask);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<TaskDetail {...props({ task: integrationTask, canTransitionTask: true })} />);

    const resume = await screen.findByRole("button", { name: "显式恢复阻塞来源" });
    expect(resume.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "选择恢复来源 TASK-1" }));
    expect(resume.hasAttribute("disabled")).toBe(false);
    await user.click(resume);
    expect(mocks.resumeTask).not.toHaveBeenCalled();
    prompt.mockReturnValue("仅恢复来源 A");
    await user.click(resume);
    await waitFor(() => expect(mocks.resumeTask).toHaveBeenCalledWith(
      integrationTask.id, integrationTask.version, "仅恢复来源 A", ["source-a"],
    ));

  });

  it("复核中任务可以启动独立 review Agent", async () => {
    const user = userEvent.setup();
    const reviewTask = { ...taskOne, status: "in_review" as const, branch: "task/TASK-1-feature" };
    const reviewingTask = { ...reviewTask, version: reviewTask.version + 1 };
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
    const onExecute = vi.fn(async () => ({ task: reviewingTask, execution }));
    render(<TaskDetail {...props({ task: reviewTask, onExecute })} />);

    await user.click(await screen.findByRole("button", { name: "独立复核" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(reviewTask, "review"));
  });

  it("阻塞任务必须提交显式恢复决策，不能直接重新运行", async () => {
    const user = userEvent.setup();
    const blockedTask = { ...taskOne, status: "blocked" as const };
    const resumedTask = {
      ...blockedTask, status: "todo" as const, version: blockedTask.version + 1,
      resumeContext: {
        decision: "依赖已解除，恢复实施", purpose: "work" as const, sourceIds: [],
        requestedAt: "2026-08-18T08:43:00.000Z", requestedBy: "user-1",
      },
    };
    mocks.fetchTask.mockResolvedValue(blockedTask);
    mocks.resumeTask.mockResolvedValue(resumedTask);
    vi.spyOn(window, "prompt").mockReturnValue("依赖已解除，恢复实施");
    const onExecute = vi.fn();
    const onTaskLoaded = vi.fn();
    render(<TaskDetail {...props({ task: blockedTask, onExecute, onTaskLoaded, canTransitionTask: true })} />);

    expect(screen.queryByRole("button", { name: "重新运行" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "显式恢复任务" }));
    await waitFor(() => expect(mocks.resumeTask).toHaveBeenCalledWith(
      blockedTask.id,
      blockedTask.version,
      "依赖已解除，恢复实施",
      undefined,
    ));
    expect(onExecute).not.toHaveBeenCalled();
    expect(onTaskLoaded).toHaveBeenCalledWith(resumedTask);
    expect(await screen.findByText("最近恢复决策与后续要求")).toBeTruthy();
    expect(screen.getByText("依赖已解除，恢复实施")).toBeTruthy();
    expect(screen.getByText(/恢复目标：实施 Agent/)).toBeTruthy();
    expect(screen.getByText("尚未交给 Agent，需另行启动")).toBeTruthy();
  });

  it("确认后删除任务并关闭详情", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const deleted = { ...taskOne, version: taskOne.version + 1, deletedAt: taskOne.updatedAt };
    const onDeleteTask = vi.fn(async () => deleted);
    const onOpenChange = vi.fn();
    render(<TaskDetail {...props({ task: taskOne, onDeleteTask, onOpenChange })} />);

    await user.click(await screen.findByRole("button", { name: "删除任务" }));
    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith(taskOne));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("确认删除任务"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    confirmSpy.mockRestore();
  });

  it("未确认时不删除任务", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDeleteTask = vi.fn();
    render(<TaskDetail {...props({ task: taskOne, onDeleteTask })} />);

    await user.click(await screen.findByRole("button", { name: "删除任务" }));
    expect(onDeleteTask).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("无删除权限时不展示删除按钮", async () => {
    render(<TaskDetail {...props({ task: taskOne, canDeleteTask: false })} />);
    expect(screen.queryByRole("button", { name: "删除任务" })).toBeNull();
  });
});
