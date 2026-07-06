import { StatusBadge } from "@/components/PlatformAdmin/common";

/** run 状态中文名（与后端 RUN_STATUS_WHITELIST 对齐） */
export const RUN_STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "运行中",
  waiting_approval: "等待审批",
  waiting_user: "等待用户",
  waiting_hand: "等待执行环境",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  return <StatusBadge kind="run" status={status} className={className} />;
}

/** run_finished.subtype 的终态色块样式 */
export function finishSubtypeClass(subtype?: string): string {
  if (subtype === "success") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (subtype === "error") return "border-destructive/40 bg-destructive/10 text-destructive";
  if (subtype === "interrupted") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border bg-muted/40 text-muted-foreground";
}

export function finishSubtypeLabel(subtype?: string): string {
  if (subtype === "success") return "成功";
  if (subtype === "error") return "失败";
  if (subtype === "interrupted") return "中断";
  return subtype ?? "未知";
}
