import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRunStatus, formatSandboxPhase } from "@/components/PlatformAdmin/displayText";

/**
 * run / sandbox 五档状态语义。
 *
 * 改造前这里手写「浅绿底 + 深绿字 + dark: 覆盖」一类硬编码调色板类串，
 * 现在 tone 直接映射到 `ui/badge.tsx` 的语义 variant，颜色由 index.css 的 token 决定。
 * 新增状态只需要在下面两个映射函数里加一行，不要再回来写 className。
 */
type StatusTone = "persistent" | "transient" | "success" | "danger" | "muted";

const TONE_VARIANT = {
  /** 持久态（运行中 / 已挂起）——蓝 */
  persistent: "info",
  /** 瞬时态（等待中 / 供应中）——琥珀，附 spinner */
  transient: "warning",
  success: "success",
  danger: "destructive",
  muted: "muted",
} as const satisfies Record<StatusTone, string>;

function runTone(status: string): StatusTone {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled" || status === "orphaned") return "muted";
  if (status === "running") return "persistent";
  if (status === "pending" || status.startsWith("waiting_")) return "transient";
  return "muted";
}

function sandboxTone(status: string): StatusTone {
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
  const label = kind === "run" ? formatRunStatus(status) : formatSandboxPhase(status);
  const showSpinner = pulse || tone === "transient";
  return (
    <Badge variant={TONE_VARIANT[tone]} className={cn(className)}>
      {showSpinner && <Loader2 className="mr-1 size-3 animate-spin" />}
      {label}
    </Badge>
  );
}
