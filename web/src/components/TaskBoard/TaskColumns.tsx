import { useEffect, useState, type DragEvent } from "react";
import {
  TASKBOARD_STATUSES,
  type TaskBoardStatus,
  type TaskBoardTask,
} from "@agent/shared";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TaskCard } from "./TaskCard";
import {
  sortTaskBoardTasks,
  STATUS_LABELS,
  taskStatusSupportsManualOrdering,
} from "./constants";

interface TaskColumnsProps {
  boardId: string;
  tasks: TaskBoardTask[];
  readOnly: boolean;
  canCreateTask: boolean;
  canReorderTask: boolean;
  canTransitionTask: boolean;
  canCreateIntegration: boolean;
  selectedDeliveryTaskIds: Set<string>;
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

const desktopStatuses: TaskBoardStatus[] = [
  ...TASKBOARD_STATUSES.filter((status) => status !== "done"),
  "done",
];
const columnClassName = "flex h-full w-72 shrink-0 flex-col rounded-xl border bg-muted/30";
const collapsedDoneClassName = "flex h-full w-10 shrink-0 flex-col rounded-xl border bg-muted/30";
const summaryMarkerClassName = "list-none [&::-webkit-details-marker]:hidden";

function doneCollapsedStorageKey(boardId: string): string {
  return `taskboard:${boardId}:done-collapsed`;
}

function readDoneCollapsed(boardId: string): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(doneCollapsedStorageKey(boardId)) !== "false";
}

export function TaskColumns({
  boardId,
  tasks,
  readOnly,
  canCreateTask,
  canReorderTask,
  canTransitionTask,
  canCreateIntegration,
  selectedDeliveryTaskIds,
  mobileStatus,
  onMobileStatusChange,
  onCreateTask,
  onOpenTask,
  onDragStart,
  onDragEnd,
  onDeliverySelectedChange,
  onDrop,
}: TaskColumnsProps) {
  const [doneCollapsed, setDoneCollapsed] = useState(() => readDoneCollapsed(boardId));
  const mobileTasks = sortTaskBoardTasks(tasks, mobileStatus);

  useEffect(() => {
    setDoneCollapsed(readDoneCollapsed(boardId));
  }, [boardId]);
  const dragEnabled = !readOnly && (canReorderTask || canTransitionTask);
  const canDragStatus = (status: TaskBoardStatus) => dragEnabled && taskStatusSupportsManualOrdering(status);

  const renderStatusBody = (status: TaskBoardStatus, columnTasks: TaskBoardTask[]) => {
    const statusDragEnabled = canDragStatus(status);
    return (
    <>
      {["backlog", "todo"].includes(status) ? (
        <div className="shrink-0 border-b p-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            disabled={readOnly || !canCreateTask}
            aria-label={`在${STATUS_LABELS[status]}新建任务`}
            onClick={() => onCreateTask(status)}
          >
            <Plus className="size-3.5" />
            新建任务
          </Button>
        </div>
      ) : null}
      <div
        className="min-h-24 flex-1 space-y-2 overflow-y-auto p-2"
        onDragOver={(event) => {
          if (statusDragEnabled) event.preventDefault();
        }}
        onDrop={(event) => {
          if (statusDragEnabled) onDrop(status, undefined, event);
        }}
      >
        {columnTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            readOnly={readOnly}
            allowDrag={statusDragEnabled}
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
  };

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
        {["backlog", "todo"].includes(mobileStatus) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 w-full"
            disabled={readOnly || !canCreateTask}
            aria-label={`在${STATUS_LABELS[mobileStatus]}新建任务`}
            onClick={() => onCreateTask(mobileStatus)}
          >
            <Plus className="size-3.5" />
            新建任务
          </Button>
        ) : null}
      </div>

      <div
        data-testid="taskboard-columns"
        aria-label="八态任务看板"
        className="hidden h-full min-w-0 gap-3 overflow-x-auto pb-2 md:flex"
      >
        {desktopStatuses.map((status) => {
          const columnTasks = sortTaskBoardTasks(tasks, status);

          if (status === "done") {
            return (
              <details
                key={status}
                data-status={status}
                data-testid="taskboard-done-column"
                role="region"
                aria-label={`${STATUS_LABELS[status]}列`}
                open={!doneCollapsed}
                onToggle={(event) => {
                  const collapsed = !event.currentTarget.open;
                  setDoneCollapsed(collapsed);
                  window.localStorage.setItem(doneCollapsedStorageKey(boardId), String(collapsed));
                }}
                className={doneCollapsed ? collapsedDoneClassName : columnClassName}
              >
                <summary
                  className={`${summaryMarkerClassName} ${doneCollapsed
                    ? "flex h-full min-h-56 cursor-pointer flex-col items-center gap-2 rounded-xl py-2 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    : "flex shrink-0 cursor-pointer items-center justify-between border-b px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"}`}
                  title={doneCollapsed ? "展开已完成列" : "折叠已完成列"}
                >
                  {doneCollapsed ? (
                    <>
                      <ChevronRight className="size-3.5 shrink-0" />
                      <span className="[writing-mode:vertical-rl]">{STATUS_LABELS[status]}</span>
                      <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {columnTasks.length}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="flex min-w-0 items-center gap-2">
                        <ChevronLeft className="size-3.5 shrink-0" />
                        <span className="text-sm font-semibold">{STATUS_LABELS[status]}</span>
                      </span>
                      <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
                        {columnTasks.length}
                      </span>
                    </>
                  )}
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
                if (canDragStatus(status)) event.preventDefault();
              }}
              onDrop={(event) => {
                if (canDragStatus(status)) onDrop(status, undefined, event);
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
