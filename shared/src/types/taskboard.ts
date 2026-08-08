export const TASKBOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;

export const TASKBOARD_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

export const TASKBOARD_EXECUTION_STATUSES = [
  "queued",
  "running",
  "waiting_user",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const TASKBOARD_DEFAULT_PROMPT = [
  "1. 直接完成任务，必要时使用可用工具；不要只给计划。",
  "2. 尊重当前工作区与安全边界，不 push、不部署、不对外发送，除非任务正文明确授权。",
  "3. 完成后自行检查结果。你的最终回复将作为任务的 Agent 交付回执。",
  "4. 不要自行把任务标记为“已完成”；系统只会将成功结果送到“待复核”，由用户验收。",
].join("\n");

export type TaskBoardStatus = (typeof TASKBOARD_STATUSES)[number];
export type TaskBoardPriority = (typeof TASKBOARD_PRIORITIES)[number];
export type TaskBoardExecutionStatus = (typeof TASKBOARD_EXECUTION_STATUSES)[number];

export interface TaskBoard {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  version: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardTask {
  id: string;
  boardId: string;
  identifier: string;
  title: string;
  description: string;
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  labels: string[];
  sortOrder: number;
  dueAt?: string;
  commentCount: number;
  version: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardComment {
  id: string;
  taskId: string;
  body: string;
  authorType: "user" | "agent" | "system";
  authorId: string;
  authorName: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardExecution {
  id: string;
  taskId: string;
  runId: string;
  sessionId: string;
  status: TaskBoardExecutionStatus;
  requestedBy: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardExecutionStartResult {
  task: TaskBoardTask;
  execution: TaskBoardExecution;
}

export interface TaskBoardCreateInput {
  name: string;
  description?: string;
  prompt?: string;
}

export interface TaskBoardPatchInput {
  name?: string;
  description?: string;
  prompt?: string;
  expectedVersion: number;
}

export interface TaskBoardTaskCreateInput {
  title: string;
  description?: string;
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  labels?: string[];
  dueAt?: string;
}

export interface TaskBoardTaskPatchInput {
  title?: string;
  description?: string;
  priority?: TaskBoardPriority;
  labels?: string[];
  dueAt?: string | null;
  expectedVersion: number;
}

export interface TaskBoardTaskMoveInput {
  status: TaskBoardStatus;
  previousTaskId?: string;
  nextTaskId?: string;
  expectedVersion: number;
}

export interface TaskBoardCommentCreateInput {
  body: string;
}

export interface TaskBoardExecutionStartInput {
  expectedVersion: number;
}
