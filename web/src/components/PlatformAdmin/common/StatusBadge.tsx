import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const RUN_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "运行中",
  waiting_approval: "等待审批",
  waiting_user: "等待用户",
  waiting_hand: "等待执行环境",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  orphaned: "孤儿态",
};

const SANDBOX_LABELS: Record<string, string> = {
  Running: "运行中",
  Paused: "已暂停",
  Pending: "创建中",
  Failed: "异常",
  Unknown: "未知",
};

function toneClass(tone: "persistent" | "transient" | "success" | "danger" | "muted") {
  switch (tone) {
    case "persistent":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-0";
    case "transient":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-0";
    case "success":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-0";
    case "danger":
      return "bg-destructive/15 text-destructive border-0";
    case "muted":
      return "bg-muted text-muted-foreground border-0";
  }
}

function runTone(status: string) {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled" || status === "orphaned") return "muted";
  if (status === "running") return "persistent";
  if (status === "pending" || status.startsWith("waiting_")) return "transient";
  return "muted";
}

function sandboxTone(status: string) {
  if (status === "Running" || status === "Paused") return "persistent";
  if (status === "Failed") return "danger";
  if (status === "Pending" || status === "Provisioning") return "transient";
  return "muted";
}

export function StatusBadge({
  kind,
  status,
  className,
  pulse = false,
}: {
  kind: "run" | "sandbox";
  status: string;
  className?: string;
  pulse?: boolean;
}) {
  const tone = kind === "run" ? runTone(status) : sandboxTone(status);
  const label = kind === "run" ? RUN_LABELS[status] ?? status : SANDBOX_LABELS[status] ?? status;
  const showSpinner = pulse || tone === "transient";
  return (
    <Badge className={cn(toneClass(tone), className)}>
      {showSpinner && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {label}
    </Badge>
  );
}
