import type { DragEvent } from "react";
import {
  TASKBOARD_STATUSES,
  type TaskBoardStatus,
  type TaskBoardTask,
} from "@agent/shared";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TaskCard } from "./TaskCard";
import { STATUS_LABELS } from "./constants";

interface TaskColumnsProps {
  tasks: TaskBoardTask[];
  readOnly: boolean;
  desktopStatus: TaskBoardStatus | "all";
  mobileStatus: TaskBoardStatus;
  onMobileStatusChange: (status: TaskBoardStatus) => void;
  onCreateTask: (status: TaskBoardStatus) => void;
  onOpenTask: (task: TaskBoardTask) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDrop: (
    status: TaskBoardStatus,
    nextTaskId: string | undefined,
    event: DragEvent<HTMLElement>,
  ) => void;
}

function sortedTasks(tasks: TaskBoardTask[], status: TaskBoardStatus): TaskBoardTask[] {
  return tasks
    .filter((task) => task.status === status && !task.archivedAt)
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

export function TaskColumns({
  tasks,
  readOnly,
  desktopStatus,
  mobileStatus,
  onMobileStatusChange,
  onCreateTask,
  onOpenTask,
  onDragStart,
  onDragEnd,
  onDrop,
}: TaskColumnsProps) {
  const mobileTasks = sortedTasks(tasks, mobileStatus);

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div className="mb-3 md:hidden">
        <Select value={mobileStatus} onValueChange={(value) => onMobileStatusChange(value as TaskBoardStatus)}>
          <SelectTrigger aria-label="移动端状态"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TASKBOARD_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          disabled={readOnly}
          aria-label={`在${STATUS_LABELS[mobileStatus]}新建任务`}
          onClick={() => onCreateTask(mobileStatus)}
        >
          <Plus className="size-3.5" />
          新建任务
        </Button>
      </div>

      <div
        data-testid="taskboard-columns"
        aria-label="七态任务看板"
        className="hidden h-full min-w-0 gap-3 overflow-x-auto pb-2 md:flex"
      >
        {TASKBOARD_STATUSES.map((status) => {
          const columnTasks = desktopStatus === "all" || desktopStatus === status
            ? sortedTasks(tasks, status)
            : [];
          return (
            <section
              key={status}
              data-status={status}
              aria-label={`${STATUS_LABELS[status]}列`}
              className="flex h-full w-72 shrink-0 flex-col rounded-xl border bg-muted/30"
              onDragOver={(event) => {
                if (!readOnly) event.preventDefault();
              }}
              onDrop={(event) => {
                if (!readOnly) onDrop(status, undefined, event);
              }}
            >
              <header className="flex shrink-0 items-center justify-between border-b px-3 py-2.5">
                <h3 className="text-sm font-semibold">{STATUS_LABELS[status]}</h3>
                <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
                  {columnTasks.length}
                </span>
              </header>
              <div className="shrink-0 border-b p-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={readOnly}
                  aria-label={`在${STATUS_LABELS[status]}新建任务`}
                  onClick={() => onCreateTask(status)}
                >
                  <Plus className="size-3.5" />
                  新建任务
                </Button>
              </div>
              <div
                className="min-h-24 flex-1 space-y-2 overflow-y-auto p-2"
                onDragOver={(event) => {
                  if (!readOnly) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!readOnly) onDrop(status, undefined, event);
                }}
              >
                {columnTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    readOnly={readOnly}
                    allowDrag
                    onOpen={onOpenTask}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onDropBefore={(nextTaskId, event) => onDrop(status, nextTaskId, event)}
                  />
                ))}
                {columnTasks.length === 0 ? (
                  <div className="flex h-20 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                    暂无任务
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      <section
        data-testid="taskboard-mobile-list"
        aria-label={`${STATUS_LABELS[mobileStatus]}任务列表`}
        className="h-[calc(100%-3rem)] space-y-2 overflow-y-auto md:hidden"
      >
        {mobileTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            readOnly={readOnly}
            allowDrag={false}
            onOpen={onOpenTask}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDropBefore={(nextTaskId, event) => onDrop(mobileStatus, nextTaskId, event)}
          />
        ))}
        {mobileTasks.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            当前状态暂无任务
          </div>
        ) : null}
      </section>
    </div>
  );
}
