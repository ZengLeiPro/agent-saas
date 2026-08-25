import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TASKBOARD_DEFAULT_PROMPT } from "@agent/shared";
import type { ModelList, TaskBoard, TaskBoardCreateInput } from "@agent/shared";
import type { TaskBoardCiPolicyDiscovery } from "@agent/shared/types/taskboard";
import { BoardDialog } from "./BoardDialog";

const mocks = vi.hoisted(() => ({ fetchBoardCiPolicyDiscovery: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  fetchBoardCiPolicyDiscovery: mocks.fetchBoardCiPolicyDiscovery,
}));

const modelList: ModelList = {
  groups: [{ id: "group-a", name: "模型组", models: [{ id: "model-a", name: "模型 A" }] }],
  default: "group-a/model-a",
  allowCrossGroupSwitch: true,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

const discovery: TaskBoardCiPolicyDiscovery = {
  boardId: "board-1",
  repositoryId: "github:tenant-1:acme/app",
  providerKnown: true,
  effectiveSource: "board",
  githubRequiredChecks: [],
  boardRequiredChecks: [{ name: "board-ci", appId: 9 }],
  effectiveRequiredChecks: [{ name: "board-ci", appId: 9 }],
  observedChecks: [
    { name: "board-ci", appId: 9, appName: "CI App", status: "success" },
    { name: "optional-check", appId: 7, appName: "Optional App", status: "success" },
  ],
  providerPullRequestId: "42",
  headOid: "head-42",
  providerQueriedAt: "2026-08-23T11:00:00.000Z",
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
  beforeEach(() => {
    mocks.fetchBoardCiPolicyDiscovery.mockReset();
    mocks.fetchBoardCiPolicyDiscovery.mockResolvedValue(discovery);
  });

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

  it("新看板固定提交 Agent workflow v3，且不展示协议选择或 feature flags", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async (_input: TaskBoardCreateInput) => undefined);
    render(<BoardDialog open onOpenChange={vi.fn()} onCreate={onCreate} onUpdate={vi.fn(async () => undefined)} />);

    await user.type(screen.getByRole("textbox", { name: "名称" }), "Agent 集成");
    await user.click(screen.getByRole("checkbox", { name: "关联 GitHub 仓库" }));
    await user.type(screen.getByRole("textbox", { name: "Repository ID" }), "repo-1");
    await user.type(screen.getByRole("textbox", { name: "仓库所有者" }), "kaiyan");
    await user.type(screen.getByRole("textbox", { name: "仓库名" }), "agent-saas");

    expect(screen.queryByRole("combobox", { name: "Integration workflow 版本" })).toBeNull();
    expect(screen.queryByText(/feature flags/i)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "启用 v3 engine" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "创建看板" }));

    const policy = onCreate.mock.calls[0]?.[0].integrationPolicy;
    expect(policy).toMatchObject({ workflowVersion: 3 });
    expect(policy).not.toHaveProperty("featureFlags");
  });

  it("展示 GitHub 与 observed checks，并仅在用户勾选后写入看板 fallback", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => undefined);
    mocks.fetchBoardCiPolicyDiscovery
      .mockResolvedValueOnce(discovery)
      .mockResolvedValueOnce({
        ...discovery,
        boardRequiredChecks: [...discovery.boardRequiredChecks, { name: "optional-check", appId: 7 }],
        effectiveRequiredChecks: [...discovery.boardRequiredChecks, { name: "optional-check", appId: 7 }],
      });
    const configuredBoard: TaskBoard = {
      ...board,
      repository: { provider: "github", repositoryId: discovery.repositoryId, owner: "acme", name: "app", baseBranch: "main", allowForkPullRequest: false },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: "r1", ciPolicy: { requiredChecks: [{ name: "board-ci", appId: 9 }] },
        trigger: { mode: "manual", allowedRoles: ["owner"] }, batch: { maxTasks: 10, selection: "priority_then_ready_at" },
        execution: { mergeMethod: "squash", continueIndependentSources: true, autoResolveConflicts: true, maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true, deleteRemoteBranch: false, deploy: false },
      },
    };
    render(<BoardDialog open board={configuredBoard} onOpenChange={vi.fn()} onCreate={vi.fn()} onUpdate={onUpdate} />);

    expect(await screen.findByText(/当前生效来源：看板 fallback/)).toBeTruthy();
    expect(screen.getByText("GitHub 未声明 required checks。")).toBeTruthy();
    expect(screen.getByText(/optional-check · success · Optional App/)).toBeTruthy();
    const optional = screen.getByRole("checkbox", { name: "选择 observed check optional-check" });
    expect(optional.getAttribute("data-state")).toBe("unchecked");
    await user.click(optional);
    expect((screen.getByRole("textbox", { name: "看板 fallback required contexts" }) as HTMLTextAreaElement).value)
      .toContain("optional-check | 7");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpdate).toHaveBeenCalledWith(configuredBoard.id, expect.objectContaining({
      integrationPolicy: expect.objectContaining({
        ciPolicy: { requiredChecks: [{ name: "board-ci", appId: 9 }, { name: "optional-check", appId: 7 }] },
      }),
      expectedVersion: configuredBoard.version,
    }));
    expect(await screen.findByText("已保存，并按服务端最终策略回显。")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "看板 fallback required contexts" }) as HTMLTextAreaElement).value)
      .toContain("optional-check | 7");
  });

  it("无策略权限时只读展示发现结果与 App 来源", async () => {
    const readOnlyBoard: TaskBoard = {
      ...board,
      allowedActions: ["board.read"],
      canManage: false,
      repository: { provider: "github", repositoryId: discovery.repositoryId, owner: "acme", name: "app", baseBranch: "main", allowForkPullRequest: false },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: "r1", ciPolicy: { requiredChecks: [{ name: "board-ci", appId: 9 }] },
        trigger: { mode: "manual", allowedRoles: ["owner"] }, batch: { maxTasks: 10, selection: "priority_then_ready_at" },
        execution: { mergeMethod: "squash", continueIndependentSources: true, autoResolveConflicts: true, maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true, deleteRemoteBranch: false, deploy: false },
      },
    };
    render(<BoardDialog open board={readOnlyBoard} onOpenChange={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} />);

    expect(await screen.findByText(/当前生效来源：看板 fallback/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "选择 observed check optional-check" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("textbox", { name: "看板 fallback required contexts" })).toHaveProperty("disabled", true);
  });

  it("显示 CI discovery 与保存错误，不伪装成功", async () => {
    const user = userEvent.setup();
    mocks.fetchBoardCiPolicyDiscovery.mockRejectedValueOnce(new Error("GitHub discovery unavailable"));
    const onUpdate = vi.fn(async () => { throw new Error("保存 CI policy 失败"); });
    const configuredBoard = {
      ...board,
      repository: { provider: "github" as const, repositoryId: discovery.repositoryId, owner: "acme", name: "app", baseBranch: "main", allowForkPullRequest: false as const },
      integrationPolicy: {
        schemaVersion: 1 as const, enabled: true, revision: "r1",
        trigger: { mode: "manual" as const, allowedRoles: ["owner" as const] }, batch: { maxTasks: 10, selection: "priority_then_ready_at" as const },
        execution: { mergeMethod: "squash" as const, continueIndependentSources: true as const, autoResolveConflicts: true as const, maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true as const, deleteRemoteBranch: false as const, deploy: false as const },
      },
    };
    render(<BoardDialog open board={configuredBoard} onOpenChange={vi.fn()} onCreate={vi.fn()} onUpdate={onUpdate} />);
    expect(await screen.findByText("GitHub discovery unavailable")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "看板 fallback required contexts" }), "manual-ci");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("保存 CI policy 失败")).toBeTruthy();
  });

  it("切换 Repository ID 时清空旧 fallback 并明确提示重新确认", async () => {
    const user = userEvent.setup();
    const configuredBoard: TaskBoard = {
      ...board,
      repository: { provider: "github", repositoryId: discovery.repositoryId, owner: "acme", name: "app", baseBranch: "main", allowForkPullRequest: false },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: "r1", ciPolicy: { requiredChecks: [{ name: "board-ci", appId: 9 }] },
        trigger: { mode: "manual", allowedRoles: ["owner"] }, batch: { maxTasks: 10, selection: "priority_then_ready_at" },
        execution: { mergeMethod: "squash", continueIndependentSources: true, autoResolveConflicts: true, maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true, deleteRemoteBranch: false, deploy: false },
      },
    };
    render(<BoardDialog open board={configuredBoard} onOpenChange={vi.fn()} onCreate={vi.fn()} onUpdate={vi.fn()} />);
    await screen.findByText(/当前生效来源：看板 fallback/);

    const repositoryId = screen.getByRole("textbox", { name: "Repository ID" });
    await user.clear(repositoryId);
    await user.type(repositoryId, "github:tenant-1:acme/new-app");

    expect(screen.getByText(/旧仓库 fallback 已清空/)).toBeTruthy();
    expect(screen.queryByText(/optional-check · success/)).toBeNull();
    expect((screen.getByRole("textbox", { name: "看板 fallback required contexts" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("PATCH 成功但最终策略回读失败时不显示绿色回显成功", async () => {
    const user = userEvent.setup();
    mocks.fetchBoardCiPolicyDiscovery
      .mockResolvedValueOnce(discovery)
      .mockRejectedValueOnce(new Error("discovery readback failed"));
    const onUpdate = vi.fn(async () => undefined);
    const configuredBoard: TaskBoard = {
      ...board,
      repository: { provider: "github", repositoryId: discovery.repositoryId, owner: "acme", name: "app", baseBranch: "main", allowForkPullRequest: false },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: "r1", ciPolicy: { requiredChecks: [{ name: "board-ci", appId: 9 }] },
        trigger: { mode: "manual", allowedRoles: ["owner"] }, batch: { maxTasks: 10, selection: "priority_then_ready_at" },
        execution: { mergeMethod: "squash", continueIndependentSources: true, autoResolveConflicts: true, maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true, deleteRemoteBranch: false, deploy: false },
      },
    };
    render(<BoardDialog open board={configuredBoard} onOpenChange={vi.fn()} onCreate={vi.fn()} onUpdate={onUpdate} />);
    await screen.findByText(/当前生效来源：看板 fallback/);
    await user.type(screen.getByRole("textbox", { name: "看板 fallback required contexts" }), "\nmanual-ci");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/保存成功，但未能回读最终 CI 策略：discovery readback failed/)).toBeTruthy();
    expect(screen.queryByText("已保存，并按服务端最终策略回显。")).toBeNull();
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
