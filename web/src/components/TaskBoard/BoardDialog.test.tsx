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
  visibility: "personal",
  ownerUserId: "user-1",
  canManage: true,
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
    expect(screen.getByRole("combobox", { name: "看板可见范围" }).textContent).toContain("个人");
    await user.click(screen.getByRole("combobox", { name: "看板可见范围" }));
    await user.click(screen.getByRole("option", { name: "组织" }));
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
      visibility: "organization",
    });
  });

  it("配置 GitHub 仓库、互斥定时触发与执行批次策略", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <BoardDialog
        open
        onOpenChange={vi.fn()}
        onCreate={onCreate}
        onUpdate={vi.fn(async () => undefined)}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "名称" }), "自动集成");
    await user.click(screen.getByRole("checkbox", { name: "关联 GitHub 仓库" }));
    await user.type(screen.getByRole("textbox", { name: "Repository ID" }), "repo-1");
    await user.type(screen.getByRole("textbox", { name: "仓库所有者" }), "kaiyan");
    await user.type(screen.getByRole("textbox", { name: "仓库名" }), "agent-saas");
    await user.click(screen.getByRole("combobox", { name: "集成触发模式" }));
    await user.click(screen.getByRole("option", { name: "定时触发" }));
    const cron = screen.getByRole("textbox", { name: "Cron" });
    await user.clear(cron);
    await user.type(cron, "0 3 * * 1-5");
    await user.click(screen.getByRole("button", { name: "创建看板" }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      repository: {
        provider: "github",
        repositoryId: "repo-1",
        owner: "kaiyan",
        name: "agent-saas",
        baseBranch: "main",
        allowForkPullRequest: false,
      },
      integrationPolicy: expect.objectContaining({
        enabled: true,
        trigger: { mode: "scheduled", cron: "0 3 * * 1-5", timezone: "Asia/Shanghai" },
        batch: { maxTasks: 10, selection: "priority_then_ready_at" },
        execution: expect.objectContaining({ mergeMethod: "squash" }),
      }),
    }));
    expect(screen.queryByRole("spinbutton", { name: "就绪防抖（毫秒）" })).toBeNull();
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

  it("创建看板时为各执行阶段指定默认模型", async () => {
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

    await user.type(screen.getByRole("textbox", { name: "名称" }), "阶段模型看板");
    await user.click(screen.getByRole("combobox", { name: "实施（work）默认模型" }));
    await user.click(screen.getByRole("option", { name: "模型 A" }));
    await user.click(screen.getByRole("combobox", { name: "复核（review）默认模型" }));
    await user.click(screen.getByRole("option", { name: "模型 A" }));
    await user.click(screen.getByRole("combobox", { name: "集成（merge）默认模型" }));
    await user.click(screen.getByRole("option", { name: "模型 A" }));
    await user.click(screen.getByRole("button", { name: "创建看板" }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      stageModels: { work: "group-a/model-a", review: "group-a/model-a", merge: "group-a/model-a" },
    }));
  });

  it("创建看板时展示各阶段提示语默认值，编辑后随创建请求提交", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(
      <BoardDialog
        open
        onOpenChange={vi.fn()}
        onCreate={onCreate}
        onUpdate={vi.fn(async () => undefined)}
      />,
    );

    // 默认展示固定模板文本。
    const work = screen.getByRole("textbox", { name: "实施（work）" }) as HTMLTextAreaElement;
    expect(work.value).toContain("## 任务看板执行职责");
    // 未编辑时不随创建请求提交。
    await user.type(screen.getByRole("textbox", { name: "名称" }), "阶段提示语看板");
    await user.click(screen.getByRole("button", { name: "创建看板" }));
    expect(onCreate).toHaveBeenCalledWith(expect.not.objectContaining({ stagePrompts: expect.anything() }));

    // 编辑后仅提交与默认不同的阶段。
    const review = screen.getByRole("textbox", { name: "复核（review）" });
    await user.clear(review);
    await user.type(review, "复核时检查证据链。");
    await user.click(screen.getByRole("button", { name: "创建看板" }));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      stagePrompts: { review: "复核时检查证据链。" },
    }));
  });

  it("编辑看板时展示已有阶段模型，并可将阶段恢复为继承看板默认", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => undefined);
    render(
      <BoardDialog
        open
        modelList={modelList}
        board={{ ...board, stageModels: { work: "group-a/model-a", merge: "group-a/model-merge" } }}
        onOpenChange={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByRole("combobox", { name: "实施（work）默认模型" }).textContent).toContain("模型 A");
    expect(screen.getByRole("combobox", { name: "复核（review）默认模型" }).textContent).toContain("继承看板默认模型");
    // 列表外的模型 ref 保留原值提交，展示时回退为空占位。
    expect(screen.getByRole("combobox", { name: "集成（merge）默认模型" }).textContent).toBe("");
    await user.click(screen.getByRole("combobox", { name: "实施（work）默认模型" }));
    await user.click(screen.getByRole("option", { name: "继承看板默认模型" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpdate).toHaveBeenCalledWith(board.id, {
      stageModels: { merge: "group-a/model-merge" },
      expectedVersion: board.version,
    });
  });

  it("编辑看板时加载已有阶段提示语，改动后提交完整覆盖", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => undefined);
    render(
      <BoardDialog
        open
        board={{
          ...board,
          stagePrompts: { work: "只负责实施。", merge: "负责合并交付。" },
        }}
        onOpenChange={vi.fn()}
        onCreate={vi.fn(async () => undefined)}
        onUpdate={onUpdate}
      />,
    );

    const work = screen.getByRole("textbox", { name: "实施（work）" }) as HTMLTextAreaElement;
    expect(work.value).toBe("只负责实施。");
    const merge = screen.getByRole("textbox", { name: "集成（merge）" }) as HTMLTextAreaElement;
    expect(merge.value).toBe("负责合并交付。");

    await user.clear(merge);
    await user.type(merge, "合并前必须绿色检查。");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onUpdate).toHaveBeenCalledWith(board.id, {
      stagePrompts: { work: "只负责实施。", merge: "合并前必须绿色检查。" },
      expectedVersion: board.version,
    });
  });

  it("默认使用 workflow v2，并在选择 v3 后提交 feature flags", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    render(<BoardDialog open onOpenChange={vi.fn()} onCreate={onCreate} onUpdate={vi.fn(async () => undefined)} />);

    await user.type(screen.getByRole("textbox", { name: "名称" }), "v3 集成");
    await user.click(screen.getByRole("checkbox", { name: "关联 GitHub 仓库" }));
    await user.type(screen.getByRole("textbox", { name: "Repository ID" }), "repo-1");
    await user.type(screen.getByRole("textbox", { name: "仓库所有者" }), "kaiyan");
    await user.type(screen.getByRole("textbox", { name: "仓库名" }), "agent-saas");
    expect(screen.getByRole("combobox", { name: "Integration workflow 版本" }).textContent).toContain("v2");
    expect(screen.queryByRole("checkbox", { name: "启用 v3 engine" })).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "Integration workflow 版本" }));
    await user.click(screen.getByRole("option", { name: "v3（Candidate）" }));
    expect(screen.getByRole("checkbox", { name: "启用 v3 engine" }).getAttribute("data-state")).toBe("checked");
    await user.click(screen.getByRole("checkbox", { name: "Workspace 同步" }));
    await user.click(screen.getByRole("button", { name: "创建看板" }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      integrationPolicy: expect.objectContaining({
        workflowVersion: 3,
        featureFlags: {
          engineV3: true, compose: true, review: true, merge: true, cleanup: true, workspaceSync: false,
        },
      }),
    }));
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
