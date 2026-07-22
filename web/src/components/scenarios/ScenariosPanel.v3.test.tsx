import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScenariosPanel } from "./ScenariosPanel";
import { makeWorkflowLibrary, makeWorkflowScenario, makeWorkflowSkin } from "./workflowTestFixtures";
import { OUTCOME_OPTIONS } from "./workflowUi";

const mocked = vi.hoisted(() => ({ workflowLibrary: null as ReturnType<typeof makeWorkflowLibrary> | null }));

vi.mock("./useScenarioLibrary", async () => {
  const actual = await vi.importActual<typeof import("./useScenarioLibrary")>("./useScenarioLibrary");
  return {
    ...actual,
    useScenarioLibrary: () => ({
      library: null,
      workflowLibrary: mocked.workflowLibrary,
      mode: "v3",
      fallbackReason: null,
      loading: false,
      error: null,
      reload: vi.fn(),
    }),
  };
});

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/capabilities/templates");
  const scenarios = Array.from({ length: 28 }, (_, index) => makeWorkflowScenario(`scenario-${index + 1}`, {
    roleIds: [index % 2 === 0 ? "sales" : "finance"],
    goalTags: [OUTCOME_OPTIONS[index % OUTCOME_OPTIONS.length]],
    industryTags: [index % 3 === 0 ? "trade" : "manufacturing"],
  }));
  mocked.workflowLibrary = makeWorkflowLibrary(scenarios);
});

describe("ScenariosPanel V3", () => {
  it("有引导演示时默认只展示精选工作现场，完整目录按需展开", () => {
    const guided = makeWorkflowScenario("guided", {
      featured: true,
      featuredOrder: 1,
      readiness: "D1_CONNECTOR",
      launch: { sampleAvailable: false, startMode: "connector", starterMessage: "接入后启动" },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
      presentation: {
        version: 1,
        dataLabel: "合成场景演示",
        limitation: "演示数据均为虚构。",
        chapters: Array.from({ length: 6 }, (_, index) => ({
          id: `chapter-${index + 1}`,
          title: `业务步骤 ${index + 1}`,
          narration: "展示 AI 同事当前正在完成的业务动作。",
          result: "业务系统状态已经变化。",
          interaction: { kind: "next" as const, label: "下一步" },
          surface: {
            kind: "crm_table" as const,
            title: "客户关系系统",
            items: [{ label: "状态", value: "已更新", state: "success" as const }],
          },
        })),
      },
    });
    mocked.workflowLibrary = makeWorkflowLibrary([guided, makeWorkflowScenario("ordinary")]);

    render(<ScenariosPanel onTryScenario={vi.fn()} />);
    expect(screen.getByTestId("guided-presentations").children).toHaveLength(1);
    expect(screen.queryByTestId("workflow-catalog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "看它如何完成" }));
    expect(screen.getByRole("heading", { name: guided.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "浏览全部 2 个工作场景" }));
    expect(screen.getByTestId("workflow-catalog").children).toHaveLength(2);
  });

  it("默认只渲染28个唯一 catalog 卡片，skin/role view 不复制卡", () => {
    render(<ScenariosPanel onTryScenario={vi.fn()} />);
    expect(screen.getByTestId("workflow-catalog").children).toHaveLength(28);
    expect(screen.getByText(/默认目录共 28 个唯一工作流/)).toBeTruthy();
  });

  it("结果、岗位、行业三轴按 AND 收窄，并可一键清空", () => {
    render(<ScenariosPanel onTryScenario={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "追回款" }));
    fireEvent.click(screen.getByRole("tab", { name: "财务" }));
    fireEvent.click(screen.getByRole("tab", { name: "贸易" }));
    const count = screen.queryByTestId("workflow-catalog")?.children.length ?? 0;
    expect(count).toBeLessThan(28);
    fireEvent.click(screen.getByRole("button", { name: "清空筛选" }));
    expect(screen.getByTestId("workflow-catalog").children).toHaveLength(28);
  });

  it("D1 主 CTA 只进入连接器，不调用聊天启动", () => {
    const d1 = makeWorkflowScenario("connector-scenario", {
      readiness: "D1_CONNECTOR",
      launch: { sampleAvailable: false, startMode: "connector", starterMessage: "接入后启动" },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
    });
    mocked.workflowLibrary = makeWorkflowLibrary([d1]);
    const onStartWorkflow = vi.fn();
    const onConnectWorkflow = vi.fn();
    render(<ScenariosPanel onTryScenario={vi.fn()} onStartWorkflow={onStartWorkflow} onConnectWorkflow={onConnectWorkflow} />);
    fireEvent.click(screen.getByRole("button", { name: "接入我的系统" }));
    expect(onConnectWorkflow).toHaveBeenCalledWith("workflow-connector-scenario");
    expect(onStartWorkflow).not.toHaveBeenCalled();
  });

  it("D1 隔离演示入口只登记发送时启动意图，不回落为静态详情", () => {
    const d1 = makeWorkflowScenario("isolated-demo-scenario", {
      readiness: "D1_CONNECTOR",
      launch: {
        sampleAvailable: false,
        isolatedDemoAvailable: true,
        startMode: "connector",
        starterMessage: "运行受控版本隔离演示",
      },
      cta: { primary: "接入我的系统", secondary: "查看工作流" },
    });
    mocked.workflowLibrary = makeWorkflowLibrary([d1]);
    const onStartWorkflow = vi.fn();
    render(<ScenariosPanel onTryScenario={vi.fn()} onStartWorkflow={onStartWorkflow} />);

    fireEvent.click(screen.getByRole("button", { name: d1.title }));
    fireEvent.click(screen.getByRole("button", { name: "运行隔离演示" }));

    expect(onStartWorkflow).toHaveBeenCalledWith(
      d1.launch.starterMessage,
      d1,
      { isolatedDemo: true },
    );
  });

  it("12 个 Hero 按 featuredOrder 优先展示，客户只看到克制徽标", () => {
    const ordinary = makeWorkflowScenario("ordinary");
    const heroSecond = makeWorkflowScenario("hero-second", { featured: true, featuredOrder: 2 });
    const heroFirst = makeWorkflowScenario("hero-first", { featured: true, featuredOrder: 1 });
    mocked.workflowLibrary = makeWorkflowLibrary([ordinary, heroSecond, heroFirst]);
    render(<ScenariosPanel onTryScenario={vi.fn()} />);
    const titles = within(screen.getByTestId("workflow-catalog"))
      .getAllByRole("heading", { level: 3 })
      .map((node) => node.textContent);
    expect(titles).toEqual(["业务结果 hero-first", "业务结果 hero-second", "业务结果 ordinary"]);
    expect(screen.getAllByText("重点工作流")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("82");
    expect(document.body.textContent).not.toContain("designScore");
  });

  it("旧 alias 的 skin/role view 进入真实详情且 canonical URL 不丢选择", () => {
    const scenario = makeWorkflowScenario("industry-role", {
      roleIds: ["sales", "finance"],
      roleViewIds: ["view-sales", "view-finance"],
    });
    const base = makeWorkflowLibrary([scenario]);
    mocked.workflowLibrary = {
      ...base,
      skins: [makeWorkflowSkin(scenario.workflowId, {
        id: "skin-export",
        title: "外贸电子询价版本",
        industryVerticals: ["电子电气"],
        businessModels: ["外贸出口"],
        objectLabels: [{ key: "rfq", label: "客户询价、报价版本与送达回执" }],
      })],
      roleViews: [{
        id: "view-finance",
        workflowId: scenario.workflowId,
        roleId: "finance",
        title: "财务",
        responsibilities: ["核对利润、账期与信用边界"],
        visibleStages: ["判断与取舍", "系统动作与协作"],
        actions: ["确认利润底线"],
        approvalSummary: "超账期或低毛利需要财务确认",
      }],
      aliases: [{
        legacySlug: "legacy-export-quote",
        resolution: "catalog",
        targetCatalogScenarioId: scenario.id,
        skinId: "skin-export",
        roleViewId: "view-finance",
        roleId: "finance",
      }],
    };
    window.history.replaceState({}, "", "/capabilities/templates?scenario=legacy-export-quote&intent=view");
    render(<ScenariosPanel onTryScenario={vi.fn()} />);
    expect(screen.getByText("行业业务版本 · 外贸电子询价版本")).toBeTruthy();
    expect(screen.getByText("客户询价、报价版本与送达回执")).toBeTruthy();
    expect(screen.getByText("岗位视图 · 财务")).toBeTruthy();
    expect(screen.getByText("核对利润、账期与信用边界")).toBeTruthy();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("workflow")).toBe(scenario.id);
    expect(params.get("skinId")).toBe("skin-export");
    expect(params.get("roleViewId")).toBe("view-finance");
    expect(params.get("roleId")).toBe("finance");
  });

  it("当前行业与岗位筛选会选择对应 skin 和 role view，不只过滤卡片", () => {
    const scenario = makeWorkflowScenario("filtered-detail", {
      roleIds: ["sales", "finance"],
      roleViewIds: ["view-finance"],
      industryTags: ["manufacturing", "export"],
      industryVerticals: ["机械装备/自动化", "电子电气"],
      businessModels: ["生产制造", "外贸出口"],
    });
    const base = makeWorkflowLibrary([scenario]);
    mocked.workflowLibrary = {
      ...base,
      skins: [
        makeWorkflowSkin(scenario.workflowId, {
          id: "skin-export",
          title: "出口版本",
          industryVerticals: ["电子电气"],
          businessModels: ["外贸出口"],
          objectLabels: [{ key: "export", label: "出口询价" }],
        }),
        makeWorkflowSkin(scenario.workflowId, {
          id: "skin-manufacturing",
          title: "生产制造版本",
          industryVerticals: ["机械装备/自动化"],
          businessModels: ["生产制造"],
          objectLabels: [{ key: "order", label: "生产订单与交期承诺" }],
        }),
      ],
      roleViews: [{
        id: "view-finance",
        workflowId: scenario.workflowId,
        roleId: "finance",
        title: "财务",
        responsibilities: ["确认成本与信用风险"],
        visibleStages: ["判断与取舍"],
        actions: ["确认信用额度"],
        approvalSummary: "超额度需要财务负责人确认",
      }],
    };
    render(<ScenariosPanel onTryScenario={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "财务" }));
    fireEvent.click(screen.getByRole("tab", { name: "机械装备/自动化" }));
    fireEvent.click(screen.getByRole("tab", { name: "生产制造" }));
    fireEvent.click(screen.getByRole("tab", { name: "已有单体系统" }));
    fireEvent.click(screen.getByRole("button", { name: scenario.title }));
    expect(screen.getByText("行业业务版本 · 生产制造版本")).toBeTruthy();
    expect(screen.getByText("生产订单与交期承诺")).toBeTruthy();
    expect(screen.getByText("岗位视图 · 财务")).toBeTruthy();
    expect(screen.getByText("确认成本与信用风险")).toBeTruthy();
  });

  it("后置旧 slug 明确提示未开放，且不启动聊天", () => {
    const base = makeWorkflowLibrary([makeWorkflowScenario("open-scenario")]);
    mocked.workflowLibrary = {
      ...base,
      deferredObjects: [{ id: "legacy-deferred-object", kind: "workflow", reason: "需要项目级系统接入后再开放", status: "deferred" }],
      aliases: [{ legacySlug: "legacy-deferred", resolution: "deferred", deferredObjectId: "legacy-deferred-object" }],
    };
    window.history.replaceState({}, "", "/capabilities/templates?scenario=legacy-deferred&intent=run");
    const onStartWorkflow = vi.fn();
    render(<ScenariosPanel onTryScenario={vi.fn()} onStartWorkflow={onStartWorkflow} />);
    expect(screen.getByRole("heading", { name: "当前未作为标准工作流开放" })).toBeTruthy();
    expect(screen.getByText("需要项目级系统接入后再开放")).toBeTruthy();
    expect(onStartWorkflow).not.toHaveBeenCalled();
  });
});
