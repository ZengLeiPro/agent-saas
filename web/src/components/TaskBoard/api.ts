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
import type {
  TaskBoardIntegrationBatchCreateInput,
  TaskBoardIntegrationCandidateDetails,
  TaskBoardDirectoryUser,
  TaskBoardIntegrationSource,
  TaskBoardMember,
  TaskBoardMemberPatchInput,
} from "@agent/shared/types/taskboard";
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

function jsonRequest(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown): RequestInit {
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

export async function fetchTaskboardUsers(): Promise<TaskBoardDirectoryUser[]> {
  const response = await authFetch(`${API_BASE}/users`);
  return parseEntity<TaskBoardDirectoryUser[]>(response, "组织用户", "users");
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

export async function fetchBoardMembers(boardId: string): Promise<TaskBoardMember[]> {
  const response = await authFetch(`${API_BASE}/boards/${encodeURIComponent(boardId)}/members`);
  return parseEntity<TaskBoardMember[]>(response, "看板成员", "members");
}

export async function upsertBoardMember(
  boardId: string,
  input: TaskBoardMemberPatchInput,
): Promise<TaskBoardMember> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(boardId)}/members`,
    jsonRequest("PUT", input),
  );
  return parseEntity<TaskBoardMember>(response, "看板成员", "member");
}

export async function deleteBoardMember(boardId: string, userId: string): Promise<void> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`,
    jsonRequest("DELETE"),
  );
  if (!response.ok) await parseJsonResponse<unknown>(response, "看板成员");
}

export async function createIntegrationBatch(
  boardId: string,
  input: TaskBoardIntegrationBatchCreateInput,
): Promise<{ task: TaskBoardTask; execution?: TaskBoardExecution }> {
  const response = await authFetch(
    `${API_BASE}/boards/${encodeURIComponent(boardId)}/integrations`,
    jsonRequest("POST", input),
  );
  return parseEntity<{ task: TaskBoardTask; execution?: TaskBoardExecution }>(response, "人工集成批次", "result");
}

export async function resumeTask(
  taskId: string,
  expectedVersion: number,
  decision: string,
  sourceIds?: string[],
): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/resume`,
    jsonRequest("POST", { expectedVersion, decision, ...(sourceIds?.length ? { sourceIds } : {}) }),
  );
  return parseEntity<TaskBoardTask>(response, "恢复任务", "task");
}

export async function cancelIntegrationTask(
  taskId: string,
  expectedVersion: number,
  reason?: string,
): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/integration-cancel`,
    jsonRequest("POST", { expectedVersion, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  );
  return parseEntity<TaskBoardTask>(response, "取消集成任务", "task");
}

export async function fetchIntegrationCandidate(
  taskId: string,
  options: { includeHistory?: boolean; page?: number; pageSize?: number } = {},
): Promise<TaskBoardIntegrationCandidateDetails> {
  const query = new URLSearchParams();
  if (options.includeHistory) query.set("includeHistory", "true");
  if (options.page !== undefined) query.set("page", String(options.page));
  if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/integration-candidate${query.size ? `?${query}` : ""}`,
  );
  return parseEntity<TaskBoardIntegrationCandidateDetails>(response, "Integration v3 Candidate", "result");
}

export async function requeueIntegrationCandidate(taskId: string, reason: string): Promise<{ candidateId: string; taskId: string; previousError: string; status: "idle" }> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/integration-candidate/requeue`,
    jsonRequest("POST", { reason: reason.trim() }),
  );
  return parseEntity<{ candidateId: string; taskId: string; previousError: string; status: "idle" }>(response, "重新排队 Integration v3 Candidate", "result");
}

export async function fetchIntegrationSources(taskId: string): Promise<TaskBoardIntegrationSource[]> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/integration-sources`,
  );
  return parseEntity<TaskBoardIntegrationSource[]>(response, "集成来源", "integrationSources");
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

export async function deleteTask(id: string, expectedVersion: number): Promise<TaskBoardTask> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(id)}`,
    jsonRequest("DELETE", { expectedVersion }),
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
    jsonRequest("POST", purpose === "work" ? { expectedVersion } : { expectedVersion, purpose }),
  );
  return parseEntity<TaskBoardExecutionStartResult>(response, "Agent 执行", "result");
}

export async function continueTaskExecution(
  taskId: string,
  commentId: string,
): Promise<TaskBoardExecutionStartResult> {
  const response = await authFetch(
    `${API_BASE}/tasks/${encodeURIComponent(taskId)}/comments/${encodeURIComponent(commentId)}/execute`,
    jsonRequest("POST"),
  );
  return parseEntity<TaskBoardExecutionStartResult>(response, "继续 Agent 执行", "result");
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
