import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelList } from "@agent/shared";
import { TaskDialog } from "./TaskDialog";

const modelList: ModelList = {
  groups: [{ id: "group-a", name: "模型组", models: [{ id: "model-b", name: "模型 B" }] }],
  default: "group-a/model-b",
  allowCrossGroupSwitch: true,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

describe("TaskDialog 交互", () => {
  it("下拉选项浮在弹窗之上，连续选择状态与优先级后可提交", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <TaskDialog
        open
        modelList={modelList}
        onOpenChange={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "标题" }), "修复任务看板交互");
    await user.click(screen.getByRole("combobox", { name: "新任务状态" }));
    expect(screen.getByRole("listbox").className).toContain("z-[110]");
    await user.click(screen.getByRole("option", { name: "待处理" }));
    await user.click(screen.getByRole("combobox", { name: "新任务优先级" }));
    await user.click(screen.getByRole("option", { name: "紧急" }));
    await user.click(screen.getByRole("combobox", { name: "任务运行模型" }));
    await user.click(screen.getByRole("option", { name: "模型 B" }));
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: "修复任务看板交互",
      status: "todo",
      priority: "urgent",
      model: "group-a/model-b",
    })));
  });

  it("提交期间锁定全部表单控件，请求完成后再关闭", async () => {
    const user = userEvent.setup();
    let resolveCreate!: () => void;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => {
      resolveCreate = resolve;
    }));
    const onOpenChange = vi.fn();
    render(
      <TaskDialog
        open
        onOpenChange={onOpenChange}
        onCreate={onCreate}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "标题" }), "检查提交锁定");
    await user.click(screen.getByRole("button", { name: "创建任务" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());

    expect(screen.getByRole("textbox", { name: "标题" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "正文" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("combobox", { name: "新任务状态" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("combobox", { name: "新任务优先级" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "标签" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("截止日期")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "取消" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "创建中..." })).toHaveProperty("disabled", true);
    expect(onOpenChange).not.toHaveBeenCalled();

    resolveCreate();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
