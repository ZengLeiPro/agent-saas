import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelList, TaskBoardTaskCreateInput } from "@agent/shared";
import { TaskDialog } from "./TaskDialog";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/authFetch", () => ({ authFetch: mocks.authFetch }));

const modelList: ModelList = {
  groups: [{ id: "group-a", name: "模型组", models: [{ id: "model-b", name: "模型 B" }] }],
  default: "group-a/model-b",
  allowCrossGroupSwitch: true,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

describe("TaskDialog 交互", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset();
  });

  it("下拉选项浮在弹窗之上，连续选择状态、优先级与实施/复核模型后可提交", async () => {
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

    await user.type(screen.getByRole("textbox", { name: "正文" }), "修复任务看板交互");
    expect(screen.queryByRole("textbox", { name: "标题" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "工作分支" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "新任务状态" }));
    expect(screen.getByRole("listbox").className).toContain("z-[110]");
    await user.click(screen.getByRole("option", { name: "待推进" }));
    await user.click(screen.getByRole("combobox", { name: "新任务优先级" }));
    await user.click(screen.getByRole("option", { name: "紧急" }));
    for (const purpose of ["实施阶段", "复核阶段"]) {
      await user.click(screen.getByRole("combobox", { name: `${purpose}运行模型` }));
      await user.click(screen.getByRole("option", { name: "模型 B" }));
    }
    expect(screen.queryByRole("combobox", { name: "集成阶段运行模型" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      description: "修复任务看板交互",
      status: "todo",
      priority: "urgent",
      stageModels: {
        work: "group-a/model-b",
        review: "group-a/model-b",
      },
    })));
  });

  it("TASK-84 可显式创建 advisory，且不提交分支字段", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async (_input: TaskBoardTaskCreateInput) => undefined);
    render(<TaskDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);

    await user.click(screen.getByRole("combobox", { name: "任务类型" }));
    await user.click(screen.getByRole("option", { name: "答复与分析（不实施变更）" }));
    await user.type(screen.getByRole("textbox", { name: "正文" }), "仅回答部署风险");
    expect(screen.queryByRole("textbox", { name: "工作分支" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      description: "仅回答部署风险",
      kind: "advisory",
    })));
    expect(onCreate.mock.calls[0]?.[0]).not.toHaveProperty("branch");
  });

  it("实施中任务可勾选直接执行，其他状态不显示该选项", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<TaskDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);

    expect(screen.queryByRole("checkbox", { name: "直接执行" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "正文" }), "立即处理异常");
    await user.click(screen.getByRole("combobox", { name: "新任务状态" }));
    await user.click(screen.getByRole("option", { name: "实施中" }));
    await user.click(screen.getByRole("checkbox", { name: "直接执行" }));
    await user.click(screen.getByRole("button", { name: "创建任务" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      description: "立即处理异常",
      status: "in_progress",
      dispatch: true,
    })));
  });

  it("创建状态与 REST 契约一致，非法工作流状态不可选且实施中必须直接执行", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<TaskDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);

    await user.type(screen.getByRole("textbox", { name: "正文" }), "立即执行任务");
    await user.click(screen.getByRole("combobox", { name: "新任务状态" }));
    expect(screen.getByRole("option", { name: "需求池" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "待推进" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "实施中" })).toBeTruthy();
    for (const illegal of ["复核中", "待合并", "已阻塞", "已完成", "已取消"]) {
      expect(screen.queryByRole("option", { name: illegal })).toBeNull();
    }
    await user.click(screen.getByRole("option", { name: "实施中" }));
    await user.click(screen.getByRole("button", { name: "创建任务" }));
    expect((await screen.findByRole("alert")).textContent).toContain("必须勾选“直接执行”");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("正文支持一次上传多个附件并随任务提交", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      files: [
        {
          attachmentId: "11111111-1111-4111-8111-111111111111",
          originalName: "需求图.png",
          relativePath: "uploads/需求图.png",
          size: 3,
          mimeType: "image/png",
          isImage: true,
        },
        {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          originalName: "演示.mp4",
          relativePath: "uploads/演示.mp4",
          size: 4,
          mimeType: "video/mp4",
          isImage: false,
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<TaskDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);

    await user.type(screen.getByRole("textbox", { name: "正文" }), "带附件任务");
    const files = [
      new File(["png"], "需求图.png", { type: "image/png" }),
      new File(["video"], "演示.mp4", { type: "video/mp4" }),
    ];
    fireEvent.change(screen.getByLabelText("选择附件"), { target: { files } });
    await waitFor(() => expect(screen.getByText("需求图.png")).toBeTruthy());
    expect(screen.getByText("演示.mp4")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "创建任务" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      attachments: expect.arrayContaining([
        expect.objectContaining({ originalName: "需求图.png", isImage: true }),
        expect.objectContaining({ originalName: "演示.mp4", isImage: false }),
      ]),
    })));
    const request = mocks.authFetch.mock.calls[0];
    expect(request?.[0]).toBe("/api/upload");
    expect((request?.[1]?.body as FormData).getAll("files")).toHaveLength(2);
  });

  it("正文粘贴文件会上传附件且不写入文本", async () => {
    const pasted = new File(["image"], "粘贴截图.png", { type: "image/png" });
    mocks.authFetch.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      files: [{
        attachmentId: "33333333-3333-4333-8333-333333333333",
        originalName: pasted.name,
        relativePath: `uploads/${pasted.name}`,
        size: pasted.size,
        mimeType: pasted.type,
        isImage: true,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<TaskDialog open onOpenChange={vi.fn()} onCreate={vi.fn()} />);
    const body = screen.getByRole("textbox", { name: "正文" });

    fireEvent.paste(body, {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => pasted }],
      },
    });

    await waitFor(() => expect(screen.getByText(pasted.name)).toBeTruthy());
    expect((body as HTMLTextAreaElement).value).toBe("");
  });

  it("正文为空时不提交", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<TaskDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);

    expect(screen.getByRole("textbox", { name: "正文" })).toHaveProperty("required", true);
    await user.click(screen.getByRole("button", { name: "创建任务" }));
    expect(onCreate).not.toHaveBeenCalled();
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

    await user.type(screen.getByRole("textbox", { name: "正文" }), "提交锁定测试");
    await user.click(screen.getByRole("button", { name: "创建任务" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());

    expect(screen.queryByRole("textbox", { name: "标题" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "正文" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("combobox", { name: "新任务状态" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("combobox", { name: "新任务优先级" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("textbox", { name: "标签" })).toBeNull();
    expect(screen.queryByLabelText("截止日期")).toBeNull();
    expect(screen.getByRole("button", { name: "取消" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "创建中..." })).toHaveProperty("disabled", true);
    expect(onOpenChange).not.toHaveBeenCalled();

    resolveCreate();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
