import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "@agent/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BoardMembers } from "./BoardMembers";

const mocks = vi.hoisted(() => ({
  fetchBoardMembers: vi.fn(),
  fetchTaskboardUsers: vi.fn(),
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
    mocks.fetchTaskboardUsers.mockResolvedValue([
      { id: "owner-1", username: "owner", realName: "所有者" },
      { id: "user-2", username: "user2", realName: "成员二" },
      { id: "user-3", username: "user3", realName: "成员三" },
    ]);
    mocks.upsertBoardMember.mockImplementation(async (_boardId: string, input: { userId: string; role: "viewer" | "editor" | "maintainer" }) => ({
      ...member,
      ...input,
    }));
    mocks.deleteBoardMember.mockResolvedValue(undefined);
  });

  it("展示 owner 与成员角色，并允许维护角色、添加和移除成员", async () => {
    const user = userEvent.setup();
    render(<BoardMembers board={board} canManage />);

    expect(await screen.findByText("所有者 @owner")).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "成员二 @user2 的角色" }));
    await user.click(screen.getByRole("option", { name: "维护者" }));
    await waitFor(() => expect(mocks.upsertBoardMember).toHaveBeenCalledWith(board.id, {
      userId: "user-2",
      role: "maintainer",
    }));

    await user.click(screen.getByRole("combobox", { name: "选择组织用户" }));
    await screen.findByRole("listbox", { name: "组织用户列表" });
    await user.type(screen.getByRole("searchbox", { name: "搜索组织用户" }), "成员三");
    await user.click(screen.getByRole("option", { name: /成员三 @user3/ }));
    await user.click(screen.getByRole("combobox", { name: "新成员角色" }));
    await user.click(screen.getByRole("option", { name: "编辑者" }));
    await user.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(mocks.upsertBoardMember).toHaveBeenCalledWith(board.id, {
      userId: "user-3",
      role: "editor",
    }));

    await user.click(screen.getByRole("button", { name: "移除成员 成员二 @user2" }));
    await waitFor(() => expect(mocks.deleteBoardMember).toHaveBeenCalledWith(board.id, "user-2"));
  });

  it("在看板设置 Dialog 内允许搜索并选择组织用户", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>看板设置</DialogTitle>
          <DialogDescription>配置看板成员</DialogDescription>
          <BoardMembers board={board} canManage />
        </DialogContent>
      </Dialog>,
    );

    await screen.findByText("所有者 @owner");
    await user.click(screen.getByRole("combobox", { name: "选择组织用户" }));
    const search = screen.getByRole("searchbox", { name: "搜索组织用户" });
    await user.click(search);
    await user.type(search, "成员三");
    await user.click(screen.getByRole("option", { name: /成员三 @user3/ }));

    expect(screen.getByRole("combobox", { name: "选择组织用户" }).textContent).toContain("成员三 @user3");
  });

  it("无 members.manage 权限时角色和删除按钮只读", async () => {
    render(<BoardMembers board={{ ...board, role: "viewer", allowedActions: ["board.read"] }} canManage={false} />);

    expect(await screen.findByRole("combobox", { name: "成员二 @user2 的角色" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "移除成员 成员二 @user2" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("textbox", { name: "用户 ID" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "选择组织用户" })).toBeNull();
  });
});
