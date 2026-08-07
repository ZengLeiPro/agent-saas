import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  type TaskBoardPriority,
  type TaskBoardStatus,
  type TaskBoardTask,
  type TaskBoardTaskPatchInput,
} from "@agent/shared";
import { Archive, ArchiveRestore, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Textarea } from "@/components/ui/textarea";
import * as api from "./api";
import {
  dateFromDueAt,
  dueAtFromDate,
  PRIORITY_LABELS,
  splitLabels,
  STATUS_LABELS,
} from "./constants";
import { useTaskComments } from "./hooks";

type TaskDraftField = "title" | "description" | "priority" | "labels" | "dueAt";

interface TaskDetailProps {
  open: boolean;
  active?: boolean;
  task: TaskBoardTask | null;
  boardReadOnly: boolean;
  onOpenChange: (open: boolean) => void;
  onTaskLoaded: (task: TaskBoardTask) => void;
  onUpdate: (
    task: TaskBoardTask,
    input: Omit<TaskBoardTaskPatchInput, "expectedVersion">,
  ) => Promise<TaskBoardTask>;
  onMove: (task: TaskBoardTask, status: TaskBoardStatus) => Promise<TaskBoardTask>;
  onSetArchived: (task: TaskBoardTask, archived: boolean) => Promise<TaskBoardTask>;
  onCommentsChanged: () => Promise<void>;
}

export function TaskDetail({
  open,
  active = true,
  task,
  boardReadOnly,
  onOpenChange,
  onTaskLoaded,
  onUpdate,
  onMove,
  onSetArchived,
  onCommentsChanged,
}: TaskDetailProps) {
  const [currentTask, setCurrentTask] = useState<TaskBoardTask | null>(task);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskBoardPriority>("none");
  const [labels, setLabels] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftTaskIdRef = useRef<string | null>(null);
  const dirtyFieldsRef = useRef<Set<TaskDraftField>>(new Set());
  const detailRequestRef = useRef(0);

  const { comments, loading: commentsLoading, error: commentsError, addComment } =
    useTaskComments(open && task ? task.id : null);

  const hydrateDraft = useCallback((next: TaskBoardTask) => {
    draftTaskIdRef.current = next.id;
    dirtyFieldsRef.current.clear();
    setTitle(next.title);
    setDescription(next.description);
    setPriority(next.priority);
    setLabels(next.labels.join(", "));
    setDueDate(dateFromDueAt(next.dueAt));
  }, []);

  const mergeServerDraft = useCallback((next: TaskBoardTask) => {
    const dirty = dirtyFieldsRef.current;
    if (!dirty.has("title")) setTitle(next.title);
    if (!dirty.has("description")) setDescription(next.description);
    if (!dirty.has("priority")) setPriority(next.priority);
    if (!dirty.has("labels")) setLabels(next.labels.join(", "));
    if (!dirty.has("dueAt")) setDueDate(dateFromDueAt(next.dueAt));
  }, []);

  useEffect(() => {
    const switchedTask = task?.id !== draftTaskIdRef.current;
    setCurrentTask(task);
    if (switchedTask) {
      detailRequestRef.current += 1;
      setSaving(false);
    }
    if (!task) {
      draftTaskIdRef.current = null;
      dirtyFieldsRef.current.clear();
      setCommentBody("");
      return;
    }
    if (switchedTask) {
      hydrateDraft(task);
      setCommentBody("");
      setError(null);
    } else {
      mergeServerDraft(task);
    }
  }, [hydrateDraft, mergeServerDraft, task]);

  const taskId = task?.id ?? null;
  useEffect(() => {
    if (!open || !taskId) return;
    const requestId = ++detailRequestRef.current;
    api.fetchTask(taskId)
      .then((next) => {
        if (requestId !== detailRequestRef.current || next.id !== taskId) return;
        setCurrentTask(next);
        onTaskLoaded(next);
        if (draftTaskIdRef.current !== next.id) hydrateDraft(next);
        else mergeServerDraft(next);
      })
      .catch((caught) => {
        if (requestId === detailRequestRef.current) {
          setError(caught instanceof Error ? caught.message : "加载任务详情失败");
        }
      });
    return () => {
      detailRequestRef.current += 1;
    };
  }, [hydrateDraft, mergeServerDraft, open, onTaskLoaded, taskId]);

  const useConflictCurrent = (caught: unknown) => {
    if (caught instanceof api.TaskBoardConflictError && caught.current) {
      const next = caught.current as TaskBoardTask;
      setCurrentTask(next);
      mergeServerDraft(next);
    }
  };

  const archived = !!currentTask?.archivedAt;
  const readOnly = boardReadOnly || archived;
  const isCurrentOperation = (requestId: number, operationTaskId: string) => (
    requestId === detailRequestRef.current && operationTaskId === draftTaskIdRef.current
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentTask || readOnly) return;
    if (!title.trim()) {
      setError("请输入任务标题");
      return;
    }
    const dirty = dirtyFieldsRef.current;
    if (dirty.size === 0) return;
    const input: Omit<TaskBoardTaskPatchInput, "expectedVersion"> = {};
    if (dirty.has("title")) input.title = title.trim();
    if (dirty.has("description")) input.description = description.trim();
    if (dirty.has("priority")) input.priority = priority;
    if (dirty.has("labels")) input.labels = splitLabels(labels);
    if (dirty.has("dueAt")) input.dueAt = dueDate ? dueAtFromDate(dueDate) : null;

    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const next = await onUpdate(operationTask, input);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(next);
      hydrateDraft(next);
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      useConflictCurrent(caught);
      setError(caught instanceof Error ? caught.message : "保存任务失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const changeStatus = async (status: TaskBoardStatus) => {
    if (!currentTask || readOnly || status === currentTask.status) return;
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const next = await onMove(operationTask, status);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(next);
      mergeServerDraft(next);
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      useConflictCurrent(caught);
      setError(caught instanceof Error ? caught.message : "移动任务失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const changeArchived = async () => {
    if (!currentTask || boardReadOnly) return;
    const operationTask = currentTask;
    const nextArchived = !Boolean(operationTask.archivedAt);
    if (nextArchived && !window.confirm(`确认归档任务“${operationTask.title}”吗？`)) return;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const next = await onSetArchived(operationTask, nextArchived);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(next);
      mergeServerDraft(next);
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      useConflictCurrent(caught);
      setError(caught instanceof Error ? caught.message : nextArchived ? "归档任务失败" : "恢复任务失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const submitComment = async (event: FormEvent) => {
    event.preventDefault();
    const body = commentBody.trim();
    if (!body || !currentTask || readOnly) return;
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      await addComment({ body });
      if (isCurrentOperation(requestId, operationTask.id)) setCommentBody("");
      await onCommentsChanged();
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setError(caught instanceof Error ? caught.message : "发表评论失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  return (
    <Sheet
      open={active && open && !!task}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && saving) return;
        onOpenChange(nextOpen);
      }}
    >
      <SheetContent side="right" className="w-full gap-0 overflow-hidden p-0 sm:max-w-xl">
        {currentTask ? (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="truncate">{currentTask.identifier} · {currentTask.title}</SheetTitle>
              <SheetDescription>
                {boardReadOnly ? "归档看板只读" : archived ? "该任务已归档，可恢复后继续编辑" : "编辑任务并补充评论"}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              <form className="space-y-4" onSubmit={save}>
                <div className="space-y-2">
                  <Label htmlFor="task-detail-title">标题</Label>
                  <Input
                    id="task-detail-title"
                    value={title}
                    onChange={(event) => {
                      dirtyFieldsRef.current.add("title");
                      setTitle(event.target.value);
                    }}
                    disabled={readOnly || saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="task-detail-description">正文</Label>
                  <Textarea
                    id="task-detail-description"
                    value={description}
                    onChange={(event) => {
                      dirtyFieldsRef.current.add("description");
                      setDescription(event.target.value);
                    }}
                    rows={7}
                    disabled={readOnly || saving}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>状态</Label>
                    <Select
                      value={currentTask.status}
                      onValueChange={(value) => void changeStatus(value as TaskBoardStatus)}
                      disabled={readOnly || saving}
                    >
                      <SelectTrigger aria-label="任务状态"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TASKBOARD_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>优先级</Label>
                    <Select
                      value={priority}
                      onValueChange={(value) => {
                        dirtyFieldsRef.current.add("priority");
                        setPriority(value as TaskBoardPriority);
                      }}
                      disabled={readOnly || saving}
                    >
                      <SelectTrigger aria-label="任务优先级"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TASKBOARD_PRIORITIES.map((value) => (
                          <SelectItem key={value} value={value}>{PRIORITY_LABELS[value]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="task-detail-labels">标签</Label>
                  <Input
                    id="task-detail-labels"
                    value={labels}
                    onChange={(event) => {
                      dirtyFieldsRef.current.add("labels");
                      setLabels(event.target.value);
                    }}
                    placeholder="多个标签用逗号分隔"
                    disabled={readOnly || saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="task-detail-due">截止日期</Label>
                  <Input
                    id="task-detail-due"
                    type="date"
                    value={dueDate}
                    onChange={(event) => {
                      dirtyFieldsRef.current.add("dueAt");
                      setDueDate(event.target.value);
                    }}
                    disabled={readOnly || saving}
                  />
                </div>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {!readOnly ? <Button type="submit" disabled={saving}>保存任务</Button> : null}
                  {!boardReadOnly ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void changeArchived()}
                      disabled={saving}
                      className={archived ? "" : "text-destructive hover:text-destructive"}
                    >
                      {archived ? <ArchiveRestore /> : <Archive />}
                      {archived ? "恢复任务" : "归档任务"}
                    </Button>
                  ) : null}
                </div>
              </form>

              <div className="my-6 border-t" />
              <section aria-label="任务评论" className="space-y-3">
                <h3 className="text-sm font-semibold">评论（{comments.length}）</h3>
                {commentsError ? <p role="alert" className="text-sm text-destructive">{commentsError}</p> : null}
                {commentsLoading ? <p className="text-sm text-muted-foreground">正在加载评论...</p> : null}
                {comments.map((comment) => (
                  <article key={comment.id} className="rounded-lg border bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{comment.authorName}</span>
                      <time>{new Date(comment.createdAt).toLocaleString("zh-CN")}</time>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{comment.body}</p>
                  </article>
                ))}
                {!commentsLoading && comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无评论</p>
                ) : null}
                <form className="space-y-2" onSubmit={submitComment}>
                  <Label htmlFor="task-comment-body">发表评论</Label>
                  <Textarea
                    id="task-comment-body"
                    value={commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    placeholder={readOnly ? "只读状态不可发表评论" : "补充进展、上下文或复核意见"}
                    rows={3}
                    disabled={readOnly || saving}
                  />
                  <Button type="submit" size="sm" disabled={readOnly || saving || !commentBody.trim()}>
                    <Send />
                    发表
                  </Button>
                </form>
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
