import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  type ModelList,
  type TaskBoard,
  type TaskBoardExecutionPurpose,
  type TaskBoardStageModels,
  type TaskBoardExecutionStartResult,
  type TaskBoardPriority,
  type TaskBoardStatus,
  type TaskBoardTask,
  type TaskBoardTaskPatchInput,
} from "@agent/shared";
import { Archive, ArchiveRestore, Bell, BellRing, Bot, CircleX, ExternalLink, GitCommitHorizontal, LoaderCircle, Settings2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { requestExecutionCancellation } from "./executionCancellation";
import {
  boardAllows,
  canUserTransitionTask,
  EXECUTION_STATUS_LABELS,
  INTEGRATION_SOURCE_STATE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_KIND_LABELS,
} from "./constants";
import { IntegrationSourceDetails, useIntegrationSources } from "./IntegrationSources";
import { ModelSelect } from "./ModelSelect";
import { TaskAttachmentField, TaskAttachmentList, toTaskBoardAttachments } from "./TaskAttachments";
import { TaskDetailComments, EXECUTION_PURPOSE_LABELS } from "./TaskDetailComments";
import { useTaskComments, useTaskExecutions } from "./hooks";

type TaskDraftField = "description" | "attachments" | "priority" | "stageModels";

const TASK_MODEL_PURPOSES: TaskBoardExecutionPurpose[] = ["work", "review"];
const ACTIVE_EXECUTION_STATUSES = new Set(["queued", "running", "waiting_user", "waiting_approval"]);

function taskStageModels(task: TaskBoardTask): TaskBoardStageModels {
  if (task.stageModels && Object.keys(task.stageModels).length > 0) {
    return {
      ...(task.stageModels.work ? { work: task.stageModels.work } : {}),
      ...(task.stageModels.review ? { review: task.stageModels.review } : {}),
    };
  }
  return task.model
    ? { work: task.model, review: task.model }
    : {};
}

function inheritedModelHint(board: TaskBoard | null, purpose: TaskBoardExecutionPurpose): string {
  const model = board?.stageModels?.[purpose] ?? board?.model;
  return model ?? "未指定时继承看板默认模型";
}

interface TaskDetailProps {
  open: boolean;
  active?: boolean;
  task: TaskBoardTask | null;
  board?: TaskBoard | null;
  boardReadOnly: boolean;
  canUpdateTask?: boolean;
  canTransitionTask?: boolean;
  canArchiveTask?: boolean;
  canDeleteTask?: boolean;
  canComment?: boolean;
  canExecute?: boolean;
  canCancelExecution?: boolean;
  canCancelIntegration?: boolean;
  modelList?: ModelList | null;
  onOpenChange: (open: boolean) => void;
  onTaskLoaded: (task: TaskBoardTask) => void;
  onNavigateTask?: (taskId: string) => void;
  onConfigureCiPolicy?: () => void;
  onUpdate: (
    task: TaskBoardTask,
    input: Omit<TaskBoardTaskPatchInput, "expectedVersion">,
  ) => Promise<TaskBoardTask>;
  onMove: (task: TaskBoardTask, status: TaskBoardStatus) => Promise<TaskBoardTask>;
  onSetArchived: (task: TaskBoardTask, archived: boolean) => Promise<TaskBoardTask>;
  onDeleteTask?: (task: TaskBoardTask) => Promise<TaskBoardTask>;
  onExecute: (
    task: TaskBoardTask,
    purpose?: TaskBoardExecutionPurpose,
  ) => Promise<TaskBoardExecutionStartResult>;
  onCommentsChanged: () => Promise<void>;
}

export function TaskDetail({
  open,
  active = true,
  task,
  board = null,
  boardReadOnly,
  canUpdateTask = true,
  canTransitionTask = true,
  canArchiveTask = true,
  canDeleteTask = true,
  canComment = true,
  canExecute = true,
  canCancelExecution = false,
  canCancelIntegration = false,
  modelList = null,
  onOpenChange,
  onTaskLoaded,
  onNavigateTask,
  onConfigureCiPolicy,
  onUpdate,
  onMove,
  onSetArchived,
  onDeleteTask,
  onExecute,
  onCommentsChanged,
}: TaskDetailProps) {
  const [currentTask, setCurrentTask] = useState<TaskBoardTask | null>(task);
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskBoardPriority>("none");
  const [stageModels, setStageModels] = useState<TaskBoardStageModels>({});
  const [executionStartedTaskId, setExecutionStartedTaskId] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [continueAfterComment, setContinueAfterComment] = useState(false);
  const [pendingContinuationCommentId, setPendingContinuationCommentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [watching, setWatching] = useState(false);
  const [watchLoading, setWatchLoading] = useState(false);
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
  const integrationSourcesState = useIntegrationSources(
    open && currentTask?.kind === "integration" ? currentTask.id : null,
    active && open,
  );

  const hydrateDraft = useCallback((next: TaskBoardTask) => {
    draftTaskIdRef.current = next.id;
    dirtyFieldsRef.current.clear();
    setDescription(next.description);
    taskAttachments.replaceFiles(next.attachments ?? []);
    setPriority(next.priority);
    setStageModels(taskStageModels(next));
  }, [taskAttachments.replaceFiles]);

  const mergeServerDraft = useCallback((next: TaskBoardTask) => {
    const dirty = dirtyFieldsRef.current;
    if (!dirty.has("description")) setDescription(next.description);
    if (!dirty.has("attachments")) taskAttachments.replaceFiles(next.attachments ?? []);
    if (!dirty.has("priority")) setPriority(next.priority);
    if (!dirty.has("stageModels")) setStageModels(taskStageModels(next));
  }, [taskAttachments.replaceFiles]);

  useEffect(() => {
    const switchedTask = task?.id !== draftTaskIdRef.current;
    setCurrentTask(task);
    if (switchedTask) {
      detailRequestRef.current += 1;
      refreshedExecutionRef.current = null;
      setWatching(task?.watched === true);
      setExecutionStartedTaskId(null);
      setSaving(false);
    }
    if (!task) {
      draftTaskIdRef.current = null;
      dirtyFieldsRef.current.clear();
      setCommentBody("");
      setContinueAfterComment(false);
      setPendingContinuationCommentId(null);
      taskAttachments.clearFiles();
      commentAttachments.clearFiles();
      return;
    }
    if (switchedTask) {
      hydrateDraft(task);
      setCommentBody("");
      setContinueAfterComment(false);
      setPendingContinuationCommentId(null);
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
        setWatching(next.watched === true);
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
  const latestExecutionActive = Boolean(latestExecution && ACTIVE_EXECUTION_STATUSES.has(latestExecution.status));
  const executionActive = latestExecution
    ? latestExecutionActive
      || latestExecution.continuationActive === true
      || latestExecution.sessionActivityActive === true
    : false;
  const executionStatusLabel = latestExecution?.sessionActivityActive && !latestExecutionActive
    ? "主 Run 已结束 · 后台仍在执行"
    : latestExecution ? EXECUTION_STATUS_LABELS[latestExecution.status] : "";
  const executionStarted = Boolean(
    taskId
    && (executionStartedTaskId === taskId || executions.some((item) => item.taskId === taskId)),
  );
  useEffect(() => {
    if (latestExecution?.continuationActive || latestExecution?.sessionActivityActive) {
      refreshedExecutionRef.current = null;
      return;
    }
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
  const taskKind = currentTask?.kind ?? "delivery";
  const editReadOnly = readOnly || !canUpdateTask || taskKind === "integration" || taskKind === "remediation";
  const contentReadOnly = editReadOnly || executionStarted;
  const commentReadOnly = readOnly || !canComment;
  const canRunCurrentTask = !readOnly && canExecute
    && !currentTask?.mergedCommitOid
    && (taskKind === "integration"
      ? ["todo", "in_progress"].includes(currentTask?.status ?? "canceled")
      : ["todo", "in_review"].includes(currentTask?.status ?? "canceled")
        || (currentTask?.status === "in_progress" && !executionActive));
  const canContinueCurrentTask = taskKind === "integration"
    ? (!readOnly && canExecute && executionActive
      && currentTask?.status === "in_progress" && latestExecution?.purpose === "work")
    : (canRunCurrentTask && currentTask?.status !== "in_progress")
      || (!readOnly && canExecute && currentTask?.status === "in_progress" && executionActive);
  const canTransitionCurrentTask = Boolean(
    currentTask
    && !readOnly
    && canTransitionTask
    && TASKBOARD_STATUSES.some((status) => canUserTransitionTask(taskKind, currentTask.status, status)),
  );
  const isCurrentOperation = (requestId: number, operationTaskId: string) => (
    requestId === detailRequestRef.current && operationTaskId === draftTaskIdRef.current
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentTask || editReadOnly) return;
    if (taskAttachments.uploading) {
      setError("请等待附件上传完成");
      return;
    }
    const dirty = dirtyFieldsRef.current;
    if (dirty.size === 0) return;
    const input: Omit<TaskBoardTaskPatchInput, "expectedVersion"> = {};
    if (dirty.has("description")) input.description = description.trim();
    if (dirty.has("attachments")) input.attachments = toTaskBoardAttachments(taskAttachments.uploadedFiles);
    if (dirty.has("priority")) input.priority = priority;
    if (dirty.has("stageModels")) input.stageModels = stageModels;

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

  const promoteToDelivery = async () => {
    if (!currentTask || taskKind !== "advisory" || editReadOnly || !canTransitionTask) return;
    if (!window.confirm("确认将该答复与分析任务升级为交付任务吗？升级后将进入待推进，且不能改回 advisory。")) return;
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const next = await onUpdate(operationTask, { kind: "delivery" });
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(next);
      hydrateDraft(next);
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      useConflictCurrent(caught);
      setError(caught instanceof Error ? caught.message : "升级交付任务失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const changeStatus = async (status: TaskBoardStatus) => {
    if (!currentTask || !canTransitionCurrentTask || status === currentTask.status
      || !canUserTransitionTask(taskKind, currentTask.status, status)) return;
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
    if (!currentTask || boardReadOnly || !canArchiveTask) return;
    const operationTask = currentTask;
    const nextArchived = !Boolean(operationTask.archivedAt);
    if (nextArchived && !window.confirm(`确认归档任务“${operationTask.title || operationTask.identifier}”吗？`)) return;
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

  const deleteCurrentTask = async () => {
    if (!currentTask || boardReadOnly || !canDeleteTask || !onDeleteTask) return;
    const operationTask = currentTask;
    if (!window.confirm(`确认删除任务“${operationTask.title || operationTask.identifier}”吗？删除后任务将不再显示，且无法恢复。`)) return;
    setSaving(true);
    setError(null);
    try {
      await onDeleteTask(operationTask);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除任务失败");
    } finally {
      setSaving(false);
    }
  };

  const cancelCurrentExecution = async () => {
    if (!currentTask || !latestExecution || !latestExecutionActive || !canCancelExecution || taskKind === "integration") return;
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true); setError(null);
    try {
      const result = await requestExecutionCancellation(operationTask, latestExecution);
      if (!result || !isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(result.task); mergeServerDraft(result.task); onTaskLoaded(result.task);
      await refreshExecutions();
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      useConflictCurrent(caught);
      setError(caught instanceof Error ? caught.message : "终止 Agent 执行失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const resumeBlocked = async (preset?: { decision: string; startAfterResume?: boolean }) => {
    if (!currentTask || currentTask.status !== "blocked" || !canTransitionTask || executionActive) return;
    const decision = preset?.decision ?? window.prompt(
      taskKind === "integration"
        ? "请填写恢复 Integration Agent 的决策与后续要求"
        : "请填写解除阻塞后的恢复决策与后续要求",
    )?.trim();
    if (!decision) return;
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const resumed = await api.resumeTask(operationTask.id, operationTask.version, decision);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      const next = preset?.startAfterResume ? (await onExecute(resumed, "work")).task : resumed;
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(next);
      mergeServerDraft(next);
      onTaskLoaded(next);
      if (taskKind === "integration") {
          await integrationSourcesState.refresh();
      }
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      useConflictCurrent(caught);
      setError(caught instanceof Error ? caught.message : "恢复任务失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const cancelIntegration = async () => {
    if (!currentTask || taskKind !== "integration" || !canCancelIntegration) return;
    if (!window.confirm(`确认取消集成任务“${currentTask.title}”吗？已合并来源不会回滚。`)) return;
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const next = await api.cancelIntegrationTask(operationTask.id, operationTask.version);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(next);
      onTaskLoaded(next);
      mergeServerDraft(next);
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setError(caught instanceof Error ? caught.message : "取消集成任务失败");
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const startAgentExecution = async (purpose: TaskBoardExecutionPurpose) => {
    const statusAllowed = taskKind === "integration"
      ? purpose === "work" && ["todo", "in_progress"].includes(currentTask?.status ?? "")
      : purpose === "review"
        ? currentTask?.status === "in_review"
        : ["todo", "blocked", "in_progress"].includes(currentTask?.status ?? "");
    if (!currentTask || !canRunCurrentTask || !statusAllowed || executionActive) return;
    if (dirtyFieldsRef.current.size > 0) {
      setError("请先保存未提交的任务修改，再交给 Agent");
      return;
    }
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    try {
      const result = await onExecute(operationTask, purpose);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setExecutionStartedTaskId(operationTask.id);
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
    const retryCommentId = continueAfterComment ? pendingContinuationCommentId : null;
    if ((!retryCommentId && !body && commentAttachments.uploadedFiles.length === 0) || !currentTask || commentReadOnly) return;
    if (continueAfterComment && !canContinueCurrentTask) return;
    if (!retryCommentId && commentAttachments.uploading) {
      setError("请等待附件上传完成");
      return;
    }
    if (continueAfterComment && dirtyFieldsRef.current.size > 0) {
      setError("请先保存未提交的任务修改，再继续执行");
      return;
    }
    const operationTask = currentTask;
    const requestId = ++detailRequestRef.current;
    setSaving(true);
    setError(null);
    let commentPublished = Boolean(retryCommentId);
    try {
      let continuationCommentId = retryCommentId;
      if (!continuationCommentId) {
        const comment = await addComment({
          body,
          ...(commentAttachments.uploadedFiles.length
            ? { attachments: toTaskBoardAttachments(commentAttachments.uploadedFiles) }
            : {}),
        });
        commentPublished = true;
        if (continueAfterComment) continuationCommentId = comment.id;
        if (isCurrentOperation(requestId, operationTask.id)) {
          setCommentBody("");
          commentAttachments.clearFiles();
          if (continueAfterComment) setPendingContinuationCommentId(comment.id);
        }
      }
      if (continueAfterComment && continuationCommentId) {
        const result = await api.continueTaskExecution(operationTask.id, continuationCommentId);
        if (isCurrentOperation(requestId, operationTask.id)) {
          setCurrentTask(result.task);
          mergeServerDraft(result.task);
          onTaskLoaded(result.task);
          setPendingContinuationCommentId(null);
          await refreshExecutions();
        }
      }
      if (isCurrentOperation(requestId, operationTask.id)) {
        setCommentBody("");
        setContinueAfterComment(false);
        setPendingContinuationCommentId(null);
        commentAttachments.clearFiles();
      }
      await onCommentsChanged();
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      const message = caught instanceof Error ? caught.message : "未知错误";
      setError(commentPublished
        ? `${continueAfterComment ? "评论已发表，但继续执行失败，可重试" : "评论已发表，但刷新失败"}：${message}`
        : `发表评论失败：${message}`);
    } finally {
      if (isCurrentOperation(requestId, operationTask.id)) setSaving(false);
    }
  };

  const toggleWatch = async () => {
    if (!currentTask || watchLoading) return;
    setWatchLoading(true);
    setError(null);
    try {
      setWatching(await api.setTaskWatch(currentTask.id, !watching));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新任务关注状态失败");
    } finally {
      setWatchLoading(false);
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
      <SheetContent side="right" className="w-full gap-0 overflow-hidden p-0 sm:max-w-[95vw] xl:max-w-[1400px]">
        {currentTask ? (
          <>
            <SheetHeader className="pr-12">
              <SheetTitle className="truncate">{currentTask.title ? `${currentTask.identifier} · ${currentTask.title}` : currentTask.identifier}</SheetTitle>
              <SheetDescription>
                {boardReadOnly ? "归档看板只读" : archived ? "该任务已归档，可恢复后继续编辑" : "编辑任务并补充评论"}
              </SheetDescription>
            </SheetHeader>
            <div data-testid="task-detail-columns" className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
              <div data-testid="task-detail-information" className="min-h-0 overflow-y-auto border-b p-4 sm:p-6 lg:border-b-0 lg:border-r">
              <section aria-label="流程状态" className="mb-6 space-y-2 rounded-lg border bg-muted/20 p-4 text-sm">
                <h3 className="text-sm font-semibold">流程状态（Task）</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={taskKind === "integration" ? "default" : "secondary"} className={taskKind === "integration" ? "bg-violet-600 hover:bg-violet-600" : ""}>{TASK_KIND_LABELS[taskKind]}</Badge>
                  <Badge variant="outline">{STATUS_LABELS[currentTask.status]}</Badge>
                  {currentTask.integrationState ? <Badge variant="outline">{INTEGRATION_SOURCE_STATE_LABELS[currentTask.integrationState]}</Badge> : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void toggleWatch()}
                    disabled={watchLoading}
                    aria-label={watching ? "取消关注任务" : "关注任务"}
                    title={watching ? "取消关注；之后不再接收该任务关键状态通知" : "关注并接收该任务关键状态通知"}
                  >
                    {watchLoading ? <LoaderCircle className="animate-spin" /> : watching ? <BellRing /> : <Bell />}
                    {watching ? "已关注" : "关注"}
                  </Button>
                  {executionActive && latestExecution?.sessionId ? (
                    <a
                      href={`/chat/${encodeURIComponent(latestExecution.sessionId)}`}
                      className="inline-flex items-center gap-1 rounded-md border border-primary/30 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/5"
                      aria-label="打开当前执行会话"
                      title="打开当前执行会话"
                    >
                      打开会话
                      <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                  {taskKind === "advisory" && canTransitionTask && canUpdateTask && !readOnly ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => void promoteToDelivery()} disabled={saving || executionActive}>
                      升级为交付任务
                    </Button>
                  ) : null}
                </div>
                {latestExecution ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {taskKind === "integration" ? "集成执行" : latestExecution.purpose === "review" ? "独立复核" : taskKind === "advisory" ? "分析/答复" : "实施"}
                      ：{executionStatusLabel}
                    </span>
                    <time>{new Date(latestExecution.updatedAt).toLocaleString("zh-CN")}</time>
                  </div>
                ) : null}
                {executionsError ? <p role="alert" className="text-xs text-destructive">{executionsError}</p> : null}
                {latestExecution?.error ? <p className="whitespace-pre-wrap text-xs text-destructive">{latestExecution.error}</p> : null}
                {canRunCurrentTask && (
                  (taskKind === "integration" && ["todo", "in_progress"].includes(currentTask.status))
                  || (taskKind !== "integration" && currentTask.status === "todo")
                  || (taskKind !== "integration" && currentTask.status === "in_review")
                  || (taskKind !== "integration" && currentTask.status === "in_progress" && !executionActive)
                ) ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void startAgentExecution(
                      taskKind === "integration" ? "work" : currentTask.status === "in_review" ? "review" : "work",
                    )}
                    disabled={saving || executionsLoading || executionActive}
                  >
                    {saving || executionActive ? <LoaderCircle className="animate-spin" /> : <Bot />}
                    {executionActive && latestExecution
                      ? executionStatusLabel
                      : taskKind === "integration" ? "继续集成"
                        : currentTask.status === "in_review" ? "独立复核"
                          : currentTask.status === "in_progress" ? "恢复实施"
                          : taskKind === "advisory" ? "开始分析/答复"
                          : "开始实施"}
                  </Button>
                ) : null}
                {taskKind === "integration" && !["done", "canceled"].includes(currentTask.status) ? (
                  <p className="text-xs text-muted-foreground">
                    一个持久 Integration Agent 自主完成组合、GitHub 合并与清理；只有需要人工决定时才会阻塞。
                  </p>
                ) : null}
                {currentTask.providerPullRequestId ? <p>PR：<span className="font-mono">{currentTask.providerPullRequestId}</span>{currentTask.pullRequestNumber ? `（#${currentTask.pullRequestNumber}）` : ""}</p> : null}
                {taskKind !== "integration" && currentTask.reviewedSubjectDigest ? <p className="break-all text-xs text-muted-foreground">已复核对象：<span className="font-mono">{currentTask.reviewedSubjectDigest}</span></p> : null}
                {currentTask.mergedCommitOid ? <p className="flex items-center gap-1 break-all text-xs text-emerald-700 dark:text-emerald-400"><GitCommitHorizontal className="size-3.5 shrink-0" />merged commit {currentTask.mergedCommitOid}</p> : null}
                {taskKind !== "integration" && currentTask.providerCiStatus === "unconfigured" ? (
                  <div aria-label="CI 门禁未配置" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
                    <p className="font-medium">CI 门禁未配置</p>
                    <p className="text-xs">GitHub required checks 与看板 fallback 均为空；系统已 fail-closed，不会把 observed optional checks 自动视为门禁。</p>
                    {boardAllows(board, "board.policy.update") && onConfigureCiPolicy ? (
                      <Button type="button" size="sm" variant="outline" onClick={onConfigureCiPolicy} disabled={saving}>
                        <Settings2 />前往配置
                      </Button>
                    ) : <p className="text-xs">你没有修改看板策略的权限，请联系看板所有者配置 CI fallback 或 GitHub required checks。</p>}
                    {currentTask.status === "blocked" && canTransitionTask ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void resumeBlocked({ decision: "CI 门禁已配置，恢复实施并重新检查当前精确 PR head", startAfterResume: true })}
                        disabled={saving || executionActive}
                      >
                        {saving ? <LoaderCircle className="animate-spin" /> : <Bot />}恢复任务并重新检查
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {currentTask.status === "blocked" && (taskKind === "integration" || currentTask.providerCiStatus !== "unconfigured") ? (
                  <div className="space-y-2 text-amber-700 dark:text-amber-300">
                    <p>任务已阻塞；请查看最新执行错误或评论中的解除条件。</p>
                    {canTransitionTask ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void resumeBlocked()}
                        disabled={saving || executionActive}
                      >
                        恢复{taskKind === "integration" ? " Integration Agent" : "任务"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {currentTask.resumeContext ? (
                  <div aria-label="最近恢复决策" className="space-y-1 rounded-md border border-blue-200 bg-blue-50 p-3 text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
                    <p className="font-medium">最近恢复决策与后续要求</p>
                    <p className="whitespace-pre-wrap">{currentTask.resumeContext.decision}</p>
                    <p className="text-xs opacity-80">
                      恢复目标：{taskKind === "integration" ? "集成" : currentTask.resumeContext.purpose === "review" ? "复核" : "实施"} Agent
                      {currentTask.resumeContext.sourceIds.length
                        ? ` · ${currentTask.resumeContext.sourceIds.length} 个来源`
                        : ""}
                      {` · 提交于 ${new Date(currentTask.resumeContext.requestedAt).toLocaleString("zh-CN")}`}
                    </p>
                    <p className="text-xs opacity-80">
                      {currentTask.resumeContext.consumedAt
                        ? `已交给 Agent · ${new Date(currentTask.resumeContext.consumedAt).toLocaleString("zh-CN")}`
                        : taskKind === "integration"
                          ? "等待系统自动恢复同一个 Integration Agent"
                          : "尚未交给 Agent，需另行启动"}
                    </p>
                  </div>
                ) : null}
                {taskKind === "remediation" ? <p className="text-amber-700 dark:text-amber-300">{currentTask.status === "done" ? "修复已验收，等待来源继续集成。" : "自动修复任务：完成后会回到来源复核流程，不作为独立交付合并。"}</p> : null}
                {currentTask.rootDeliveryTaskId && taskKind === "remediation" ? (
                  <p>
                    原交付：
                    <button type="button" className="text-primary hover:underline" onClick={() => onNavigateTask?.(currentTask.rootDeliveryTaskId!)} disabled={!onNavigateTask}>
                      {currentTask.rootDeliveryTaskIdentifier ?? currentTask.rootDeliveryTaskId}
                      {currentTask.rootDeliveryTaskTitle ? ` · ${currentTask.rootDeliveryTaskTitle}` : ""}
                    </button>
                  </p>
                ) : null}
                {currentTask.integrationTaskId ? (
                  <p className="text-violet-700 dark:text-violet-300">
                    {currentTask.mergeEligibility === "claimed" ? "已进入集成 " : currentTask.integrationState === "canceled" ? "上次批次已取消，可重新选择：" : "关联集成："}
                    <button type="button" className="hover:underline" onClick={() => onNavigateTask?.(currentTask.integrationTaskId!)} disabled={!onNavigateTask}>
                      {currentTask.integrationTaskIdentifier ?? currentTask.integrationTaskId}
                      {currentTask.integrationTaskTitle ? ` · ${currentTask.integrationTaskTitle}` : ""}
                    </button>
                    {currentTask.mergeEligibility === "claimed" ? "，不可重复选择。" : ""}
                  </p>
                ) : null}
              </section>

              {taskKind === "integration" ? (
                <IntegrationSourceDetails
                  taskId={currentTask.id}
                  state={integrationSourcesState}
                  onNavigateTask={onNavigateTask}
                />
              ) : null}

              <form className="space-y-4" onSubmit={save}>
                {!executionStarted ? (
                  <>
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
                        disabled={contentReadOnly || saving}
                        onPaste={(event) => {
                          if (event.clipboardData.files.length > 0) dirtyFieldsRef.current.add("attachments");
                          void taskAttachments.handlePaste(event);
                        }}
                      />
                      {contentReadOnly ? (
                        <TaskAttachmentList taskId={currentTask.id} attachments={taskAttachments.uploadedFiles} />
                      ) : (
                        <TaskAttachmentField
                          upload={taskAttachments}
                          disabled={saving}
                          onFilesChanged={() => dirtyFieldsRef.current.add("attachments")}
                        />
                      )}
                    </div>
                  </>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>状态</Label>
                    <Select
                      value={currentTask.status}
                      onValueChange={(value) => void changeStatus(value as TaskBoardStatus)}
                      disabled={!canTransitionCurrentTask || saving}
                    >
                      <SelectTrigger aria-label="任务状态"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TASKBOARD_STATUSES.map((status) => (
                          <SelectItem
                            key={status}
                            value={status}
                            disabled={status !== currentTask.status && !canUserTransitionTask(taskKind, currentTask.status, status)}
                          >{STATUS_LABELS[status]}</SelectItem>
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
                      disabled={editReadOnly || saving}
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
                <section aria-label="分阶段运行模型" className="space-y-3 rounded-lg border bg-muted/20 p-3">
                  <div>
                    <h3 className="text-sm font-medium">运行模型</h3>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {TASK_MODEL_PURPOSES.map((purpose) => (
                      <div className="space-y-2" key={purpose}>
                        <Label>{EXECUTION_PURPOSE_LABELS[purpose]}</Label>
                        <ModelSelect
                          modelList={modelList}
                          value={stageModels[purpose] ?? null}
                          onChange={(next) => {
                            dirtyFieldsRef.current.add("stageModels");
                            setStageModels((current) => ({ ...current, [purpose]: next ?? undefined }));
                          }}
                          inheritLabel="继承看板对应阶段模型"
                          ariaLabel={`${EXECUTION_PURPOSE_LABELS[purpose]}运行模型`}
                          disabled={editReadOnly || saving}
                        />
                        <p className="text-[11px] text-muted-foreground">{inheritedModelHint(board, purpose)}</p>
                      </div>
                    ))}
                  </div>
                </section>
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {!editReadOnly ? <Button type="submit" disabled={saving || taskAttachments.uploading}>保存任务</Button> : null}
                  {!boardReadOnly && taskKind !== "integration" && canCancelExecution && latestExecutionActive ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void cancelCurrentExecution()}
                      disabled={saving}
                    >
                      {saving ? <LoaderCircle className="animate-spin" /> : <CircleX />}终止执行
                    </Button>
                  ) : null}
                  {!boardReadOnly && taskKind === "integration" && canCancelIntegration
                    && !["done", "canceled"].includes(currentTask.status) ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void cancelIntegration()}
                      disabled={saving}
                    >
                      <CircleX />取消集成
                    </Button>
                  ) : null}
                  {!boardReadOnly && canArchiveTask ? (
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
                  {!boardReadOnly && canDeleteTask && onDeleteTask ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void deleteCurrentTask()}
                      disabled={saving}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 />
                      删除任务
                    </Button>
                  ) : null}
                </div>
              </form>
              </div>

              <TaskDetailComments
                comments={comments}
                commentsLoading={commentsLoading}
                commentsError={commentsError}
                currentTask={currentTask}
                taskDescription={executionStarted ? description : null}
                taskAttachments={executionStarted ? taskAttachments.uploadedFiles : []}
                latestExecution={latestExecution}
                latestExecutionActive={Boolean(latestExecution && ACTIVE_EXECUTION_STATUSES.has(latestExecution.status))}
                commentReadOnly={commentReadOnly}
                saving={saving}
                canContinueCurrentTask={canContinueCurrentTask}
                commentBody={commentBody}
                setCommentBody={setCommentBody}
                continueAfterComment={continueAfterComment}
                setContinueAfterComment={setContinueAfterComment}
                pendingContinuationCommentId={pendingContinuationCommentId}
                setPendingContinuationCommentId={setPendingContinuationCommentId}
                commentAttachments={commentAttachments}
                onSubmit={submitComment}
              />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
