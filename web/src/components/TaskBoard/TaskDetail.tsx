import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
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
import { Archive, ArchiveRestore, Bell, BellRing, Bot, CircleX, ExternalLink, GitCommitHorizontal, LoaderCircle, Settings2, Trash2, X } from "lucide-react";
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
import { FloatingPanel } from "@/components/ui/floating-panel";
import {
  BRAND_SEGMENTED_TABS_LIST_CLASS,
  BRAND_SEGMENTED_TAB_TRIGGER_CLASS,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useFileUpload } from "@/hooks/useFileUpload";
import * as api from "./api";
import { requestExecutionCancellation } from "./executionCancellation";
import {
  boardAllows,
  canUserMoveTask,
  EXECUTION_STATUS_LABELS,
  INTEGRATION_SOURCE_STATE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
} from "./constants";
import { IntegrationSourceDetails, useIntegrationSources } from "./IntegrationSources";
import { ModelSelect } from "./ModelSelect";
import { TaskAttachmentField, TaskAttachmentList, toTaskBoardAttachments } from "./TaskAttachments";
import { canManuallyCompleteTask, TaskCompletionButton } from "./TaskCompletionButton";
import { TaskDetailComments, EXECUTION_PURPOSE_LABELS } from "./TaskDetailComments";
import { useTaskComments, useTaskExecutions } from "./hooks";
type TaskDraftField = "description" | "attachments" | "priority" | "stageModels";
type TaskDetailTab = "details" | "discussion";
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
  canReorderTask?: boolean;
  canTransitionTask?: boolean;
  canArchiveTask?: boolean;
  canDeleteTask?: boolean;
  canComment?: boolean;
  canExecute?: boolean;
  canCancelExecution?: boolean;
  canCancelIntegration?: boolean;
  modelList?: ModelList | null;
  portalTarget?: HTMLElement | null;
  onOpenChange: (open: boolean) => void;
  onTaskLoaded: (task: TaskBoardTask) => void;
  onNavigateTask?: (taskId: string) => void;
  onConfigureCiPolicy?: () => void;
  onUpdate: (
    task: TaskBoardTask,
    input: Omit<TaskBoardTaskPatchInput, "expectedVersion">,
  ) => Promise<TaskBoardTask>;
  onMove: (task: TaskBoardTask, status: TaskBoardStatus) => Promise<TaskBoardTask>;
  onCompleteTask: (task: TaskBoardTask) => Promise<TaskBoardTask>;
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
  canReorderTask = true,
  canTransitionTask = true,
  canArchiveTask = true,
  canDeleteTask = true,
  canComment = true,
  canExecute = true,
  canCancelExecution = false,
  canCancelIntegration = false,
  modelList = null,
  portalTarget = null, onOpenChange,
  onTaskLoaded,
  onNavigateTask,
  onConfigureCiPolicy,
  onUpdate,
  onMove,
  onCompleteTask,
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
  const [activeTab, setActiveTab] = useState<TaskDetailTab>(task?.commentCount ? "discussion" : "details");
  const [error, setError] = useState<string | null>(null);
  const taskAttachments = useFileUpload("taskboard");
  const commentAttachments = useFileUpload("taskboard");
  const draftTaskIdRef = useRef<string | null>(null);
  const dirtyFieldsRef = useRef<Set<TaskDraftField>>(new Set());
  const detailRequestRef = useRef(0);
  const refreshedExecutionRef = useRef<string | null>(null);
  const tabSelectionResolvedTaskIdRef = useRef<string | null>(null);
  const detailsViewportRef = useRef<HTMLDivElement>(null);
  const detailsContentRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const {
    comments,
    loading: commentsLoading,
    error: commentsError,
    ready: commentsReady,
    addComment,
    refresh: refreshComments,
  } = useTaskComments(open && task ? task.id : null);
  const {
    executions,
    loading: executionsLoading,
    error: executionsError,
    ready: executionsReady,
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

  const resizeDescription = useCallback(() => {
    const textarea = descriptionRef.current;
    const viewport = detailsViewportRef.current;
    const content = detailsContentRef.current;
    if (!textarea || !viewport || !content) return;

    textarea.style.height = "auto";
    const styles = window.getComputedStyle(textarea);
    const cssPixels = (value: string) => Number.parseFloat(value) || 0;
    const lineHeight = cssPixels(styles.lineHeight) || 20;
    const verticalChrome = cssPixels(styles.paddingTop) + cssPixels(styles.paddingBottom)
      + cssPixels(styles.borderTopWidth) + cssPixels(styles.borderBottomWidth);
    const minimumHeight = Math.ceil(lineHeight * 3 + verticalChrome);
    const naturalHeight = textarea.scrollHeight;
    textarea.style.height = `${minimumHeight}px`;

    const fixedContentHeight = content.scrollHeight - textarea.offsetHeight;
    const availableHeight = Math.max(minimumHeight, viewport.clientHeight - fixedContentHeight);
    const nextHeight = Math.min(
      Math.max(naturalHeight, minimumHeight),
      availableHeight,
      naturalHeight + lineHeight * 2,
    );
    textarea.style.height = `${Math.max(minimumHeight, nextHeight)}px`;
    textarea.style.overflowY = naturalHeight > nextHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeDescription();
  });

  useEffect(() => {
    const viewport = detailsViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeDescription);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [active, open, resizeDescription, task?.id]);

  useEffect(() => {
    const switchedTask = task?.id !== draftTaskIdRef.current;
    setCurrentTask(task);
    if (switchedTask) {
      detailRequestRef.current += 1;
      refreshedExecutionRef.current = null;
      tabSelectionResolvedTaskIdRef.current = null;
      setWatching(task?.watched === true);
      setExecutionStartedTaskId(null);
      setActiveTab(task?.commentCount ? "discussion" : "details");
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
    if (!taskId || !commentsReady || tabSelectionResolvedTaskIdRef.current === taskId) return;
    setActiveTab(comments.length > 0 ? "discussion" : "details");
    tabSelectionResolvedTaskIdRef.current = taskId;
  }, [comments.length, commentsReady, taskId]);

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
  const canMoveCurrentTaskTo = (status: TaskBoardStatus) => Boolean(currentTask && canUserMoveTask(
    currentTask, currentTask.status, status, canReorderTask, canTransitionTask,
  ));
  const canTransitionCurrentTask = Boolean(
    currentTask && !readOnly && TASKBOARD_STATUSES.some(canMoveCurrentTaskTo),
  );
  const canCompleteCurrentTask = canManuallyCompleteTask(currentTask, readOnly, canTransitionTask, executionActive, executionsReady && !executionsLoading && !executionsError);
  const integrationMergedCount = integrationSourcesState.sources.filter((source) => source.state === "merged").length;
  const integrationNeedsHumanCount = integrationSourcesState.sources.filter((source) => source.state === "needs_human").length;
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
      || !canMoveCurrentTaskTo(status)) return;
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

  const completeCurrentTask = async () => {
    if (!currentTask || !canCompleteCurrentTask) return;
    if (!window.confirm(`确认将任务“${currentTask.title || currentTask.identifier}”标记为已完成吗？完成后将结束当前任务工作流。`)) return;
    const operationTask = currentTask; const requestId = ++detailRequestRef.current;
    setSaving(true); setError(null);
    try {
      const next = await onCompleteTask(operationTask);
      if (!isCurrentOperation(requestId, operationTask.id)) return;
      setCurrentTask(next); mergeServerDraft(next); onTaskLoaded(next);
    } catch (caught) {
      if (!isCurrentOperation(requestId, operationTask.id)) return; useConflictCurrent(caught); void refreshExecutions();
      setError(caught instanceof Error ? caught.message : "完成任务失败");
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
        ? `${continueAfterComment ? "讨论已发表，但继续执行失败，可重试" : "讨论已发表，但刷新失败"}：${message}`
        : `发表讨论失败：${message}`);
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

  useEffect(() => {
    if (!active || !open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || saving) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="listbox"], [data-radix-popper-content-wrapper]')) return;
      onOpenChange(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [active, onOpenChange, open, saving]);

  if (!active || !open || !task) return null;

  const panel = (
    <FloatingPanel
      role="dialog"
      aria-modal={false}
      aria-labelledby="task-detail-title"
      data-testid="task-detail-panel"
      className={portalTarget
        ? "flex h-full min-h-0 w-full flex-col"
        : "absolute inset-0 z-20 flex min-h-0 flex-col md:static md:basis-[46%] md:min-w-[24rem] md:max-w-[36rem] md:shrink-0"}
    >
        {currentTask ? (
          <>
            <div className="space-y-2 border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <h2 id="task-detail-title" className="min-w-0 flex-1 truncate text-lg font-semibold">{currentTask.title ? `${currentTask.identifier} · ${currentTask.title}` : currentTask.identifier}</h2>
                <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0" aria-label="关闭任务详情"
                  disabled={saving} onClick={() => onOpenChange(false)}><X className="size-4" /></Button>
              </div>
              <div data-testid="task-detail-actions" className="flex flex-wrap items-center gap-2">
                {currentTask.integrationState ? <Badge variant="outline">{INTEGRATION_SOURCE_STATE_LABELS[currentTask.integrationState]}</Badge> : null}
                {taskKind === "integration" && integrationSourcesState.sources.length > 0 ? <Badge variant="outline">{integrationMergedCount}/{integrationSourcesState.sources.length} 已合并</Badge> : null}
                {integrationNeedsHumanCount > 0 ? <Badge variant="destructive">{integrationNeedsHumanCount} 项需人工处理</Badge> : null}
                {latestExecution ? <Badge variant="outline">{executionStatusLabel}</Badge> : null}
                <Button type="button" size="sm" variant="ghost" onClick={() => void toggleWatch()} disabled={watchLoading}
                  aria-label={watching ? "取消关注任务" : "关注任务"} title={watching ? "取消关注；之后不再接收该任务关键状态通知" : "关注并接收该任务关键状态通知"}>
                  {watchLoading ? <LoaderCircle className="animate-spin" /> : watching ? <BellRing /> : <Bell />}
                  <span className="sr-only">{watching ? "已关注" : "关注"}</span>
                </Button>
                {executionActive && latestExecution?.sessionId ? (
                  <a href={`/chat/${encodeURIComponent(latestExecution.sessionId)}`} aria-label="打开当前执行会话" title="打开当前执行会话"
                    className="inline-flex items-center gap-1 rounded-md border border-primary/30 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/5">
                    打开会话<ExternalLink className="size-3" />
                  </a>
                ) : null}
                {canRunCurrentTask ? (
                  <Button type="button" size="sm" disabled={saving || executionsLoading || executionActive}
                    onClick={() => void startAgentExecution(taskKind === "integration" ? "work" : currentTask.status === "in_review" ? "review" : "work")}>
                    {saving || executionActive ? <LoaderCircle className="animate-spin" /> : <Bot />}
                    {executionActive && latestExecution ? executionStatusLabel : taskKind === "integration" ? "继续集成" : currentTask.status === "in_review" ? "独立复核"
                      : currentTask.status === "in_progress" ? "恢复实施" : taskKind === "advisory" ? "开始分析/答复" : "开始实施"}
                  </Button>
                ) : null}
                {taskKind === "advisory" && canTransitionTask && canUpdateTask && !readOnly ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => void promoteToDelivery()} disabled={saving || executionActive}>
                    升级为交付任务
                  </Button>
                ) : null}
              </div>
            </div>
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                tabSelectionResolvedTaskIdRef.current = currentTask.id;
                setActiveTab(value as TaskDetailTab);
              }}
              className="shrink-0 border-b px-4 py-2 sm:px-6"
            >
              <TabsList
                aria-label="任务详情分区"
                className={`${BRAND_SEGMENTED_TABS_LIST_CLASS} relative grid grid-cols-2`}
              >
                <span
                  aria-hidden="true"
                  data-task-detail-tab-indicator
                  className="pointer-events-none absolute inset-y-1 left-1 rounded-[7px] bg-background shadow-[0_1px_4px_rgba(15,23,42,0.10)] transition-transform duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                  style={{
                    width: "calc((100% - 0.5rem) / 2)",
                    transform: `translateX(${activeTab === "details" ? 0 : 100}%)`,
                  }}
                />
                <TabsTrigger value="details" className={`${BRAND_SEGMENTED_TAB_TRIGGER_CLASS} relative z-10`}>
                  详细信息
                </TabsTrigger>
                <TabsTrigger value="discussion" className={`${BRAND_SEGMENTED_TAB_TRIGGER_CLASS} relative z-10`}>
                  讨论（{Math.max(comments.length, currentTask.commentCount)}）
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {activeTab === "discussion" && (executionsError || latestExecution?.error || integrationSourcesState.error
              || currentTask.status === "blocked" || currentTask.providerCiStatus === "unconfigured"
              || currentTask.integrationState === "needs_human" || integrationNeedsHumanCount > 0) ? (
              <section aria-label="任务关键状态" className="space-y-1 border-b bg-amber-50 px-4 py-2 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100 sm:px-6">
                {executionsError ? <p role="alert">{executionsError}</p> : null}
                {latestExecution?.error ? <p className="line-clamp-2 whitespace-pre-wrap">{latestExecution.error}</p> : null}
                {integrationSourcesState.error ? <p role="alert">{integrationSourcesState.error}</p> : null}
                {currentTask.status === "blocked" ? <p>任务已阻塞，切换至详细信息查看解除条件。</p> : null}
                {currentTask.providerCiStatus === "unconfigured" ? <p>CI 门禁未配置，切换至详细信息处理。</p> : null}
                {currentTask.integrationState === "needs_human" || integrationNeedsHumanCount > 0 ? <p>集成来源需要人工处理，切换至详细信息查看。</p> : null}
              </section>
            ) : null}
            <div data-testid="task-detail-columns" className="relative min-h-0 flex-1 overflow-hidden">
              <div
                ref={detailsViewportRef}
                id="task-detail-information"
                data-testid="task-detail-information"
                aria-hidden={activeTab !== "details"}
                {...({ inert: activeTab !== "details" } as Record<string, boolean>)}
                className={`absolute inset-0 overflow-y-auto will-change-[opacity,transform] transition-[opacity,transform] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${activeTab === "details" ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-2 opacity-0"}`}
              >
                <div ref={detailsContentRef} data-testid="task-detail-content" className="p-4 sm:p-6">
              <section aria-label="流程状态" className="mb-6 space-y-2 rounded-lg border bg-muted/20 p-4 text-sm">
                <h3 className="text-sm font-semibold">流程与执行</h3>
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
                    <p>任务已阻塞；请查看最新执行错误或讨论中的解除条件。</p>
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
                        ref={descriptionRef}
                        id="task-detail-description"
                        value={description}
                        onChange={(event) => {
                          dirtyFieldsRef.current.add("description");
                          setDescription(event.target.value);
                        }}
                        rows={3}
                        className="resize-none overflow-y-hidden"
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
                          upload={taskAttachments} taskId={currentTask.id}
                          disabled={saving}
                          onFilesChanged={() => dirtyFieldsRef.current.add("attachments")}
                        />
                      )}
                    </div>
                  </>
                ) : null}
                <div role="group" aria-label="任务选项" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                  <div className="min-w-0 space-y-2">
                    <Label>状态</Label>
                    <Select
                      value={currentTask.status}
                      onValueChange={(value) => void changeStatus(value as TaskBoardStatus)}
                      disabled={!canTransitionCurrentTask || saving}
                    >
                      <SelectTrigger aria-label="任务状态" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TASKBOARD_STATUSES.map((status) => (
                          <SelectItem
                            key={status}
                            value={status}
                            disabled={status !== currentTask.status && !canMoveCurrentTaskTo(status)}
                          >{STATUS_LABELS[status]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0 space-y-2">
                    <Label>优先级</Label>
                    <Select
                      value={priority}
                      onValueChange={(value) => {
                        dirtyFieldsRef.current.add("priority");
                        setPriority(value as TaskBoardPriority);
                      }}
                      disabled={editReadOnly || saving}
                    >
                      <SelectTrigger aria-label="任务优先级" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TASKBOARD_PRIORITIES.map((value) => (
                          <SelectItem key={value} value={value}>{PRIORITY_LABELS[value]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {TASK_MODEL_PURPOSES.map((purpose) => (
                    <div className="min-w-0 space-y-2" key={purpose}>
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
                {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
                <div role="group" aria-label="任务操作" className="flex flex-wrap items-center gap-2 border-t pt-4">
                  {!editReadOnly ? (
                    <Button
                      type="submit"
                      size="sm"
                      className="w-[4.5rem]"
                      aria-label="保存任务"
                      disabled={saving || taskAttachments.uploading}
                    >
                      保存
                    </Button>
                  ) : null}
                  {!boardReadOnly && taskKind !== "integration" && canCancelExecution && latestExecutionActive ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-[4.5rem] text-destructive hover:text-destructive"
                      aria-label="终止执行"
                      onClick={() => void cancelCurrentExecution()}
                      disabled={saving}
                    >
                      {saving ? <LoaderCircle className="animate-spin" /> : <CircleX />}终止
                    </Button>
                  ) : null}
                  {!boardReadOnly && taskKind === "integration" && canCancelIntegration
                    && !["done", "canceled"].includes(currentTask.status) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="w-[4.5rem] text-destructive hover:text-destructive"
                      aria-label="取消集成"
                      onClick={() => void cancelIntegration()}
                      disabled={saving}
                    >
                      <CircleX />取消
                    </Button>
                  ) : null}
                  <TaskCompletionButton visible={canCompleteCurrentTask} saving={saving} onComplete={() => void completeCurrentTask()} />
                  {!boardReadOnly && canArchiveTask ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label={archived ? "恢复任务" : "归档任务"}
                      onClick={() => void changeArchived()}
                      disabled={saving}
                      className={`w-[4.5rem] ${archived ? "" : "text-destructive hover:text-destructive"}`}
                    >
                      {archived ? <ArchiveRestore /> : <Archive />}
                      {archived ? "恢复" : "归档"}
                    </Button>
                  ) : null}
                  {!boardReadOnly && canDeleteTask && onDeleteTask ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-label="删除任务"
                      onClick={() => void deleteCurrentTask()}
                      disabled={saving}
                      className="w-[4.5rem] text-destructive hover:text-destructive"
                    >
                      <Trash2 />
                      删除
                    </Button>
                  ) : null}
                </div>
              </form>
                </div>
              </div>

              <div
                aria-hidden={activeTab !== "discussion"}
                {...({ inert: activeTab !== "discussion" } as Record<string, boolean>)}
                className={`absolute inset-0 flex min-h-0 flex-col will-change-[opacity,transform] transition-[opacity,transform] duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${activeTab === "discussion" ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-2 opacity-0"}`}
              >
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
            </div>
          </>
        ) : null}
    </FloatingPanel>
  );

  return portalTarget ? createPortal(panel, portalTarget) : panel;
}
