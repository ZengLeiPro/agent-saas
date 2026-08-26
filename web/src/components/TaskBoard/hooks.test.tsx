import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard, TaskBoardComment, TaskBoardExecution, TaskBoardTask } from "@agent/shared";
import { TaskBoardConflictError } from "./api";
import { useBoardTasks, useTaskBoards, useTaskComments, useTaskExecutions } from "./hooks";

const mocks = vi.hoisted(() => ({
  fetchBoards: vi.fn(),
  createBoard: vi.fn(),
  patchBoard: vi.fn(),
  archiveBoard: vi.fn(),
  restoreBoard: vi.fn(),
  fetchTasks: vi.fn(),
  createTask: vi.fn(),
  patchTask: vi.fn(),
  moveTask: vi.fn(),
  completeTask: vi.fn(),
  archiveTask: vi.fn(),
  restoreTask: vi.fn(),
  deleteTask: vi.fn(),
  executeTask: vi.fn(),
  fetchExecutions: vi.fn(),
  fetchComments: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, ...mocks };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const originalBoard: TaskBoard = {
  id: "board-1",
  name: "研发事项",
  visibility: "personal",
  ownerUserId: "user-1",
  canManage: true,
  prompt: "执行看板任务",
  version: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const originalTask: TaskBoardTask = {
  id: "task-1",
  boardId: "board-1",
  identifier: "TASK-1",
  title: "并发移动",
  description: "",
  status: "backlog",
  priority: "none",
  labels: [],
  sortOrder: 1_000,
  commentCount: 0,
  version: 7,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const comment: TaskBoardComment = {
  id: "comment-1",
  taskId: originalTask.id,
  body: "新评论",
  authorType: "user",
  authorId: "user-1",
  authorName: "alice",
  version: 1,
  createdAt: "2026-08-01T01:00:00.000Z",
  updatedAt: "2026-08-01T01:00:00.000Z",
};

describe("任务看板 hooks 并发一致性", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchBoards.mockResolvedValue([originalBoard]);
    mocks.fetchTasks.mockResolvedValue([originalTask]);
    mocks.fetchExecutions.mockResolvedValue([]);
    mocks.fetchComments.mockResolvedValue([]);
  });

  it("正式 Execution 终态但 continuation 活跃时继续轮询", async () => {
    const activeContinuation: TaskBoardExecution = {
      id: "execution-terminal",
      taskId: originalTask.id,
      runId: "run-terminal",
      sessionId: "session-terminal",
      status: "succeeded",
      purpose: "work",
      requestedBy: "user-1",
      continuationActive: true,
      createdAt: originalTask.createdAt,
      updatedAt: originalTask.updatedAt,
    };
    mocks.fetchExecutions
      .mockResolvedValueOnce([activeContinuation])
      .mockResolvedValueOnce([{ ...activeContinuation, continuationActive: false }]);
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useTaskExecutions(originalTask.id));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.executions[0]?.continuationActive).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(result.current.executions[0]?.continuationActive).toBeFalsy();
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("终态或空闲时低频轮询以发现其他操作者启动的 Execution", async () => {
    const activeExecution: TaskBoardExecution = {
      id: "execution-new", taskId: originalTask.id, runId: "run-new", sessionId: "session-new",
      status: "running", purpose: "work", requestedBy: "user-2",
      createdAt: originalTask.createdAt, updatedAt: originalTask.updatedAt,
    };
    mocks.fetchExecutions.mockResolvedValueOnce([]).mockResolvedValueOnce([activeExecution]);
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useTaskExecutions(originalTask.id));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.executions).toEqual([]);

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(result.current.executions[0]).toEqual(activeExecution);
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("后台 Execution 刷新未完成时不发起重叠请求", async () => {
    const activeExecution: TaskBoardExecution = {
      id: "execution-slow", taskId: originalTask.id, runId: "run-slow", sessionId: "session-slow",
      status: "running", purpose: "work", requestedBy: "user-2",
      createdAt: originalTask.createdAt, updatedAt: originalTask.updatedAt,
    };
    const pendingRefresh = deferred<TaskBoardExecution[]>();
    mocks.fetchExecutions.mockResolvedValueOnce([activeExecution]).mockReturnValueOnce(pendingRefresh.promise);
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useTaskExecutions(originalTask.id));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);
      await act(async () => { pendingRefresh.resolve([activeExecution]); await pendingRefresh.promise; });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("乐观移动立即生效，失败后回滚并刷新，同时提交 expectedVersion", async () => {
    const pendingMove = deferred<TaskBoardTask>();
    mocks.moveTask.mockReturnValueOnce(pendingMove.promise);
    const { result } = renderHook(() => useBoardTasks("board-1"));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    const optimisticTask = { ...originalTask, status: "todo" as const, sortOrder: 1_000 };
    let movePromise!: Promise<TaskBoardTask>;
    await act(async () => {
      movePromise = result.current.optimisticMove(
        originalTask,
        { status: "todo", previousTaskId: "task-2" },
        [optimisticTask],
      );
      await Promise.resolve();
    });
    expect(result.current.tasks[0]?.status).toBe("todo");
    expect(mocks.moveTask).toHaveBeenCalledWith("task-1", {
      status: "todo",
      previousTaskId: "task-2",
      expectedVersion: 7,
    });

    await act(async () => {
      pendingMove.reject(new Error("版本冲突"));
      await expect(movePromise).rejects.toThrow("版本冲突");
    });

    expect(result.current.tasks).toEqual([originalTask]);
    expect(mocks.fetchTasks).toHaveBeenCalledTimes(2);
  });

  it("任务写入会使先前的慢 GET 失效，不允许旧响应覆盖新任务", async () => {
    const staleFetch = deferred<TaskBoardTask[]>();
    const edited = { ...originalTask, title: "已保存的新标题", version: 8 };
    mocks.fetchTasks
      .mockResolvedValueOnce([originalTask])
      .mockReturnValueOnce(staleFetch.promise);
    mocks.patchTask.mockResolvedValueOnce(edited);
    const { result } = renderHook(() => useBoardTasks("board-1"));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    await act(async () => {
      await result.current.updateTask(originalTask, { title: edited.title });
    });
    expect(result.current.tasks).toEqual([edited]);

    await act(async () => {
      staleFetch.resolve([originalTask]);
      await refreshPromise;
    });
    expect(result.current.tasks).toEqual([edited]);
  });

  it("人工完成任务后同步已完成状态并提交 CAS 版本", async () => {
    const completed = { ...originalTask, status: "done" as const, version: originalTask.version + 1 };
    mocks.completeTask.mockResolvedValueOnce(completed);
    const { result } = renderHook(() => useBoardTasks(originalTask.boardId));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    await act(async () => {
      await expect(result.current.completeTask(originalTask)).resolves.toEqual(completed);
    });

    expect(mocks.completeTask).toHaveBeenCalledWith(originalTask.id, originalTask.version);
    expect(result.current.tasks).toEqual([completed]);
  });

  it("显式交给 Agent 后同步 in_progress 任务和执行记录", async () => {
    const running = { ...originalTask, status: "in_progress" as const, version: 8 };
    const execution = {
      id: "execution-1",
      taskId: originalTask.id,
      runId: "run-1",
      sessionId: "session-1",
      status: "queued" as const,
      requestedBy: "user-1",
      createdAt: originalTask.createdAt,
      updatedAt: originalTask.updatedAt,
    };
    mocks.executeTask.mockResolvedValueOnce({ task: running, execution });
    const { result } = renderHook(() => useBoardTasks(originalTask.boardId));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    await act(async () => {
      const started = await result.current.executeTask(originalTask);
      expect(started.execution).toEqual(execution);
    });

    expect(mocks.executeTask).toHaveBeenCalledWith(originalTask.id, originalTask.version, "work");
    expect(result.current.tasks).toEqual([running]);
  });

  it("写入失败也会重拉，不能因使旧 GET 失效而留下空任务列表", async () => {
    const staleFetch = deferred<TaskBoardTask[]>();
    mocks.fetchTasks
      .mockReturnValueOnce(staleFetch.promise)
      .mockResolvedValueOnce([originalTask]);
    mocks.createTask.mockRejectedValueOnce(new Error("保存失败"));
    const { result } = renderHook(() => useBoardTasks("board-1"));

    await act(async () => {
      await expect(result.current.addTask({ title: "新任务" })).rejects.toThrow("保存失败");
    });
    expect(result.current.tasks).toEqual([originalTask]);

    await act(async () => {
      staleFetch.resolve([]);
      await staleFetch.promise;
    });
    expect(result.current.tasks).toEqual([originalTask]);
  });

  it("非拖拽任务写入遇到 409 时采用 current 并重拉，下一次可使用最新版本", async () => {
    const current = { ...originalTask, title: "其他窗口已修改", version: 9 };
    mocks.patchTask.mockRejectedValueOnce(new TaskBoardConflictError("版本冲突", current));
    mocks.fetchTasks
      .mockResolvedValueOnce([originalTask])
      .mockResolvedValueOnce([current]);
    const { result } = renderHook(() => useBoardTasks("board-1"));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    await act(async () => {
      await expect(result.current.updateTask(originalTask, { title: "我的修改" }))
        .rejects.toBeInstanceOf(TaskBoardConflictError);
    });

    expect(result.current.tasks).toEqual([current]);
    expect(mocks.fetchTasks).toHaveBeenCalledTimes(2);
  });

  it("看板归档遇到 409 时重拉当前看板版本", async () => {
    const current = { ...originalBoard, name: "其他窗口已改名", version: 4 };
    mocks.archiveBoard.mockRejectedValueOnce(new TaskBoardConflictError("版本冲突", current));
    mocks.fetchBoards
      .mockResolvedValueOnce([originalBoard])
      .mockResolvedValueOnce([current]);
    const { result } = renderHook(() => useTaskBoards());
    await waitFor(() => expect(result.current.boards).toEqual([originalBoard]));

    await act(async () => {
      await expect(result.current.archive(originalBoard)).rejects.toBeInstanceOf(TaskBoardConflictError);
    });

    expect(result.current.boards).toEqual([current]);
    expect(mocks.fetchBoards).toHaveBeenCalledTimes(2);
  });

  it("删除任务后本地列表移除该任务，携带 CAS 版本", async () => {
    const deleted = { ...originalTask, deletedAt: "2026-08-02T00:00:00.000Z", version: 8 };
    mocks.deleteTask.mockResolvedValueOnce(deleted);
    const { result } = renderHook(() => useBoardTasks(originalTask.boardId));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    await act(async () => {
      const next = await result.current.removeTask(originalTask);
      expect(next).toEqual(deleted);
    });

    expect(mocks.deleteTask).toHaveBeenCalledWith(originalTask.id, originalTask.version);
    expect(result.current.tasks).toEqual([]);
  });

  it("删除任务失败时抛出错误并重拉列表", async () => {
    mocks.deleteTask.mockRejectedValueOnce(new Error("删除失败"));
    mocks.fetchTasks
      .mockResolvedValueOnce([originalTask])
      .mockResolvedValueOnce([originalTask]);
    const { result } = renderHook(() => useBoardTasks(originalTask.boardId));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    await act(async () => {
      await expect(result.current.removeTask(originalTask)).rejects.toThrow("删除失败");
    });
    expect(result.current.tasks).toEqual([originalTask]);
  });

  it("新增评论会使慢评论 GET 失效，旧列表不会抹掉刚发布的评论", async () => {
    const staleFetch = deferred<TaskBoardComment[]>();
    mocks.fetchComments.mockReturnValueOnce(staleFetch.promise);
    mocks.createComment.mockResolvedValueOnce(comment);
    const { result } = renderHook(() => useTaskComments(originalTask.id));

    await act(async () => {
      await result.current.addComment({ body: comment.body });
    });
    expect(result.current.comments).toEqual([comment]);

    await act(async () => {
      staleFetch.resolve([]);
      await staleFetch.promise;
    });
    expect(result.current.comments).toEqual([comment]);
  });

  it("看板写入期间后发的慢 GET 不会覆盖写入结果", async () => {
    const pendingPatch = deferred<TaskBoard>();
    const staleFetch = deferred<TaskBoard[]>();
    const edited = { ...originalBoard, name: "已保存的新名称", version: 3 };
    mocks.patchBoard.mockReturnValueOnce(pendingPatch.promise);
    const { result } = renderHook(() => useTaskBoards());
    await waitFor(() => expect(result.current.boards).toEqual([originalBoard]));
    mocks.fetchBoards.mockReturnValueOnce(staleFetch.promise);

    let mutationPromise!: Promise<TaskBoard>;
    act(() => {
      mutationPromise = result.current.updateBoard(originalBoard.id, {
        name: edited.name,
        expectedVersion: originalBoard.version,
      });
    });
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await act(async () => {
      pendingPatch.resolve(edited);
      await mutationPromise;
    });
    expect(result.current.boards).toEqual([edited]);

    await act(async () => {
      staleFetch.resolve([originalBoard]);
      await refreshPromise;
    });
    expect(result.current.boards).toEqual([edited]);
  });

  it("任务写入期间后发的慢 GET 不会覆盖写入结果", async () => {
    const pendingPatch = deferred<TaskBoardTask>();
    const staleFetch = deferred<TaskBoardTask[]>();
    const edited = { ...originalTask, title: "已保存的新标题", version: 8 };
    mocks.patchTask.mockReturnValueOnce(pendingPatch.promise);
    const { result } = renderHook(() => useBoardTasks(originalTask.boardId));
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));
    mocks.fetchTasks.mockReturnValueOnce(staleFetch.promise);

    let mutationPromise!: Promise<TaskBoardTask>;
    act(() => {
      mutationPromise = result.current.updateTask(originalTask, { title: edited.title });
    });
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await act(async () => {
      pendingPatch.resolve(edited);
      await mutationPromise;
    });
    expect(result.current.tasks).toEqual([edited]);

    await act(async () => {
      staleFetch.resolve([originalTask]);
      await refreshPromise;
    });
    expect(result.current.tasks).toEqual([edited]);
  });

  it("评论写入期间后发的慢 GET 不会覆盖新评论", async () => {
    const pendingCreate = deferred<TaskBoardComment>();
    const staleFetch = deferred<TaskBoardComment[]>();
    mocks.createComment.mockReturnValueOnce(pendingCreate.promise);
    const { result } = renderHook(() => useTaskComments(originalTask.id));
    await waitFor(() => expect(mocks.fetchComments).toHaveBeenCalledOnce());
    mocks.fetchComments.mockReturnValueOnce(staleFetch.promise);

    let mutationPromise!: Promise<TaskBoardComment>;
    act(() => {
      mutationPromise = result.current.addComment({ body: comment.body });
    });
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await act(async () => {
      pendingCreate.resolve(comment);
      await mutationPromise;
    });
    expect(result.current.comments).toEqual([comment]);

    await act(async () => {
      staleFetch.resolve([]);
      await refreshPromise;
    });
    expect(result.current.comments).toEqual([comment]);
  });
});
