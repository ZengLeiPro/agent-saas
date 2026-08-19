import { useState, type DragEvent } from "react";
import {
  TASKBOARD_STATUSES,
  type TaskBoardStatus,
  type TaskBoardTask,
} from "@agent/shared";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
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
  canCreateTask: boolean;
  canReorderTask: boolean;
  canTransitionTask: boolean;
  canCreateIntegration: boolean;
  selectedDeliveryTaskIds: Set<string>;
  desktopStatus: TaskBoardStatus | "all";
  mobileStatus: TaskBoardStatus;
  onMobileStatusChange: (status: TaskBoardStatus) => void;
  onCreateTask: (status: TaskBoardStatus) => void;
  onOpenTask: (task: TaskBoardTask) => void;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDeliverySelectedChange: (taskId: string, selected: boolean) => void;
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

const columnClassName = "flex h-full w-72 shrink-0 flex-col rounded-xl border bg-muted/30";
const summaryMarkerClassName = "list-none [&::-webkit-details-marker]:hidden";

export function TaskColumns({
  tasks,
  readOnly,
  canCreateTask,
  canReorderTask,
  canTransitionTask,
  canCreateIntegration,
  selectedDeliveryTaskIds,
  desktopStatus,
  mobileStatus,
  onMobileStatusChange,
  onCreateTask,
  onOpenTask,
  onDragStart,
  onDragEnd,
  onDeliverySelectedChange,
  onDrop,
}: TaskColumnsProps) {
  const [doneCollapsed, setDoneCollapsed] = useState(true);
  const mobileTasks = sortedTasks(tasks, mobileStatus);
  const dragEnabled = !readOnly && (canReorderTask || canTransitionTask);

  const renderStatusBody = (status: TaskBoardStatus, columnTasks: TaskBoardTask[]) => (
    <>
      <div className="shrink-0 border-b p-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          disabled={readOnly || !canCreateTask || !["backlog", "todo"].includes(status)}
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
          if (dragEnabled) event.preventDefault();
        }}
        onDrop={(event) => {
          if (dragEnabled) onDrop(status, undefined, event);
        }}
      >
        {columnTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            readOnly={readOnly}
            allowDrag={dragEnabled}
            selectable={canCreateIntegration && task.mergeEligibility === "eligible"}
            selected={selectedDeliveryTaskIds.has(task.id)}
            onSelectedChange={onDeliverySelectedChange}
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
    </>
  );

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
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
          disabled={readOnly || !canCreateTask || !["backlog", "todo"].includes(mobileStatus)}
          aria-label={`在${STATUS_LABELS[mobileStatus]}新建任务`}
          onClick={() => onCreateTask(mobileStatus)}
        >
          <Plus className="size-3.5" />
          新建任务
        </Button>
      </div>

      <div
        data-testid="taskboard-columns"
        aria-label="八态任务看板"
        className="hidden h-full min-w-0 gap-3 overflow-x-auto pb-2 md:flex"
      >
        {TASKBOARD_STATUSES.map((status) => {
          const columnTasks = desktopStatus === "all" || desktopStatus === status
            ? sortedTasks(tasks, status)
            : [];

          if (status === "done") {
            return (
              <details
                key={status}
                data-status={status}
                data-testid="taskboard-done-column"
                role="region"
                aria-label={`${STATUS_LABELS[status]}列`}
                open={!doneCollapsed}
                onToggle={(event) => setDoneCollapsed(!event.currentTarget.open)}
                className={doneCollapsed ? "contents" : columnClassName}
              >
                <summary
                  className={`${summaryMarkerClassName} ${doneCollapsed
                    ? "absolute right-0 top-2 z-10 flex cursor-pointer items-center gap-1 rounded-l-lg border border-r-0 bg-background/95 px-2 py-2 text-xs font-medium shadow-sm backdrop-blur"
                    : "flex shrink-0 cursor-pointer items-center justify-between border-b px-3 py-2.5"}`}
                  title={doneCollapsed ? "展开已完成列" : "折叠已完成列"}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {doneCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    <span>{STATUS_LABELS[status]}（{columnTasks.length}）</span>
                  </span>
                </summary>
                {renderStatusBody(status, columnTasks)}
              </details>
            );
          }

          return (
            <section
              key={status}
              data-status={status}
              aria-label={`${STATUS_LABELS[status]}列`}
              className={columnClassName}
              onDragOver={(event) => {
                if (dragEnabled) event.preventDefault();
              }}
              onDrop={(event) => {
                if (dragEnabled) onDrop(status, undefined, event);
              }}
            >
              <header className="flex shrink-0 items-center justify-between border-b px-3 py-2.5">
                <h3 className="text-sm font-semibold">{STATUS_LABELS[status]}</h3>
                <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
                  {columnTasks.length}
                </span>
              </header>
              {renderStatusBody(status, columnTasks)}
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
            selectable={canCreateIntegration && task.mergeEligibility === "eligible"}
            selected={selectedDeliveryTaskIds.has(task.id)}
            onSelectedChange={onDeliverySelectedChange}
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
