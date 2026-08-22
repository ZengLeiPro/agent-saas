import { useEffect, useRef, type Dispatch, type FormEvent, type SetStateAction } from "react";
import type {
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardExecutionPurpose,
  TaskBoardTask,
} from "@agent/shared";
import { ExternalLink, Send } from "lucide-react";
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

type TaskDetailCommentsProps = {
  comments: TaskBoardComment[];
  commentsLoading: boolean;
  commentsError: string | null;
  currentTask: TaskBoardTask;
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

  useEffect(() => {
    if (commentsLoading) return;
    const container = commentsScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [comments.length, commentsLoading]);

  return (
    <section aria-label="任务评论" className="flex min-h-0 flex-col bg-muted/10">
      <header className="flex items-center justify-between border-b bg-background px-4 py-3 sm:px-6">
        <div>
          <h3 className="text-sm font-semibold">评论（{comments.length}）</h3>
        </div>
      </header>
      <div ref={commentsScrollRef} data-testid="task-comments-scroll" className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {commentsError ? <p role="alert" className="mb-4 text-sm text-destructive">{commentsError}</p> : null}
        {commentsLoading ? <p className="text-sm text-muted-foreground">正在加载评论...</p> : null}
        <div className="space-y-0">
          {taskDescription !== undefined && taskDescription !== null ? (
            <article data-testid="task-description-comment" className="pb-6">
              <div className="min-w-0 rounded-lg border bg-card p-3 shadow-sm">
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
              <article key={comment.id} className="pb-6 last:pb-0">
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
            暂无评论
          </div>
        ) : null}
      </div>
      <form className="space-y-2 border-t bg-background p-4 sm:px-6" onSubmit={onSubmit}>
        <Label htmlFor="task-comment-body">发表评论</Label>
        <Textarea
          id="task-comment-body"
          value={commentBody}
          onChange={(event) => setCommentBody(event.target.value)}
          placeholder={commentReadOnly ? "当前角色不可发表评论" : "补充进展、上下文或复核意见（支持 Markdown）"}
          rows={3}
          disabled={commentReadOnly || saving}
          onPaste={(event) => void commentAttachments.handlePaste(event)}
        />
        {!commentReadOnly ? <TaskAttachmentField upload={commentAttachments} disabled={saving} /> : null}
        {!commentReadOnly && canContinueCurrentTask ? (
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
            <Label htmlFor="task-comment-continue" className="font-normal">
              {latestExecution && latestExecutionActive
                ? latestExecution.purpose === "merge" ? "发表后继续集成"
                  : latestExecution.purpose === "review" ? "发表后继续复核"
                  : currentTask.kind === "advisory" ? "发表后继续分析/答复" : "发表后继续实施"
                : currentTask.kind === "integration" ? "发表后继续集成"
                  : currentTask.status === "in_review" ? "发表后继续复核"
                  : currentTask.kind === "advisory" ? "发表后继续分析/答复" : "发表后继续实施"}
            </Label>
          </div>
        ) : null}
        <div className="flex justify-end">
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
      </form>
    </section>
  );
}
