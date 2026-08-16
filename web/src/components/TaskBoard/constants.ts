import type {
  TaskBoardExecutionStatus,
  TaskBoardPriority,
  TaskBoardStatus,
} from "@agent/shared";

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
  succeeded: "已交付",
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
