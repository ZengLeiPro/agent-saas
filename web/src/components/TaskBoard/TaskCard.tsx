import type { DragEvent } from "react";
import type { TaskBoardTask } from "@agent/shared";
import { CalendarDays, CircleCheck, GitBranch, GitCommitHorizontal, MessageCircle } from "lucide-react";
import { UserAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  formatDueAt,
  formatTaskDate,
  INTEGRATION_SOURCE_STATE_LABELS,
  PRIORITY_CLASSES,
  PRIORITY_LABELS,
  TASK_KIND_LABELS,
} from "./constants";
import { IntegrationCardSummary } from "./IntegrationSources";

interface TaskCardProps {
  task: TaskBoardTask;
  readOnly: boolean;
  allowDrag: boolean;
  onOpen: (task: TaskBoardTask) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDropBefore: (taskId: string, event: DragEvent<HTMLDivElement>) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (taskId: string, selected: boolean) => void;
}

export function TaskCard({
  task,
  readOnly,
  allowDrag,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropBefore,
  selectable = false,
  selected = false,
  onSelectedChange,
}: TaskCardProps) {
  const dueAt = formatDueAt(task.dueAt);
  const createdAt = formatTaskDate(task.createdAt);
  const completedAt = formatTaskDate(task.completedAt);
  const creatorName = task.creatorName?.trim() || "提交人未知";
  const kind = task.kind ?? "delivery";
  const cardAriaLabel = [
    `打开任务 ${task.identifier} ${task.title}`,
    `提交人 ${creatorName}`,
    createdAt ? `提交于 ${createdAt}` : null,
    completedAt ? `完成于 ${completedAt}` : null,
    dueAt ? `截止 ${dueAt}` : null,
    `${task.commentCount} 条评论`,
  ].filter(Boolean).join("，");

  return (
    <div
      data-testid={`task-card-${task.id}`}
      draggable={!readOnly && allowDrag}
      onDragStart={(event) => {
        if (readOnly || !allowDrag) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!readOnly && allowDrag) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!readOnly && allowDrag) onDropBefore(task.id, event);
      }}
      className={cn(
        "rounded-lg border bg-card p-3 shadow-sm transition-colors",
        !readOnly && allowDrag && "cursor-grab hover:border-foreground/20 active:cursor-grabbing",
      )}
    >
      {selectable ? (
        <label className="mb-2 flex cursor-pointer items-center gap-2 rounded-md bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange?.(task.id, checked === true)}
            aria-label={`选择 ${task.identifier} 加入人工集成批次`}
          />
          加入人工集成批次
        </label>
      ) : null}
      <button
        type="button"
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen(task)}
        aria-label={cardAriaLabel}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{task.identifier}</span>
          <span className="flex flex-wrap justify-end gap-1">
            {kind !== "delivery" ? (
              <Badge variant={kind === "integration" ? "default" : "secondary"} className={cn("font-normal", kind === "integration" && "bg-violet-600 hover:bg-violet-600")}>
                {TASK_KIND_LABELS[kind]}
              </Badge>
            ) : null}
            {task.priority !== "none" ? (
              <Badge variant="outline" className={cn("font-normal", PRIORITY_CLASSES[task.priority])}>
                {PRIORITY_LABELS[task.priority]}
              </Badge>
            ) : null}
          </span>
        </div>
        {task.title ? (
          <div className="mt-2 line-clamp-2 text-sm font-medium leading-5 text-foreground">
            {task.title}
          </div>
        ) : null}
        {task.providerPullRequestId ? (
          <div className="mt-2 text-xs text-muted-foreground">
            PR <span className="font-mono">{task.providerPullRequestId}</span>
            {task.reviewedSubjectDigest ? <span className="ml-2 text-emerald-700 dark:text-emerald-400">已复核</span> : <span className="ml-2 text-amber-700 dark:text-amber-300">待复核</span>}
          </div>
        ) : null}
        {kind === "integration" ? (
          <IntegrationCardSummary taskId={task.id} />
        ) : null}
        {kind === "delivery" && task.integrationState ? (
          <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            集成状态：{INTEGRATION_SOURCE_STATE_LABELS[task.integrationState]}
          </div>
        ) : null}
        {task.mergedCommitOid ? (
          <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
            <GitCommitHorizontal className="size-3.5 shrink-0" />
            <span className="truncate" title={task.mergedCommitOid}>merged commit {task.mergedCommitOid}</span>
          </div>
        ) : null}
        {task.branch ? (
          <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate" title={task.branch}>{task.branch}</span>
          </div>
        ) : null}
        <div className="mt-3 space-y-2 border-t pt-2.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex min-w-0 items-center gap-1.5" title={creatorName}>
              <UserAvatar
                userId={task.creatorUserId}
                avatar={task.creatorUserId}
                version={task.creatorAvatarVersion}
                size={20}
              />
              <span className="truncate">{creatorName}</span>
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1" aria-label={`${task.commentCount} 条评论`}>
              <MessageCircle className="size-3.5" />
              {task.commentCount}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {createdAt ? <time dateTime={task.createdAt}>提交 {createdAt}</time> : null}
            {completedAt ? (
              <time className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400" dateTime={task.completedAt}>
                <CircleCheck className="size-3" />
                完成 {completedAt}
              </time>
            ) : null}
            {dueAt ? (
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="size-3" />
                截止 {dueAt}
              </span>
            ) : null}
          </div>
        </div>
      </button>
    </div>
  );
}
