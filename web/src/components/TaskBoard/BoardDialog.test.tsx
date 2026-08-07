import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "@agent/shared";
import { BoardDialog } from "./BoardDialog";

const board: TaskBoard = {
  id: "board-1",
  name: "研发事项",
  description: "服务端说明",
  version: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("BoardDialog 冲突重试", () => {
  it("同一看板版本刷新时保留用户草稿，并用最新 expectedVersion 提交", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => undefined);
    const common = {
      open: true,
      onOpenChange: vi.fn(),
      onCreate: vi.fn(async () => undefined),
      onUpdate,
    };
    const { rerender } = render(<BoardDialog {...common} board={board} />);

    const name = screen.getByRole("textbox", { name: "名称" }) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "我的看板草稿");

    rerender(<BoardDialog {...common} board={{
      ...board,
      name: "其他窗口名称",
      description: "其他窗口说明",
      version: 3,
    }} />);
    expect(name.value).toBe("我的看板草稿");
    expect((screen.getByRole("textbox", { name: "说明" }) as HTMLTextAreaElement).value).toBe("其他窗口说明");

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onUpdate).toHaveBeenCalledWith(board.id, {
      name: "我的看板草稿",
      expectedVersion: 3,
    });
  });
});
