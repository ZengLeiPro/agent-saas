import type { DragEvent } from "react";
import type { TaskBoardTask } from "@agent/shared";
import { ArrowDown, ArrowUp, CalendarDays, GitBranch, MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDueAt, PRIORITY_CLASSES, PRIORITY_LABELS } from "./constants";

interface TaskCardProps {
  task: TaskBoardTask;
  readOnly: boolean;
  allowDrag: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onOpen: (task: TaskBoardTask) => void;
  onMoveUp: (task: TaskBoardTask) => void;
  onMoveDown: (task: TaskBoardTask) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDropBefore: (taskId: string, event: DragEvent<HTMLDivElement>) => void;
}

export function TaskCard({
  task,
  readOnly,
  allowDrag,
  canMoveUp,
  canMoveDown,
  onOpen,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDropBefore,
}: TaskCardProps) {
  const dueAt = formatDueAt(task.dueAt);

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
      <button
        type="button"
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen(task)}
        aria-label={`打开任务 ${task.identifier} ${task.title}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{task.identifier}</span>
          <Badge variant="outline" className={cn("font-normal", PRIORITY_CLASSES[task.priority])}>
            {PRIORITY_LABELS[task.priority]}
          </Badge>
        </div>
        <div className="mt-2 line-clamp-2 text-sm font-medium leading-5 text-foreground">
          {task.title}
        </div>
        {task.labels.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {task.labels.slice(0, 4).map((label) => (
              <Badge key={label} variant="secondary" className="max-w-24 truncate font-normal">
                {label}
              </Badge>
            ))}
          </div>
        ) : null}
        {task.branch ? (
          <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate" title={task.branch}>{task.branch}</span>
          </div>
        ) : null}
        <div className="mt-3 flex min-h-4 items-center gap-3 text-xs text-muted-foreground">
          {dueAt ? (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="size-3.5" />
              {dueAt}
            </span>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-1" aria-label={`${task.commentCount} 条评论`}>
            <MessageCircle className="size-3.5" />
            {task.commentCount}
          </span>
        </div>
      </button>
      {!readOnly ? (
        <div className="mt-2 flex justify-end gap-1 border-t pt-2" aria-label={`${task.identifier} 排序操作`}>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`上移 ${task.identifier}`}
            disabled={!canMoveUp}
            onClick={() => onMoveUp(task)}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`下移 ${task.identifier}`}
            disabled={!canMoveDown}
            onClick={() => onMoveDown(task)}
          >
            <ArrowDown className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
