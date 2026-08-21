import { useState, type DragEvent } from "react";
import {
  TASKBOARD_PRIORITIES,
  type TaskBoard,
  type TaskBoardPriority,
} from "@agent/shared";
import { Archive, ArchiveRestore, MoreHorizontal, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { boardAllows, PRIORITY_LABELS } from "./constants";
import {
  loadBoardOrder,
  orderBoards,
  reorderBoardIds,
  saveBoardOrder,
} from "./boardOrder";

interface BoardToolbarProps {
  boards: TaskBoard[];
  board: TaskBoard;
  search: string;
  submitters: Array<{ id: string; label: string }>;
  submitterUserId: string;
  priority: TaskBoardPriority | "all";
  archivedCount: number;
  message?: string | null;
  onBoardChange: (id: string) => void;
  onCreateBoard: () => void;
  onEditBoard: () => void;
  onArchiveBoard: () => void;
  onRestoreBoard: () => void;
  onSearchChange: (value: string) => void;
  onSubmitterChange: (value: string) => void;
  onPriorityChange: (value: TaskBoardPriority | "all") => void;
  onOpenArchivedTasks: () => void;
}

export function BoardToolbar({
  boards,
  board,
  search,
  submitters,
  submitterUserId,
  priority,
  archivedCount,
  message,
  onBoardChange,
  onCreateBoard,
  onEditBoard,
  onArchiveBoard,
  onRestoreBoard,
  onSearchChange,
  onSubmitterChange,
  onPriorityChange,
  onOpenArchivedTasks,
}: BoardToolbarProps) {
  const [boardOrder, setBoardOrder] = useState(loadBoardOrder);
  const [draggedBoardId, setDraggedBoardId] = useState<string | null>(null);
  const orderedBoards = orderBoards(boards, boardOrder);
  const readOnly = !!board.archivedAt;

  const handleBoardDragStart = (event: DragEvent<HTMLDivElement>, boardId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", boardId);
    setDraggedBoardId(boardId);
  };

  const handleBoardDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleBoardDrop = (event: DragEvent<HTMLDivElement>, targetBoardId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceBoardId = draggedBoardId || event.dataTransfer.getData("text/plain");
    setDraggedBoardId(null);
    if (!sourceBoardId || sourceBoardId === targetBoardId) return;

    const currentOrder = orderedBoards.map((item) => item.id);
    const nextOrder = reorderBoardIds(currentOrder, sourceBoardId, targetBoardId);
    if (nextOrder === currentOrder) return;
    setBoardOrder(nextOrder);
    saveBoardOrder(nextOrder);
  };
  const canOpenSettings = boardAllows(board, "board.update")
    || boardAllows(board, "board.policy.update")
    || boardAllows(board, "board.members.manage");
  const canArchive = boardAllows(board, "board.archive");

  return (
    <div className="mb-3 flex shrink-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={board.id} onValueChange={onBoardChange}>
          <SelectTrigger className="w-full sm:w-64" aria-label="选择看板">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {orderedBoards.map((item) => (
              <SelectItem
                key={item.id}
                value={item.id}
                draggable
                title="拖动调整看板顺序（仅保存在本浏览器）"
                onDragStart={(event) => handleBoardDragStart(event, item.id)}
                onDragOver={handleBoardDragOver}
                onDrop={(event) => handleBoardDrop(event, item.id)}
                onDragEnd={() => setDraggedBoardId(null)}
              >
                {item.name}{item.visibility === "organization" ? "（组织）" : "（个人）"}{item.archivedAt ? "（已归档）" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="看板管理">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>看板管理</DropdownMenuLabel>
            <DropdownMenuItem onSelect={onCreateBoard}>
              <Plus />创建看板
            </DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly || !canOpenSettings} onSelect={onEditBoard}>
              看板设置与成员
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {readOnly ? (
              <DropdownMenuItem disabled={!canArchive} onSelect={onRestoreBoard}>
                <ArchiveRestore />恢复看板
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={!canArchive}
                className="text-destructive focus:text-destructive"
                onSelect={onArchiveBoard}
              >
                <Archive />归档看板
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="pl-9"
            placeholder="搜索编号、标题、正文或标签"
            aria-label="搜索任务"
          />
        </div>
        <div className="w-44">
          <Select value={submitterUserId} onValueChange={onSubmitterChange}>
            <SelectTrigger aria-label="提交人筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部提交人</SelectItem>
              {submitters.map((submitter) => (
                <SelectItem key={submitter.id} value={submitter.id}>{submitter.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-32">
          <Select value={priority} onValueChange={(value) => onPriorityChange(value as TaskBoardPriority | "all")}>
            <SelectTrigger aria-label="优先级筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部优先级</SelectItem>
              {TASKBOARD_PRIORITIES.map((value) => (
                <SelectItem key={value} value={value}>{PRIORITY_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          aria-label={`查看已归档任务（${archivedCount}）`}
          title="查看已归档任务"
          onClick={onOpenArchivedTasks}
        >
          <Archive className="size-4" />
          归档
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{archivedCount}</span>
        </Button>
      </div>
      {readOnly ? (
        <div role="status" className="rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          此看板已归档，当前只读；恢复后才能新建、编辑、移动任务或发表评论。
        </div>
      ) : null}
      {message ? (
        <div role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {message}
        </div>
      ) : null}
    </div>
  );
}
