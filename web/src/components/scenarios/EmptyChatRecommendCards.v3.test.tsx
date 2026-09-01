import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyChatRecommendCards } from "./EmptyChatRecommendCards";
import { makeWorkflowLibrary, makeWorkflowScenario } from "./workflowTestFixtures";

const d0 = makeWorkflowScenario("d0-current", { title: "当前可运行工作流" });
const d1 = makeWorkflowScenario("d1-connector", {
  title: "需要标准接入工作流",
  industryTags: ["retail"],
  readiness: "D1_CONNECTOR",
  launch: {
    sampleAvailable: false,
    startMode: "connector",
    entry: { kind: "business_event", content: "业务系统出现一条待处理事件。" },
    starterMessage: "业务系统出现一条待处理事件。",
  },
  cta: { primary: "接入我的系统", secondary: "查看工作流" },
});
const demo = makeWorkflowScenario("demo-with-script", {
  title: "有剧本的工作流",
  industryTags: ["retail"],
  cta: { primary: "接入这个流程", secondary: "查看工作流" },
  presentation: {
    version: 1,
    dataLabel: "合成场景演示",
    limitation: "演示数据均为示例。",
    chapters: [
      {
        id: "only",
        title: "读取并回写",
        narration: "读取客户资料并回写状态。",
        result: "状态已回写。",
        interaction: { kind: "next", label: "下一步" },
        surface: {
          kind: "crm_table",
          title: "客户关系系统",
          items: [{ label: "状态", value: "已回写", state: "success", changed: true }],
        },
      },
    ],
  },
});
const library = makeWorkflowLibrary([d0, d1, demo]);
const display = vi.hoisted(() => ({
  config: { source: "platform", displayCount: 3, workflowIds: [] as string[], revision: 0 },
}));

vi.mock("./useScenarioLibrary", () => ({
  useScenarioLibrary: () => ({ library: null, workflowLibrary: library, loading: false, error: null }),
  matchRoleIdByPosition: () => null,
  pickRecommendedWorkflowScenarios: (items: typeof library.scenarios) => items,
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("./useWorkflowDisplayConfig", () => ({
  useWorkflowDisplayConfig: () => ({ config: display.config, loading: false, error: false }),
}));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  display.config = { source: "platform", displayCount: 3, workflowIds: [], revision: 0 };
});

describe("EmptyChatRecommendCards V3", () => {
  it("D0 预填短启动语，D1 进入目录接入路径而不启动聊天", () => {
    const onStartWorkflow = vi.fn();
    const onViewAll = vi.fn(() => window.history.pushState({}, "", "/capabilities"));
    render(<EmptyChatRecommendCards onTryScenario={vi.fn()} onStartWorkflow={onStartWorkflow} onViewAll={onViewAll} />);

    fireEvent.click(screen.getByRole("button", { name: /当前可运行工作流/ }));
    expect(onStartWorkflow).toHaveBeenCalledWith(d0.launch.starterMessage, d0);
    expect(onViewAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /需要标准接入工作流/ }));
    expect(onViewAll).toHaveBeenCalledOnce();
    expect(onStartWorkflow).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("workflow")).toBe("d1-connector");
    expect(params.get("intent")).toBe("connect");
  });

  it("有剧本的场景在第一屏只给回放入口", () => {
    const onStartWorkflow = vi.fn();
    const onViewAll = vi.fn(() => window.history.pushState({}, "", "/capabilities"));
    render(<EmptyChatRecommendCards onTryScenario={vi.fn()} onStartWorkflow={onStartWorkflow} onViewAll={onViewAll} />);

    // 有剧本的推荐项只表达回放动作，不暴露接入 CTA。
    expect(screen.getAllByText("看回放")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "接入这个流程" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /有剧本的工作流/ }));
    expect(onViewAll).toHaveBeenCalledOnce();
    expect(onStartWorkflow).not.toHaveBeenCalled();
    const params = new URLSearchParams(window.location.search);
    expect(params.get("workflow")).toBe("demo-with-script");
    expect(params.get("intent")).toBe("presentation");
  });

  it("行业命中不足时从全量场景补齐 Top 3", () => {
    localStorage.setItem("ky.scenarios.industry", "manufacturing");
    render(<EmptyChatRecommendCards onTryScenario={vi.fn()} onViewAll={vi.fn()} />);

    expect(screen.getByText("当前可运行工作流")).toBeTruthy();
    expect(screen.getByText("需要标准接入工作流")).toBeTruthy();
    expect(screen.getByText("有剧本的工作流")).toBeTruthy();
  });

  it("组织覆盖按配置顺序和数量显示，0 个时仍保留全部能力入口", () => {
    display.config = { source: "position", displayCount: 2, workflowIds: [demo.id, d0.id, d1.id], revision: 4 };
    const view = render(<EmptyChatRecommendCards onTryScenario={vi.fn()} onViewAll={vi.fn()} />);
    const cards = screen.getAllByRole("button").filter((button) => button.textContent?.includes("工作流"));
    expect(cards.slice(0, 2).map((button) => button.textContent)).toEqual([
      expect.stringContaining("有剧本的工作流"),
      expect.stringContaining("当前可运行工作流"),
    ]);
    expect(screen.queryByText("需要标准接入工作流")).toBeNull();

    display.config = { source: "user", displayCount: 0, workflowIds: [], revision: 5 };
    view.rerender(<EmptyChatRecommendCards onTryScenario={vi.fn()} onViewAll={vi.fn()} />);
    expect(screen.getByRole("button", { name: /查看全部能力/ })).toBeTruthy();
    expect(screen.queryByText("当前可运行工作流")).toBeNull();
  });
});
