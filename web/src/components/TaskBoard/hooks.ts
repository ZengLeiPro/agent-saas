import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ModelList,
  TaskBoard,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCreateInput,
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardPatchInput,
  TaskBoardTask,
  TaskBoardTaskCreateInput,
  TaskBoardTaskMoveInput,
  TaskBoardTaskPatchInput,
} from "@agent/shared";
import { authFetch } from "@/lib/authFetch";
import * as api from "./api";
import { sortTaskBoardTasks } from "./constants";

function moveInputForLatestTasks(
  tasks: TaskBoardTask[],
  originalTasks: TaskBoardTask[],
  taskId: string,
  input: Omit<TaskBoardTaskMoveInput, "expectedVersion">,
): Omit<TaskBoardTaskMoveInput, "expectedVersion"> {
  const peers = sortTaskBoardTasks(tasks, input.status)
    .filter((task) => task.id !== taskId);
  const nextIndex = input.nextTaskId
    ? peers.findIndex((task) => task.id === input.nextTaskId)
    : -1;
  if (nextIndex >= 0) {
    return {
      status: input.status,
      previousTaskId: peers[nextIndex - 1]?.id,
      nextTaskId: peers[nextIndex]?.id,
    };
  }
  const previousIndex = input.previousTaskId
    ? peers.findIndex((task) => task.id === input.previousTaskId)
    : -1;
  if (previousIndex >= 0) {
    return {
      status: input.status,
      previousTaskId: peers[previousIndex]?.id,
      nextTaskId: peers[previousIndex + 1]?.id,
    };
  }
  const originalPeers = sortTaskBoardTasks(originalTasks, input.status)
    .filter((task) => task.id !== taskId);
  const originalNextIndex = input.nextTaskId
    ? originalPeers.findIndex((task) => task.id === input.nextTaskId)
    : -1;
  const originalPreviousIndex = input.previousTaskId
    ? originalPeers.findIndex((task) => task.id === input.previousTaskId)
    : -1;
  const insertAt = Math.min(
    originalNextIndex >= 0
      ? originalNextIndex
      : originalPreviousIndex >= 0
        ? originalPreviousIndex + 1
        : originalPeers.length,
    peers.length,
  );
  return {
    status: input.status,
    previousTaskId: peers[insertAt - 1]?.id,
    nextTaskId: peers[insertAt]?.id,
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useTaskBoards() {
  const [boards, setBoards] = useState<TaskBoard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await api.fetchBoards();
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setBoards(next);
      setError(null);
    } catch (caught) {
      if (!mountedRef.current || requestId !== requestRef.current) return;
      setError(errorText(caught, "加载任务看板失败"));
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invalidateRefresh = useCallback(() => {
    requestRef.current += 1;
    setLoading(false);
  }, []);

  const replaceBoard = useCallback((board: TaskBoard) => {
    setBoards((current) => {
      const exists = current.some((item) => item.id === board.id);
      return exists
        ? current.map((item) => (item.id === board.id ? board : item))
        : [...current, board];
    });
  }, []);

  const recoverFailure = useCallback(async (caught: unknown) => {
    if (caught instanceof api.TaskBoardConflictError && caught.current) {
      replaceBoard(caught.current as TaskBoard);
    }
    await refresh();
  }, [refresh, replaceBoard]);

  const addBoard = async (input: TaskBoardCreateInput) => {
    invalidateRefresh();
    try {
      const board = await api.createBoard(input);
      if (mountedRef.current) {
        invalidateRefresh();
        setBoards((current) => [...current, board]);
        setError(null);
      }
      return board;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught);
      throw caught;
    }
  };

  const updateBoard = async (id: string, input: TaskBoardPatchInput) => {
    invalidateRefresh();
    try {
      const board = await api.patchBoard(id, input);
      if (mountedRef.current) {
        invalidateRefresh();
        replaceBoard(board);
        setError(null);
      }
      return board;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught);
      throw caught;
    }
  };

  const archive = async (board: TaskBoard) => {
    invalidateRefresh();
    try {
      const next = await api.archiveBoard(board.id, board.version);
      if (mountedRef.current) {
        invalidateRefresh();
        replaceBoard(next);
        setError(null);
      }
      return next;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught);
      throw caught;
    }
  };

  const restore = async (board: TaskBoard) => {
    invalidateRefresh();
    try {
      const next = await api.restoreBoard(board.id, board.version);
      if (mountedRef.current) {
        invalidateRefresh();
        replaceBoard(next);
        setError(null);
      }
      return next;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught);
      throw caught;
    }
  };

  return { boards, loading, error, refresh, addBoard, updateBoard, archive, restore };
}

export function useBoardTasks(boardId: string | null) {
  const [tasks, setTasks] = useState<TaskBoardTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const boardIdRef = useRef(boardId);
  const boardEpochRef = useRef(0);
  const previousBoardIdRef = useRef(boardId);
  const requestRef = useRef(0);
  const tasksRef = useRef<TaskBoardTask[]>([]);
  if (previousBoardIdRef.current !== boardId) {
    previousBoardIdRef.current = boardId;
    boardEpochRef.current += 1;
  }
  boardIdRef.current = boardId;

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    const requestedBoardId = boardId;
    if (!requestedBoardId) {
      tasksRef.current = [];
      setTasks([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.fetchTasks(requestedBoardId);
      if (
        !mountedRef.current
        || requestId !== requestRef.current
        || requestedBoardId !== boardIdRef.current
      ) return;
      tasksRef.current = next;
      setTasks(next);
      setError(null);
    } catch (caught) {
      if (
        !mountedRef.current
        || requestId !== requestRef.current
        || requestedBoardId !== boardIdRef.current
      ) return;
      setError(errorText(caught, "加载看板任务失败"));
    } finally {
      if (
        mountedRef.current
        && requestId === requestRef.current
        && requestedBoardId === boardIdRef.current
      ) setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    requestRef.current += 1;
    tasksRef.current = [];
    setTasks([]);
    setError(null);
    setLoading(false);
    void refresh();
  }, [refresh]);

  const invalidateRefresh = useCallback(() => {
    requestRef.current += 1;
    setLoading(false);
  }, []);

  const syncTask = useCallback((task: TaskBoardTask) => {
    if (!mountedRef.current || task.boardId !== boardIdRef.current) return;
    setTasks((current) => {
      const exists = current.some((item) => item.id === task.id);
      const next = exists
        ? current.map((item) => (item.id === task.id ? task : item))
        : [...current, task];
      tasksRef.current = next;
      return next;
    });
  }, []);

  const recoverFailure = useCallback(async (caught: unknown, mutationBoardId: string | null) => {
    if (mutationBoardId !== boardIdRef.current) return;
    if (caught instanceof api.TaskBoardConflictError && caught.current) {
      syncTask(caught.current as TaskBoardTask);
    }
    await refresh();
  }, [refresh, syncTask]);

  const addTask = async (input: TaskBoardTaskCreateInput) => {
    const mutationBoardId = boardId;
    if (!mutationBoardId) throw new Error("请先选择任务看板");
    invalidateRefresh();
    try {
      const task = await api.createTask(mutationBoardId, input);
      if (mountedRef.current && mutationBoardId === boardIdRef.current) {
        invalidateRefresh();
        syncTask(task);
        setError(null);
      }
      return task;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught, mutationBoardId);
      throw caught;
    }
  };

  const updateTask = async (
    task: TaskBoardTask,
    input: Omit<TaskBoardTaskPatchInput, "expectedVersion">,
  ) => {
    const mutationBoardId = boardId;
    invalidateRefresh();
    try {
      const next = await api.patchTask(task.id, { ...input, expectedVersion: task.version });
      if (mountedRef.current && mutationBoardId === boardIdRef.current) {
        invalidateRefresh();
        syncTask(next);
        setError(null);
      }
      return next;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught, mutationBoardId);
      throw caught;
    }
  };

  const completeTask = async (task: TaskBoardTask) => {
    const mutationBoardId = boardId;
    invalidateRefresh();
    try {
      const next = await api.completeTask(task.id, task.version);
      if (mountedRef.current && mutationBoardId === boardIdRef.current) {
        invalidateRefresh();
        syncTask(next);
        setError(null);
      }
      return next;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught, mutationBoardId);
      throw caught;
    }
  };

  const setArchived = async (task: TaskBoardTask, archived: boolean) => {
    const mutationBoardId = boardId;
    invalidateRefresh();
    try {
      const next = archived
        ? await api.archiveTask(task.id, task.version)
        : await api.restoreTask(task.id, task.version);
      if (mountedRef.current && mutationBoardId === boardIdRef.current) {
        invalidateRefresh();
        syncTask(next);
        setError(null);
      }
      return next;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught, mutationBoardId);
      throw caught;
    }
  };

  const removeTask = async (task: TaskBoardTask) => {
    const mutationBoardId = boardId;
    invalidateRefresh();
    try {
      const next = await api.deleteTask(task.id, task.version);
      if (mountedRef.current && mutationBoardId === boardIdRef.current) {
        setTasks((current) => {
          const filtered = current.filter((item) => item.id !== task.id);
          tasksRef.current = filtered;
          return filtered;
        });
        setError(null);
      }
      return next;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught, mutationBoardId);
      throw caught;
    }
  };

  const executeTask = async (
    task: TaskBoardTask,
    purpose: TaskBoardExecutionPurpose = "work",
  ) => {
    const mutationBoardId = boardId;
    invalidateRefresh();
    try {
      const result = await api.executeTask(task.id, task.version, purpose);
      if (mountedRef.current && mutationBoardId === boardIdRef.current) {
        invalidateRefresh();
        syncTask(result.task);
        setError(null);
      }
      return result;
    } catch (caught) {
      if (mountedRef.current) await recoverFailure(caught, mutationBoardId);
      throw caught;
    }
  };

  const optimisticMove = async (
    task: TaskBoardTask,
    input: Omit<TaskBoardTaskMoveInput, "expectedVersion">,
    optimisticTasks: TaskBoardTask[],
  ) => {
    const mutationBoardId = boardId;
    const mutationBoardEpoch = boardEpochRef.current;
    const snapshot = tasksRef.current;
    invalidateRefresh();
    tasksRef.current = optimisticTasks;
    setTasks(optimisticTasks);
    try {
      let next: TaskBoardTask;
      try {
        next = await api.moveTask(task.id, { ...input, expectedVersion: task.version });
      } catch (caught) {
        if (!(caught instanceof api.TaskBoardInvalidMoveError) || !mutationBoardId) throw caught;
        const latestTasks = await api.fetchTasks(mutationBoardId);
        const latestTask = latestTasks.find((candidate) => candidate.id === task.id);
        if (!mountedRef.current
          || mutationBoardId !== boardIdRef.current
          || mutationBoardEpoch !== boardEpochRef.current) return latestTask ?? task;
        if (!latestTask) throw caught;
        next = await api.moveTask(task.id, {
          ...moveInputForLatestTasks(latestTasks, snapshot, task.id, input),
          expectedVersion: latestTask.version,
        });
      }
      if (!mountedRef.current || mutationBoardId !== boardIdRef.current) return next;
      invalidateRefresh();
      syncTask(next);
      await refresh();
      return next;
    } catch (caught) {
      if (mutationBoardId === boardIdRef.current) {
        tasksRef.current = snapshot;
        setTasks(snapshot);
        await recoverFailure(caught, mutationBoardId);
      }
      throw caught;
    }
  };

  return {
    tasks,
    loading,
    error,
    refresh,
    addTask,
    updateTask,
    completeTask,
    setArchived,
    removeTask,
    executeTask,
    optimisticMove,
    syncTask,
  };
}

const ACTIVE_EXECUTION_STATUSES = new Set<TaskBoardExecution["status"]>([
  "queued",
  "running",
  "waiting_user",
  "waiting_approval",
]);

export function useTaskExecutions(taskId: string | null, active = true) {
  const [executions, setExecutions] = useState<TaskBoardExecution[]>([]);
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef(taskId);
  const requestRef = useRef(0);
  const backgroundRefreshRef = useRef<{ requestId: number; taskId: string } | null>(null);
  taskIdRef.current = taskId;

  const refresh = useCallback(async (background = false) => {
    const requestedTaskId = taskId;
    if (!requestedTaskId || !active) {
      requestRef.current += 1;
      backgroundRefreshRef.current = null;
      setExecutions([]);
      setLoadedTaskId(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (background && backgroundRefreshRef.current?.taskId === requestedTaskId) return;
    if (!background) backgroundRefreshRef.current = null;
    const requestId = ++requestRef.current;
    const backgroundRequest = background ? { requestId, taskId: requestedTaskId } : null;
    if (backgroundRequest) backgroundRefreshRef.current = backgroundRequest;
    else setLoading(true);
    try {
      const next = await api.fetchExecutions(requestedTaskId);
      if (requestId !== requestRef.current || requestedTaskId !== taskIdRef.current) return;
      setExecutions(next);
      setLoadedTaskId(requestedTaskId);
      setError(null);
    } catch (caught) {
      if (requestId !== requestRef.current || requestedTaskId !== taskIdRef.current) return;
      setLoadedTaskId(null);
      setError(errorText(caught, "加载 Agent 执行记录失败"));
    } finally {
      if (backgroundRequest && backgroundRefreshRef.current === backgroundRequest) {
        backgroundRefreshRef.current = null;
      } else if (!background && requestId === requestRef.current && requestedTaskId === taskIdRef.current) {
        setLoading(false);
      }
    }
  }, [active, taskId]);

  useEffect(() => {
    requestRef.current += 1;
    backgroundRefreshRef.current = null;
    setExecutions([]);
    setLoadedTaskId(null);
    setError(null);
    setLoading(false);
    void refresh();
    return () => {
      requestRef.current += 1;
      backgroundRefreshRef.current = null;
    };
  }, [refresh]);

  const latestExecution = executions[0];
  const executionActive = Boolean(latestExecution && (
    ACTIVE_EXECUTION_STATUSES.has(latestExecution.status)
    || latestExecution.continuationActive
    || latestExecution.sessionActivityActive
  ));
  useEffect(() => {
    if (!active || !taskId) return;
    const timer = window.setInterval(() => {
      if (!loading) void refresh(true);
    }, executionActive ? 3_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [active, executionActive, loading, refresh, taskId]);

  const ready = Boolean(taskId && loadedTaskId === taskId && !error);
  return { executions, loading, error, ready, refresh };
}

export function useTaskComments(taskId: string | null) {
  const [comments, setComments] = useState<TaskBoardComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef(taskId);
  const requestRef = useRef(0);
  taskIdRef.current = taskId;

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    const requestedTaskId = taskId;
    if (!requestedTaskId) {
      setComments([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.fetchComments(requestedTaskId);
      if (requestId !== requestRef.current || requestedTaskId !== taskIdRef.current) return;
      setComments(next);
      setError(null);
    } catch (caught) {
      if (requestId !== requestRef.current || requestedTaskId !== taskIdRef.current) return;
      setError(errorText(caught, "加载评论失败"));
    } finally {
      if (requestId === requestRef.current && requestedTaskId === taskIdRef.current) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    requestRef.current += 1;
    setComments([]);
    setError(null);
    setLoading(false);
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  const addComment = async (input: TaskBoardCommentCreateInput) => {
    const mutationTaskId = taskId;
    if (!mutationTaskId) throw new Error("未选择任务");
    requestRef.current += 1;
    setLoading(false);
    try {
      const comment = await api.createComment(mutationTaskId, input);
      if (mutationTaskId === taskIdRef.current) {
        requestRef.current += 1;
        setLoading(false);
        setComments((current) => [...current, comment]);
        setError(null);
      }
      return comment;
    } catch (caught) {
      if (mutationTaskId === taskIdRef.current) await refresh();
      throw caught;
    }
  };

  return { comments, loading, error, refresh, addComment };
}

/**
 * 任务看板的模型列表：用于看板默认模型与任务级模型选择。
 * 复用 /api/models（与正常会话、定时任务同一份租户可见模型清单）。
 */
export function useTaskboardModelList(): ModelList | null {
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    authFetch("/api/models")
      .then((response) => (response.ok ? response.json() as Promise<ModelList> : null))
      .then((next) => {
        if (requestId === requestRef.current && next) setModelList(next);
      })
      .catch(() => {
        // 模型列表获取失败不阻塞看板操作，选择器自动隐藏。
      });
    return () => {
      requestRef.current += 1;
    };
  }, []);

  return modelList;
}
