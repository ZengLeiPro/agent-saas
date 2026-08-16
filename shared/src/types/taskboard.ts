export const TASKBOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "ready_to_merge",
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

export const TASKBOARD_EXECUTION_PURPOSES = ["work", "review"] as const;

export const TASKBOARD_VISIBILITIES = ["personal", "organization"] as const;

export const TASKBOARD_DEFAULT_PROMPT = [
  "1. 直接完成任务，必要时使用可用工具；不要只给计划。",
  "2. 尊重当前工作区与安全边界，不 push、不部署、不对外发送，除非任务正文明确授权。",
  "3. 完成后自行检查结果。你的最终回复将作为任务的 Agent 交付回执。",
  "4. 实施 Agent 不要自行标记“待合并”或“已完成”；复核通过只进入“待合并”，不直接完成。",
].join("\n");

export type TaskBoardStatus = (typeof TASKBOARD_STATUSES)[number];
export type TaskBoardPriority = (typeof TASKBOARD_PRIORITIES)[number];
export type TaskBoardExecutionStatus = (typeof TASKBOARD_EXECUTION_STATUSES)[number];
export type TaskBoardExecutionPurpose = (typeof TASKBOARD_EXECUTION_PURPOSES)[number];
export type TaskBoardVisibility = (typeof TASKBOARD_VISIBILITIES)[number];

export interface TaskBoard {
  id: string;
  name: string;
  description?: string;
  visibility: TaskBoardVisibility;
  ownerUserId: string;
  canManage: boolean;
  prompt: string;
  /** 看板默认模型 ref（groupId/modelId）；缺省时任务执行回落到组织默认模型。 */
  model?: string;
  version: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardAttachment {
  /** 上传接口生成的附件标识；Agent 生成的工作区文件没有此字段。 */
  attachmentId?: string;
  originalName: string;
  relativePath: string;
  size: number;
  mimeType: string;
  isImage: boolean;
}

export interface TaskBoardUploadAttachment extends TaskBoardAttachment {
  attachmentId: string;
}

export interface TaskBoardTask {
  id: string;
  boardId: string;
  identifier: string;
  title: string;
  description: string;
  /** Agent 实施、复核或合并时使用的 Git 分支。 */
  branch?: string;
  attachments?: TaskBoardAttachment[];
  status: TaskBoardStatus;
  priority: TaskBoardPriority;
  labels: string[];
  sortOrder: number;
  dueAt?: string;
  /** 任务级模型 ref；缺省时继承看板默认模型。 */
  model?: string;
  commentCount: number;
  version: number;
  /** 旧任务可能没有创建人快照。 */
  creatorUserId?: string;
  creatorName?: string;
  completedAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoardComment {
  id: string;
  taskId: string;
  body: string;
  attachments?: TaskBoardAttachment[];
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
  purpose: TaskBoardExecutionPurpose;
  requestedBy: string;
  error?: string;
  /** 独立评论续跑仍在处理；用于正式 Execution 已终态时继续轮询最终交付。 */
  continuationActive?: boolean;
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
  model?: string;
  visibility?: TaskBoardVisibility;
}

export interface TaskBoardPatchInput {
  name?: string;
  description?: string;
  prompt?: string;
  /** null 表示清除看板默认模型，回落到组织默认模型。 */
  model?: string | null;
  visibility?: TaskBoardVisibility;
  expectedVersion: number;
}

export interface TaskBoardTaskCreateInput {
  title: string;
  description?: string;
  branch?: string;
  attachments?: TaskBoardUploadAttachment[];
  status?: TaskBoardStatus;
  priority?: TaskBoardPriority;
  labels?: string[];
  dueAt?: string;
  model?: string;
  /** 同一次新建表单重试时保持不变，避免直执失败后重复建任务。 */
  clientRequestId?: string;
  /** 创建后立即启动实施 Agent；任务进入“实施中”。 */
  dispatch?: boolean;
}

export interface TaskBoardTaskPatchInput {
  title?: string;
  description?: string;
  /** null 表示清除工作分支。 */
  branch?: string | null;
  attachments?: TaskBoardUploadAttachment[];
  priority?: TaskBoardPriority;
  labels?: string[];
  dueAt?: string | null;
  /** null 表示清除任务级模型，恢复继承看板默认模型。 */
  model?: string | null;
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
  attachments?: TaskBoardUploadAttachment[];
}

export interface TaskBoardCommentPatchInput {
  body: string;
  expectedVersion: number;
}

export interface TaskBoardExecutionStartInput {
  expectedVersion: number;
  /** work 从待实施开始实施；review 从复核中开始独立复核。 */
  purpose?: TaskBoardExecutionPurpose;
}
