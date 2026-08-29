import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      detailsExpanded={false}
      onToggleDetails={vi.fn()}
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

  it("将已执行任务的正文作为评论区首条消息", () => {
    renderComments({
      taskDescription: "任务背景说明",
      comments: [agentComment],
    });

    const taskDescription = screen.getByTestId("task-description-comment");
    expect(taskDescription.textContent).toContain("任务正文");
    expect(taskDescription.textContent).toContain("任务背景说明");
    expect(taskDescription.firstElementChild?.className).toContain("bg-user-bubble");
    expect(taskDescription.compareDocumentPosition(screen.getByText("已完成实施。")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("暂无讨论")).toBeNull();
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
        detailsExpanded={false}
        onToggleDetails={vi.fn()}
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

  it("讨论栏整行控制详情，并在展开时移动到输入区上方", () => {
    const onToggleDetails = vi.fn();
    renderComments({ detailsExpanded: true, onToggleDetails });

    const toggle = screen.getByRole("button", { name: "收起任务详情" });
    const discussion = screen.getByTestId("task-discussion-toggle");
    const form = screen.getByRole("textbox", { name: "发表讨论" }).closest("form");
    expect(toggle.textContent).toContain("讨论（0）");
    expect(toggle.className).toContain("justify-center");
    expect(toggle.querySelector("svg")?.classList.contains("rotate-180")).toBe(true);
    expect(discussion.nextElementSibling).toBe(form);
    expect(discussion.className).toContain("slide-in-from-bottom-1");
    expect(screen.queryByText(/^评论（/)).toBeNull();
    fireEvent.click(toggle);
    expect(onToggleDetails).toHaveBeenCalledOnce();
  });

  it("将附件、直接实施与发表收在同一操作行，并移除冗余文案", () => {
    renderComments({
      commentReadOnly: false,
      canContinueCurrentTask: true,
    });

    const attachment = screen.getByRole("button", { name: "添加附件" });
    const publish = screen.getByRole("button", { name: "发表" });
    const actionRow = attachment.parentElement?.parentElement;
    expect(actionRow?.contains(publish)).toBe(true);
    expect(screen.getByRole("checkbox", { name: "直接实施" })).toBeTruthy();
    expect(screen.queryByText("可多选，也可直接粘贴图片、视频或文件")).toBeNull();
    expect(screen.queryByText("发表讨论")).toBeNull();
  });

  it("评论框随内容增高但最高不超过 160px", () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(240);
    renderComments({ commentBody: "多行评论内容" });

    const textarea = screen.getByRole("textbox", { name: "发表讨论" }) as HTMLTextAreaElement;
    expect(textarea.style.height).toBe("160px");
    expect(textarea.style.overflowY).toBe("auto");
    scrollHeight.mockRestore();
  });
});
