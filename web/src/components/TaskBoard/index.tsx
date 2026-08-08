import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import type {
  TaskBoardPriority,
  TaskBoardStatus,
  TaskBoardTask,
} from "@agent/shared";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { TaskBoardConflictError } from "./api";
import { BoardDialog } from "./BoardDialog";
import { BoardToolbar } from "./BoardToolbar";
import { useBoardTasks, useTaskBoards } from "./hooks";
import { TaskColumns } from "./TaskColumns";
import { TaskDetail } from "./TaskDetail";
import { TaskDialog } from "./TaskDialog";

interface TaskBoardViewProps {
  headerActionsTarget?: HTMLElement | null;
  active?: boolean;
}

type BoardDialogMode = "create" | "edit" | null;

function sortedInStatus(tasks: TaskBoardTask[], status: TaskBoardStatus, excludedId?: string) {
  return tasks
    .filter((task) => !task.archivedAt && task.status === status && task.id !== excludedId)
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

function optimisticOrder(
  tasks: TaskBoardTask[],
  moved: TaskBoardTask,
  status: TaskBoardStatus,
  previousTaskId?: string,
  nextTaskId?: string,
): TaskBoardTask[] {
  const target = sortedInStatus(tasks, status, moved.id);
  let insertAt = target.length;
  if (nextTaskId) {
    const nextIndex = target.findIndex((task) => task.id === nextTaskId);
    if (nextIndex >= 0) insertAt = nextIndex;
  } else if (previousTaskId) {
    const previousIndex = target.findIndex((task) => task.id === previousTaskId);
    if (previousIndex >= 0) insertAt = previousIndex + 1;
  }
  target.splice(insertAt, 0, { ...moved, status });
  const targetOrder = new Map(target.map((task, index) => [task.id, (index + 1) * 1_000]));
  return tasks.map((task) => {
    const sortOrder = targetOrder.get(task.id);
    if (sortOrder === undefined) return task;
    return {
      ...task,
      ...(task.id === moved.id ? { status } : {}),
      sortOrder,
    };
  });
}

export function TaskBoardView({ headerActionsTarget, active = true }: TaskBoardViewProps) {
  const {
    boards,
    loading: boardsLoading,
    error: boardsError,
    refresh: refreshBoards,
    addBoard,
    updateBoard,
    archive: archiveSelectedBoard,
    restore: restoreSelectedBoard,
  } = useTaskBoards();
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );
  const {
    tasks,
    loading: tasksLoading,
    error: tasksError,
    refresh: refreshTasks,
    addTask,
    updateTask,
    setArchived,
    executeTask,
    optimisticMove,
    syncTask,
  } = useBoardTasks(selectedBoard?.id ?? null);

  const [boardDialogMode, setBoardDialogMode] = useState<BoardDialogMode>(null);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskDialogStatus, setTaskDialogStatus] = useState<TaskBoardStatus>("backlog");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [desktopStatus, setDesktopStatus] = useState<TaskBoardStatus | "all">("all");
  const [mobileStatus, setMobileStatus] = useState<TaskBoardStatus>("backlog");
  const [priority, setPriority] = useState<TaskBoardPriority | "all">("all");
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (boards.length === 0) {
      setSelectedBoardId(null);
      return;
    }
    if (!selectedBoardId || !boards.some((board) => board.id === selectedBoardId)) {
      setSelectedBoardId((boards.find((board) => !board.archivedAt) ?? boards[0]).id);
    }
  }, [boards, selectedBoardId]);

  useEffect(() => {
    if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
      setDetailOpen(false);
    }
  }, [selectedTaskId, tasks]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks],
  );

  const visibleTasks = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase("zh-CN");
    return tasks.filter((task) => {
      if (task.archivedAt) return false;
      if (priority !== "all" && task.priority !== priority) return false;
      if (!keyword) return true;
      return [task.identifier, task.title, task.description, ...task.labels]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword));
    });
  }, [priority, search, tasks]);

  const archivedTasks = useMemo(
    () => tasks.filter((task) => !!task.archivedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [tasks],
  );

  const refresh = useCallback(async () => {
    setNotice(null);
    await Promise.all([refreshBoards(), refreshTasks()]);
  }, [refreshBoards, refreshTasks]);

  const reportMoveError = useCallback((caught: unknown) => {
    if (caught instanceof TaskBoardConflictError) {
      setNotice("任务版本已冲突，已回滚并重新加载最新数据，请重试。");
    } else {
      setNotice(`移动任务失败：${caught instanceof Error ? caught.message : "未知错误"}`);
    }
  }, []);

  const moveTaskTo = useCallback(async (
    task: TaskBoardTask,
    status: TaskBoardStatus,
    previousTaskId?: string,
    nextTaskId?: string,
  ) => {
    const optimisticTasks = optimisticOrder(tasks, task, status, previousTaskId, nextTaskId);
    try {
      const next = await optimisticMove(
        task,
        { status, previousTaskId, nextTaskId },
        optimisticTasks,
      );
      setNotice(null);
      return next;
    } catch (caught) {
      reportMoveError(caught);
      throw caught;
    }
  }, [optimisticMove, reportMoveError, tasks]);

  const handleDrop = (
    status: TaskBoardStatus,
    nextTaskId: string | undefined,
    event: DragEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const taskId = draggedTaskId || event.dataTransfer.getData("text/plain");
    setDraggedTaskId(null);
    const moved = tasks.find((task) => task.id === taskId);
    if (!moved || moved.archivedAt || selectedBoard?.archivedAt || nextTaskId === moved.id) return;
    const target = sortedInStatus(tasks, status, moved.id);
    const nextIndex = nextTaskId ? target.findIndex((task) => task.id === nextTaskId) : -1;
    const previousTaskId = nextIndex > 0
      ? target[nextIndex - 1]?.id
      : nextIndex === 0
        ? undefined
        : target.at(-1)?.id;
    void moveTaskTo(moved, status, previousTaskId, nextTaskId).catch(() => undefined);
  };

  const moveFromDetail = useCallback(async (task: TaskBoardTask, status: TaskBoardStatus) => {
    const previousTaskId = sortedInStatus(tasks, status, task.id).at(-1)?.id;
    return moveTaskTo(task, status, previousTaskId, undefined);
  }, [moveTaskTo, tasks]);

  const moveWithinStatus = useCallback((task: TaskBoardTask, direction: "up" | "down") => {
    const visibleColumn = sortedInStatus(visibleTasks, task.status);
    const currentIndex = visibleColumn.findIndex((item) => item.id === task.id);
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    const target = visibleColumn[targetIndex];
    if (currentIndex < 0 || !target) return;

    const peers = sortedInStatus(tasks, task.status, task.id);
    const peerIndex = peers.findIndex((item) => item.id === target.id);
    if (peerIndex < 0) return;
    const previousTaskId = direction === "up" ? peers[peerIndex - 1]?.id : target.id;
    const nextTaskId = direction === "up" ? target.id : peers[peerIndex + 1]?.id;
    void moveTaskTo(task, task.status, previousTaskId, nextTaskId).catch(() => undefined);
  }, [moveTaskTo, tasks, visibleTasks]);

  const openTaskDialog = (status: TaskBoardStatus) => {
    setTaskDialogStatus(status);
    setTaskDialogOpen(true);
  };

  const headerActions = (
    <>
      <Button size="sm" variant="outline" onClick={() => void refresh()}>
        <RefreshCw className="size-3.5" />
        刷新
      </Button>
      <Button
        size="sm"
        onClick={() => openTaskDialog("backlog")}
        disabled={!selectedBoard || !!selectedBoard.archivedAt}
      >
        <Plus className="size-3.5" />
        新建任务
      </Button>
    </>
  );

  const readOnly = !!selectedBoard?.archivedAt;

  return (
    <div className="flex h-full min-h-0 w-full flex-col px-4 pb-4 pt-3 sm:px-6 sm:pb-6 sm:pt-4">
      {headerActionsTarget === undefined ? (
        <SettingsPanelHeader
          title="任务看板"
          description="人工管理个人工作事项，不会自动执行或驱动定时任务。"
          actions={headerActions}
        />
      ) : headerActionsTarget ? createPortal(headerActions, headerActionsTarget) : null}

      {boardsLoading && boards.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">正在加载任务看板...</div>
      ) : boards.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="max-w-sm rounded-xl border border-dashed px-8 py-12 text-center">
            <h2 className="text-lg font-semibold">还没有任务看板</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">先创建一个个人看板，再记录和推进工作事项。</p>
            {boardsError ? <p role="alert" className="mt-3 text-sm text-destructive">{boardsError}</p> : null}
            <Button className="mt-5" onClick={() => setBoardDialogMode("create")}>
              <Plus />创建看板
            </Button>
          </div>
        </div>
      ) : selectedBoard ? (
        <>
          <BoardToolbar
            boards={boards}
            board={selectedBoard}
            search={search}
            desktopStatus={desktopStatus}
            priority={priority}
            message={notice || boardsError || tasksError}
            onBoardChange={setSelectedBoardId}
            onCreateBoard={() => setBoardDialogMode("create")}
            onEditBoard={() => setBoardDialogMode("edit")}
            onArchiveBoard={() => {
              if (!window.confirm(`确认归档看板“${selectedBoard.name}”吗？归档后看板将只读。`)) return;
              void archiveSelectedBoard(selectedBoard).catch((caught) => {
                setNotice(caught instanceof Error ? caught.message : "归档看板失败");
              });
            }}
            onRestoreBoard={() => {
              void restoreSelectedBoard(selectedBoard).catch((caught) => {
                setNotice(caught instanceof Error ? caught.message : "恢复看板失败");
              });
            }}
            onSearchChange={setSearch}
            onDesktopStatusChange={setDesktopStatus}
            onPriorityChange={setPriority}
          />

          {tasksLoading && tasks.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">正在加载任务...</div>
          ) : (
            <TaskColumns
              tasks={visibleTasks}
              readOnly={readOnly}
              desktopStatus={desktopStatus}
              mobileStatus={mobileStatus}
              onMobileStatusChange={setMobileStatus}
              onCreateTask={openTaskDialog}
              onOpenTask={(task) => {
                setSelectedTaskId(task.id);
                setDetailOpen(true);
              }}
              onMoveTask={moveWithinStatus}
              onDragStart={setDraggedTaskId}
              onDragEnd={() => setDraggedTaskId(null)}
              onDrop={handleDrop}
            />
          )}

          {archivedTasks.length ? (
            <details className="mt-3 shrink-0 rounded-lg border bg-muted/20 px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">已归档任务（{archivedTasks.length}）</summary>
              <div className="mt-2 max-h-32 space-y-2 overflow-y-auto">
                {archivedTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-2 rounded-md bg-card px-3 py-2 text-sm">
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left hover:underline"
                      onClick={() => {
                        setSelectedTaskId(task.id);
                        setDetailOpen(true);
                      }}
                    >
                      {task.identifier} · {task.title}
                    </button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={readOnly}
                      onClick={() => {
                        void setArchived(task, false).catch((caught) => {
                          setNotice(caught instanceof Error ? caught.message : "恢复任务失败");
                        });
                      }}
                    >恢复</Button>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : null}

      <BoardDialog
        active={active}
        open={boardDialogMode !== null}
        board={boardDialogMode === "edit" ? selectedBoard ?? undefined : undefined}
        onOpenChange={(open) => {
          if (!open) setBoardDialogMode(null);
        }}
        onCreate={async (input) => {
          const board = await addBoard(input);
          setSelectedBoardId(board.id);
        }}
        onUpdate={async (id, input) => {
          await updateBoard(id, input);
        }}
      />
      <TaskDialog
        active={active}
        open={taskDialogOpen}
        initialStatus={taskDialogStatus}
        onOpenChange={setTaskDialogOpen}
        onCreate={async (input) => {
          await addTask(input);
        }}
      />
      <TaskDetail
        active={active}
        open={detailOpen}
        task={selectedTask}
        boardReadOnly={readOnly}
        onOpenChange={setDetailOpen}
        onTaskLoaded={syncTask}
        onUpdate={async (task, input) => updateTask(task, input)}
        onMove={moveFromDetail}
        onSetArchived={async (task, archived) => setArchived(task, archived)}
        onExecute={executeTask}
        onCommentsChanged={refreshTasks}
      />
    </div>
  );
}
