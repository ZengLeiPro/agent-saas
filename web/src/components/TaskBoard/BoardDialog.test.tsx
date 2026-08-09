import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TASKBOARD_DEFAULT_PROMPT } from "@agent/shared";
import type { ModelList, TaskBoard } from "@agent/shared";
import { BoardDialog } from "./BoardDialog";

const modelList: ModelList = {
  groups: [{ id: "group-a", name: "模型组", models: [{ id: "model-a", name: "模型 A" }] }],
  default: "group-a/model-a",
  allowCrossGroupSwitch: true,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

const board: TaskBoard = {
  id: "board-1",
  name: "研发事项",
  description: "服务端说明",
  prompt: "服务端提示语",
  version: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("BoardDialog", () => {
  it("创建看板时展示并提交默认提示语，且允许修改", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <BoardDialog
        open
        modelList={modelList}
        onOpenChange={vi.fn()}
        onCreate={onCreate}
        onUpdate={vi.fn(async () => undefined)}
      />,
    );

    const prompt = screen.getByRole("textbox", { name: "看板提示语" }) as HTMLTextAreaElement;
    expect(prompt.value).toBe(TASKBOARD_DEFAULT_PROMPT);
    await user.clear(prompt);
    await user.type(prompt, "只处理当前任务，不修改无关文件。");
    await user.type(screen.getByRole("textbox", { name: "名称" }), "产品研发");
    await user.click(screen.getByRole("combobox", { name: "看板运行模型" }));
    await user.click(screen.getByRole("option", { name: "模型 A" }));
    await user.click(screen.getByRole("button", { name: "创建看板" }));

    expect(onCreate).toHaveBeenCalledWith({
      name: "产品研发",
      prompt: "只处理当前任务，不修改无关文件。",
      model: "group-a/model-a",
    });
  });

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
      prompt: "其他窗口提示语",
      version: 3,
    }} />);
    expect(name.value).toBe("我的看板草稿");
    expect((screen.getByRole("textbox", { name: "说明" }) as HTMLTextAreaElement).value).toBe("其他窗口说明");
    expect((screen.getByRole("textbox", { name: "看板提示语" }) as HTMLTextAreaElement).value)
      .toBe("其他窗口提示语");

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onUpdate).toHaveBeenCalledWith(board.id, {
      name: "我的看板草稿",
      expectedVersion: 3,
    });
  });

  it("编辑看板时可清除显式模型并恢复继承组织默认", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => undefined);
    render(
      <BoardDialog
        open
        board={{ ...board, model: "group-a/model-a" }}
        onOpenChange={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "看板运行模型" }));
    await user.click(screen.getByRole("option", { name: "继承组织默认模型" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpdate).toHaveBeenCalledWith(board.id, {
      model: null,
      expectedVersion: board.version,
    });
  });

  it("提交期间锁定全部表单控件，请求完成后再关闭", async () => {
    const user = userEvent.setup();
    let resolveUpdate!: () => void;
    const onUpdate = vi.fn(() => new Promise<void>((resolve) => {
      resolveUpdate = resolve;
    }));
    const onOpenChange = vi.fn();
    render(
      <BoardDialog
        open
        board={board}
        onOpenChange={onOpenChange}
        onCreate={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );

    const name = screen.getByRole("textbox", { name: "名称" });
    await user.type(name, "更新");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());

    expect(name).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "说明" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "看板提示语" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "取消" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "保存中..." })).toHaveProperty("disabled", true);
    expect(onOpenChange).not.toHaveBeenCalled();

    resolveUpdate();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
