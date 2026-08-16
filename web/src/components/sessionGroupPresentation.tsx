import { Clock, Folder } from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { SessionGroup } from "@/types/sessionGroup";

function groupIcon(kind: SessionGroup["kind"]) {
  if (kind === "cron") return Clock;
  if (kind === "taskboard") return EntityIcons.taskboard;
  return Folder;
}

function groupColor(kind: SessionGroup["kind"]): string {
  if (kind === "cron") return "text-amber-600 dark:text-amber-300";
  if (kind === "taskboard") return "text-violet-600 dark:text-violet-300";
  return "text-brand-500/80 dark:text-brand-300/80";
}

export function sessionGroupKindLabel(kind: SessionGroup["kind"]): string {
  if (kind === "cron") return "cron";
  if (kind === "taskboard") return "看板";
  return "分组";
}

export function SessionGroupGlyph({ kind, className }: {
  kind: SessionGroup["kind"];
  className?: string;
}) {
  const Icon = groupIcon(kind);
  return <Icon className={cn("shrink-0", groupColor(kind), className)} aria-hidden="true" />;
}

export function CompactSessionGroupLeadingIcon({ kind }: { kind: SessionGroup["kind"] }) {
  return (
    <SessionGroupGlyph
      kind={kind}
      className={cn(
        "size-4",
        kind === "cron" && "fill-amber-100 dark:fill-amber-900/35",
        kind === "manual" && "fill-brand-100 dark:fill-brand-900/35",
      )}
    />
  );
}

export function SessionGroupLeadingIcon({ kind }: { kind: SessionGroup["kind"] }) {
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-full ring-1",
        kind === "cron"
          ? "bg-amber-50 ring-amber-100 dark:bg-amber-900/25 dark:ring-amber-700/30"
          : kind === "taskboard"
            ? "bg-violet-50 ring-violet-100 dark:bg-violet-900/25 dark:ring-violet-700/30"
            : "bg-brand-50 ring-brand-100 dark:bg-brand-900/35 dark:ring-brand-800",
      )}
      aria-hidden="true"
    >
      <SessionGroupGlyph kind={kind} className="size-5" />
    </span>
  );
}
