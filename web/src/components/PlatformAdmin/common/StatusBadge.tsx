import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRunStatus, formatSandboxPhase } from "@/components/PlatformAdmin/displayText";

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
  const label = kind === "run" ? formatRunStatus(status) : formatSandboxPhase(status);
  const showSpinner = pulse || tone === "transient";
  return (
    <Badge className={cn(toneClass(tone), className)}>
      {showSpinner && <Loader2 className="mr-1 size-3 animate-spin" />}
      {label}
    </Badge>
  );
}
