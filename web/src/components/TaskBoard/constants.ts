import type {
  TaskBoard,
  TaskBoardExecutionStatus,
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardTask,
} from "@agent/shared";
import type {
  TaskBoardAllowedAction,
  TaskBoardIntegrationSourceState,
  TaskBoardMemberRole,
  TaskBoardTaskKind,
} from "@agent/shared/types/taskboard";

export const STATUS_LABELS: Record<TaskBoardStatus, string> = {
  backlog: "需求池",
  todo: "待实施",
  in_progress: "实施中",
  in_review: "复核中",
  ready_to_merge: "待合并",
  blocked: "已阻塞",
  done: "已完成",
  canceled: "已取消",
};

export const TASK_KIND_LABELS: Record<TaskBoardTaskKind, string> = {
  delivery: "交付任务",
  advisory: "答复与分析",
  integration: "集成批次",
  remediation: "修复任务",
};

export const MEMBER_ROLE_LABELS: Record<TaskBoardMemberRole, string> = {
  viewer: "查看者",
  editor: "编辑者",
  maintainer: "维护者",
  owner: "所有者",
};

export const INTEGRATION_SOURCE_STATE_LABELS: Record<TaskBoardIntegrationSourceState, string> = {
  pending: "待处理",
  canceled: "已取消",
  validating: "校验中",
  ready: "可合并",
  merging: "合并中",
  merged: "已合并",
  waiting_retry: "等待重试",
  re_reviewing: "重新复核",
  resolving_conflict: "解决冲突",
  waiting_remediation: "等待修复",
  needs_human: "需要人工处理",
};

const UPDATED_TIME_SORT_STATUSES = new Set<TaskBoardStatus>([
  "in_progress",
  "in_review",
  "ready_to_merge",
  "blocked",
  "done",
  "canceled",
]);

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 需求池与待实施保留手动顺序，其余状态按最近更新时间倒序展示。 */
export function taskStatusUsesUpdatedTime(status: TaskBoardStatus): boolean {
  return UPDATED_TIME_SORT_STATUSES.has(status);
}

export function taskStatusSupportsManualOrdering(status: TaskBoardStatus): boolean {
  return !taskStatusUsesUpdatedTime(status);
}

export function sortTaskBoardTasks(tasks: TaskBoardTask[], status: TaskBoardStatus): TaskBoardTask[] {
  return tasks
    .filter((task) => task.status === status && !task.archivedAt)
    .sort((left, right) => {
      if (taskStatusUsesUpdatedTime(status)) {
        return timestamp(right.updatedAt) - timestamp(left.updatedAt)
          || right.sortOrder - left.sortOrder
          || right.identifier.localeCompare(left.identifier);
      }
      return left.sortOrder - right.sortOrder || left.identifier.localeCompare(right.identifier);
    });
}

export function boardAllows(board: TaskBoard | null | undefined, action: TaskBoardAllowedAction): boolean {
  if (!board) return false;
  const allowed = board.allowedActions
    ? board.allowedActions.includes(action)
    : action === "board.read" || board.canManage;
  if (board.archivedAt && action !== "board.read" && action !== "board.archive") return false;
  return allowed;
}

const WORKFLOW_PROTECTED_STATUSES = new Set<TaskBoardStatus>([
  "in_progress",
  "in_review",
  "ready_to_merge",
  "blocked",
  "done",
]);

export function canUserTransitionTask(task: TaskBoardTaskKind | undefined, from: TaskBoardStatus, to: TaskBoardStatus): boolean {
  if ((task ?? "delivery") === "integration" || from === to) return false;
  return !WORKFLOW_PROTECTED_STATUSES.has(from) && !WORKFLOW_PROTECTED_STATUSES.has(to);
}

export const PRIORITY_LABELS: Record<TaskBoardPriority, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
  none: "无",
};

export const EXECUTION_STATUS_LABELS: Record<TaskBoardExecutionStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_user: "等待用户",
  waiting_approval: "等待授权",
  succeeded: "运行已结束 · 已提交结构化结果",
  failed: "执行失败",
  cancelled: "已取消",
};

export const PRIORITY_CLASSES: Record<TaskBoardPriority, string> = {
  urgent: "border-destructive/30 bg-destructive/10 text-destructive",
  high: "border-orange-300/50 bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  medium: "border-amber-300/50 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
  low: "border-blue-300/50 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
  none: "border-border bg-muted text-muted-foreground",
};

export function splitLabels(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,，]/)
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  );
}

export function dueAtFromDate(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T23:59:59.999`).toISOString();
}

export function dateFromDueAt(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function formatDueAt(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function formatTaskDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
