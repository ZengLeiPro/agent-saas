import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskBoardComment, TaskBoardTask } from "@agent/shared";
import { TaskDetailComments } from "./TaskDetailComments";

const task: TaskBoardTask = {
  id: "task-1",
  boardId: "board-1",
  identifier: "TASK-1",
  title: "任务一",
  description: "",
  status: "todo",
  priority: "none",
  labels: [],
  sortOrder: 1,
  commentCount: 1,
  version: 1,
  createdAt: "2026-08-19T01:00:00.000Z",
  updatedAt: "2026-08-19T01:00:00.000Z",
};

const agentComment: TaskBoardComment = {
  id: "comment-1",
  taskId: task.id,
  body: "已完成实施。",
  authorType: "agent",
  authorId: "agent-1",
  authorName: "Agent",
  executionPurpose: "work",
  version: 1,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
};

const commentAttachments = {
  uploading: false,
  uploadedFiles: [],
} as unknown as ComponentProps<typeof TaskDetailComments>["commentAttachments"];

function renderComments(overrides: Partial<ComponentProps<typeof TaskDetailComments>> = {}) {
  return render(
    <TaskDetailComments
      comments={[]}
      commentsLoading={false}
      commentsError={null}
      currentTask={task}
      latestExecutionActive={false}
      commentReadOnly
      saving={false}
      canContinueCurrentTask={false}
      commentBody=""
      setCommentBody={vi.fn()}
      continueAfterComment={false}
      setContinueAfterComment={vi.fn()}
      pendingContinuationCommentId={null}
      setPendingContinuationCommentId={vi.fn()}
      commentAttachments={commentAttachments}
      onSubmit={vi.fn()}
      {...overrides}
    />,
  );
}

describe("TaskDetailComments", () => {
  it("阶段徽标不再使用括号包裹", () => {
    renderComments({ comments: [agentComment] });

    const author = screen.getByText((_, element) => (
      element?.tagName.toLowerCase() === "span" && element.textContent === "Agent 实施阶段"
    ));
    expect(author.textContent).toBe("Agent 实施阶段");
    expect(author.textContent).not.toContain("（");
    expect(author.textContent).not.toContain("）");
  });

  it("评论加载完成后自动滚动到底部", async () => {
    const { rerender } = renderComments({ comments: [agentComment], commentsLoading: true });
    const scrollContainer = screen.getByTestId("task-comments-scroll");
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 480 });

    rerender(
      <TaskDetailComments
        comments={[agentComment]}
        commentsLoading={false}
        commentsError={null}
        currentTask={task}
        latestExecutionActive={false}
        commentReadOnly
        saving={false}
        canContinueCurrentTask={false}
        commentBody=""
        setCommentBody={vi.fn()}
        continueAfterComment={false}
        setContinueAfterComment={vi.fn()}
        pendingContinuationCommentId={null}
        setPendingContinuationCommentId={vi.fn()}
        commentAttachments={commentAttachments}
        onSubmit={vi.fn()}
      />,
    );

    await waitFor(() => expect(scrollContainer.scrollTop).toBe(480));
  });
});
