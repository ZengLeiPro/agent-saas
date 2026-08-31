import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("按正文与评论顺序渲染可访问的阶段圆点导航", () => {
    const comments: TaskBoardComment[] = [
      agentComment,
      { ...agentComment, id: "comment-work-2", body: "第二条实施评论。" },
      { ...agentComment, id: "comment-review", body: "复核评论。", executionPurpose: "review" },
      { ...agentComment, id: "comment-merge", body: "集成评论。", executionPurpose: "merge" },
      { ...agentComment, id: "comment-general", body: "普通用户评论。", authorType: "user", authorName: "曾磊", executionPurpose: undefined },
    ];
    renderComments({ taskDescription: "很长的任务正文".repeat(20), comments });

    const navigation = screen.getByRole("navigation", { name: "评论阶段导航" });
    const buttons = within(navigation).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "跳转到第 1 条：任务正文",
      "跳转到第 2 条：实施阶段评论",
      "跳转到第 3 条：实施阶段评论",
      "跳转到第 4 条：复核阶段评论",
      "跳转到第 5 条：集成阶段评论",
      "跳转到第 6 条：用户评论",
    ]);
    expect(buttons.map((button) => button.getAttribute("data-purpose"))).toEqual([
      "general", "work", "work", "review", "merge", "general",
    ]);
    expect(buttons.map((button) => button.getAttribute("data-kind"))).toEqual([
      "task", "agent", "agent", "agent", "agent", "user",
    ]);
    expect(buttons[1]?.firstElementChild?.className).toContain("bg-blue-500");
    expect(buttons[3]?.firstElementChild?.className).toContain("bg-violet-500");
    expect(buttons[4]?.firstElementChild?.className).toContain("bg-emerald-500");
    expect(buttons[5]?.firstElementChild?.className).toContain("bg-orange-500");
  });

  it("点击圆点后持续强调当前圆点和目标评论，并在再次点击时切换", () => {
    const userComment: TaskBoardComment = {
      ...agentComment,
      id: "comment-user",
      body: "用户补充意见",
      authorType: "user",
      authorName: "曾磊",
      executionPurpose: undefined,
    };
    renderComments({ comments: [userComment, agentComment] });

    const container = screen.getByTestId("task-comments-scroll");
    Object.defineProperties(container, {
      scrollTop: { configurable: true, writable: true, value: 0 },
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 300 },
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    container.scrollTo = vi.fn();
    for (const commentId of [userComment.id, agentComment.id]) {
      const target = document.querySelector<HTMLElement>(`[data-comment-id="${commentId}"]`);
      vi.spyOn(target!, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    }

    const userButton = screen.getByRole("button", { name: "跳转到第 1 条：用户评论" });
    const agentButton = screen.getByRole("button", { name: "跳转到第 2 条：实施阶段评论" });
    const userTarget = document.querySelector<HTMLElement>('[data-comment-id="comment-user"]');
    const agentTarget = document.querySelector<HTMLElement>('[data-comment-id="comment-1"]');

    fireEvent.click(userButton);
    expect(userButton.getAttribute("aria-current")).toBe("true");
    expect(agentButton.getAttribute("aria-current")).toBeNull();
    expect(userButton.firstElementChild?.className).toContain("size-4");
    expect(userTarget?.getAttribute("data-navigation-selected")).toBe("true");
    expect(userTarget?.firstElementChild?.className).toContain("outline-primary/70");
    expect(userTarget?.firstElementChild?.className).toContain("border-orange-200/80");
    expect(screen.getByText("曾磊").className).toContain("text-orange-800");

    fireEvent.click(agentButton);
    expect(userButton.getAttribute("aria-current")).toBeNull();
    expect(agentButton.getAttribute("aria-current")).toBe("true");
    expect(userTarget?.getAttribute("data-navigation-selected")).toBeNull();
    expect(agentTarget?.getAttribute("data-navigation-selected")).toBe("true");
  });

  it("点击圆点后将目标评论顶部对齐滚动区，并为末尾评论补足滚动边界", () => {
    const lastComment: TaskBoardComment = {
      ...agentComment,
      id: "comment-last",
      body: "末尾长评论".repeat(100),
      executionPurpose: "review",
    };
    renderComments({ comments: [agentComment, lastComment] });

    const container = screen.getByTestId("task-comments-scroll");
    const target = document.querySelector<HTMLElement>('[data-comment-id="comment-last"]');
    expect(target).toBeTruthy();
    Object.defineProperties(container, {
      scrollTop: { configurable: true, writable: true, value: 20 },
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(target!, "getBoundingClientRect").mockReturnValue({ top: 380 } as DOMRect);
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;

    fireEvent.click(screen.getByRole("button", { name: "跳转到第 2 条：复核阶段评论" }));

    expect(Number.parseFloat(container.style.paddingBottom)).toBeGreaterThan(0);
    expect(scrollTo).toHaveBeenCalledWith({ top: 300, behavior: "smooth" });
  });

  it("展开详情时隐藏评论列表，并让讨论栏紧贴输入区", () => {
    const onToggleDetails = vi.fn();
    renderComments({ detailsExpanded: true, onToggleDetails });

    const toggle = screen.getByRole("button", { name: "收起任务详情" });
    const discussion = screen.getByTestId("task-discussion-toggle");
    const form = screen.getByRole("textbox", { name: "发表讨论" }).closest("form");
    expect(toggle.textContent).toContain("讨论（0）");
    expect(toggle.className).toContain("justify-center");
    const chevron = toggle.querySelector("svg");
    expect(chevron?.classList.contains("left-full")).toBe(true);
    expect(chevron?.classList.contains("ml-1")).toBe(true);
    expect(chevron?.classList.contains("right-1")).toBe(false);
    expect(chevron?.classList.contains("rotate-180")).toBe(true);
    expect(screen.getByTestId("task-comments-scroll").className).toContain("hidden");
    expect(screen.getByRole("region", { name: "任务讨论" }).className).toContain("shrink-0");
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
