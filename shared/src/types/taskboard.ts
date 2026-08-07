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

export type TaskBoardStatus = (typeof TASKBOARD_STATUSES)[number];
export type TaskBoardPriority = (typeof TASKBOARD_PRIORITIES)[number];

export interface TaskBoard {
  id: string;
  name: string;
  description?: string;
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
  authorType: "user";
  authorId: string;
  authorName: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardCreateInput {
  name: string;
  description?: string;
}

export interface TaskBoardPatchInput {
  name?: string;
  description?: string;
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
