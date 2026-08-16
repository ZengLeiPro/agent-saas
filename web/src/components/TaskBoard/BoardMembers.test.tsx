import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "@agent/shared";
import { BoardMembers } from "./BoardMembers";

const mocks = vi.hoisted(() => ({
  fetchBoardMembers: vi.fn(),
  upsertBoardMember: vi.fn(),
  deleteBoardMember: vi.fn(),
}));

vi.mock("./api", () => mocks);

const board: TaskBoard = {
  id: "board-1",
  name: "组织研发",
  visibility: "organization",
  ownerUserId: "owner-1",
  role: "owner",
  allowedActions: ["board.read", "board.members.manage"],
  canManage: true,
  prompt: "",
  version: 4,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const member = {
  boardId: board.id,
  userId: "user-2",
  role: "viewer" as const,
  createdAt: board.createdAt,
  updatedAt: board.updatedAt,
};

describe("BoardMembers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchBoardMembers.mockResolvedValue([member]);
    mocks.upsertBoardMember.mockImplementation(async (_boardId: string, input: { userId: string; role: "viewer" | "editor" | "maintainer" }) => ({
      ...member,
      ...input,
    }));
    mocks.deleteBoardMember.mockResolvedValue(undefined);
  });

  it("展示 owner 与成员角色，并允许维护角色、添加和移除成员", async () => {
    const user = userEvent.setup();
    render(<BoardMembers board={board} canManage />);

    expect(await screen.findByText("owner-1")).toBeTruthy();
    expect(screen.getByText("所有者")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "user-2 的角色" }));
    await user.click(screen.getByRole("option", { name: "维护者" }));
    await waitFor(() => expect(mocks.upsertBoardMember).toHaveBeenCalledWith(board.id, {
      userId: "user-2",
      role: "maintainer",
    }));

    await user.type(screen.getByRole("textbox", { name: "用户 ID" }), "user-3");
    await user.click(screen.getByRole("combobox", { name: "新成员角色" }));
    await user.click(screen.getByRole("option", { name: "编辑者" }));
    await user.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(mocks.upsertBoardMember).toHaveBeenCalledWith(board.id, {
      userId: "user-3",
      role: "editor",
    }));

    await user.click(screen.getByRole("button", { name: "移除成员 user-2" }));
    await waitFor(() => expect(mocks.deleteBoardMember).toHaveBeenCalledWith(board.id, "user-2"));
  });

  it("无 members.manage 权限时角色和删除按钮只读", async () => {
    render(<BoardMembers board={{ ...board, role: "viewer", allowedActions: ["board.read"] }} canManage={false} />);

    expect(await screen.findByRole("combobox", { name: "user-2 的角色" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "移除成员 user-2" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("textbox", { name: "用户 ID" })).toBeNull();
  });
});
