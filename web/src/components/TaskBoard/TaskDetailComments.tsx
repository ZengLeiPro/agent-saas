import { useEffect, useRef, type Dispatch, type FormEvent, type SetStateAction } from "react";
import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardTask,
} from "@agent/shared";
import { ChevronDown, ExternalLink, Send } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FileUploadState } from "@/hooks/useFileUpload";
import { TaskAttachmentField, TaskAttachmentList } from "./TaskAttachments";
import { TaskCommentMarkdown } from "./TaskCommentMarkdown";

export const EXECUTION_PURPOSE_LABELS: Record<TaskBoardExecutionPurpose, string> = {
  work: "实施阶段",
  review: "复核阶段",
  merge: "集成阶段",
};

export const EXECUTION_PURPOSE_CLASSES: Record<TaskBoardExecutionPurpose, string> = {
  work: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  review: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
  merge: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
};

const EXECUTION_PURPOSE_DOT_CLASSES: Record<TaskBoardExecutionPurpose, string> = {
  work: "bg-blue-500",
  review: "bg-violet-500",
  merge: "bg-emerald-500",
};

type TaskDetailCommentsProps = {
  comments: TaskBoardComment[];
  commentsLoading: boolean;
  commentsError: string | null;
  currentTask: TaskBoardTask;
  detailsExpanded: boolean;
  onToggleDetails: () => void;
  taskDescription?: string | null;
  taskAttachments?: TaskBoardTask["attachments"];
  latestExecution?: TaskBoardExecution;
  latestExecutionActive: boolean;
  commentReadOnly: boolean;
  saving: boolean;
  canContinueCurrentTask: boolean;
  commentBody: string;
  setCommentBody: Dispatch<SetStateAction<string>>;
  continueAfterComment: boolean;
  setContinueAfterComment: Dispatch<SetStateAction<boolean>>;
  pendingContinuationCommentId: string | null;
  setPendingContinuationCommentId: Dispatch<SetStateAction<string | null>>;
  commentAttachments: FileUploadState;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export function TaskDetailComments({
  comments,
  commentsLoading,
  commentsError,
  currentTask,
  detailsExpanded,
  onToggleDetails,
  taskDescription,
  taskAttachments = [],
  latestExecution,
  latestExecutionActive,
  commentReadOnly,
  saving,
  canContinueCurrentTask,
  commentBody,
  setCommentBody,
  continueAfterComment,
  setContinueAfterComment,
  pendingContinuationCommentId,
  setPendingContinuationCommentId,
  commentAttachments,
  onSubmit,
}: TaskDetailCommentsProps) {
  const commentsScrollRef = useRef<HTMLDivElement>(null);
  const commentBodyRef = useRef<HTMLTextAreaElement>(null);
  const navigationTargetRefs = useRef(new Map<string, HTMLElement>());
  const navigationItems = [
    ...(taskDescription !== undefined && taskDescription !== null
      ? [{ id: "task-description", label: "任务正文", purpose: null }]
      : []),
    ...comments.map((comment) => ({
      id: comment.id,
      label: comment.executionPurpose
        ? `${EXECUTION_PURPOSE_LABELS[comment.executionPurpose]}评论`
        : comment.authorType === "system" ? "系统评论"
          : comment.authorType === "agent" ? "Agent 评论" : "用户评论",
      purpose: comment.executionPurpose ?? null,
    })),
  ];

  useEffect(() => {
    if (commentsLoading) return;
    const container = commentsScrollRef.current;
    if (container) {
      container.style.paddingBottom = "";
      container.scrollTop = container.scrollHeight;
    }
  }, [comments.length, commentsLoading]);

  const scrollToNavigationTarget = (id: string) => {
    const container = commentsScrollRef.current;
    const target = navigationTargetRefs.current.get(id);
    if (!container || !target) return;

    container.style.paddingBottom = "";
    const targetTop = target.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      + container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (targetTop > maxScrollTop) {
      const basePadding = Number.parseFloat(window.getComputedStyle(container).paddingBottom) || 0;
      container.style.paddingBottom = `${basePadding + targetTop - maxScrollTop}px`;
    }
    container.scrollTo({ top: targetTop, behavior: "smooth" });
  };

  useEffect(() => {
    const textarea = commentBodyRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 60), 160);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > nextHeight ? "auto" : "hidden";
  }, [commentBody]);

  const detailsToggle = (
    <header data-testid="task-discussion-toggle" className={`border-b bg-background px-4 py-2 sm:px-6 ${detailsExpanded ? "animate-in fade-in-0 slide-in-from-bottom-1" : "animate-in fade-in-0 slide-in-from-top-1"}`}>
      <button type="button" className="relative flex h-8 w-full items-center justify-center rounded-md text-sm font-semibold transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={detailsExpanded} aria-controls="task-detail-information"
        aria-label={detailsExpanded ? "收起任务详情" : "展开任务详情"} onClick={onToggleDetails}>
        <span className="relative inline-flex items-center">
          <span>讨论（{comments.length}）</span>
          <ChevronDown className={`absolute left-full ml-1 size-4 transition-transform duration-300 ${detailsExpanded ? "rotate-180" : ""}`} />
        </span>
      </button>
    </header>
  );

  return (
    <section aria-label="任务讨论" className={`flex flex-col bg-muted/10 ${detailsExpanded ? "shrink-0" : "min-h-0 flex-1"}`}>
      {!detailsExpanded ? detailsToggle : null}
      <div ref={commentsScrollRef} data-testid="task-comments-scroll" className={detailsExpanded ? "hidden" : "min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"}>
        {commentsError ? <p role="alert" className="mb-4 text-sm text-destructive">{commentsError}</p> : null}
        {commentsLoading ? <p className="text-sm text-muted-foreground">正在加载讨论...</p> : null}
        <div className="space-y-0">
          {taskDescription !== undefined && taskDescription !== null ? (
            <article
              ref={(node) => {
                if (node) navigationTargetRefs.current.set("task-description", node);
                else navigationTargetRefs.current.delete("task-description");
              }}
              data-testid="task-description-comment"
              className="pb-6"
            >
              <div className="min-w-0 rounded-2xl rounded-tr-md border border-transparent bg-user-bubble p-3 text-foreground shadow-sm ring-1 ring-[rgba(232,132,58,0.22)] shadow-[0_1px_2px_rgba(232,132,58,0.10),0_4px_12px_-4px_rgba(232,132,58,0.20)]">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="text-xs font-medium text-foreground">任务正文</span>
                  <time className="text-xs text-muted-foreground">{new Date(currentTask.createdAt).toLocaleString("zh-CN")}</time>
                </div>
                {taskDescription ? <TaskCommentMarkdown body={taskDescription} /> : null}
                <TaskAttachmentList taskId={currentTask.id} attachments={taskAttachments} />
              </div>
            </article>
          ) : null}
          {comments.map((comment) => {
            const purpose = comment.executionPurpose;
            const sessionHref = comment.sessionId
              ? `/chat/${encodeURIComponent(comment.sessionId)}`
              : null;
            return (
              <article
                key={comment.id}
                ref={(node) => {
                  if (node) navigationTargetRefs.current.set(comment.id, node);
                  else navigationTargetRefs.current.delete(comment.id);
                }}
                data-comment-id={comment.id}
                className="pb-6 last:pb-0"
              >
                <div className={`min-w-0 rounded-lg border p-3 shadow-sm ${comment.authorType === "user" ? "rounded-2xl rounded-tr-md border-transparent bg-user-bubble text-foreground ring-1 ring-[rgba(232,132,58,0.22)] shadow-[0_1px_2px_rgba(232,132,58,0.10),0_4px_12px_-4px_rgba(232,132,58,0.20)]" : "bg-card"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
                      {comment.authorType === "agent" ? (
                        <span>
                          Agent{" "}
                          {purpose ? <span className={`ml-0.5 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${EXECUTION_PURPOSE_CLASSES[purpose]}`}>{EXECUTION_PURPOSE_LABELS[purpose]}</span> : null}
                        </span>
                      ) : comment.authorType === "system" ? "系统" : comment.authorName}
                      {sessionHref ? (
                        <a
                          href={sessionHref}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/5"
                          aria-label="打开会话"
                          title="打开会话"
                        >
                          打开会话
                          <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </div>
                    <time className="text-xs text-muted-foreground">{new Date(comment.createdAt).toLocaleString("zh-CN")}</time>
                  </div>
                  {comment.body ? <TaskCommentMarkdown body={comment.body} /> : null}
                  <TaskAttachmentList taskId={currentTask.id} attachments={comment.attachments ?? []} />
                </div>
              </article>
            );
          })}
        </div>
        {!commentsLoading && comments.length === 0 && (taskDescription === undefined || taskDescription === null) ? (
          <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed bg-background text-sm text-muted-foreground">
            暂无讨论
          </div>
        ) : null}
      </div>
      {!detailsExpanded && navigationItems.length > 0 ? (
        <nav aria-label="评论阶段导航" className="shrink-0 overflow-x-auto border-t bg-background px-4 py-2 sm:px-6">
          <div className="relative inline-flex min-w-full items-center justify-around gap-3">
            <span aria-hidden className="pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-border" />
            {navigationItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label={`跳转到第 ${index + 1} 条：${item.label}`}
                title={item.label}
                data-purpose={item.purpose ?? "general"}
                onClick={() => scrollToNavigationTarget(item.id)}
              >
                <span className={`size-3 rounded-full ring-2 ring-background ${item.purpose ? EXECUTION_PURPOSE_DOT_CLASSES[item.purpose] : "bg-slate-400 dark:bg-slate-500"}`} />
              </button>
            ))}
          </div>
        </nav>
      ) : null}
      {detailsExpanded ? detailsToggle : null}
      <form className="space-y-2 border-t bg-background p-3 sm:px-4" onSubmit={onSubmit}>
        <Textarea
          ref={commentBodyRef}
          id="task-comment-body"
          aria-label="发表讨论"
          value={commentBody}
          onChange={(event) => setCommentBody(event.target.value)}
          placeholder={commentReadOnly ? "当前角色不可发表讨论" : "补充进展、上下文或复核意见（支持 Markdown）"}
          rows={2}
          className="max-h-40 resize-none overflow-y-hidden"
          disabled={commentReadOnly || saving}
          onPaste={(event) => void commentAttachments.handlePaste(event)}
        />
        {!commentReadOnly ? (
          <div className="flex flex-wrap items-start justify-between gap-2">
            <TaskAttachmentField
              upload={commentAttachments}
              disabled={saving}
              hideHint
              className="min-w-[10rem] flex-1"
            />
            <div className="flex min-h-8 items-center gap-3">
              {canContinueCurrentTask ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="task-comment-continue"
                    checked={continueAfterComment}
                    onCheckedChange={(checked) => {
                      const next = checked === true;
                      setContinueAfterComment(next);
                      if (!next) setPendingContinuationCommentId(null);
                    }}
                    disabled={saving}
                  />
                  <Label htmlFor="task-comment-continue" className="whitespace-nowrap font-normal">
                    {latestExecution && latestExecutionActive
                      ? latestExecution.purpose === "merge" ? "直接集成"
                        : latestExecution.purpose === "review" ? "直接复核"
                        : currentTask.kind === "advisory" ? "直接分析/答复" : "直接实施"
                      : currentTask.kind === "integration" ? "直接集成"
                        : currentTask.status === "in_review" ? "直接复核"
                        : currentTask.kind === "advisory" ? "直接分析/答复" : "直接实施"}
                  </Label>
                </div>
              ) : null}
              <Button
                type="submit"
                size="sm"
                disabled={commentReadOnly || saving || (!pendingContinuationCommentId && commentAttachments.uploading)
                  || (!pendingContinuationCommentId && !commentBody.trim()
                    && commentAttachments.uploadedFiles.length === 0)}
              >
                <Send />
                {pendingContinuationCommentId ? "重试继续执行" : "发表"}
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </section>
  );
}
