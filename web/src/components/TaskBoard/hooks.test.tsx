import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard, TaskBoardComment, TaskBoardExecution, TaskBoardTask } from "@agent/shared";
import { TaskBoardConflictError, TaskBoardInvalidMoveError } from "./api";
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

  it("正式 Execution 终态但 Session 后台活跃时继续轮询", async () => {
    const activeSession: TaskBoardExecution = {
      id: "execution-session-active",
      taskId: originalTask.id,
      runId: "run-session-active",
      sessionId: "session-active",
      status: "succeeded",
      purpose: "work",
      requestedBy: "user-1",
      sessionActivityActive: true,
      createdAt: originalTask.createdAt,
      updatedAt: originalTask.updatedAt,
    };
    mocks.fetchExecutions
      .mockResolvedValueOnce([activeSession])
      .mockResolvedValueOnce([{ ...activeSession, sessionActivityActive: false }]);
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useTaskExecutions(originalTask.id));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.executions[0]?.sessionActivityActive).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(result.current.executions[0]?.sessionActivityActive).toBeFalsy();
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

  it("后台 Execution 慢刷新不重叠且有效响应最终落地", async () => {
    const activeExecution: TaskBoardExecution = {
      id: "execution-slow", taskId: originalTask.id, runId: "run-slow", sessionId: "session-slow",
      status: "running", purpose: "work", requestedBy: "user-2",
      createdAt: originalTask.createdAt, updatedAt: originalTask.updatedAt,
    };
    const completedExecution = { ...activeExecution, status: "succeeded" as const };
    const pendingRefresh = deferred<TaskBoardExecution[]>();
    mocks.fetchExecutions.mockResolvedValueOnce([activeExecution]).mockReturnValueOnce(pendingRefresh.promise);
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useTaskExecutions(originalTask.id));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);

      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);
      await act(async () => { pendingRefresh.resolve([completedExecution]); await pendingRefresh.promise; });
      expect(result.current.executions[0]).toEqual(completedExecution);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("旧任务后台刷新挂起时切换任务仍会恢复轮询", async () => {
    const pendingOldTaskRefresh = deferred<TaskBoardExecution[]>();
    const pendingNewTaskRefresh = deferred<TaskBoardExecution[]>();
    const newTaskExecution: TaskBoardExecution = {
      id: "execution-task-2", taskId: "task-2", runId: "run-task-2", sessionId: "session-task-2",
      status: "running", purpose: "work", requestedBy: "user-2",
      createdAt: originalTask.createdAt, updatedAt: originalTask.updatedAt,
    };
    mocks.fetchExecutions
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pendingOldTaskRefresh.promise)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pendingNewTaskRefresh.promise);
    vi.useFakeTimers();
    try {
      const { result, rerender, unmount } = renderHook(
        ({ taskId }) => useTaskExecutions(taskId),
        { initialProps: { taskId: originalTask.id } },
      );
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);

      rerender({ taskId: "task-2" });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(3);

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(4);

      await act(async () => {
        pendingOldTaskRefresh.resolve([]);
        await pendingOldTaskRefresh.promise;
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(4);

      await act(async () => {
        pendingNewTaskRefresh.resolve([newTaskExecution]);
        await pendingNewTaskRefresh.promise;
      });
      expect(result.current.executions[0]).toEqual(newTaskExecution);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("后台刷新挂起时前台刷新成功后仍会恢复轮询", async () => {
    const pendingBackgroundRefresh = deferred<TaskBoardExecution[]>();
    const newExecution: TaskBoardExecution = {
      id: "execution-after-foreground", taskId: originalTask.id,
      runId: "run-after-foreground", sessionId: "session-after-foreground",
      status: "running", purpose: "work", requestedBy: "user-2",
      createdAt: originalTask.createdAt, updatedAt: originalTask.updatedAt,
    };
    mocks.fetchExecutions
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pendingBackgroundRefresh.promise)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([newExecution]);
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useTaskExecutions(originalTask.id));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(2);

      await act(async () => { await result.current.refresh(); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(3);

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(mocks.fetchExecutions).toHaveBeenCalledTimes(4);
      expect(result.current.executions[0]).toEqual(newExecution);

      await act(async () => {
        pendingBackgroundRefresh.resolve([]);
        await pendingBackgroundRefresh.promise;
      });
      expect(result.current.executions[0]).toEqual(newExecution);
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

  it.each([
    ["需求池到待推进", "backlog", "todo"],
    ["待推进到需求池", "todo", "backlog"],
  ] as const)("%s 的目标邻居并发离列时，保留原插入位次并自动重试", async (_label, from, to) => {
    const source = { ...originalTask, status: from };
    const stalePeer = {
      ...originalTask,
      id: "stale-peer",
      identifier: "TASK-STALE",
      status: to,
      sortOrder: 2_000,
    };
    const stablePeer = {
      ...stalePeer,
      id: "stable-peer",
      identifier: "TASK-STABLE",
      sortOrder: 3_000,
    };
    const latestSource = { ...source, version: source.version + 1 };
    const latestPeer = { ...stalePeer, status: "in_progress" as const, version: 8 };
    const moved = { ...latestSource, status: to, sortOrder: 1_024, version: latestSource.version + 1 };
    mocks.fetchTasks
      .mockReset()
      .mockResolvedValueOnce([source, stalePeer, stablePeer])
      .mockResolvedValueOnce([latestSource, latestPeer, stablePeer])
      .mockResolvedValueOnce([moved, latestPeer, stablePeer]);
    mocks.moveTask
      .mockRejectedValueOnce(new TaskBoardInvalidMoveError())
      .mockResolvedValueOnce(moved);
    const { result } = renderHook(() => useBoardTasks(source.boardId));
    await waitFor(() => expect(result.current.tasks).toEqual([source, stalePeer, stablePeer]));

    await act(async () => {
      await result.current.optimisticMove(
        source,
        { status: to, nextTaskId: stalePeer.id },
        [moved, stalePeer, stablePeer],
      );
    });

    expect(mocks.moveTask).toHaveBeenNthCalledWith(1, source.id, {
      status: to,
      nextTaskId: stalePeer.id,
      expectedVersion: source.version,
    });
    expect(mocks.moveTask).toHaveBeenNthCalledWith(2, source.id, {
      status: to,
      previousTaskId: undefined,
      nextTaskId: stablePeer.id,
      expectedVersion: latestSource.version,
    });
    expect(result.current.tasks[0]).toEqual(moved);
  });

  it("邻居刷新期间切换看板再切回时不继续第二次移动写入", async () => {
    const retryFetch = deferred<TaskBoardTask[]>();
    mocks.fetchTasks.mockResolvedValueOnce([originalTask]).mockReturnValueOnce(retryFetch.promise);
    mocks.moveTask.mockRejectedValueOnce(new TaskBoardInvalidMoveError());
    const { result, rerender } = renderHook(
      ({ boardId }) => useBoardTasks(boardId),
      { initialProps: { boardId: originalTask.boardId } },
    );
    await waitFor(() => expect(result.current.tasks).toEqual([originalTask]));

    let movePromise!: Promise<TaskBoardTask>;
    await act(async () => {
      movePromise = result.current.optimisticMove(
        originalTask,
        { status: "todo", nextTaskId: "stale-peer" },
        [{ ...originalTask, status: "todo" }],
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.fetchTasks).toHaveBeenCalledTimes(2));
    rerender({ boardId: "board-2" });
    rerender({ boardId: originalTask.boardId });

    await act(async () => {
      retryFetch.resolve([originalTask]);
      await movePromise;
    });

    expect(mocks.moveTask).toHaveBeenCalledTimes(1);
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
