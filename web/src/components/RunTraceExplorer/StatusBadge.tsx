import { StatusBadge } from "@/components/PlatformAdmin/common";
export { RUN_STATUS_LABELS } from "@/components/PlatformAdmin/displayText";

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
