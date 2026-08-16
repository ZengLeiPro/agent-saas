import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  type TaskBoard,
  type TaskBoardPriority,
  type TaskBoardStatus,
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
import { boardAllows, MEMBER_ROLE_LABELS, PRIORITY_LABELS, STATUS_LABELS } from "./constants";

interface BoardToolbarProps {
  boards: TaskBoard[];
  board: TaskBoard;
  search: string;
  desktopStatus: TaskBoardStatus | "all";
  priority: TaskBoardPriority | "all";
  message?: string | null;
  onBoardChange: (id: string) => void;
  onCreateBoard: () => void;
  onEditBoard: () => void;
  onArchiveBoard: () => void;
  onRestoreBoard: () => void;
  onSearchChange: (value: string) => void;
  onDesktopStatusChange: (value: TaskBoardStatus | "all") => void;
  onPriorityChange: (value: TaskBoardPriority | "all") => void;
}

export function BoardToolbar({
  boards,
  board,
  search,
  desktopStatus,
  priority,
  message,
  onBoardChange,
  onCreateBoard,
  onEditBoard,
  onArchiveBoard,
  onRestoreBoard,
  onSearchChange,
  onDesktopStatusChange,
  onPriorityChange,
}: BoardToolbarProps) {
  const readOnly = !!board.archivedAt;
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
            {boards.map((item) => (
              <SelectItem key={item.id} value={item.id}>
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
        <div className="hidden w-36 md:block">
          <Select value={desktopStatus} onValueChange={(value) => onDesktopStatusChange(value as TaskBoardStatus | "all")}>
            <SelectTrigger aria-label="状态筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {TASKBOARD_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>
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
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {board.visibility === "organization" ? "组织看板" : "个人看板"}
        {` · 当前角色：${MEMBER_ROLE_LABELS[board.role ?? (board.canManage ? "owner" : "editor")]}`}
        {board.repository ? ` · GitHub ${board.repository.owner}/${board.repository.name}:${board.repository.baseBranch}` : ""}
        {board.integrationPolicy ? ` · 集成${board.integrationPolicy.enabled ? "已启用" : "已停用"}（${board.integrationPolicy.trigger.mode}）` : ""}
        {board.description ? ` · ${board.description}` : ""}
      </p>
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
