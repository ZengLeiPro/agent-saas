import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  type ModelList,
  type TaskBoardExecutionStartResult,
  type TaskBoardPriority,
  type TaskBoardStatus,
  type TaskBoardTask,
  type TaskBoardTaskPatchInput,
} from "@agent/shared";
import { Archive, ArchiveRestore, Bot, ExternalLink, LoaderCircle, Send } from "lucide-react";
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
import { useFileUpload } from "@/hooks/useFileUpload";
import * as api from "./api";
import {
  dateFromDueAt,
  dueAtFromDate,
  EXECUTION_STATUS_LABELS,
  PRIORITY_LABELS,
  splitLabels,
  STATUS_LABELS,
} from "./constants";
import { ModelSelect } from "./ModelSelect";
import { TaskAttachmentField, TaskAttachmentList, toTaskBoardAttachments } from "./TaskAttachments";
import { useTaskComments, useTaskExecutions } from "./hooks";

type TaskDraftField = "title" | "description" | "attachments" | "priority" | "labels" | "dueAt" | "model";

const ACTIVE_EXECUTION_STATUSES = new Set(["queued", "running", "waiting_user", "waiting_approval"]);

interface TaskDetailProps {
  open: boolean;
  active?: boolean;
  task: TaskBoardTask | null;
  boardReadOnly: boolean;
  modelList?: ModelList | null;
  onOpenChange: (open: boolean) => void;
  onTaskLoaded: (task: TaskBoardTask) => void;
  onUpdate: (
    task: TaskBoardTask,
    input: Omit<TaskBoardTaskPatchInput, "expectedVersion">,
  ) => Promise<TaskBoardTask>;
  onMove: (task: TaskBoardTask, status: TaskBoardStatus) => Promise<TaskBoardTask>;
  onSetArchived: (task: TaskBoardTask, archived: boolean) => Promise<TaskBoardTask>;
  onExecute: (task: TaskBoardTask) => Promise<TaskBoardExecutionStartResult>;
  onCommentsChanged: () => Promise<void>;
}

export function TaskDetail({
  open,
  active = true,
  task,
  boardReadOnly,
  modelList = null,
  onOpenChange,
  onTaskLoaded,
  onUpdate,
  onMove,
  onSetArchived,
  onExecute,
  onCommentsChanged,
}: TaskDetailProps) {
  const [currentTask, setCurrentTask] = useState<TaskBoardTask | null>(task);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskBoardPriority>("none");
  const [labels, setLabels] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskAttachments = useFileUpload("taskboard");
  const commentAttachments = useFileUpload("taskboard");
  const draftTaskIdRef = useRef<string | null>(null);
  const dirtyFieldsRef = useRef<Set<TaskDraftField>>(new Set());
  const detailRequestRef = useRef(0);
  const refreshedExecutionRef = useRef<string | null>(null);

  const {
    comments,
    loading: commentsLoading,
    error: commentsError,
    addComment,
    refresh: refreshComments,
  } = useTaskComments(open && task ? task.id : null);
  const {
    executions,
    loading: executionsLoading,
    error: executionsError,
    refresh: refreshExecutions,
  } = useTaskExecutions(open && task ? task.id : null, active && open);

  const hydrateDraft = useCallback((next: TaskBoardTask) => {
    draftTaskIdRef.current = next.id;
    dirtyFieldsRef.current.clear();
    setTitle(next.title);
    setDescription(next.description);
    taskAttachments.replaceFiles(next.attachments ?? []);
    setPriority(next.priority);
    setLabels(next.labels.join(", "));
    setDueDate(dateFromDueAt(next.dueAt));
    setModel(next.model ?? null);
  }, [taskAttachments.replaceFiles]);

  const mergeServerDraft = useCallback((next: TaskBoardTask) => {
    const dirty = dirtyFieldsRef.current;
    if (!dirty.has("title")) setTitle(next.title);
    if (!dirty.has("description")) setDescription(next.description);
    if (!dirty.has("attachments")) taskAttachments.replaceFiles(next.attachments ?? []);
    if (!dirty.has("priority")) setPriority(next.priority);
    if (!dirty.has("labels")) setLabels(next.labels.join(", "));
    if (!dirty.has("dueAt")) setDueDate(dateFromDueAt(next.dueAt));
    if (!dirty.has("model")) setModel(next.model ?? null);
  }, [taskAttachments.replaceFiles]);

  useEffect(() => {
    const switchedTask = task?.id !== draftTaskIdRef.current;
    setCurrentTask(task);
    if (switchedTask) {
      detailRequestRef.current += 1;
      refreshedExecutionRef.current = null;
      setSaving(false);
    }
    if (!task) {
      draftTaskIdRef.current = null;
      dirtyFieldsRef.current.clear();
      setCommentBody("");
      taskAttachments.clearFiles();
      commentAttachments.clearFiles();
      return;
    }
    if (switchedTask) {
      hydrateDraft(task);
      setCommentBody("");
      commentAttachments.clearFiles();
      setError(null);
    } else {
      mergeServerDraft(task);
    }
  }, [
    commentAttachments.clearFiles,
    hydrateDraft,
    mergeServerDraft,
    task,
    taskAttachments.clearFiles,
  ]);

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

  const latestExecution = executions[0];
  const executionActive = latestExecution
    ? ACTIVE_EXECUTION_STATUSES.has(latestExecution.status)
    : false;
  useEffect(() => {
    if (
      !open
      || !taskId
      || !latestExecution
      || ACTIVE_EXECUTION_STATUSES.has(latestExecution.status)
      || refreshedExecutionRef.current === latestExecution.id
    ) return;
    refreshedExecutionRef.current = latestExecution.id;
    void Promise.all([api.fetchTask(taskId), refreshComments()])
      .then(([next]) => {
        if (taskId !== draftTaskIdRef.current) return;
        setCurrentTask(next);
        onTaskLoaded(next);
        mergeServerDraft(next);
      })
      .catch((caught) => {
        if (taskId === draftTaskIdRef.current) {
          setError(caught instanceof Error ? caught.message : "刷新 Agent 交付结果失败");
        }
      });
  }, [latestExecution, mergeServerDraft, onTaskLoaded, open, refreshComments, taskId]);

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
    if (taskAttachments.uploading) {
      setError("请等待附件上传完成");
      return;
    }
    if (!title.trim()) {
      setError("请输入任务标题");
      return;
    }
    const dirty = dirtyFieldsRef.current;
    if (dirty.size === 0) return;
    const input: Omit<TaskBoardTaskPatchInput, "expectedVersion"> = {};
    if (dirty.has("title")) input.title = title.trim();
    if (dirty.has("description")) input.description = description.trim();
    if (dirty.has("attachments")) input.attachments = toTaskBoardAttachments(taskAttachments.uploadedFiles);
    if (dirty.has("priority")) input.priority = priority;
    if (dirty.has("labels")) input.labels = splitLabels(labels);
    if (dirty.has("dueAt")) input.dueAt = dueDate ? dueAtFromDate(dueDate) : null;
    if (dirty.has("model")) input.model = model;

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

  const startAgentExecution = async () => {
    if (!currentTask || readOnly || currentTask.status !== "todo" || executionActive) return;
    if (dirtyFieldsRef.current.size > 0) {
      setError("请先保存未提交的任务修改，再交给 Agent");
      return;
    }
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const result = await onExecute(operationTask);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(result.task);
      mergeServerDraft(result.task);
      onTaskLoaded(result.task);
      await refreshExecutions();
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      useConflictCurrent(caught);
      setError(caught instanceof Error ? caught.message : "启动 Agent 执行失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const submitComment = async (event: FormEvent) => {
    event.preventDefault();
    const body = commentBody.trim();
    if ((!body && commentAttachments.uploadedFiles.length === 0) || !currentTask || readOnly) return;
    if (commentAttachments.uploading) {
      setError("请等待附件上传完成");
      return;
    }
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      await addComment({
        body,
        ...(commentAttachments.uploadedFiles.length
          ? { attachments: toTaskBoardAttachments(commentAttachments.uploadedFiles) }
          : {}),
      });
      if (isCurrentOperation(requestId, operationTask.id)) {
        setCommentBody("");
        commentAttachments.clearFiles();
      }
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
              <section aria-label="Agent 执行" className="mb-6 space-y-3 rounded-lg border bg-muted/20 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Agent 执行</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Agent 自验后只会进入待复核，由你确认是否完成。
                    </p>
                  </div>
                  {!readOnly && currentTask.status === "todo" ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void startAgentExecution()}
                      disabled={saving || executionsLoading || executionActive}
                    >
                      {saving || executionActive ? <LoaderCircle className="animate-spin" /> : <Bot />}
                      {executionActive && latestExecution
                        ? EXECUTION_STATUS_LABELS[latestExecution.status]
                        : "交给 Agent"}
                    </Button>
                  ) : null}
                </div>
                {executionsError ? <p role="alert" className="text-sm text-destructive">{executionsError}</p> : null}
                {executionsLoading && executions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">正在加载执行记录...</p>
                ) : null}
                {latestExecution ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{EXECUTION_STATUS_LABELS[latestExecution.status]}</span>
                      <time className="text-xs text-muted-foreground">
                        {new Date(latestExecution.updatedAt).toLocaleString("zh-CN")}
                      </time>
                    </div>
                    {latestExecution.error ? (
                      <p className="whitespace-pre-wrap text-xs text-destructive">{latestExecution.error}</p>
                    ) : null}
                    <a
                      href={`/chat/${encodeURIComponent(latestExecution.sessionId)}`}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      打开执行会话
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                ) : !executionsLoading ? (
                  <p className="text-sm text-muted-foreground">尚未交给 Agent 执行</p>
                ) : null}
              </section>

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
                    onPaste={(event) => {
                      if (event.clipboardData.files.length > 0) dirtyFieldsRef.current.add("attachments");
                      void taskAttachments.handlePaste(event);
                    }}
                  />
                  {readOnly ? (
                    <TaskAttachmentList attachments={taskAttachments.uploadedFiles} />
                  ) : (
                    <TaskAttachmentField
                      upload={taskAttachments}
                      disabled={saving}
                      onFilesChanged={() => dirtyFieldsRef.current.add("attachments")}
                    />
                  )}
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
                <div className="space-y-2">
                  <Label>运行模型</Label>
                  <ModelSelect
                    modelList={modelList}
                    value={model}
                    onChange={(next) => {
                      dirtyFieldsRef.current.add("model");
                      setModel(next);
                    }}
                    inheritLabel="继承看板默认模型"
                    ariaLabel="任务运行模型"
                    disabled={readOnly || saving}
                  />
                  <p className="text-xs text-muted-foreground">
                    交给 Agent 执行时使用的模型，未指定时继承看板默认模型。
                  </p>
                </div>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {!readOnly ? <Button type="submit" disabled={saving || taskAttachments.uploading}>保存任务</Button> : null}
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
                    {comment.body ? (
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{comment.body}</p>
                    ) : null}
                    <TaskAttachmentList attachments={comment.attachments ?? []} />
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
                    onPaste={(event) => void commentAttachments.handlePaste(event)}
                  />
                  {!readOnly ? <TaskAttachmentField upload={commentAttachments} disabled={saving} /> : null}
                  <Button
                    type="submit"
                    size="sm"
                    disabled={readOnly || saving || commentAttachments.uploading
                      || (!commentBody.trim() && commentAttachments.uploadedFiles.length === 0)}
                  >
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
