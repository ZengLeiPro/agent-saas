import { useMemo, useState } from "react";
import {
  TASKBOARD_PRIORITIES,
  type TaskBoardPriority,
  type TaskBoardTask,
} from "@agent/shared";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PRIORITY_LABELS } from "./constants";

interface ArchivedTasksSheetProps {
  open: boolean;
  tasks: TaskBoardTask[];
  readOnly: boolean;
  canRestoreTask: boolean;
  canDeleteTask: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenTask: (task: TaskBoardTask) => void;
  onRestoreTask: (task: TaskBoardTask) => void;
  onDeleteTask: (task: TaskBoardTask) => void;
}

export function ArchivedTasksSheet({
  open,
  tasks,
  readOnly,
  canRestoreTask,
  canDeleteTask,
  onOpenChange,
  onOpenTask,
  onRestoreTask,
  onDeleteTask,
}: ArchivedTasksSheetProps) {
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState<TaskBoardPriority | "all">("all");
  const visibleTasks = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase("zh-CN");
    return tasks.filter((task) => {
      if (priority !== "all" && task.priority !== priority) return false;
      if (!keyword) return true;
      return [task.identifier, task.title, task.description, ...task.labels]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword));
    });
  }, [priority, search, tasks]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-hidden p-0 sm:max-w-xl">
        <SheetHeader className="pr-12">
          <SheetTitle>已归档任务（{tasks.length}）</SheetTitle>
          <SheetDescription>归档任务已退出活跃工作流，可在这里查看、筛选、恢复或删除。</SheetDescription>
        </SheetHeader>

        <div className="flex shrink-0 flex-col gap-2 border-b p-4 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder="搜索编号、标题、正文或标签"
              aria-label="搜索已归档任务"
            />
          </div>
          <Select value={priority} onValueChange={(value) => setPriority(value as TaskBoardPriority | "all")}>
            <SelectTrigger className="w-full sm:w-36" aria-label="已归档任务优先级筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部优先级</SelectItem>
              {TASKBOARD_PRIORITIES.map((value) => (
                <SelectItem key={value} value={value}>{PRIORITY_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {visibleTasks.map((task) => (
            <article key={task.id} className="rounded-xl border bg-card p-3 shadow-sm">
              <button
                type="button"
                className="block w-full text-left"
                aria-label={`打开已归档任务 ${task.identifier}`}
                onClick={() => {
                  onOpenChange(false);
                  onOpenTask(task);
                }}
              >
                <span className="block text-xs text-muted-foreground">{task.identifier}</span>
                <span className="mt-1 block font-medium hover:underline">{task.title}</span>
              </button>
              <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
                <span className="text-xs text-muted-foreground">{PRIORITY_LABELS[task.priority]}优先级</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly || !canRestoreTask}
                    onClick={() => onRestoreTask(task)}
                  >恢复</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={readOnly || !canDeleteTask}
                    onClick={() => {
                      if (!window.confirm(`确认删除任务“${task.title}”吗？删除后任务将不再显示，且无法恢复。`)) return;
                      onDeleteTask(task);
                    }}
                  >删除</Button>
                </div>
              </div>
            </article>
          ))}
          {visibleTasks.length === 0 ? (
            <div className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
              {tasks.length === 0 ? "暂无已归档任务" : "没有符合筛选条件的归档任务"}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
