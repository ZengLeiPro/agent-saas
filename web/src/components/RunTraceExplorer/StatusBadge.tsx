import { StatusBadge } from "@/components/PlatformAdmin/common";
export { RUN_STATUS_LABELS } from "@/components/PlatformAdmin/displayText";

export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  return <StatusBadge kind="run" status={status} className={className} />;
}

/** run_finished.subtype 的终态色块样式 */
export function finishSubtypeClass(subtype?: string): string {
  if (subtype === "success") return "border-success/40 bg-success/10 text-success-ink";
  if (subtype === "error") return "border-destructive/40 bg-destructive/10 text-destructive";
  if (subtype === "interrupted") return "border-warning/40 bg-warning/10 text-warning-ink";
  return "border bg-muted/40 text-muted-foreground";
}

export function finishSubtypeLabel(subtype?: string): string {
  if (subtype === "success") return "成功";
  if (subtype === "error") return "失败";
  if (subtype === "interrupted") return "中断";
  return subtype ?? "未知";
}
