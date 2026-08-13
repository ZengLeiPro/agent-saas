import { parseJsonResponse } from "@agent/shared";
import type {
  TaskBoard,
  TaskBoardComment,
  TaskBoardCommentCreateInput,
  TaskBoardCreateInput,
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardExecutionStartResult,
  TaskBoardPatchInput,
  TaskBoardTask,
  TaskBoardTaskCreateInput,
  TaskBoardTaskMoveInput,
  TaskBoardTaskPatchInput,
} from "@agent/shared";
import { authFetch } from "@/lib/authFetch";

const API_BASE = "/api/taskboard";

export class TaskBoardConflictError<T = TaskBoard | TaskBoardTask> extends Error {
  readonly current?: T;

  constructor(message = "数据已被其他操作更新", current?: T) {
    super(message);
    this.name = "TaskBoardConflictError";
    this.current = current;
  }
}

function entityFrom<T>(data: unknown, key: string): T {
  if (data && typeof data === "object" && key in data) {
    return (data as Record<string, T>)[key];
  }
  return data as T;
}

async function parseEntity<T>(response: Response, label: string, key: string): Promise<T> {
  if (response.status === 409) {
    const conflict = await response.clone().json().catch(() => null) as {
      error?: unknown;
      current?: unknown;
    } | null;
    if (!conflict) await parseJsonResponse<unknown>(response, label);
    const message = typeof conflict?.error === "string" && conflict.error !== "Version conflict"
      ? conflict.error
      : "数据已被其他操作更新，请基于最新版本重试";
    throw new TaskBoardConflictError<T>(message, conflict?.current as T | undefined);
  }
  const data = await parseJsonResponse<unknown>(response, label);
  return entityFrom<T>(data, key);
}

function jsonRequest(method: "POST" | "PATCH", body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function fetchBoards(): Promise<TaskBoard[]> {
  const response = await authFetch(`${API_BASE}/boards?includeArchived=true`);
  return parseEntity<TaskBoard[]>(response, "任务看板", "boards");
}

export async function createBoard(input: TaskBoardCreateInput): Promise<TaskBoard> {
  const response = await authFetch(`${API_BASE}/boards`, jsonRequest("POST", input));
  return parseEntity<TaskBoard>(response, "任务看板", "board");
}

export async function patchBoard(id: string, input: TaskBoardPatchInput): Promise<TaskBoard> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(id)}`,
    jsonRequest("PATCH", input),
  );
  return parseEntity<TaskBoard>(response, "任务看板", "board");
}

export async function archiveBoard(id: string, expectedVersion: number): Promise<TaskBoard> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(id)}/archive`,
    jsonRequest("POST", { expectedVersion }),
  );
  return parseEntity<TaskBoard>(response, "任务看板", "board");
}

export async function restoreBoard(id: string, expectedVersion: number): Promise<TaskBoard> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(id)}/restore`,
    jsonRequest("POST", { expectedVersion }),
  );
  return parseEntity<TaskBoard>(response, "任务看板", "board");
}

export async function fetchTasks(boardId: string): Promise<TaskBoardTask[]> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(boardId)}/tasks?includeArchived=true`,
  );
  return parseEntity<TaskBoardTask[]>(response, "看板任务", "tasks");
}

export async function createTask(
  boardId: string,
  input: TaskBoardTaskCreateInput,
): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(boardId)}/tasks`,
    jsonRequest("POST", input),
  );
  return parseEntity<TaskBoardTask>(response, "看板任务", "task");
}

export async function fetchTask(id: string): Promise<TaskBoardTask> {
  const response = await authFetch(`${API_BASE}/tasks/${encodeURIComponent(id)}`);
  return parseEntity<TaskBoardTask>(response, "看板任务", "task");
}

export async function patchTask(
  id: string,
  input: TaskBoardTaskPatchInput,
): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(id)}`,
    jsonRequest("PATCH", input),
  );
  return parseEntity<TaskBoardTask>(response, "看板任务", "task");
}

export async function moveTask(
  id: string,
  input: TaskBoardTaskMoveInput,
): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(id)}/move`,
    jsonRequest("POST", input),
  );
  return parseEntity<TaskBoardTask>(response, "移动任务", "task");
}

export async function archiveTask(id: string, expectedVersion: number): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(id)}/archive`,
    jsonRequest("POST", { expectedVersion }),
  );
  return parseEntity<TaskBoardTask>(response, "看板任务", "task");
}

export async function restoreTask(id: string, expectedVersion: number): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(id)}/restore`,
    jsonRequest("POST", { expectedVersion }),
  );
  return parseEntity<TaskBoardTask>(response, "看板任务", "task");
}

export async function fetchExecutions(taskId: string): Promise<TaskBoardExecution[]> {
  const response = await authFetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/executions`);
  return parseEntity<TaskBoardExecution[]>(response, "Agent 执行记录", "executions");
}

export async function executeTask(
  taskId: string,
  expectedVersion: number,
  purpose: TaskBoardExecutionPurpose = "work",
): Promise<TaskBoardExecutionStartResult> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/execute`,
    jsonRequest("POST", purpose === "review" ? { expectedVersion, purpose } : { expectedVersion }),
  );
  return parseEntity<TaskBoardExecutionStartResult>(response, "Agent 执行", "result");
}

export async function fetchComments(taskId: string): Promise<TaskBoardComment[]> {
  const response = await authFetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/comments`);
  return parseEntity<TaskBoardComment[]>(response, "任务评论", "comments");
}

export async function createComment(
  taskId: string,
  input: TaskBoardCommentCreateInput,
): Promise<TaskBoardComment> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/comments`,
    jsonRequest("POST", input),
  );
  return parseEntity<TaskBoardComment>(response, "任务评论", "comment");
}
