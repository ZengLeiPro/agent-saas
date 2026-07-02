import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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

function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-0";
    case "failed":
      return "bg-destructive/15 text-destructive border-0";
    case "cancelled":
      return "bg-muted text-muted-foreground border-0";
    case "running":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-0";
    case "pending":
      return "bg-muted text-muted-foreground border-0";
    case "waiting_approval":
    case "waiting_user":
    case "waiting_hand":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-0";
    default:
      return "bg-muted text-muted-foreground border-0";
  }
}

export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge className={cn(statusBadgeClass(status), className)}>
      {RUN_STATUS_LABELS[status] ?? status}
    </Badge>
  );
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
