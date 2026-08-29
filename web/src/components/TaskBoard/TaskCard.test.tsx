import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskBoardTask } from "@agent/shared";
import { TaskCard } from "./TaskCard";

vi.mock("./IntegrationSources", () => ({ IntegrationCardSummary: () => <div>v2 source summary</div> }));

function task(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
  return {
    id: "task-33",
    boardId: "board-1",
    identifier: "TASK-33",
    title: "任务看板的卡片上显示更多信息",
    description: "",
    status: "done",
    priority: "none",
    labels: [],
    sortOrder: 1024,
    commentCount: 3,
    version: 2,
    creatorUserId: "user-1",
    creatorName: "曾磊 @zenglei",
    creatorAvatarVersion: 7,
    createdAt: new Date(2026, 7, 13, 12).toISOString(),
    completedAt: new Date(2026, 7, 14, 12).toISOString(),
    updatedAt: new Date(2026, 7, 14, 12).toISOString(),
    ...overrides,
  };
}

function renderCard(current: TaskBoardTask) {
  render(
    <TaskCard
      task={current}
      readOnly
      allowDrag={false}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      onDropBefore={vi.fn()}
    />,
  );
}

describe("TaskCard", () => {
  it("紧凑展示提交人、提交日期、最新动态和完成日期，并隐藏无优先级噪声", () => {
    renderCard(task({ latestActivityAt: new Date(2026, 7, 15, 12).toISOString() }));

    expect(screen.getByText("曾磊 @zenglei")).toBeTruthy();
    expect(screen.getByRole("img", { name: "User" }).getAttribute("src")).toBe("/api/auth/avatar/user-1?v=7");
    const submittedAt = screen.getByText("提交 2026-08-13");
    const latestAt = screen.getByText("最新 2026-08-15");
    expect(latestAt.previousElementSibling).toBe(submittedAt);
    expect(screen.getByText("完成 2026-08-14")).toBeTruthy();
    expect(screen.getByRole("button", {
      name: /提交人 曾磊 @zenglei，提交于 2026-08-13，最新于 2026-08-15，完成于 2026-08-14，3 条评论/,
    })).toBeTruthy();
    expect(screen.getByLabelText("3 条评论")).toBeTruthy();
    expect(screen.queryByText("无")).toBeNull();
  });

  it("在卡片右上角以灰色胶囊展示 PR，并隐藏复核状态", () => {
    renderCard(task({
      providerPullRequestId: "235",
      pullRequestNumber: 235,
      reviewedSubjectDigest: "reviewed-digest",
    }));

    const pullRequestBadge = screen.getByText("PR 235");
    expect(pullRequestBadge.className).toContain("bg-secondary");
    expect(pullRequestBadge.parentElement?.className).toContain("justify-end");
    expect(screen.queryByText("已复核")).toBeNull();
    expect(screen.queryByText("待复核")).toBeNull();
  });

  it("不展示 Agent 写入的无用标签", () => {
    renderCard(task({ labels: ["Agent 自动标签"] }));

    expect(screen.queryByText("Agent 自动标签")).toBeNull();
  });

  it("兼容没有创建人和完成时间的旧任务", () => {
    renderCard(task({ creatorUserId: undefined, creatorName: undefined, completedAt: undefined }));

    expect(screen.getByText("提交人未知")).toBeTruthy();
    expect(screen.queryByText(/完成 /)).toBeNull();
  });
});
