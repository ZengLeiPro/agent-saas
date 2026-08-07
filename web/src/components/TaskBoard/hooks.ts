import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TaskBoard,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCreateInput,
  TaskBoardPatchInput,
  TaskBoardTask,
  TaskBoardTaskCreateInput,
  TaskBoardTaskMoveInput,
  TaskBoardTaskPatchInput,
} from "@agent/shared";
import * as api from "./api";

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
  const requestRef = useRef(0);
  const tasksRef = useRef<TaskBoardTask[]>([]);
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
      if (mutationBoardId === boardIdRef.current) {
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
      if (mutationBoardId === boardIdRef.current) {
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
      if (mutationBoardId === boardIdRef.current) {
        syncTask(next);
        setError(null);
      }
      return next;
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
    const snapshot = tasksRef.current;
    invalidateRefresh();
    tasksRef.current = optimisticTasks;
    setTasks(optimisticTasks);
    try {
      const next = await api.moveTask(task.id, { ...input, expectedVersion: task.version });
      if (mutationBoardId !== boardIdRef.current) return next;
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
    setArchived,
    optimisticMove,
    syncTask,
  };
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
